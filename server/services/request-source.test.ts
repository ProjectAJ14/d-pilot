import { describe, it, expect, vi, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-request-source-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");

const store = await import("./sqlite-store.js");
const { requestSource } = await import("./request-source.js");
store.initDatabase();

/**
 * The real shape of the problem: logAudit runs deep inside an async route,
 * after awaits, with no `req` in reach. The source has to survive that.
 */
const app = express();
app.use(express.json());
app.use("/api", requestSource);
app.post("/api/run", async (req, res) => {
  await new Promise((r) => setTimeout(r, 5));
  store.logAudit({
    userId: "u1",
    userEmail: "u1@example.com",
    action: "QUERY_EXECUTE",
    sql: req.body.sql,
    phiAccessed: false,
  });
  res.json({ ok: true });
});
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const run = (sql: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ sql }),
  });

const sourceOf = (sql: string) =>
  store.getAuditLog({ limit: 50 }).find((e) => e.sql === sql)?.source;

describe("audit source", () => {
  it("records an MCP request as mcp, across awaits", async () => {
    await run("SELECT 'agent'", { "X-DPilot-Source": "mcp" });
    expect(sourceOf("SELECT 'agent'")).toBe("mcp");
  });

  it("records anything else as ui", async () => {
    await run("SELECT 'person'");
    await run("SELECT 'odd header'", { "X-DPilot-Source": "robot" });
    expect(sourceOf("SELECT 'person'")).toBe("ui");
    expect(sourceOf("SELECT 'odd header'")).toBe("ui");
  });

  it("leaves it empty outside a request", () => {
    store.logAudit({
      userId: "u1",
      userEmail: "u1@example.com",
      action: "QUERY_EXECUTE",
      sql: "SELECT 'background'",
      phiAccessed: false,
    });
    expect(sourceOf("SELECT 'background'")).toBeUndefined();
  });
});
