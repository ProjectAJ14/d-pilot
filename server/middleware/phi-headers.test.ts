import { describe, it, expect } from "vitest";
import { decodeHeaderText } from "./phi-headers.js";

describe("decodeHeaderText", () => {
  it.each([
    [
      "encoded",
      encodeURIComponent("Ticket 42 — José Müller"),
      "Ticket 42 — José Müller",
    ],
    [
      "encoded newline",
      encodeURIComponent("line one\nline two"),
      "line one\nline two",
    ],
    [
      "raw from an old client",
      "Support ticket investigation",
      "Support ticket investigation",
    ],
    ["raw with a stray %", "100% sure", "100% sure"],
    ["malformed escape", "%E2%80", "%E2%80"],
    ["empty", "", undefined],
    ["absent", undefined, undefined],
    ["repeated header", [encodeURIComponent("é"), "x"], "é"],
  ])("%s", (_, raw, expected) => {
    expect(decodeHeaderText(raw)).toBe(expected);
  });
});
