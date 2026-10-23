import { getConfig } from "../config/settings.js";

// Shared classifier for "the database host is unreachable / connection failed"
// errors across the four drivers (pg, mssql, mongodb, elasticsearch). Used to
// tell connectivity problems (DNS failure, refused or timed-out connects, a
// connection lost mid-flight) from query/schema errors. Deliberately NOT here:
// - mssql's request timeout ("Timeout: Request failed to complete in Nms",
//   RequestError ETIMEOUT): the server is reachable, the query is slow.
// - mssql ELOGIN: a refused login, which "check your VPN" would not fix.
// - Elasticsearch's TimeoutError: the transport turns a failed or timed-out
//   connect into a ConnectionError, so a TimeoutError means a request was in
//   flight on an open connection and the server was slow. Its `meta` never
//   carries a response either way, so it cannot tell us more.
export const CONNECTION_ERROR_PATTERN =
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|getaddrinfo|socket hang up|Failed to connect|Connection (?:lost|closed|timeout)|timeout exceeded when trying to connect|Server selection timed out/i;

const CONNECTION_ERROR_NAMES = new Set([
  "MongoServerSelectionError", // mongodb driver
  "ConnectionError", // mssql (raised while connecting) and elasticsearch
]);

type ErrShape = { name?: string; message?: string; code?: unknown } | null;

export function isConnectionError(err: unknown): boolean {
  const e = err as ErrShape;
  // mssql reports a refused login as a ConnectionError too.
  if (e?.code === "ELOGIN") return false;
  if (e?.name && CONNECTION_ERROR_NAMES.has(e.name)) return true;
  // The code too: when "localhost" resolves to both ::1 and 127.0.0.1 and both
  // refuse, Node throws an AggregateError with an empty message and only
  // `code: "ECONNREFUSED"` to go on.
  return CONNECTION_ERROR_PATTERN.test(
    `${e?.message ?? e ?? ""} ${typeof e?.code === "string" ? e.code : ""}`,
  );
}

// Failures that prove no statement reached the database: the host could not
// be resolved or reached, or the connect itself timed out.
const PRE_CONNECT_PATTERN =
  /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|getaddrinfo|timeout exceeded when trying to connect/i;

/**
 * Tags an error thrown by a step that sends no statement (connect, pool
 * acquire, begin, ping). Only the write executor's connect call sites use it.
 */
export function markPreConnect(err: unknown): unknown {
  if (err && typeof err === "object")
    (err as { preConnect?: boolean }).preConnect = true;
  return err;
}

/**
 * True only when nothing reached the database, so a write that failed this way
 * can safely run again. Fails closed: the error must come from a connect step
 * (markPreConnect) AND look like a network failure there. Anything else — a
 * timeout or reset after connecting, a driver's own retry, a server response
 * whose text mentions ECONNREFUSED — has an unknown outcome and is not.
 */
export function isPreConnectError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as NonNullable<ErrShape> & { preConnect?: unknown };
  if (e.preConnect !== true || e.code === "ELOGIN") return false;
  if (
    e.name === "MongoServerSelectionError" ||
    e.name === "NoLivingConnectionsError" // elasticsearch: nothing to send to
  )
    return true;
  // mssql raises ConnectionError only while acquiring a connection (a failure
  // mid-request is a RequestError); Elasticsearch's has no code.
  if (e.name === "ConnectionError" && typeof e.code === "string") return true;
  return PRE_CONNECT_PATTERN.test(
    `${e.message ?? ""} ${typeof e.code === "string" ? e.code : ""}`,
  );
}

/**
 * What users and MCP agents see when a target database can't be reached. It
 * says D-Pilot itself is fine, so nobody rewrites a correct query, and appends
 * the deployment's NETWORK_HINT (e.g. "Connect to the VPN and retry.").
 */
export function connectionFailedMessage(target?: {
  name: string;
  env: string;
}): string {
  const db = target ? `the ${target.name} (${target.env})` : "the";
  const hint =
    getConfig("NETWORK_HINT")?.trim() ||
    "Check your network or VPN connection and retry.";
  return `D-Pilot is running, but it can't reach ${db} database. This is a network problem between D-Pilot and the database, not your query. ${hint}`;
}
