import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/** Connections are managed in Settings only — DBFORGE_CONNECTIONS is ignored. */

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-seed-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "seed-test-key");
vi.stubEnv(
  "DBFORGE_CONNECTIONS",
  JSON.stringify([
    { id: "orders-dev", name: "Orders", env: "DEV", type: "postgres" },
  ]),
);

const store = await import("./sqlite-store.js");
const { loadConnections, getEnvironments } =
  await import("../config/connections.js");

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("first run", () => {
  it("starts with no connections even when DBFORGE_CONNECTIONS is set", () => {
    store.initDatabase();
    expect(loadConnections()).toEqual([]);
    expect(getEnvironments()).toEqual([]);
  });
});
