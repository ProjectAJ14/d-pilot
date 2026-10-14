import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";
import fs from "fs";
import path from "path";

/**
 * At-rest encryption for secrets stored in the app database (connection
 * passwords/URIs, the AI key). AES-256-GCM, so a tampered value fails to
 * decrypt rather than decrypting to garbage.
 *
 * The key never lives in SQLite: it is `SETTINGS_ENCRYPTION_KEY` (any string,
 * hashed to 32 bytes) or, failing that, a random key generated once into
 * `DATA_DIR/settings.key` (mode 0600). Lose that file and the stored secrets
 * are unrecoverable — back it up with the database, but not inside it.
 */

const PREFIX = "enc:v1:";
const keys = new Map<string, Buffer>();

function encryptionKey(): Buffer {
  const fromEnv = process.env.SETTINGS_ENCRYPTION_KEY;
  if (fromEnv) return createHash("sha256").update(fromEnv).digest();

  const file = path.resolve(
    process.cwd(),
    process.env.DATA_DIR || "data",
    "settings.key",
  );
  const hit = keys.get(file);
  if (hit) return hit;

  let hex: string;
  try {
    hex = readKeyFile(file);
  } catch {
    hex = createKeyFile(file);
  }
  const key = Buffer.from(hex, "hex");
  if (!/^[0-9a-f]{64}$/i.test(hex) || key.length !== 32)
    throw new Error(
      `Encryption key file ${file} is empty or not a 64-character hex key — restore it from backup (secrets stored under it cannot be read without it), or delete it only if no secrets are stored yet.`,
    );
  keys.set(file, key);
  return key;
}

/**
 * Writes a new random key to `file` without ever exposing a partial file, and
 * without clobbering one another process created first: the key goes to a
 * private temp file that is then hard-linked into place, which fails if `file`
 * exists — in which case that process's key is the one to use.
 */
function createKeyFile(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const hex = randomBytes(32).toString("hex");
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, hex);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmp, file);
    return hex;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return readKeyFile(file);
    if (!["EPERM", "ENOTSUP", "ENOSYS", "EXDEV"].includes(code ?? ""))
      throw err;
    // No hard links on this filesystem: claim the name by renaming the
    // complete temp file, so the key file is never seen half-written.
    // ponytail: exists-then-rename has a tiny window where two first-run
    // processes could both rename; link() above is the race-free path.
    if (!fs.existsSync(file)) {
      fs.renameSync(tmp, file);
      return hex;
    }
    return readKeyFile(file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Reads the key file, waiting up to ~2s while it exists but is empty — another
 * process may have just created it (exclusive create, no hard links) and not
 * written it yet. Still empty after that is reported by the caller.
 */
function readKeyFile(file: string): string {
  const deadline = Date.now() + 2000;
  for (;;) {
    const hex = fs.readFileSync(file, "utf8").trim();
    if (hex || Date.now() >= deadline) return hex;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return (
    PREFIX +
    [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64")).join(":")
  );
}

// Stored values whose decrypt failure was already logged (as hashes), so a
// secret read on every request logs once rather than flooding the log.
const reported = new Set<string>();

/** Decrypts a stored secret; null (and one log line per value) when the key no longer fits. */
export function decryptSecret(stored: string): string | null {
  if (!stored.startsWith(PREFIX)) return null;
  try {
    const [iv, tag, ct] = stored
      .slice(PREFIX.length)
      .split(":")
      .map((s) => Buffer.from(s, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
      "utf8",
    );
  } catch (err) {
    const id = createHash("sha256").update(stored).digest("hex");
    if (!reported.has(id)) {
      reported.add(id);
      // The key file's own error (empty, invalid) names the file; say that.
      const why = /key file/.test((err as Error).message)
        ? (err as Error).message
        : "was the settings encryption key changed?";
      console.error(`Failed to decrypt a stored secret — ${why}`);
    }
    return null;
  }
}
