/**
 * The row limit a query sends, from the toolbar's Limit checkbox.
 *
 * `null` means "the user turned the limit off" and the server caps at
 * MAX_ROWS. It must be `null`, never `undefined`: `JSON.stringify` drops an
 * undefined field, and a request with no `defaultLimit` gets the server's
 * built-in 500 — the checkbox would silently do nothing.
 */
export function queryLimit(s: {
  defaultLimitEnabled: boolean;
  defaultLimitValue: number;
}): number | null {
  return s.defaultLimitEnabled ? s.defaultLimitValue : null;
}
