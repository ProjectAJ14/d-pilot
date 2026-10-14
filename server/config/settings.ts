import { z } from "zod";
import {
  deleteSetting,
  getSetting,
  setSetting,
} from "../services/sqlite-store.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import type { AppSettingView, SettingSource } from "../types/index.js";

/**
 * Runtime configuration an admin can edit in-app. Each key is also the env var
 * that seeds it, so precedence is: `app_settings` row > `process.env` > default.
 * A deployment configured purely through `.env` keeps working unchanged — the
 * DB only wins once someone saves a value, and resetting deletes the row.
 *
 * Read through `getConfig*` at use time, never into a module-level const, or a
 * saved value would only apply after a restart.
 *
 * Bootstrap values (PORT, DATA_DIR, BASE_PATH, JWT_SECRET, …) stay env-only:
 * they are needed before the DB exists or are baked into the client build.
 */

type Kind = "string" | "url" | "int" | "number" | "bool" | "json" | "duration";

interface SettingDef {
  group: "ai" | "branding" | "limits";
  kind: Kind;
  default?: string;
  secret?: boolean;
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
  LOGO_URL: { group: "branding", kind: "string" },
  LIGHT_LOGO_URL: { group: "branding", kind: "string" },
  FAVICON_URL: { group: "branding", kind: "string" },
  EMAIL_DOMAIN: { group: "branding", kind: "string" },
  APP_BASE_URL: { group: "branding", kind: "url" },

  MAX_ROWS: { group: "limits", kind: "int", default: "10000" },
  QUERY_TIMEOUT_MS: { group: "limits", kind: "int", default: "90000" },
  MCP_MAX_ROWS: { group: "limits", kind: "int", default: "1000" },
  SCHEMA_CACHE_TTL_HOURS: { group: "limits", kind: "number", default: "24" },
  COPY_FORMATS: { group: "limits", kind: "json" },
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
    const value = def(key).secret ? decryptSecret(stored) : stored;
    if (value !== null) return { value, source: "db" };
  }
  // `||`, not `??`: an empty env var has always meant "unset" here.
  const env = process.env[key] || undefined;
  if (env !== undefined) return { value: env, source: "env" };
  return { value: def(key).default, source: "default" };
}

export function getConfig(key: SettingKey): string | undefined {
  return resolve(key).value;
}

/** Numeric setting; anything unparseable falls back to the built-in default. */
export function getConfigNumber(key: SettingKey): number {
  const n = Number(getConfig(key));
  return Number.isFinite(n) ? n : Number(def(key).default);
}

export function getConfigBool(key: SettingKey): boolean {
  return /^(1|true|yes|on)$/i.test(getConfig(key) ?? "");
}

/** Every setting for the admin UI. Secrets report only whether they are set. */
export function listSettings(): AppSettingView[] {
  return (Object.keys(SETTINGS) as SettingKey[]).map((key) => {
    const { value, source } = resolve(key);
    const d = def(key);
    return {
      key,
      group: d.group,
      secret: !!d.secret,
      source,
      ...(d.secret ? { set: !!value } : { value: value ?? null }),
    };
  });
}

// ms-style durations, as jsonwebtoken's `expiresIn` accepts them ("24h", "7 days").
const DURATION =
  /^\d+(\.\d+)?\s*(ms|msecs?|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|y|yrs?|years?)?$/i;

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
  json: z.string().refine((v) => {
    try {
      return Array.isArray(JSON.parse(v));
    } catch {
      return false;
    }
  }, "must be a JSON array"),
  duration: z.string().regex(DURATION, 'must be a duration like "24h"'),
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
    writes.push([key, value]);
  }
  // A stored key the admin cannot read must not be sendable to a URL they pick,
  // or over TLS they switched off — moving the key's target means typing it again.
  const movesKey = writes.some(
    ([k, v]) => AI_KEY_TARGET.includes(k) && v !== (getConfig(k) ?? ""),
  );
  if (
    movesKey &&
    getConfig("AZURE_OPENAI_KEY") &&
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
 * Drop the stored value so the env var (or default) applies again. Resetting
 * the key resets its target too: otherwise an admin could save their own
 * endpoint with a throwaway key, reset the key, and receive the `.env` one.
 * Returns the keys actually removed.
 */
export function resetSetting(key: SettingKey): SettingKey[] {
  const keys: SettingKey[] =
    key === "AZURE_OPENAI_KEY" ? [key, ...AI_KEY_TARGET] : [key];
  return keys.filter((k) => deleteSetting(k));
}
