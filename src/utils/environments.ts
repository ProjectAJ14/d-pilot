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

const ENV_COLORS: Record<string, string> = {
  PROD: "red",
  STG: "orange",
  UAT: "teal",
  QA: "violet",
  DEV: "green",
};

const ENV_LABELS: Record<string, string> = {
  PROD: "Production",
  STG: "Staging",
  QA: "QA / Testing",
  DEV: "Development",
};

/** Badge color for an environment; custom envs get a distinct fallback. */
export const envColor = (env: string): string => ENV_COLORS[env] ?? "pink";

/** Human label for an environment; custom envs show their own name. */
export const envLabel = (env: string): string => ENV_LABELS[env] ?? env;

/**
 * This deployment's environments in display order — most sensitive first, which
 * is how every picker and the connection tree list them.
 */
export function useEnvironments(): string[] {
  const envs = useStore((s) => s.config.environments);
  return [...envs].reverse();
}
