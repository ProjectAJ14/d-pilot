import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

/**
 * The PHI decision and request validation in /query and /export, with the
 * database, store and masking faked so each branch can be set up directly.
 * Unmasking needs the capability for this env *and*, on a masked env, a reason;
 * anything less stays masked (and an unauthorized attempt is audited).
 */

const conn = {
  id: "qa-core",
  name: "Orders",
  env: "QA",
  database: "app_core",
};
let resolved: typeof conn | null = conn;
let validation: { valid: boolean; error?: string } = { valid: true };
const executeQuery = vi.fn();
vi.mock("../services/query-executor.js", () => ({
  validateQuery: () => validation,
  executeQuery,
}));
vi.mock("../middleware/auth.js", () => ({
  resolveReadableConnection: (_req: unknown, res: any) => {
    if (!resolved) res.status(403).json({ error: "no access" });
    return resolved;
  },
}));
let maskedEnvs: string[] = [];
const logAudit = vi.fn();
const getQueryHistory = vi.fn(() => []);
const getAuditLog = vi.fn((): any[] => []);
const queryArchive = vi.fn((): any[] => []);
vi.mock("../services/sqlite-store.js", () => ({
  logAudit,
  getPhiMaskedEnvs: () => maskedEnvs,
  getQueryHistory,
  getAuditLog,
  queryArchive,
}));
vi.mock("../config/settings.js", () => ({ getConfig: () => undefined }));
const fkTargets = new Map<string, unknown>();
vi.mock("../services/schema-introspector.js", () => ({
  fkTargetsForColumns: () => fkTargets,
}));
// Masks the `ssn` column unless phiEnabled is false.
vi.mock("../services/phi-masking.js", () => ({
  maskQueryResults: (
    columns: { name: string }[],
    rows: Record<string, unknown>[],
    opts: { phiEnabled: boolean },
  ) => ({
    maskedColumns: columns,
    maskedRows: opts.phiEnabled
      ? rows.map((r) => ({ ...r, ssn: "***" }))
      : rows,
    maskedFieldNames: ["ssn"],
  }),
}));

const { default: queryRouter } = await import("./query.js");
const { default: exportRouter } = await import("./export.js");

let server: Server;
let base: string;
let user: Record<string, unknown>;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user as any;
    next();
  });
  app.use("/query", queryRouter);
  app.use("/export", exportRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

const READER = {
  sub: "u1",
  email: "u1@example.com",
  isAdmin: false,
  canUnmaskPhi: false,
  unmaskEnvironments: [],
};
const UNMASKER = {
  ...READER,
  canUnmaskPhi: true,
  unmaskEnvironments: ["QA"],
};

beforeEach(() => {
  user = READER;
  resolved = conn;
  validation = { valid: true };
  maskedEnvs = [];
  fkTargets.clear();
  logAudit.mockClear();
  executeQuery.mockReset();
  executeQuery.mockResolvedValue({
    columns: [{ name: "id" }, { name: "ssn" }, { name: "note" }],
    rows: [{ id: 1, ssn: "123-45-6789", note: 'said "hi", then\nleft' }],
    totalRows: 1,
    executionTimeMs: 3,
    truncated: false,
  });
});

const send = (
  url: string,
  body: object,
  headers: Record<string, string> = {},
) =>
  fetch(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const OK_BODY = { connectionId: "qa-core", sql: "select 1" };
const UNMASK = { "x-phi-shield": "off" };
const REASON = { ...UNMASK, "x-phi-unmask-reason": "Ticket 42" };

describe("request validation (execute, csv, json)", () => {
  for (const url of ["/query/execute", "/export/csv", "/export/json"]) {
    it(`${url}: 400 on missing fields or a write, 403 from the read check`, async () => {
      expect((await send(url, { sql: "select 1" })).status).toBe(400);
      expect((await send(url, { connectionId: "qa-core" })).status).toBe(400);
      validation = { valid: false, error: "Only read queries are allowed" };
      const write = await send(url, OK_BODY);
      expect(write.status).toBe(400);
      expect(await write.json()).toEqual({
        error: "Only read queries are allowed",
      });
      validation = { valid: true };
      resolved = null;
      expect((await send(url, OK_BODY)).status).toBe(403);
      expect(executeQuery).not.toHaveBeenCalled();
    });
  }
});

describe("POST /query/execute PHI", () => {
  it("masks by default and labels FK columns", async () => {
    fkTargets.set("id", { table: "customers", column: "id" });
    const res = await send("/query/execute", OK_BODY);
    const body = await res.json();
    expect(body.rows[0].ssn).toBe("***");
    expect(body.columns[0]).toEqual({
      name: "id",
      references: { table: "customers", column: "id" },
    });
    expect(body.columns[1]).toEqual({ name: "ssn" });
    expect(body.masked).toBe(true);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "QUERY_EXECUTE",
        phiAccessed: false,
        phiFieldsUnmasked: [],
        phiUnmaskReason: undefined,
      }),
    );
  });

  it("audits and ignores an unmask the user may not do here", async () => {
    const res = await send("/query/execute", OK_BODY, REASON);
    expect((await res.json()).rows[0].ssn).toBe("***");
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "PHI_UNMASK_DENIED" }),
    );
  });

  it("keeps a masked env masked without a reason", async () => {
    user = UNMASKER;
    maskedEnvs = ["QA"];
    const res = await send("/query/execute", OK_BODY, UNMASK);
    expect((await res.json()).rows[0].ssn).toBe("***");
  });

  it("unmasks with the capability and a reason, and audits what was seen", async () => {
    user = UNMASKER;
    maskedEnvs = ["QA"];
    const res = await send("/query/execute", OK_BODY, REASON);
    expect((await res.json()).rows[0].ssn).toBe("123-45-6789");
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        phiAccessed: true,
        phiFieldsUnmasked: ["ssn"],
        phiUnmaskReason: "Ticket 42",
      }),
    );
  });

  it("falls back to a generic message for an empty driver error", async () => {
    executeQuery.mockRejectedValueOnce(new Error(""));
    const res = await send("/query/execute", OK_BODY);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Query execution failed" });
  });
});

