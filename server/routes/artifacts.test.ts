import { describe, it, expect } from "vitest";
import { parseBlocks } from "./artifacts.js";

/**
 * Block validation is the only gate between an MCP agent's JSON and the
 * document store, so it gets the test: garbage in must be a 400, not a document
 * that renders as blank space for whoever opens the link.
 */
describe("parseBlocks", () => {
  it("accepts a mixed text + sql document", () => {
    const result = parseBlocks([
      { type: "text", body: "Orders stuck in PENDING." },
      { type: "sql", sql: "select 1", label: "Stuck", connectionId: "qa-core" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.blocks).toHaveLength(2);
  });

  it("rejects an unknown block type instead of dropping it", () => {
    const result = parseBlocks([{ type: "html", body: "<script>x</script>" }]);
    expect(result.ok).toBe(false);
  });

  it("rejects an empty or non-array body", () => {
    expect(parseBlocks([]).ok).toBe(false);
    expect(parseBlocks(undefined).ok).toBe(false);
    expect(parseBlocks("select 1").ok).toBe(false);
  });

  it("rejects a sql block with no query", () => {
    expect(parseBlocks([{ type: "sql", sql: "   " }]).ok).toBe(false);
  });

  it("strips unknown keys rather than storing them", () => {
    const result = parseBlocks([
      { type: "text", body: "hi", onclick: "alert(1)" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.blocks[0]).toEqual({ type: "text", body: "hi" });
  });

  it("names the offending block in the error", () => {
    const result = parseBlocks([{ type: "text", body: "ok" }, { type: "sql" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(
        "blocks[1].sql: Invalid input: expected string, received undefined",
      );
  });
});
