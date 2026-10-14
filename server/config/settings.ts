import { z } from "zod";
import {
  deleteSetting,
  getSetting,
  setSetting,
} from "../services/sqlite-store.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import type { AppSettingView, SettingSource } from "../types/index.js";

/**
 * Runtime configuration an admin can edit in-app. Branding and limits keys are
 * also env vars that act as fallbacks, so precedence is: `app_settings` row >
 * `process.env` > default; resetting deletes the row. AI settings (`group: "ai"`)
 * skip the env step — they are configured in Settings only.
 *
 * Read through `getConfig*` at use time, never into a module-level const, or a
 * saved value would only apply after a restart.
 *
 * Bootstrap values (PORT, DATA_DIR, BASE_PATH, JWT_SECRET, …) stay env-only:
 * they are needed before the DB exists or are baked into the client build.
 */

type Kind = "string" | "url" | "int" | "number" | "bool" | "duration";

interface SettingDef {
  group: "ai" | "branding" | "limits";
  kind: Kind;
  default?: string;
  secret?: boolean;
  /**
   * Built-in upper bound for int/number settings. The operator can lower it
   * with `<KEY>_LIMIT` in .env (see `settingMax`), never raise it.
   */
  max?: number;
  /** Longest string the Settings form may save (the kind's own cap otherwise). */
  maxLength?: number;
}

export const SETTINGS = {
  AZURE_OPENAI_ENDPOINT: { group: "ai", kind: "url" },
  AZURE_OPENAI_KEY: { group: "ai", kind: "string", secret: true },
  AZURE_OPENAI_DEPLOYMENT: { group: "ai", kind: "string" },
  AZURE_OPENAI_MODEL: { group: "ai", kind: "string" },
  AZURE_OPENAI_API_VERSION: {
    group: "ai",
    kind: "string",
    default: "2024-08-01-preview",
  },
  AZURE_OPENAI_INSECURE_TLS: { group: "ai", kind: "bool", default: "false" },

  APP_NAME: { group: "branding", kind: "string", default: "D-Pilot" },
  // The two lines under the app name on the login page. A saved "" hides the
  // line; an empty env var counts as unset, like every other key.
  LOGIN_TAGLINE: {
    group: "branding",
    kind: "string",
    default: "Internal query tool",
    maxLength: 80,
  },
  LOGIN_SUBTITLE: {
    group: "branding",
    kind: "string",
    default: "HIPAA · PHI tokenized",
    maxLength: 80,
  },
  LOGO_URL: { group: "branding", kind: "string" },
  LIGHT_LOGO_URL: { group: "branding", kind: "string" },
  // The icon index.html ships with.
  FAVICON_URL: {
    group: "branding",
    kind: "string",
    default: "/favicon-32.png",
  },
  EMAIL_DOMAIN: { group: "branding", kind: "string" },
  APP_BASE_URL: { group: "branding", kind: "url" },

  MAX_ROWS: { group: "limits", kind: "int", default: "10000", max: 1_000_000 },
  // Node's timer maximum and pg's statement_timeout (INT_MAX) ceiling.
  QUERY_TIMEOUT_MS: {
    group: "limits",
    kind: "int",
    default: "90000",
    max: 2_147_483_647,
  },
  MCP_MAX_ROWS: {
    group: "limits",
    kind: "int",
    default: "1000",
    max: 1_000_000,
  },
  SCHEMA_CACHE_TTL_HOURS: {
    group: "limits",
    kind: "number",
    default: "24",
    max: 8760, // a year
  },
  JWT_EXPIRES_IN: { group: "limits", kind: "duration", default: "24h" },
} satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;

const def = (key: SettingKey): SettingDef => SETTINGS[key];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

function resolve(key: SettingKey): {
  value: string | undefined;
  source: SettingSource;
} {
  const stored = getSetting(key);
  if (stored !== null) {
    // An undecryptable secret stays unset rather than falling back to env: the
    // .env key would otherwise go to whatever target was saved alongside it.
    const value = def(key).secret ? decryptSecret(stored) : stored;
    return { value: value ?? undefined, source: "db" };
  }
  // AI settings are Settings-only, like connections: the key and the target it
  // is sent to never come from .env. `||`, not `??`: an empty env var is unset.
  const env =
    def(key).group === "ai" ? undefined : process.env[key] || undefined;
  if (env !== undefined) return { value: env, source: "env" };
  return { value: def(key).default, source: "default" };
}

export function getConfig(key: SettingKey): string | undefined {
  return resolve(key).value;
}

const warned = new Set<string>();

/**
 * Effective ceiling for a numeric setting: the operator's `<KEY>_LIMIT` env var
 * when it is a valid value at or below the built-in cap, else the built-in cap.
 * Read at use time, like every setting.
 */
export function settingMax(key: SettingKey): number | undefined {
  const cap = def(key).max;
  const raw = process.env[`${key}_LIMIT`]?.trim();
  if (cap === undefined || !raw) return cap;
  const n = Number(raw);
  const ok = VALIDATORS[def(key).kind].safeParse(raw).success && n > 0;
  if (ok && n <= cap) return n;
  if (!warned.has(`${key}=${raw}`)) {
    warned.add(`${key}=${raw}`);
    console.warn(
      `Ignoring ${key}_LIMIT=${raw}: must be a number > 0 and ≤ ${cap}; using ${cap}.`,
    );
  }
  return cap;
}

/**
 * Numeric setting, capped at the operator ceiling (`settingMax`). Anything the
 * Settings form would reject — unparseable, non-positive for an int, above the
 * built-in max — falls back to the built-in default, so a stray env "0" can't
 * truncate results to zero rows. A valid value above a lowered ceiling (saved
 * before the operator lowered it) is clamped, not discarded.
 */