describe("GET /query/history", () => {
  it("defaults to 50 and caps the page at 200", async () => {
    user = READER;
    await fetch(`${base}/query/history`);
    expect(getQueryHistory).toHaveBeenLastCalledWith("u1", 50, 0);
    await fetch(`${base}/query/history?limit=999&offset=20`);
    expect(getQueryHistory).toHaveBeenLastCalledWith("u1", 200, 20);
  });

  it("refuses an export past the row cap rather than truncating", async () => {
    getAuditLog.mockReturnValueOnce(
      Array.from({ length: 10_001 }, (_, i) => ({
        sql: "select 1",
        timestamp: `2026-01-01 00:00:${i}`,
      })),
    );
    const res = await fetch(
      `${base}/query/history/export?from=2026-01-01&to=2026-01-02`,
    );
    expect(res.status).toBe(422);
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe("POST /export PHI and CSV", () => {
  it("masks for a user without unmask rights, and quotes CSV cells", async () => {
    executeQuery.mockResolvedValueOnce({
      columns: [{ name: "id" }, { name: "ssn" }, { name: "note" }],
      rows: [
        { id: 1, ssn: "1", note: 'said "hi", then\nleft' },
        { id: null, ssn: undefined, note: "plain" },
      ],
      totalRows: 2,
      executionTimeMs: 1,
    });
    const res = await send("/export/csv", OK_BODY, REASON);
    expect(await res.text()).toBe(
      'id,ssn,note\n1,***,"said ""hi"", then\nleft"\n,***,plain',
    );
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "EXPORT_CSV", phiAccessed: false }),
    );
  });

  it("keeps a masked env masked without a reason", async () => {
    user = UNMASKER;
    maskedEnvs = ["QA"];
    const res = await send("/export/json", OK_BODY, UNMASK);
    expect((await res.json())[0].ssn).toBe("***");
  });

  it("unmasks with the capability and a reason, recording it", async () => {
    user = UNMASKER;
    maskedEnvs = ["QA"];
    const csv = await send("/export/csv", OK_BODY, REASON);
    expect(await csv.text()).toContain("123-45-6789");
    const json = await send("/export/json", OK_BODY, {
      ...REASON,
      "x-phi-unmask-notes": "follow-up",
    });
    expect((await json.json())[0].ssn).toBe("123-45-6789");
    expect(logAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "EXPORT_JSON",
        phiAccessed: true,
        phiUnmaskReason: "Ticket 42",
        phiUnmaskNotes: "follow-up",
      }),
    );
  });

  it("unmasks on an unmasked env without a reason", async () => {
    user = UNMASKER;
    const res = await send("/export/json", OK_BODY, UNMASK);
    expect((await res.json())[0].ssn).toBe("123-45-6789");
  });
});
