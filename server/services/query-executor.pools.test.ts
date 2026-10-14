import { describe, it, expect, vi, afterEach } from "vitest";
import type { ConnectionConfig } from "../types/index.js";

/**
 * Retiring every pool when QUERY_TIMEOUT_MS changes must not wait on, or break,
 * queries that are still running on the old pools.
 */

const mongoClose = vi.fn(async () => {});
const mongoConnect = vi.fn(async () => {});
vi.mock("mongodb", async (orig) => ({
  ...(await orig<typeof import("mongodb")>()),
  MongoClient: class {
    connect = mongoConnect;
    close = mongoClose;
  },
}));

const esOptions: Record<string, unknown>[] = [];
vi.mock("@elastic/elasticsearch", () => ({
  Client: class {
    constructor(opts: Record<string, unknown>) {
      esOptions.push(opts);
    }
    async ping() {}
    async close() {}
  },
}));

const {
  holdConnection,
  disconnectPool,
  testConnection,
  testConnectionConfig,
  closeAllConnections,
  closeConnectionPool,
  getPgPool,
  getMongoClient,
  getPoolStatus,
} = await import("./query-executor.js");

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

describe("closeConnectionPool", () => {
  it("returns at once, without waiting for in-flight pg queries to end", () => {
    return getPgPool(pgConn).then((old) => {
      old.end = () => new Promise<void>(() => {});
      expect(closeConnectionPool(pgConn.id)).toBe(true);
      expect(getPoolStatus(pgConn.id).live).toBe(false);
    });
  });

  it("closes a Mongo client only after the grace period, and logs a failed close", async () => {
    await getMongoClient(mongoConn);
    vi.useFakeTimers();
    mongoClose.mockClear();
    mongoClose.mockRejectedValueOnce(new Error("boom"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => closeConnectionPool(mongoConn.id, 5000)).not.toThrow();
    expect(getPoolStatus(mongoConn.id).live).toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(mongoClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2500);
    expect(mongoClose).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalled();
  });

  it("does not cache a client whose connect finished after the pool was evicted", async () => {
    let finish!: () => void;
    mongoConnect.mockImplementationOnce(
      () => new Promise<void>((r) => (finish = r)),
    );
    mongoClose.mockClear();
    const pending = getMongoClient({ ...mongoConn, id: "mongo-race" });
    closeConnectionPool("mongo-race", 0);
    vi.useFakeTimers();
    finish();
    await pending;
    // The client to the old target is not handed to the next caller...
    expect(getPoolStatus("mongo-race").live).toBe(false);
    // ...and is closed once the caller that asked for it is done.
    expect(mongoClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(mongoClose).toHaveBeenCalledOnce();
  });
});

describe("testConnectionConfig", () => {
  it("does not retry an Elasticsearch ping, so a dead host fails fast", async () => {
    await testConnectionConfig({
      id: "es-1",
      name: "es",
      env: "DEV",
      type: "elasticsearch",
      host: "127.0.0.1",
    });
    expect(esOptions.at(-1)).toMatchObject({ maxRetries: 0 });
  });

  it("leaves pooled Elasticsearch clients on the driver's retry default", async () => {
    await testConnection({
      id: "es-2",
      name: "es",
      env: "DEV",
      type: "elasticsearch",
      host: "127.0.0.1",
    });
    expect("maxRetries" in esOptions.at(-1)!).toBe(false);
  });
});

describe("a retired client with a governed write running", () => {
  it("closes only once the write has finished", async () => {
    await getMongoClient({ ...mongoConn, id: "mongo-busy" });
    vi.useFakeTimers();
    mongoClose.mockClear();
    let finish!: () => void;
    const write = holdConnection(
      "mongo-busy",
      () => new Promise<void>((r) => (finish = r)),
    );
    closeConnectionPool("mongo-busy", 0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mongoClose).not.toHaveBeenCalled();
    finish();
    await write;
    await vi.advanceTimersByTimeAsync(0);
    expect(mongoClose).toHaveBeenCalledOnce();
  });

  it("closes anyway after the hard cap, and says so", async () => {
    await getMongoClient({ ...mongoConn, id: "mongo-stuck" });
    vi.useFakeTimers();
    mongoClose.mockClear();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    void holdConnection("mongo-stuck", () => new Promise<void>(() => {}));
    closeConnectionPool("mongo-stuck", 0);
    await vi.advanceTimersByTimeAsync(5 * 3_600_000);
    expect(mongoClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_600_000 + 2000);
    expect(mongoClose).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalled();
  });
});

describe("disconnectPool", () => {
  it("closes at once — an admin stopping sessions does not wait out a grace period", async () => {
    await getMongoClient({ ...mongoConn, id: "mongo-kick" });
    mongoClose.mockClear();
    expect(await disconnectPool("mongo-kick")).toBe(true);
    expect(mongoClose).toHaveBeenCalledOnce();
    expect(getPoolStatus("mongo-kick").live).toBe(false);
    expect(await disconnectPool("mongo-kick")).toBe(false);
  });

  it("logs a close that fails instead of rejecting", async () => {
    await getMongoClient({ ...mongoConn, id: "mongo-kick-2" });
    mongoClose.mockRejectedValueOnce(new Error("socket gone"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(disconnectPool("mongo-kick-2")).resolves.toBe(true);
    expect(log).toHaveBeenCalled();
  });
});
