import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PhiFieldRule } from "../types/index.js";

const rules: PhiFieldRule[] = [];
vi.mock("./sqlite-store.js", () => ({ getPhiRules: () => rules }));

const { findMatchingRule, maskValue, maskQueryResults } =
  await import("./phi-masking.js");

const rule = (over: Partial<PhiFieldRule>): PhiFieldRule => ({
  id: over.pattern ?? "r",
  pattern: "*",
  maskingType: "FULL",
  alwaysMasked: false,
  ...over,
});

beforeEach(() => {
  rules.length = 0;
});

describe("findMatchingRule", () => {
  it("matches glob patterns case-insensitively and escapes regex chars", () => {
    rules.push(rule({ pattern: "*_SSN" }), rule({ pattern: "e.mail" }));
    expect(findMatchingRule("customer_ssn")?.pattern).toBe("*_SSN");
    expect(findMatchingRule("e.mail")?.pattern).toBe("e.mail");
    // "." is literal, not a regex wildcard.
    expect(findMatchingRule("eXmail")).toBeNull();
  });

  it("skips rules scoped to another database or table", () => {
    rules.push(
      rule({ pattern: "name", database: "other_db", maskingType: "HASH" }),
      rule({ pattern: "name", table: "orders", maskingType: "PARTIAL" }),
      rule({ pattern: "name", database: "APP_CORE", table: "CUSTOMERS" }),
    );
    expect(findMatchingRule("name", "app_core", "customers")?.maskingType).toBe(
      "FULL",
    );
    // Without a database/table to compare, scoped rules still apply.
    expect(findMatchingRule("name")?.maskingType).toBe("HASH");
    expect(findMatchingRule("name", "app_core", "orders")?.maskingType).toBe(
      "PARTIAL",
    );
  });
});

describe("maskValue", () => {
  it("passes null and undefined through", () => {
    expect(maskValue(null, "FULL")).toBeNull();
    expect(maskValue(undefined, "FULL")).toBeUndefined();
  });

  it("applies each masking type", () => {
    expect(maskValue("secret", "FULL")).toBe("********");
    expect(maskValue("123456789", "PARTIAL")).toBe("*****6789");
    expect(maskValue("1234", "PARTIAL")).toBe("****");
    expect(maskValue("x", "REDACT")).toBe("[REDACTED]");
    const h = maskValue(42, "HASH");
    expect(h).toMatch(/^tok_[0-9a-f]{12}$/);
    expect(maskValue("42", "HASH")).toBe(h); // deterministic token
    expect(maskValue("x", "BOGUS" as never)).toBe("********");
  });
});

describe("maskQueryResults", () => {
  it("masks matched columns when PHI is on, and always-masked ones always", () => {
    rules.push(
      rule({ pattern: "ssn", alwaysMasked: true, maskingType: "REDACT" }),
      rule({ pattern: "email", maskingType: "FULL" }),
    );
    const rows = [{ id: 1, ssn: "111", email: "a@b" }, { id: 2 }];

    const on = maskQueryResults(["id", "ssn", "email"], rows, {
      phiEnabled: true,
      isAdmin: false,
    });
    expect(on.maskedRows).toEqual([
      { id: 1, ssn: "[REDACTED]", email: "********" },
      { id: 2 },
    ]);
    expect(on.maskedFieldNames).toEqual(["ssn", "email"]);
    expect(on.maskedColumns).toEqual([
      { name: "id", type: "string", isMasked: false },
      { name: "ssn", type: "string", isMasked: true, maskingType: "REDACT" },
      { name: "email", type: "string", isMasked: true, maskingType: "FULL" },
    ]);
    expect(rows[0].ssn).toBe("111"); // input not mutated

    const off = maskQueryResults(["ssn", "email"], [rows[0]], {
      phiEnabled: false,
      isAdmin: true,
    });
    expect(off.maskedRows[0]).toEqual({
      id: 1,
      ssn: "[REDACTED]",
      email: "a@b",
    });
    expect(off.maskedFieldNames).toEqual(["ssn"]);
    expect(off.maskedColumns[1]).toEqual({
      name: "email",
      type: "string",
      isMasked: false,
      maskingType: undefined,
    });
  });
});
