/**
 * Generate a strong, human-shareable password.
 *
 * Uses `crypto.getRandomValues` (with a `Math.random` fallback for ancient
 * insecure contexts) and an unambiguous character set — no `0/O`, `1/l/I` — so
 * an admin can read the password aloud or paste it into an onboarding message
 * without confusion. Guarantees at least one lowercase, uppercase, digit and
 * symbol so it satisfies common strength checks and the app's 8-char minimum.
 */
const LOWER = "abcdefghijkmnpqrstuvwxyz"; // no l, o
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O
const DIGITS = "23456789"; // no 0, 1
const SYMBOLS = "!@#$%^&*-_=+";
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

function randomInt(max: number): number {
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    // Rejection-sample to avoid modulo bias.
    const limit = Math.floor(0xffffffff / max) * max;
    const buf = new Uint32Array(1);
    let n = 0;
    do {
      crypto.getRandomValues(buf);
      n = buf[0];
    } while (n >= limit);
    return n % max;
  }
  return Math.floor(Math.random() * max);
}

function pick(chars: string): string {
  return chars[randomInt(chars.length)];
}

export function generatePassword(length = 16): string {
  const len = Math.max(12, length);
  // Seed one of each required class, then fill the rest from the full set.
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < len) {
    chars.push(pick(ALL));
  }
  // Fisher–Yates shuffle so the seeded classes aren't always up front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
