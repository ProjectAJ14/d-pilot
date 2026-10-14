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
    hex = fs.readFileSync(file, "utf8").trim();
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    hex = randomBytes(32).toString("hex");
    // `wx` so two processes racing on first run cannot both win and leave
    // secrets encrypted under a key that was then overwritten.
    try {
      fs.writeFileSync(file, hex, { mode: 0o600, flag: "wx" });
    } catch {
      hex = fs.readFileSync(file, "utf8").trim();
    }
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error(`Invalid encryption key in ${file}`);
  keys.set(file, key);
  return key;
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

/** Decrypts a stored secret; null (and a log line) when the key no longer fits. */
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
  } catch {
    console.error(
      "Failed to decrypt a stored secret — was the settings encryption key changed?",
    );
    return null;
  }
}
