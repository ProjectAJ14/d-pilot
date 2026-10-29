import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { randomUUID } from "crypto";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

/**
 * Audit-log and query-history CSV export, plus the paging that replaced the
 * 500-row client-side list. Real routers against a real (temp) SQLite store,
 * so the date bounds, the archive read and the audit trail are what ships.
 */

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-audit-export-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");

const store = await import("../services/sqlite-store.js");
const { default: auditRouter } = await import("./audit.js");
const { default: queryRouter } = await import("./query.js");

store.initDatabase();

function insert(rows: Record<string, unknown>[]) {
  const stmt = store.getDb().prepare(
    `INSERT INTO audit_log (id, user_id, user_email, action, sql, phi_accessed, timestamp)
       VALUES (@id, @user_id, @user_email, @action, @sql, @phi_accessed, @timestamp)`,
  );
  store.getDb().transaction(() => {
    for (const r of rows)
      stmt.run({
        id: randomUUID(),
        user_id: "u1",
        user_email: "u1@example.com",
        action: "QUERY_EXECUTE",
        sql: "SELECT 1",
        phi_accessed: 0,
        ...r,
      });
  })();
}

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

// Old rows first, so archiving moves them into audit_archive.sqlite.
insert([
  { sql: "SELECT archived", timestamp: `${daysAgo(60)} 12:00:00` },
  { user_id: "u2", sql: "SELECT other", timestamp: `${daysAgo(60)} 12:00:00` },
]);
store.archiveOldAuditEntries(30);
insert([
  { sql: "SELECT in_range", timestamp: "2026-01-05 09:00:00" },
  { sql: "=cmd()", timestamp: "2026-01-14 23:59:59" },
  { sql: "SELECT after", timestamp: "2026-01-15 00:00:00" },
  { sql: "SELECT before", timestamp: "2025-12-31 23:59:59" },
  {
    user_id: "u2",
    sql: "SELECT not_mine",
    phi_accessed: 1,
    timestamp: "2026-01-06 00:00:00",
  },
  { action: "PHI_UNMASK", sql: null, timestamp: "2026-01-07 00:00:00" },
  { action: "QUERY_ERROR", sql: "SELEC", timestamp: "2026-01-08 00:00:00" },
]);

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.user = {
      sub: "u1",
      email: "u1@example.com",
      isAdmin: req.headers["x-test-admin"] === "1",
    } as any;
    next();
  });
  app.use("/audit", auditRouter);
  app.use("/query", queryRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const get = (url: string, admin = true) =>
  fetch(`${base}${url}`, { headers: admin ? { "x-test-admin": "1" } : {} });

const lastAudit = () => store.getAuditLog({ limit: 1 })[0];

describe("GET /audit/export", () => {
  it("returns every entry in the inclusive UTC range as CSV, and audits it", async () => {
    const res = await get("/audit/export?from=2026-01-01&to=2026-01-14");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain(
      "audit-log-live-2026-01-01-to-2026-01-14.csv",
    );
    const csv = await res.text();
    expect(csv.split("\n")[0]).toMatch(/^timestamp,userEmail,action,/);
    expect(csv).toContain("SELECT in_range");
    expect(csv).toContain("SELECT not_mine");
    expect(csv).toContain("'=cmd()");
    expect(csv).not.toContain("SELECT after");
    expect(csv).not.toContain("SELECT before");
    expect(csv.split("\n")).toHaveLength(1 + 5);

    expect(lastAudit()).toMatchObject({
      action: "AUDIT_EXPORT",
      userId: "u1",
      rowsReturned: 5,
    });
  });

  it("applies the action and PHI filters", async () => {
    const errors = await (
      await get(
        "/audit/export?from=2026-01-01&to=2026-01-14&action=QUERY_ERROR",
      )
    ).text();
    expect(errors.split("\n")).toHaveLength(2);
    expect(errors).toContain("SELEC");

    const phi = await (
      await get("/audit/export?from=2026-01-01&to=2026-01-14&phi=1")
    ).text();
    expect(phi).toContain("SELECT not_mine");
    expect(phi).toContain("PHI_UNMASK");
    expect(phi.split("\n")).toHaveLength(3);
    expect(lastAudit().sql).toContain("PHI only");
  });

  it("reads the archive when asked", async () => {
    const res = await get(
      `/audit/export?from=${daysAgo(61)}&to=${daysAgo(59)}&source=archive`,
    );
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain("SELECT archived");
    expect(csv).toContain("SELECT other");
  });

  it.each([
    ["no range", ""],
    ["15 days", "?from=2026-01-01&to=2026-01-15"],
    ["a reversed range", "?from=2026-01-14&to=2026-01-01"],
  ])("400s for %s", async (_, qs) => {
    const before = lastAudit().id;
    const res = await get(`/audit/export${qs}`);
    expect(res.status).toBe(400);
    expect(lastAudit().id).toBe(before);
  });

  it("is admin only", async () => {
    const res = await get("/audit/export?from=2026-01-01&to=2026-01-14", false);
    expect(res.status).toBe(403);
  });

  it("422s instead of truncating past 10,000 rows", async () => {
    insert(
      Array.from({ length: 10_001 }, () => ({
        action: "BULK_TEST",
        timestamp: "2026-03-01 00:00:00",
      })),
    );
    const over = await get(
      "/audit/export?from=2026-03-01&to=2026-03-01&action=BULK_TEST",
    );
    expect(over.status).toBe(422);
    expect((await over.json()).error).toMatch(/More than 10,000/);

    store
      .getDb()
      .prepare(
        `DELETE FROM audit_log WHERE id IN (
         SELECT id FROM audit_log WHERE action = 'BULK_TEST' LIMIT 1)`,
      )
      .run();
    const exact = await get(
      "/audit/export?from=2026-03-01&to=2026-03-01&action=BULK_TEST",
    );
    expect(exact.status).toBe(200);
    expect((await exact.text()).split("\n")).toHaveLength(1 + 10_000);
  });
});

describe("GET /audit (paging)", () => {
  it("filters PHI access server-side, so a page is not thinned client-side", async () => {
    const rows = await (await get("/audit?phi=1&from=2026-01-01")).json();
    expect(rows.map((r: any) => r.sql ?? r.action).sort()).toEqual([
      "PHI_UNMASK",
      "SELECT not_mine",
    ]);
  });

  it("pages with limit/offset", async () => {
    const q = "/audit?from=2026-01-01&to=2026-01-14T23:59:59&limit=2";
    const first = await (await get(q)).json();
    const second = await (await get(`${q}&offset=2`)).json();
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(first.map((r: any) => r.id)).not.toContain(second[0].id);
  });
});

describe("ordering within one second", () => {
  // Timestamps have one-second resolution; without a tiebreak a burst of
  // queries came back shuffled, and OFFSET paging could repeat or skip rows.
  it("is newest-first by insertion, so pages neither overlap nor skip", async () => {
    insert(
      Array.from({ length: 6 }, (_, i) => ({
        user_id: "u3",
        sql: `SELECT burst_${i}`,
        timestamp: "2026-02-01 12:00:00",
      })),
    );
    const expected = [5, 4, 3, 2, 1, 0].map((i) => `SELECT burst_${i}`);
    const pages = await Promise.all(
      [0, 2, 4].map(async (offset) =>
        (
          await (await get(`/audit?userId=u3&limit=2&offset=${offset}`)).json()
        ).map((r: any) => r.sql),
      ),
    );
    expect(pages.flat()).toEqual(expected);

    const csv = await (
      await get("/audit/export?from=2026-02-01&to=2026-02-01&userId=u3")
    ).text();
    expect(
      csv
        .split("\n")
        .slice(1)
        .map((l) => l.match(/SELECT burst_\d/)?.[0]),
    ).toEqual(expected);
  });
});

describe("query history", () => {
  it("pages with offset", async () => {
    const all = await (await get("/query/history?limit=200", false)).json();
    const page = await (
      await get("/query/history?limit=1&offset=1", false)
    ).json();
    expect(page[0].id).toBe(all[1].id);
  });

  it("exports only the caller's own queries, live and archived, and audits it", async () => {
    const res = await get(
      `/query/history/export?from=2025-12-31&to=2026-01-13`,
      false,
    );
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv.split("\n")[0]).toBe(
      "timestamp,connectionId,sql,rowsReturned,executionMs",
    );
    expect(csv).toContain("SELECT in_range");
    expect(csv).toContain("SELECT before");
    expect(csv).not.toContain("SELECT not_mine");
    expect(csv).not.toContain("SELEC,"); // QUERY_ERROR is not history
    expect(csv).not.toContain("u1@example.com"); // no identity columns

    const archived = await (
      await get(
        `/query/history/export?from=${daysAgo(61)}&to=${daysAgo(59)}`,
        false,
      )
    ).text();
    expect(archived).toContain("SELECT archived");
    expect(archived).not.toContain("SELECT other");

    expect(lastAudit()).toMatchObject({
      action: "HISTORY_EXPORT",
      userId: "u1",
      rowsReturned: 1,
    });
  });

  it("400s past 14 days", async () => {
    const res = await get(
      "/query/history/export?from=2026-01-01&to=2026-01-20",
      false,
    );
    expect(res.status).toBe(400);
  });
});
