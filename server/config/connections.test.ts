import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `loadConnections()` memoizes, so each case re-imports the module with its own
 * DBFORGE_CONNECTIONS.
 */
async function envsFor(connections: unknown): Promise<string[]> {
  vi.resetModules();
  process.env.DBFORGE_CONNECTIONS =
    connections === undefined ? "" : JSON.stringify(connections);
  if (connections === undefined) delete process.env.DBFORGE_CONNECTIONS;
  const { getEnvironments } = await import("./connections.js");
  return getEnvironments();
}

const conn = (id: string, env: string) => ({
  id,
  env,
  name: id,
  type: "postgres",
});

describe("getEnvironments", () => {
  beforeEach(() => {
    delete process.env.DBFORGE_CONNECTIONS;
  });

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

  it("falls back to the standard five when no connections are configured", async () => {
    expect(await envsFor(undefined)).toEqual([
      "DEV",
      "QA",
      "UAT",
      "STG",
      "PROD",
    ]);
  });
});
