import { useStore } from "../store";

/**
 * Environment presentation + the deployment's environment list.
 *
 * The set of environments is NOT hardcoded here: it comes from the server
 * (`/api/config` → `environments`, derived from `DBFORGE_CONNECTIONS`), so a
 * deployment can add its own (e.g. `SUPER_PROD`) without a frontend change.
 * Only the colors/labels of the well-known ones live here, with a fallback for
 * anything else.
 */

/**
 * Mantine palette names, and each of these five is overridden in `main.tsx`
 * with a ramp tuned to the two grounds — so an env badge follows the theme
 * rather than sitting on it in stock Mantine colours.
 *
 * `teal` is deliberately not in this list any more: verdigris is the brand and
 * the PHI-tokenization hue, so an env wearing it would read as "masked".
 */
const ENV_COLORS: Record<string, string> = {
  PROD: "red",
  STG: "orange",
  UAT: "blue",
  QA: "violet",
  DEV: "green",
};

const ENV_LABELS: Record<string, string> = {
  PROD: "Production",
  STG: "Staging",
  QA: "QA / Testing",
  DEV: "Development",
};

/** Badge color for an environment. A deployment can define its own env name,
 *  and there is no sixth hue that is not already spoken for, so anything
 *  unrecognised gets the neutral ramp rather than a colour that would claim a
 *  meaning it does not have. */
export const envColor = (env: string): string => ENV_COLORS[env] ?? "neutral";

/** Human label for an environment; custom envs show their own name. */
export const envLabel = (env: string): string => ENV_LABELS[env] ?? env;

/**
 * Whether an environment counts as production for the PHI safety rail. Any name
 * containing "prod" qualifies — `PROD`, `SUPER_PROD`, `PREPROD` — and its PHI
 * stays tokenized; the server enforces the same rule (`isProductionEnv` in
 * `server/config/connections.ts`), this only mirrors it in the UI.
 */
export const isProductionEnv = (env: string): boolean => /prod/i.test(env);

/**
 * This deployment's environments in display order — most sensitive first, which
 * is how every picker and the connection tree list them.
 */
export function useEnvironments(): string[] {
  const envs = useStore((s) => s.config.environments);
  return [...envs].reverse();
}