export function getConfigNumber(key: SettingKey): number {
  const raw = getConfig(key)?.trim() ?? "";
  const cap = def(key).max;
  const ok =
    VALIDATORS[def(key).kind].safeParse(raw).success &&
    (cap === undefined || Number(raw) <= cap);
  const n = Number(ok ? raw : def(key).default);
  return Math.min(n, settingMax(key) ?? Infinity);
}

const parseBool = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? "");

export function getConfigBool(key: SettingKey): boolean {
  return parseBool(getConfig(key));
}

/**
 * Every setting for the admin UI. Secrets report only whether they are set —
 * stored, not decryptable today, matching the guard in updateSettings and
 * connections' storedConnectionSecrets.
 */
export function listSettings(): AppSettingView[] {
  return (Object.keys(SETTINGS) as SettingKey[]).map((key) => {
    const { value, source } = resolve(key);
    const d = def(key);
    return {
      key,
      group: d.group,
      secret: !!d.secret,
      source,
      ...(d.secret
        ? { set: getSetting(key) !== null || !!value }
        : { value: value ?? null }),
      // Limits report what is enforced: clamped to the ceiling, a bad env value
      // replaced by the default.
      ...(d.max !== undefined && {
        value: String(getConfigNumber(key)),
        max: settingMax(key),
      }),
    };
  });
}

// ms-style durations, as jsonwebtoken's `expiresIn` accepts them ("24h", "7 days").
// The unit is required: jsonwebtoken reads a bare "3600" as milliseconds, which
// would expire every token on issue. Zero is rejected for the same reason.
const DURATION =
  /^\d+(\.\d+)?\s*(ms|msecs?|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|y|yrs?|years?)$/i;
const isDuration = (v: string) => DURATION.test(v) && parseFloat(v) > 0;

/**
 * Token lifetime for signing. A value stored or set in env before the
 * validator tightened falls back to the default rather than locking out.
 */
export function jwtExpiresIn(): string {
  const v = getConfig("JWT_EXPIRES_IN") ?? "";
  return isDuration(v) ? v : SETTINGS.JWT_EXPIRES_IN.default;
}

const VALIDATORS: Record<Kind, z.ZodType<string>> = {
  string: z.string().max(2000),
  url: z.union([z.literal(""), z.url().max(2000)]),
  int: z
    .string()
    .regex(/^\d+$/, "must be a whole number")
    .refine((v) => Number(v) > 0, "must be greater than 0"),
  number: z
    .string()
    .refine((v) => v.trim() !== "" && Number(v) >= 0, "must be a number ≥ 0"),
  bool: z.string().regex(/^(true|false)$/, "must be true or false"),
  duration: z.string().refine(isDuration, 'must be a duration like "24h"'),
};

/**
 * Validates and stores a batch of values. Returns the keys actually written;
 * an empty value for a secret means "keep what is there" and is skipped.
 * Throws with a readable message on the first invalid value, before writing.
 */
export function updateSettings(
  values: Record<string, string | number | boolean>,
): SettingKey[] {
  const writes: [SettingKey, string][] = [];
  for (const [key, raw] of Object.entries(values)) {
    if (!isSettingKey(key)) throw new Error(`Unknown setting: ${key}`);
    const value = String(raw).trim();
    if (def(key).secret && value === "") continue;
    const parsed = VALIDATORS[def(key).kind].safeParse(value);
    if (!parsed.success) {
      throw new Error(`${key} ${parsed.error.issues[0]?.message ?? "invalid"}`);
    }
    const maxLength = def(key).maxLength;
    if (maxLength !== undefined && value.length > maxLength) {
      throw new Error(`${key} must be at most ${maxLength} characters`);
    }
    const max = settingMax(key);
    if (max !== undefined && Number(value) > max) {
      throw new Error(
        max < def(key).max!
          ? `${key} must be ≤ ${max} (set by the server operator)`
          : `${key} must be at most ${max}`,
      );
    }
    writes.push([key, value]);
  }
  // A stored key the admin cannot read must not be sendable to a URL they pick,
  // or over TLS they switched off — moving the key's target means typing it again.
  // Bools compare by meaning, so "true" is no change from a stored "1".
  const same = (k: SettingKey, v: string) =>
    def(k).kind === "bool"
      ? parseBool(v) === getConfigBool(k)
      : v === (getConfig(k) ?? "");
  const movesKey = writes.some(
    ([k, v]) => AI_KEY_TARGET.includes(k) && !same(k, v),
  );
  if (
    movesKey &&
    // Stored, not just decryptable: a key that fails today revives if the
    // key file is restored, so it guards its target all the same.
    getSetting("AZURE_OPENAI_KEY") !== null &&
    !writes.some(([k]) => k === "AZURE_OPENAI_KEY")
  ) {
    throw new Error(
      "AZURE_OPENAI_KEY must be re-entered when the endpoint or TLS setting changes",
    );
  }
  for (const [key, value] of writes) {
    setSetting(key, def(key).secret ? encryptSecret(value) : value);
  }
  return writes.map(([key]) => key);
}

/** Settings that decide where AZURE_OPENAI_KEY is sent. */
const AI_KEY_TARGET: SettingKey[] = [
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_INSECURE_TLS",
];

/**
 * Drop the stored value so the env var (or default) applies again. Returns
 * the keys actually removed.
 */
export function resetSetting(key: SettingKey): SettingKey[] {
  return deleteSetting(key) ? [key] : [];
}
