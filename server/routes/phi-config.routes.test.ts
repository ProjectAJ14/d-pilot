import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

/**
 * /phi-config against a real (temporary) app store: the production masking
 * rail, environment-scoped unmask, and the CSV round trip — import is
 * all-or-nothing, re-imports never duplicate, and every bulk action is audited.
 */

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-phi-config-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");

const store = await import("../services/sqlite-store.js");
const { default: phi } = await import("./phi-config.js");

store.initDatabase();
for (const [id, env] of [
  ["dev-core", "DEV"],
  ["qa-core", "QA"],
  ["prod-core", "PROD"],
])
  store.saveDbConnection({
    id,
    name: id,
    env,
    type: "postgres",
    host: "localhost",
    database: "app_core",
  });

type Who = Record<string, unknown>;
let who: Who = {};
const admin: Who = { sub: "admin", email: "admin@example.com", isAdmin: true };
const dev: Who = {
  sub: "dev",
  email: "dev@example.com",
  isAdmin: false,
  unmaskEnvironments: ["DEV"],
  canUnmaskPhi: false,
};

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use((req, _res, next) => {
    req.user = who as never;
    next();
  });
  app.use("/phi", phi);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/phi`;
});

afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  who = admin;
  store.deleteAllPhiRules(true);
});

const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(base + url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
};
const importCsv = (csv: unknown) => call("POST", "/import", { csv });
const lastAudit = (action: string) =>
  store.getAuditLog({ action, limit: 1 })[0];

describe("masked environments", () => {
  it("lists them, with production always included", async () => {
    const r = await call("GET", "/masked-envs");
    expect(r.body.environments).toContain("PROD");
  });

  it("refuses an invalid list", async () => {
    const r = await call("PUT", "/masked-envs", { environments: ["NOPE"] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid environments list. Allowed: /);
  });

  it("refuses to unmask production", async () => {
    const r = await call("PUT", "/masked-envs", { environments: ["QA"] });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/PROD must remain masked/);
  });

  it("saves a list that keeps production masked", async () => {
    const r = await call("PUT", "/masked-envs", {
      environments: ["QA", "PROD"],
    });
    expect(r.body).toEqual({ environments: ["QA", "PROD"] });
    expect((await call("GET", "/masked-envs")).body.environments).toEqual(
      expect.arrayContaining(["QA", "PROD"]),
    );
  });

  it("is admin only to change", async () => {
    who = dev;
    expect(
      (await call("PUT", "/masked-envs", { environments: ["PROD"] })).status,
    ).toBe(403);
  });
});

describe("POST /unmask", () => {
  it("allows a user with unmask on the connection's env, and audits it", async () => {
    who = dev;
    const r = await call("POST", "/unmask", {
      reason: "Support ticket",
      notes: "case 12",
      connectionId: "dev-core",
    });
    expect(r.body).toEqual({ logged: true });
    expect(lastAudit("PHI_UNMASK")).toMatchObject({
      userId: "dev",
      connectionId: "dev-core",
      phiAccessed: true,
      phiUnmaskReason: "Support ticket",
      phiUnmaskNotes: "case 12",
    });
  });

  it("refuses an env the user cannot unmask", async () => {
    who = dev;
    const r = await call("POST", "/unmask", {
      reason: "x",
      connectionId: "qa-core",
    });
    expect(r.status).toBe(403);
  });

  it("lets an admin unmask anywhere", async () => {
    const r = await call("POST", "/unmask", {
      reason: "x",
      connectionId: "prod-core",
    });
    expect(r.status).toBe(200);
  });

  it("falls back to canUnmaskPhi without a connection", async () => {
    who = dev;
    expect((await call("POST", "/unmask", { reason: "x" })).status).toBe(403);
    who = { ...dev, canUnmaskPhi: true };
    expect((await call("POST", "/unmask", { reason: "x" })).status).toBe(200);
    const entry = lastAudit("PHI_UNMASK");
    expect(entry.connectionId).toBeFalsy();
    expect(entry.phiUnmaskNotes).toBeFalsy();
  });

  it("requires a reason", async () => {
    const r = await call("POST", "/unmask", { connectionId: "dev-core" });
    expect(r).toMatchObject({
      status: 400,
      body: { error: "Reason is required" },
    });
  });
});

describe("rule CRUD", () => {
  it("creates, updates, lists and deletes a rule", async () => {
    let r = await call("POST", "/", { pattern: "ssn", maskingType: "FULL" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ pattern: "ssn", alwaysMasked: false });
    const id = r.body.id;
    r = await call("PUT", `/${id}`, {
      pattern: "ssn",
      maskingType: "HASH",
      alwaysMasked: true,
      database: "app_core",
      table: "customers",
    });
    expect(r.body).toMatchObject({
      id,
      maskingType: "HASH",
      alwaysMasked: true,
    });
    r = await call("GET", "/");
    expect(r.body).toEqual([
      expect.objectContaining({ id, table: "customers" }),
    ]);
    expect((await call("DELETE", `/${id}`)).body).toEqual({ deleted: true });
    expect((await call("DELETE", `/${id}`)).status).toBe(404);
  });

  it("requires pattern and maskingType", async () => {
    expect((await call("POST", "/", { pattern: "ssn" })).status).toBe(400);
    expect((await call("POST", "/", { maskingType: "FULL" })).status).toBe(400);
  });

  it("is admin only", async () => {
    who = dev;
    expect(
      (await call("POST", "/", { pattern: "x", maskingType: "FULL" })).status,
    ).toBe(403);
    expect((await call("DELETE", "/")).status).toBe(403);
  });
});

describe("DELETE / (all)", () => {
  const seed = () => {
    store.upsertPhiRule({
      pattern: "a",
      maskingType: "FULL",
      alwaysMasked: true,
    });
    store.upsertPhiRule({
      pattern: "b",
      maskingType: "FULL",
      alwaysMasked: false,
    });
  };

  it("keeps locked rules by default", async () => {
    seed();
    expect((await call("DELETE", "/")).body).toEqual({ deleted: 1, kept: 1 });
    expect(lastAudit("PHI_RULES_DELETE_ALL").sql).toBe(
      "Deleted 1 PHI rule(s), kept 1 locked",
    );
  });

  it("removes locked rules when asked", async () => {
    seed();
    expect((await call("DELETE", "/?includeLocked=true")).body).toEqual({
      deleted: 2,
      kept: 0,
    });
    expect(lastAudit("PHI_RULES_DELETE_ALL").sql).toBe(
      "Deleted 2 PHI rule(s) including locked",
    );
  });
});

describe("CSV export", () => {
  it("neutralizes formulas, quotes specials and is audited", async () => {
    store.upsertPhiRule({
      pattern: "=cmd",
      maskingType: "REDACT",
      alwaysMasked: true,
      database: "app_core",
      table: 'say "hi", there',
    });
    store.upsertPhiRule({
      pattern: "email",
      maskingType: "PARTIAL",
      alwaysMasked: false,
    });
    const r = await call("GET", "/export");
    expect(r.headers.get("content-type")).toMatch(/text\/csv/);
    expect(r.headers.get("content-disposition")).toBe(
      "attachment; filename=phi-rules.csv",
    );
    expect(r.body).toBe(
      [
        "pattern,maskingType,alwaysMasked,database,table",
        `'=cmd,REDACT,true,app_core,"say ""hi"", there"`,
        "email,PARTIAL,false,,",
      ].join("\n"),
    );
    expect(lastAudit("PHI_RULES_EXPORT")).toMatchObject({
      sql: "Exported 2 PHI rule(s) as CSV",
      rowsReturned: 2,
    });
  });

  it("round-trips through import unchanged", async () => {
    store.upsertPhiRule({
      pattern: "=cmd",
      maskingType: "REDACT",
      alwaysMasked: true,
      table: "multi\nline",
    });
    const csv = (await call("GET", "/export")).body;
    expect((await importCsv(csv)).body).toEqual({
      imported: 0,
      updated: 0,
      skipped: 1,
      total: 1,
    });
  });
});

