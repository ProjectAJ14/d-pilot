import { describe, it, expect } from "vitest";
import {
  credentialWarnings,
  toIdempotent,
  validateObjectChange,
} from "./object-change.js";
import type { DbObjectInfo } from "../types/index.js";

const proc: DbObjectInfo = {
  schema: "app_core",
  name: "refresh_order_totals",
  kind: "procedure",
};

describe("toIdempotent", () => {
  it("turns SQL Server CREATE into CREATE OR ALTER, past a header comment", () => {
    const def =
      "-- CREATE PROCEDURE old_name (kept for history)\n/* author */\nCREATE   PROC app_core.refresh_order_totals AS SELECT 1";
    expect(toIdempotent(def, "mssql")).toBe(
      "-- CREATE PROCEDURE old_name (kept for history)\n/* author */\nCREATE OR ALTER PROC app_core.refresh_order_totals AS SELECT 1",
    );
  });

  it("leaves an already idempotent definition alone and rewrites a Postgres trigger", () => {
    const fn =
      "CREATE OR REPLACE FUNCTION app_core.f() RETURNS int LANGUAGE sql AS $$SELECT 1$$";
    expect(toIdempotent(fn, "postgres")).toBe(fn);
    expect(
      toIdempotent(
        "CREATE TRIGGER orders_audit BEFORE UPDATE ON app_core.orders FOR EACH ROW EXECUTE FUNCTION app_core.f();",
        "postgres",
      ),
    ).toBe(
      "CREATE OR REPLACE TRIGGER orders_audit BEFORE UPDATE ON app_core.orders FOR EACH ROW EXECUTE FUNCTION app_core.f();",
    );
  });

  it("has no idempotent form for a materialized view", () => {
    expect(
      toIdempotent(
        "CREATE MATERIALIZED VIEW app_core.mv AS SELECT 1",
        "postgres",
      ),
    ).toBeNull();
  });
});

describe("validateObjectChange", () => {
  const ok = (sql: string, obj = proc, db: "mssql" | "postgres" = "mssql") =>
    validateObjectChange(sql, db, obj, db === "mssql" ? "dbo" : "public");

  it("accepts the same object, qualified, bracketed or in the default schema", () => {
    expect(
      ok(
        "CREATE OR ALTER PROCEDURE app_core.refresh_order_totals AS\nBEGIN\n  UPDATE app_core.orders SET status = 'x' WHERE id = 1;\n  SELECT 1;\nEND",
      ),
    ).toBeNull();
    expect(
      ok("CREATE OR ALTER PROC [app_core].[Refresh_Order_Totals] AS SELECT 1"),
    ).toBeNull();
    expect(
      ok("CREATE OR ALTER PROCEDURE refresh_order_totals AS SELECT 1", {
        ...proc,
        schema: "dbo",
      }),
    ).toBeNull();
  });

  it.each([
    [
      "CREATE PROCEDURE app_core.refresh_order_totals AS SELECT 1",
      "CREATE OR ALTER",
    ],
    [
      "CREATE OR ALTER PROCEDURE app_core.other_proc AS SELECT 1",
      "not app_core.other_proc",
    ],
    [
      "CREATE OR ALTER PROCEDURE refresh_order_totals AS SELECT 1",
      "not dbo.refresh_order_totals",
    ],
    [
      "CREATE OR ALTER VIEW app_core.refresh_order_totals AS SELECT 1",
      "creates a view",
    ],
    [
      "DROP TABLE app_core.orders;\nCREATE OR ALTER PROCEDURE app_core.refresh_order_totals AS SELECT 1",
      "must start with",
    ],
    [
      "CREATE OR ALTER PROCEDURE app_core.refresh_order_totals AS SELECT 1\nGO\nDROP TABLE app_core.orders",
      "GO separators",
    ],
  ])("refuses %s", (sql, why) => {
    expect(ok(sql)).toContain(why);
  });

  it("allows one Postgres statement, $$ body and all, and refuses a second", () => {
    const fn: DbObjectInfo = {
      schema: "app_core",
      name: "f",
      kind: "function",
      args: "",
    };
    const body =
      "CREATE OR REPLACE FUNCTION app_core.f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN UPDATE app_core.orders SET status = 'x' WHERE id = 1; RETURN 1; END $$;";
    expect(ok(body, fn, "postgres")).toBeNull();
    expect(
      ok(`${body}\nDROP TABLE app_core.orders;`, fn, "postgres"),
    ).toContain("one statement");
  });
});

describe("credentialWarnings", () => {
  it.each([
    "EXEC sp_send @password = 'hunter22'",
    "SET @conn = 'Server=db;User Id=app;Pwd=S3cret!'",
    "SELECT dblink('postgres://app:hunter22@db/app', 'SELECT 1')",
    "api_key: abcd1234",
  ])("flags %s", (sql) => {
    expect(credentialWarnings(sql)).toHaveLength(1);
  });

  it("does not flag ordinary code", () => {
    expect(
      credentialWarnings(
        "UPDATE app_core.customers SET password_hash = @hash WHERE id = @id",
      ),
    ).toEqual([]);
  });
});
