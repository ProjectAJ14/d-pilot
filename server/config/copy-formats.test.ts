import { describe, it, expect, beforeEach, vi } from "vitest";

/** `loadCopyFormats()` memoizes, so each case re-imports with its own env. */
async function load(
  raw: string | undefined,
): Promise<import("../types/index.js").CopyFormat[]> {
  vi.resetModules();
  if (raw === undefined) delete process.env.COPY_FORMATS;
  else process.env.COPY_FORMATS = raw;
  const { loadCopyFormats } = await import("./copy-formats.js");
  return loadCopyFormats();
}

describe("loadCopyFormats", () => {
  beforeEach(() => {
    delete process.env.COPY_FORMATS;
  });

  it("returns the code defaults when COPY_FORMATS is unset", async () => {
    const formats = await load(undefined);
    expect(formats.map((f) => f.id)).toContain("comma");
    expect(formats.map((f) => f.id)).toContain("single-quoted");
  });

  it("parses a valid custom list", async () => {
    const formats = await load(
      JSON.stringify([
        {
          id: "pipe",
          label: "Pipes",
          template: { columnSeparator: "|", rowSeparator: "\n" },
        },
        { id: "j", label: "JSON", builtin: "json" },
      ]),
    );
    expect(formats).toHaveLength(2);
    expect(formats[0]).toMatchObject({
      id: "pipe",
      template: { columnSeparator: "|" },
    });
  });

  it("drops invalid entries but keeps the valid ones", async () => {
    const formats = await load(
      JSON.stringify([
        { id: "ok", label: "Ok", builtin: "csv" },
        { id: "no-source", label: "Missing renderer" }, // neither builtin nor template
        { label: "no id", builtin: "csv" }, // missing id
        {
          id: "both",
          label: "Ambiguous",
          builtin: "csv",
          template: { columnSeparator: ",", rowSeparator: "," },
        },
      ]),
    );
    expect(formats.map((f) => f.id)).toEqual(["ok"]);
  });

  it("falls back to defaults when nothing valid remains", async () => {
    const formats = await load(JSON.stringify([{ nope: true }]));
    expect(formats.length).toBeGreaterThan(1);
    expect(formats.map((f) => f.id)).toContain("comma");
  });

  it("falls back to defaults on malformed JSON", async () => {
    const formats = await load("{not json");
    expect(formats.map((f) => f.id)).toContain("comma");
  });

  it("falls back to defaults when the JSON is not an array", async () => {
    const formats = await load(
      JSON.stringify({ id: "x", label: "x", builtin: "csv" }),
    );
    expect(formats.map((f) => f.id)).toContain("comma");
  });
});