describe("CSV import", () => {
  it("requires content", async () => {
    for (const csv of [undefined, 5, "   "])
      expect((await importCsv(csv)).body.error).toBe(
        "csv (file content) is required",
      );
  });

  it("refuses a file with only blank lines", async () => {
    const r = await importCsv(" ,  \n,\n");
    expect(r).toMatchObject({
      status: 400,
      body: { error: "CSV file is empty" },
    });
  });

  it("needs pattern and maskingType headers", async () => {
    const r = await importCsv("pattern,table\nssn,x");
    expect(r.body.error).toMatch(/at least "pattern" and "maskingType"/);
  });

  it("needs a data row", async () => {
    expect((await importCsv("pattern,maskingType\n")).body.error).toBe(
      "CSV has no data rows below the header",
    );
  });

  it("caps the rows per import", async () => {
    const csv =
      "pattern,maskingType\n" +
      Array.from({ length: 1001 }, (_, i) => `p${i},FULL`).join("\n");
    expect((await importCsv(csv)).body.error).toBe(
      "CSV has 1001 rows — the limit per import is 1000",
    );
  });

  it("rejects the whole file on any invalid row, listing at most five", async () => {
    store.upsertPhiRule({
      pattern: "keep",
      maskingType: "FULL",
      alwaysMasked: false,
    });
    const csv = [
      "pattern,maskingType,alwaysMasked",
      "good,FULL,true",
      ",FULL,false",
      "x,BOGUS,false",
      "y,FULL,maybe",
      ",NOPE,",
      "z,",
    ].join("\n");
    const r = await importCsv(csv);
    expect(r.status).toBe(400);
    expect(r.body.errors).toEqual([
      "line 3: pattern is required",
      'line 4: invalid maskingType "BOGUS" (allowed: FULL, PARTIAL, HASH, REDACT)',
      'line 5: invalid alwaysMasked "maybe" (use true/false)',
      "line 6: pattern is required",
      'line 6: invalid maskingType "NOPE" (allowed: FULL, PARTIAL, HASH, REDACT)',
      'line 7: invalid maskingType "" (allowed: FULL, PARTIAL, HASH, REDACT)',
    ]);
    expect(r.body.error).toMatch(
      /^Import rejected, nothing was applied: .* \(and 1 more\)$/,
    );
    expect(store.getPhiRules().map((x) => x.pattern)).toEqual(["keep"]);
  });

  it("reports errors without an overflow note when five or fewer", async () => {
    const r = await importCsv("pattern,maskingType\n,FULL");
    expect(r.body.error).toBe(
      "Import rejected, nothing was applied: line 2: pattern is required",
    );
  });

  it("inserts, updates and skips, then audits and returns the counts", async () => {
    store.upsertPhiRule({
      pattern: "SSN",
      maskingType: "FULL",
      alwaysMasked: false,
      database: "app_core",
      table: "customers",
    });
    store.upsertPhiRule({
      pattern: "email",
      maskingType: "PARTIAL",
      alwaysMasked: false,
    });
    const csv =
      "﻿Table,PATTERN,extra,MaskingType,Database,AlwaysMasked\r\n" +
      "Customers,ssn,ignored,hash,APP_CORE,yes\r\n" + // update (case-insensitive key)
      ",email,,partial,,n\r\n" + // identical → skip
      ',"=quoted ""x""",,full,,1\r\n' + // insert, literal quotes
      "orders,'@phone,,REDACT,,\r\n" + // insert, neutralized formula, empty → false
      "orders,'@phone,,FULL,,true\r\n" + // duplicate in file → skip
      ",,,,,\r\n" + // blank row dropped
      ',mid"quote,,FULL,,0'; // mid-field quote is literal, no trailing newline
    const r = await importCsv(csv);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ imported: 3, updated: 1, skipped: 2, total: 6 });
    const rules = store.getPhiRules();
    expect(rules.find((x) => x.pattern === "ssn")).toMatchObject({
      maskingType: "HASH",
      alwaysMasked: true,
      database: "APP_CORE",
      table: "Customers",
    });
    expect(rules.find((x) => x.pattern === "@phone")).toMatchObject({
      maskingType: "REDACT",
      alwaysMasked: false,
      table: "orders",
    });
    expect(rules.map((x) => x.pattern)).toEqual(
      expect.arrayContaining(['=quoted "x"', 'mid"quote']),
    );
    expect(lastAudit("PHI_RULES_IMPORT")).toMatchObject({
      sql: "Imported 3, updated 1, skipped 2 identical PHI rule(s) from CSV",
      rowsReturned: 4,
    });
  });

  it("is admin only", async () => {
    who = dev;
    expect((await importCsv("pattern,maskingType\nx,FULL")).status).toBe(403);
  });
});
