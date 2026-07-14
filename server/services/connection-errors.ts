// Shared classifier for "the database host is unreachable / connection failed"
// errors across the four drivers (pg, mssql, mongodb, elasticsearch). Used to
// distinguish connectivity problems (DNS failure, refused/timed-out connects,
// auth-level connect failures) from query/schema errors.
export const CONNECTION_ERROR_PATTERN =
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|getaddrinfo|ELOGIN|socket hang up|Failed to connect|Connection (?:lost|closed|timeout)|timeout: |timeout exceeded when trying to connect|Server selection timed out/i;

const CONNECTION_ERROR_NAMES = new Set([
  "MongoServerSelectionError", // mongodb driver
  "ConnectionError", // mssql
  "TimeoutError", // elasticsearch client
]);

export function isConnectionError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  if (e?.name && CONNECTION_ERROR_NAMES.has(e.name)) return true;
  return CONNECTION_ERROR_PATTERN.test(String(e?.message ?? e ?? ""));
}
