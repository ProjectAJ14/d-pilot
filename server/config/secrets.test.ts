import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { decryptSecret, encryptSecret } from "./secrets.js";

/** Each test gets its own DATA_DIR, so its own key file. */
function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-secrets-"));
  vi.stubEnv("DATA_DIR", dir);
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("secrets", () => {
  it("round-trips, with a fresh IV each time", () => {
    freshDir();
    const a = encryptSecret("p@ss");
    expect(a).not.toBe(encryptSecret("p@ss"));
    expect(decryptSecret(a)).toBe("p@ss");
  });

  it("returns null for tampered ciphertext", () => {
    freshDir();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const [iv, tag, ct] = encryptSecret("secret").slice(7).split(":");
    const flipped = Buffer.from(ct, "base64");
    flipped[0] ^= 1;
    expect(
      decryptSecret(`enc:v1:${iv}:${tag}:${flipped.toString("base64")}`),
    ).toBeNull();
  });

  it("returns null under the wrong key", () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "one");
    const stored = encryptSecret("secret");
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "two");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(decryptSecret(stored)).toBeNull();
  });

  it("logs a failed decrypt once per stored value, never the value", () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "one");
    const a = encryptSecret("secret-a");
    const b = encryptSecret("secret-b");
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "two");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) decryptSecret(a);
    decryptSecret(b);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain(a.slice(7));
  });

  it("creates a 0600 key file holding a 32-byte hex key", () => {
    const dir = freshDir();
    encryptSecret("x");
    const file = path.join(dir, "settings.key");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readdirSync(dir)).toEqual(["settings.key"]);
  });

  it("adopts the key of a process that created the file first", () => {
    const dir = freshDir();
    const file = path.join(dir, "settings.key");
    const winner = "ab".repeat(32);
    const link = fs.linkSync;
    // Another process wins the race between our read and our create.
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      writeFileSync(file, winner, { mode: 0o600 });
      return link(from, to);
    });
    const stored = encryptSecret("x");
    expect(readFileSync(file, "utf8")).toBe(winner);
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");
    expect(decryptSecret(stored)).toBe("x");
    // No temp file left behind.
    expect(fs.readdirSync(dir)).toEqual(["settings.key"]);
  });

  it("falls back to a rename where hard links are unsupported", () => {
    const dir = freshDir();
    vi.spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
    });
    const rename = vi.spyOn(fs, "renameSync");
    const stored = encryptSecret("x");
    const file = path.join(dir, "settings.key");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toMatch(/^[0-9a-f]{64}$/);
    expect(decryptSecret(stored)).toBe("x");
    expect(rename).toHaveBeenCalledOnce();
    expect(fs.readdirSync(dir)).toEqual(["settings.key"]);
  });

  it("waits for a racing writer that has created the key file but not filled it", () => {
    const dir = freshDir();
    const file = path.join(dir, "settings.key");
    const hex = "cd".repeat(32);
    writeFileSync(file, "", { mode: 0o600 });
    const read = fs.readFileSync;
    let reads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation(((
      p: fs.PathOrFileDescriptor,
      o?: unknown,
    ) => {
      // The other process finishes writing after our second look.
      if (p === file && ++reads === 2) writeFileSync(file, hex);
      return read(p, o as BufferEncoding);
    }) as typeof fs.readFileSync);
    const stored = encryptSecret("x");
    expect(decryptSecret(stored)).toBe("x");
    expect(readFileSync(file, "utf8")).toBe(hex);
  });

  it("claims the key file by rename, never over one that appeared meanwhile", () => {
    const dir = freshDir();
    const file = path.join(dir, "settings.key");
    const winner = "ef".repeat(32);
    vi.spyOn(fs, "linkSync").mockImplementation(() => {
      // No hard links here — and another process wins in the meantime.
      writeFileSync(file, winner, { mode: 0o600 });
      throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
    });
    const rename = vi.spyOn(fs, "renameSync");
    encryptSecret("x");
    expect(readFileSync(file, "utf8")).toBe(winner);
    expect(rename).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual(["settings.key"]);
  });

  it("refuses an empty key file with a message naming it", () => {
    const dir = freshDir();
    const file = path.join(dir, "settings.key");
    writeFileSync(file, "", { mode: 0o600 });
    // (after waiting ~2s for a writer that never comes)
    let message = "";
    try {
      encryptSecret("x");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(file);
    expect(message).toMatch(/empty or not a 64-character hex/);
  });
});
