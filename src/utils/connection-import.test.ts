import { describe, it, expect } from "vitest";
import { parseConnectionsJson, runLimited } from "./connection-import";

describe("parseConnectionsJson", () => {
  it("takes an array, or a single object as a one-item array", () => {
    expect(parseConnectionsJson('[{"id":"a"},{"id":"b"}]')).toEqual({
      items: [{ id: "a" }, { id: "b" }],
    });
    expect(parseConnectionsJson(' {"id":"a"} ')).toEqual({
      items: [{ id: "a" }],
    });
  });

  it("names the line and column of a trailing comma instead of fixing it", () => {
    const text = '[\n  {"id": "a"},\n  {"id": "b"},\n]';
    expect(parseConnectionsJson(text)).toEqual({
      error:
        "Trailing comma at line 3, column 14 — remove the comma after the last item",
    });
    const inObject = parseConnectionsJson('{"id": "a",\n}');
    expect("error" in inObject && inObject.error).toMatch(/line 1, column 11/);
  });

  it("ignores commas inside strings when looking for one", () => {
    const r = parseConnectionsJson('[{"name": "a,]"}, {"id": ]');
    expect("error" in r && r.error).not.toMatch(/Trailing comma/);
  });

  it("reports other syntax errors without echoing the input", () => {
    const r = parseConnectionsJson(
      '[{"id": "a", "password": "s3cret"} {"id": "b"}]',
    );
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error).toMatch(/^Invalid JSON/);
      expect(r.error).not.toContain("s3cret");
    }
  });

  it("rejects JSON that is not connections", () => {
    for (const text of ["42", '"x"', "null", "[]"])
      expect(parseConnectionsJson(text), text).toHaveProperty("error");
  });
});

describe("runLimited", () => {
  it("runs every item, never more than `limit` at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];
    await runLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5 * (n % 3)));
      inFlight--;
      done.push(n);
    });
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(3);
  });
});
