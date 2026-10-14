import { describe, it, expect, vi } from "vitest";

vi.mock("../store", () => ({ useStore: () => [] }));
const { envPickerOptions } = await import("./environments");

describe("envPickerOptions", () => {
  it("offers known envs plus saved ones with no connection, marked", () => {
    expect(envPickerOptions(["PROD", "DEV"], ["DEV", "UAT"])).toEqual([
      { value: "PROD", label: "PROD" },
      { value: "DEV", label: "DEV" },
      { value: "UAT", label: "UAT (no connection)" },
    ]);
  });

  it("depends only on the saved list, not on what the form holds now", () => {
    // Built from the list as saved when the editor opened, so unticking UAT
    // by mistake leaves it in the options to tick again before saving.
    expect(envPickerOptions(["DEV"], ["UAT"]).map((o) => o.value)).toEqual([
      "DEV",
      "UAT",
    ]);
  });
});
