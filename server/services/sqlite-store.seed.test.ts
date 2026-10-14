import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/** The one-time DBFORGE_CONNECTIONS import must not fire on an empty env. */

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-seed-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "seed-test-key");
vi.stubEnv("DBFORGE_CONNECTIONS", "");

const store = await import("./sqlite-store.js");
const { loadConnections } = await import("../config/connections.js");

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const orders = {
  id: "orders-dev",
  name: "Orders",
  env: "DEV",
  type: "postgres",
  database: "orders",
};

describe("seedConnections", () => {
  it("still imports DBFORGE_CONNECTIONS when it was unset on first run", () => {
    store.initDatabase();
    expect(loadConnections()).toEqual([]);
    expect(store.getSetting("connections_seeded")).toBeNull();

    vi.stubEnv("DBFORGE_CONNECTIONS", JSON.stringify([orders]));
    store.initDatabase();
    expect(loadConnections().map((c) => c.id)).toEqual(["orders-dev"]);
    expect(store.getSetting("connections_seeded")).not.toBeNull();
  });

  it("leaves an admin-built table alone once it has connections", () => {
    store.deleteSetting("connections_seeded");
    vi.stubEnv(
      "DBFORGE_CONNECTIONS",
      JSON.stringify([{ ...orders, id: "customers-dev", name: "Customers" }]),
    );
    store.initDatabase();
    expect(loadConnections().map((c) => c.id)).toEqual(["orders-dev"]);
    expect(store.getSetting("connections_seeded")).not.toBeNull();
  });
});
