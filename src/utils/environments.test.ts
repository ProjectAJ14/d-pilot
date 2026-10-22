import { describe, it, expect, vi } from "vitest";

vi.mock("../store", () => ({ useStore: () => [] }));
const { envPickerOptions, runEnvStyle } = await import("./environments");

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

describe("runEnvStyle", () => {
  it("makes every production-like env red, not just PROD", () => {
    for (const env of ["PROD", "SUPER_PROD", "PREPROD"]) {
      expect(runEnvStyle(env).color).toBe("red");
    }
  });

  it("keeps the badge colors for known non-prod envs", () => {
    expect(runEnvStyle("QA").color).toBe("violet");
    expect(runEnvStyle("DEV").color).toBe("green");
  });

  it("gives an unknown non-prod env the neutral ramp", () => {
    expect(runEnvStyle("SANDBOX").color).toBe("neutral");
  });

  it("labels with the raw env name", () => {
    expect(runEnvStyle("SUPER_PROD").label).toBe("SUPER_PROD");
    expect(runEnvStyle("QA").label).toBe("QA");
  });

  it("is case-insensitive about production", () => {
    for (const env of ["prod", "Prod", "PRODUCTION", "production"]) {
      expect(runEnvStyle(env).color).toBe("red");
    }
  });

  it("keeps STG and UAT on their badge colors", () => {
    expect(runEnvStyle("STG").color).toBe("orange");
    expect(runEnvStyle("UAT").color).toBe("blue");
  });

  it("treats any name containing 'prod' as production (fail-safe)", () => {
    // isProductionEnv is a /prod/i substring match, so "reproduce" is red too.
    // Deliberate: a false red costs a glance, a missed red costs a prod write.
    expect(runEnvStyle("reproduce").color).toBe("red");
  });

  it("falls back to neutral for an empty env, label unchanged", () => {
    expect(runEnvStyle("")).toEqual({ label: "", color: "neutral" });
  });

  it("never rewrites the label (no case or label-map changes)", () => {
    for (const env of ["prod", "Prod", "PREPROD", "stg", "sandbox"]) {
      expect(runEnvStyle(env).label).toBe(env);
    }
  });
});
