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
 * Its saved grants must stay visible and editable: sending it back keeps it,
 * leaving it out revokes it, and an env never saved before is refused.
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
  it("is kept on a user when sent, revoked when omitted, and stays revoked", async () => {
    store.saveDbConnections([
      conn("dev-core", "DEV"),
      conn("qa-core", "QA"),
      conn("uat-core", "UAT"),
    ]);
    const created = await call("POST", "/users", {
      email: "dev@example.com",
      password: "password123",
      allowedEnvironments: ["DEV", "QA", "UAT"],
      writeEnvironments: ["QA", "UAT"],
    });
    const id = created.body.id;
    expect(created.body.writeEnvironments).toEqual(["QA", "UAT"]);

    store.deleteDbConnection("qa-core");
    store.deleteDbConnection("uat-core");
    // The picker shows saved orphans, so sending one back keeps it...
    const kept = await call("PUT", `/users/${id}`, {
      allowedEnvironments: ["DEV", "QA", "UAT"],
      writeEnvironments: ["QA", "UAT"],
    });
    expect(kept.body.allowedEnvironments).toEqual(["DEV", "QA", "UAT"]);
    // ...and unticking one revokes it, even with no connection.
    const revoked = await call("PUT", `/users/${id}`, {
      writeEnvironments: ["QA"],
    });
    expect(revoked.body.writeEnvironments).toEqual(["QA"]);

    // A brand-new unknown env is not granted.
    const bogus = await call("PUT", `/users/${id}`, {
      allowedEnvironments: ["DEV", "STG"],
    });
    expect(bogus.body.allowedEnvironments).toEqual(["DEV"]);

    // Re-creating UAT does not bring the revoked write back.
    store.saveDbConnection(conn("uat-core", "UAT"));
    const after = await call("GET", "/users");
    const user = after.body.find((u: { id: string }) => u.id === id);
    expect(user.writeEnvironments).not.toContain("UAT");
    store.saveDbConnection(conn("qa-core", "QA"));
  });

  it("can be kept in, or removed from, the masked list", async () => {
    await call("PUT", "/phi/masked-envs", { environments: ["QA", "UAT"] });
    store.deleteDbConnection("qa-core");
    store.deleteDbConnection("uat-core");
    expect(
      (await call("PUT", "/phi/masked-envs", { environments: ["QA", "UAT"] }))
        .status,
    ).toBe(200);
    expect(store.getPhiMaskedEnvs()).toEqual(["QA", "UAT"]);
    expect(
      (await call("PUT", "/phi/masked-envs", { environments: ["QA"] })).status,
    ).toBe(200);
    expect(store.getPhiMaskedEnvs()).toEqual(["QA"]);
    expect(
      (await call("PUT", "/phi/masked-envs", { environments: ["STG"] })).status,
    ).toBe(400);
    store.saveDbConnection(conn("qa-core", "QA"));
    store.saveDbConnection(conn("uat-core", "UAT"));
  });

  it("can be kept in, or removed from, the direct-write list", async () => {
    await call("PUT", "/writes/policy", { directEnvs: ["QA", "UAT"] });
    store.deleteDbConnection("qa-core");
    store.deleteDbConnection("uat-core");
    expect(
      (await call("PUT", "/writes/policy", { directEnvs: ["QA", "UAT"] }))
        .status,
    ).toBe(200);
    expect(store.getWriteDirectEnvs()).toEqual(["QA", "UAT"]);
    await call("PUT", "/writes/policy", { directEnvs: ["UAT"] });
    expect(store.getWriteDirectEnvs()).toEqual(["UAT"]);
    expect(
      (await call("PUT", "/writes/policy", { directEnvs: ["STG"] })).status,
    ).toBe(400);
    store.saveDbConnection(conn("qa-core", "QA"));
    store.saveDbConnection(conn("uat-core", "UAT"));
  });
});
