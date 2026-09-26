import { describe, expect, it } from "vitest";
import { issueUrl, scrub, type Failure } from "./report-issue";

const base: Failure = {
  where: "Query",
  message: 'syntax error at or near ":"',
  code: "42601",
  dbType: "postgres",
  production: true,
  version: "1.25.4",
  userAgent: "Mozilla/5.0 (Macintosh) Chrome/131.0",
  time: "2026-09-26T10:42:07.000Z",
};

const params = (f: Failure) => new URL(issueUrl(f)).searchParams;

describe("scrub", () => {
  it("keeps punctuation-only quotes — they name the syntax fault", () => {
    expect(scrub('syntax error at or near ":"')).toBe(
      'syntax error at or near ":"',
    );
    expect(
      scrub(
        "Only one statement can be run at a time. Remove the extra statements after the ';'.",
      ),
    ).toBe(
      "Only one statement can be run at a time. Remove the extra statements after the ';'.",
    );
  });

  it("drops values and identifiers drivers echo back", () => {
    const pg = scrub(
      'duplicate key value violates unique constraint "customers_email_key" Key (email)=(jane.doe@example.com) already exists.',
    );
    expect(pg).not.toMatch(/customers|jane|example/);
    expect(pg).toBe(
      'duplicate key value violates unique constraint "<value>" Key (<value>)=(<value>) already exists.',
    );
    expect(scrub("Invalid object name 'app_core.orders'.")).toBe(
      "Invalid object name '<value>'.",
    );
    expect(scrub("Conversion failed for [MRN] value 123456")).toBe(
      "Conversion failed for [<value>] value <n>",
    );
  });

  it("drops bare emails, hosts, IPs and keys", () => {
    const s = scrub(
      "connect ECONNREFUSED 10.0.1.5:5432 at db.internal.acme.com for jane@acme.com, token=abcdef123456",
    );
    expect(s).not.toMatch(/10\.0|acme|jane|abcdef/);
    expect(s).toContain("<ip>");
    expect(s).toContain("<name>");
    expect(s).toContain("<email>");
  });
});

describe("issueUrl", () => {
  it("targets the public repo with a data-free title and body", () => {
    const url = issueUrl(base);
    expect(
      url.startsWith("https://github.com/ProjectAJ14/d-pilot/issues/new?"),
    ).toBe(true);
    const q = params(base);
    expect(q.get("title")).toBe(
      'Query failed (postgres, 42601): syntax error at or near ":"',
    );
    expect(q.get("labels")).toBe("bug");
    const body = q.get("body")!;
    expect(body).toContain("| Environment | production-like |");
    expect(body).toContain("| D-Pilot | 1.25.4 |");
  });

  it("a message that URL-encodes long still fits a URL GitHub accepts", () => {
    // 3-byte UTF-8 → 9 URL chars each: 500 of them alone blow the budget.
    const url = issueUrl({
      ...base,
      message: "日".repeat(2000),
      userAgent: "y".repeat(4000),
    });
    expect(url.length).toBeLessThanOrEqual(6000);
    expect(new URL(url).searchParams.get("body")).toContain("[truncated]");
  });
});
