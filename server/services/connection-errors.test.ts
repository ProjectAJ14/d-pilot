import { describe, it, expect, vi, beforeEach } from "vitest";

const getConfig = vi.fn<(key: string) => string | undefined>();
vi.mock("../config/settings.js", () => ({ getConfig }));

const { connectionFailedMessage, isConnectionError } =
  await import("./connection-errors.js");

const coded = (err: Error, code: string, name?: string) =>
  Object.assign(err, { code }, name ? { name } : {});

// Real shapes, per driver. A connection error is "the network, not your query".
const CONNECT_FAILURES: [string, unknown][] = [
  [
    "pg ECONNREFUSED",
    coded(new Error("connect ECONNREFUSED 127.0.0.1:5999"), "ECONNREFUSED"),
  ],
  [
    "pg ENOTFOUND",
    coded(new Error("getaddrinfo ENOTFOUND db.invalid"), "ENOTFOUND"),
  ],
  ["pg connect timeout", new Error("timeout exceeded when trying to connect")],
  [
    "mssql ConnectionError ESOCKET",
    coded(
      new Error("Failed to connect to db:1433 - connect ECONNREFUSED"),
      "ESOCKET",
      "ConnectionError",
    ),
  ],
  [
    "MongoServerSelectionError",
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:27017"), {
      name: "MongoServerSelectionError",
    }),
  ],
  [
    "ES ConnectionError",
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9200"), {
      name: "ConnectionError",
      meta: { body: null, statusCode: null },
    }),
  ],
  [
    "AggregateError ECONNREFUSED",
    coded(new AggregateError([], ""), "ECONNREFUSED"),
  ],
];

// Not the network: a slow query, a refused login, an ES request timeout.
const NOT_CONNECTION: [string, unknown][] = [
  [
    "mssql request timeout",
    coded(
      new Error("Timeout: Request failed to complete in 90000ms"),
      "ETIMEOUT",
      "RequestError",
    ),
  ],
  [
    "mssql login failure",
    coded(
      new Error("Login failed for user 'app'."),
      "ELOGIN",
      "ConnectionError",
    ),
  ],
  [
    // The transport's requestTimeout: no response, but connect timeouts are
    // ConnectionErrors, so this is the server taking too long — a slow query.
    "ES TimeoutError",
    Object.assign(new Error("Request timed out"), {
      name: "TimeoutError",
      meta: { body: null, statusCode: null },
    }),
  ],
];

describe("isConnectionError", () => {
  it.each(CONNECT_FAILURES)("catches a real connect failure: %s", (_n, err) => {
    expect(isConnectionError(err)).toBe(true);
  });

  it.each(NOT_CONNECTION)("is not a connection failure: %s", (_n, err) => {
    expect(isConnectionError(err)).toBe(false);
  });

  it("catches a refused localhost connect that only carries a code", () => {
    // What pg throws when both ::1 and 127.0.0.1 refuse: no message at all.
    const err = Object.assign(new AggregateError([], ""), {
      code: "ECONNREFUSED",
    });
    expect(isConnectionError(err)).toBe(true);
  });

  it("leaves query errors alone", () => {
    const err = Object.assign(new Error('relation "nope" does not exist'), {
      code: "42P01",
    });
    expect(isConnectionError(err)).toBe(false);
  });
});

describe("connectionFailedMessage", () => {
  beforeEach(() => getConfig.mockReset());

  it("names the database, blames the network, and suggests a generic fix", () => {
    const msg = connectionFailedMessage({ name: "Orders", env: "QA" });
    expect(msg).toContain("D-Pilot is running");
    expect(msg).toContain("the Orders (QA) database");
    expect(msg).toContain("not your query");
    expect(msg).toMatch(/Check your network or VPN connection and retry\.$/);
    expect(getConfig).toHaveBeenCalledWith("NETWORK_HINT");
  });

  it("appends the deployment's hint instead of the generic one", () => {
    getConfig.mockReturnValue("Connect to the VPN and retry.");
    const msg = connectionFailedMessage({ name: "Orders", env: "QA" });
    expect(msg).toMatch(/not your query\. Connect to the VPN and retry\.$/);
    expect(msg).not.toContain("Check your network");
  });

  it("works without a target", () => {
    getConfig.mockReturnValue("   ");
    const msg = connectionFailedMessage();
    expect(msg).toContain("can't reach the database.");
    expect(msg).toMatch(/Check your network or VPN connection and retry\.$/);
  });
});
