import { describe, expect, it } from "vitest";
import { scanSql } from "./sql-scan.js";

describe("scanSql", () => {
  it("counts a single statement", () => {
    expect(scanSql("UPDATE t SET a = 1 WHERE id = 2").statementCount).toBe(1);
    // trailing terminator does not add an empty statement
    expect(scanSql("UPDATE t SET a = 1;").statementCount).toBe(1);
  });

  it("counts multiple top-level statements", () => {
    const sql = "ALTER TABLE t ADD COLUMN c int; CREATE INDEX i ON t(c);";
    expect(scanSql(sql).statementCount).toBe(2);
  });

  it("ignores semicolons inside a dollar-quoted body (V019-style)", () => {
    const sql = [
      "UPDATE ai.ai_prompt_version SET active = FALSE WHERE active = TRUE;",
      "INSERT INTO ai.ai_prompt_version (system_prompt) VALUES (",
      "$sys$Return JSON; do this; and that; with ' quotes and ; semicolons$sys$",
      ");",
    ].join("\n");
    // Two real statements, not one-per-inner-semicolon.
    expect(scanSql(sql).statementCount).toBe(2);
  });

  it("blanks dollar-quoted bodies so keyword scans can't see inside them", () => {
    const { masked } = scanSql(
      "INSERT INTO t VALUES ($$ DROP DATABASE evil $$);",
    );
    expect(masked).not.toMatch(/DROP DATABASE/i);
    // structure outside the literal is preserved
    expect(masked).toMatch(/INSERT INTO t VALUES/);
  });

  it("does not flag DROP DATABASE that lives inside a string literal", () => {
    const { masked } = scanSql(
      "UPDATE t SET note = 'please DROP DATABASE later'",
    );
    expect(masked).not.toMatch(/DROP DATABASE/i);
  });

  it("does flag a real DROP DATABASE in code", () => {
    const { masked } = scanSql("DROP DATABASE prod;");
    expect(masked).toMatch(/DROP DATABASE/i);
  });

  it("ignores semicolons in line and block comments", () => {
    const sql =
      "-- a; b; c\nUPDATE t SET x = 1; /* d; e */ UPDATE t SET y = 2;";
    expect(scanSql(sql).statementCount).toBe(2);
  });

  it("splits statements safely for the no-rollback path", () => {
    const sql = "CREATE INDEX CONCURRENTLY i ON t(c); VACUUM t;";
    expect(scanSql(sql).statements).toEqual([
      "CREATE INDEX CONCURRENTLY i ON t(c)",
      "VACUUM t",
    ]);
  });
});
