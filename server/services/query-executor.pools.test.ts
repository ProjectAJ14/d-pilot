import { describe, it, expect, vi, afterEach } from "vitest";
import type { ConnectionConfig } from "../types/index.js";

/**
 * Retiring every pool when QUERY_TIMEOUT_MS changes must not wait on, or break,
 * queries that are still running on the old pools.
 */

const mongoClose = vi.fn(async () => {});
vi.mock("mongodb", async (orig) => ({
  ...(await orig<typeof import("mongodb")>()),
  MongoClient: class {
    async connect() {}
    close = mongoClose;
  },
}));

const { closeAllConnections, getPgPool, getMongoClient, getPoolStatus } =
  await import("./query-executor.js");

const pgConn: ConnectionConfig = {
  id: "pg-1",
  name: "pg",
  env: "DEV",
  type: "postgres",
  host: "127.0.0.1",
  database: "app_core",
};
const mongoConn: ConnectionConfig = {
  id: "mongo-1",
  name: "mongo",
  env: "DEV",
  type: "mongodb",
  host: "127.0.0.1",
  database: "orders",
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("closeAllConnections", () => {
  it("evicts pools at once, without waiting for in-flight queries to end", async () => {
    const old = await getPgPool(pgConn);
    // A pool whose end() is waiting on a long-running query.
    old.end = () => new Promise<void>(() => {});

    const settled = Promise.resolve(closeAllConnections()).then(() => "done");
    expect(getPoolStatus(pgConn.id).live).toBe(false);
    expect(await getPgPool(pgConn)).not.toBe(old);
    expect(
      await Promise.race([
        settled,
        new Promise((r) => setTimeout(() => r("hung"), 200)),
      ]),
    ).toBe("done");
  });

  it("logs a failed close instead of throwing", async () => {
    const pool = await getPgPool(pgConn);
    vi.spyOn(pool, "end").mockRejectedValue(new Error("already ended"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      Promise.resolve(closeAllConnections()),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
  });

  it("closes Mongo clients only after the old query timeout has passed", async () => {
    await getMongoClient(mongoConn);
    vi.useFakeTimers();
    closeAllConnections(5000);
    expect(getPoolStatus(mongoConn.id).live).toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(mongoClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2500);
    expect(mongoClose).toHaveBeenCalledOnce();
  });
});
