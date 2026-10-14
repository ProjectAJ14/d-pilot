import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

/**
 * The environment list comes from the connections, so an env whose only
 * connection is deleted (or not yet re-created) vanishes from every picker.
 * Saving a user, the masked list or the write policy while that is so must not
 * strip the env from what was already saved — the admin never saw it to untick.
 */

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-env-lists-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");

const store = await import("../services/sqlite-store.js");
const { initAuthTables } = await import("../middleware/auth.js");
const { default: users } = await import("./users.js");
const { default: phi } = await import("./phi-config.js");
const { default: writes } = await import("./write-requests.js");

store.initDatabase();
initAuthTables();
const conn = (id: string, env: string) => ({
  id,
  name: id,
  env,
  type: "postgres" as const,
  host: "localhost",
  database: "app_core",
});

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { sub: "admin", email: "a@example.com", isAdmin: true } as any;
    next();
  });
  app.use("/users", users);
  app.use("/phi", phi);
  app.use("/writes", writes);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

describe("an env with no connection right now", () => {
  it("survives saving a user who already had it", async () => {
    store.saveDbConnections([conn("dev-core", "DEV"), conn("qa-core", "QA")]);
    const created = await call("POST", "/users", {
      email: "dev@example.com",
      password: "password123",
      allowedEnvironments: ["DEV", "QA"],
      writeEnvironments: ["QA"],
    });
    expect(created.body.allowedEnvironments).toEqual(["DEV", "QA"]);

    store.deleteDbConnection("qa-core");
    // What the picker sends: only the envs it can show.
    const updated = await call("PUT", `/users/${created.body.id}`, {
      allowedEnvironments: ["DEV"],
      writeEnvironments: [],
    });
    expect(updated.body.allowedEnvironments).toEqual(["DEV", "QA"]);
    expect(updated.body.writeEnvironments).toEqual(["QA"]);

    // An unknown env the user did not already have is still dropped.
    const bogus = await call("PUT", `/users/${created.body.id}`, {
      allowedEnvironments: ["DEV", "UAT"],
    });
    expect(bogus.body.allowedEnvironments).toEqual(["DEV", "QA"]);
    store.saveDbConnection(conn("qa-core", "QA"));
  });

  it("stays masked when the masked list is saved", async () => {
    expect(
      (await call("PUT", "/phi/masked-envs", { environments: ["QA"] })).status,
    ).toBe(200);
    store.deleteDbConnection("qa-core");
    const saved = await call("PUT", "/phi/masked-envs", { environments: [] });
    expect(saved.status).toBe(200);
    expect(store.getPhiMaskedEnvs()).toContain("QA");
    // Still validated: an env that is neither known nor held is refused.
    expect(
      (await call("PUT", "/phi/masked-envs", { environments: ["UAT"] })).status,
    ).toBe(400);
    store.saveDbConnection(conn("qa-core", "QA"));
  });

  it("stays direct-write when the write policy is saved", async () => {
    await call("PUT", "/writes/policy", { directEnvs: ["QA"] });
    store.deleteDbConnection("qa-core");
    const saved = await call("PUT", "/writes/policy", { directEnvs: [] });
    expect(saved.status).toBe(200);
    expect(store.getWriteDirectEnvs()).toEqual(["QA"]);
    expect(
      (await call("PUT", "/writes/policy", { directEnvs: ["UAT"] })).status,
    ).toBe(400);
    store.saveDbConnection(conn("qa-core", "QA"));
  });
});
