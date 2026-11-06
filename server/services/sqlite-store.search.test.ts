import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-store-search-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "search-test-key");

const store = await import("./sqlite-store.js");
store.initDatabase();

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const audit = (userEmail: string, action: string, sql?: string, c?: string) =>
  store.logAudit({
    userId: userEmail,
    userEmail,
    action,
    sql,
    connectionId: c,
    phiAccessed: false,
  });

const emails = (q?: string, extra = {}) =>
  store
    .getAuditLog({ q, ...extra })
    .map((e) => e.userEmail)
    .sort();

describe("audit search", () => {
  audit("alice@example.com", "QUERY_EXECUTE", "SELECT 1", "app_core-dev");
  audit("bob@example.com", "LOGIN");
  audit("carol@example.com", "QUERY_EXECUTE", "SELECT 100% FROM t_x");
  audit("dave@example.com", "QUERY_EXECUTE", "SELECT 100 FROM tax");
  audit("erin@example.com", "QUERY_EXECUTE", "path C:\\temp");

  it("matches each column, case-insensitively", () => {
    expect(emails("ALICE")).toEqual(["alice@example.com"]);
    expect(emails("login")).toEqual(["bob@example.com"]);
    expect(emails("from t_x")).toEqual(["carol@example.com"]);
    expect(emails("APP_CORE")).toEqual(["alice@example.com"]);
  });

  it("trims, ignores empty, and caps at 200 chars", () => {
    expect(emails("  bob  ")).toEqual(["bob@example.com"]);
    expect(emails("   ")).toHaveLength(5);
    expect(emails("")).toHaveLength(5);
    expect(emails(`bob${"x".repeat(300)}`)).toEqual([]);
    expect(emails(`bob@example.com${"x".repeat(300)}`)).toEqual([]);
    audit("long@example.com", "LOGIN", "y".repeat(200) + "zzz");
    expect(emails("y".repeat(200) + "zzz")).toEqual(["long@example.com"]);
  });

  it("treats %, _ and \\ literally", () => {
    expect(emails("100%")).toEqual(["carol@example.com"]);
    expect(emails("t_x")).toEqual(["carol@example.com"]);
    expect(emails("%")).toEqual(["carol@example.com"]);
    // "_" is a literal: LOGIN has none, QUERY_EXECUTE rows do.
    expect(emails("_")).not.toContain("bob@example.com");
    expect(emails("_")).toHaveLength(4);
    expect(emails("t_")).toEqual(["carol@example.com"]);
    expect(emails("C:\\temp")).toEqual(["erin@example.com"]);
  });

  it("binds quotes as data, never as SQL", () => {
    expect(emails("' OR '1'='1")).toEqual([]);
    expect(emails("'; DROP TABLE audit_log; --")).toEqual([]);
    expect(emails("")).toHaveLength(store.getAuditLog({ limit: 1000 }).length);
  });

  it("combines with other filters", () => {
    expect(emails("select", { action: "LOGIN" })).toEqual([]);
    expect(emails("select", { userId: "dave@example.com" })).toEqual([
      "dave@example.com",
    ]);
  });
});

describe("AI chat log search", () => {
  const chat = (o: Record<string, unknown>) =>
    store.logAiChat({
      userId: "u",
      userEmail: "u@example.com",
      prompt: "p",
      status: "success",
      ...o,
    } as any);
  chat({ userEmail: "zed@example.com" });
  chat({ prompt: "Top Customers by revenue" });
  chat({ generatedQuery: "SELECT * FROM widgets" });
  chat({ status: "error", errorMessage: "Timeout exceeded" });
  chat({ model: "gpt-special" });
  chat({ prompt: "50% off", status: "error" });
  chat({ prompt: "500 off" });

  const prompts = (q?: string, extra = {}) =>
    store.getAiChatLog({ q, ...extra });

  it("matches each column, case-insensitively", () => {
    expect(prompts("ZED")).toHaveLength(1);
    expect(prompts("top customers")).toHaveLength(1);
    expect(prompts("widgets")).toHaveLength(1);
    expect(prompts("timeout")).toHaveLength(1);
    expect(prompts("GPT-SPECIAL")).toHaveLength(1);
  });

  it("ignores empty, treats % literally, and pages with limit/offset", () => {
    expect(prompts("  ")).toHaveLength(7);
    expect(prompts("50%").map((e) => e.prompt)).toEqual(["50% off"]);
    expect(prompts("example.com", { limit: 3 })).toHaveLength(3);
    expect(prompts("example.com", { limit: 3, offset: 5 })).toHaveLength(2);
    expect(prompts("off", { status: "error" })).toHaveLength(1);
  });
});
