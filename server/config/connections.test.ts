import { describe, it, expect, vi } from "vitest";
import {
  getEnvironments,
  getProductionEnvs,
  invalidateConnections,
  isProductionEnv,
} from "./connections.js";

/** Connections come from the app database only; stand in for its table. */
let table: unknown[] | null = null;
vi.mock("../services/sqlite-store.js", () => ({
  listDbConnections: () => table,
}));

function use(connections: unknown[] | null) {
  table = connections;
  invalidateConnections();
}

async function prodEnvsFor(connections: unknown[]): Promise<string[]> {
  use(connections);
  return getProductionEnvs();
}

async function envsFor(connections: unknown[] | null): Promise<string[]> {
  use(connections);
  return getEnvironments();
}

const conn = (id: string, env: string) => ({
  id,
  env,
  name: id,
  type: "postgres",
});

describe("getEnvironments", () => {
  it("returns the known envs least → most sensitive, deduped", async () => {
    expect(
      await envsFor([
        conn("a", "PROD"),
        conn("b", "DEV"),
        conn("c", "PROD"),
        conn("d", "QA"),
      ]),
    ).toEqual(["DEV", "QA", "PROD"]);
  });

  it("sorts a custom env after PROD so it reads as most sensitive", async () => {
    expect(
      await envsFor([
        conn("a", "SUPER_PROD"),
        conn("b", "PROD"),
        conn("c", "DEV"),
      ]),
    ).toEqual(["DEV", "PROD", "SUPER_PROD"]);
  });

  it("is empty when no connections are configured", async () => {
    expect(await envsFor([])).toEqual([]);
    expect(await envsFor(null)).toEqual([]);
  });

  it("ignores DBFORGE_CONNECTIONS", async () => {
    vi.stubEnv("DBFORGE_CONNECTIONS", JSON.stringify([conn("a", "QA")]));
    expect(await envsFor(null)).toEqual([]);
    vi.unstubAllEnvs();
  });
});

describe("isProductionEnv", () => {
  it("matches any environment whose name contains prod", () => {
    for (const env of ["PROD", "SUPER_PROD", "PREPROD", "PRODUCTION", "prod"]) {
      expect(isProductionEnv(env)).toBe(true);
    }
  });

  it("does not match non-production environments", () => {
    for (const env of ["DEV", "QA", "UAT", "STG"]) {
      expect(isProductionEnv(env)).toBe(false);
    }
  });
});

describe("getProductionEnvs", () => {
  it("returns every production-like env the deployment has", async () => {
    expect(
      await prodEnvsFor([
        conn("a", "DEV"),
        conn("b", "PROD"),
        conn("c", "SUPER_PROD"),
        conn("d", "QA"),
      ]),
    ).toEqual(["PROD", "SUPER_PROD"]);
  });
});
