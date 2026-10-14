/**
 * A boolean setting's value as the server reads it (`getConfigBool`): an env
 * var may say `1`/`yes`/`on`, not just `true`, and the checkbox must agree.
 */
export const settingBool = (v: string | null | undefined): boolean =>
  /^(1|true|yes|on)$/i.test(v ?? "");
