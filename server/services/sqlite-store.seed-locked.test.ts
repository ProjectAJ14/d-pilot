import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/** A default rule marked always-masked is seeded locked. */

vi.mock("../config/phi-defaults.js", () => ({
  DEFAULT_PHI_RULES: [
    { pattern: "customer_ssn", maskingType: "FULL", alwaysMasked: true },
    { pattern: "order_note", maskingType: "REDACT", alwaysMasked: false },
  ],
}));

const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-seed-locked-"));
vi.stubEnv("DATA_DIR", dir);
vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "seed-locked-test-key");

const store = await import("./sqlite-store.js");

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("seeding default PHI rules", () => {
  it("stores always-masked defaults as locked", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    store.initDatabase();
    expect(log).toHaveBeenCalledWith("Seeded 2 PHI masking rules");
    expect(
      store.getPhiRules().map(({ pattern, maskingType, alwaysMasked }) => ({
        pattern,
        maskingType,
        alwaysMasked,
      })),
    ).toEqual([
      { pattern: "customer_ssn", maskingType: "FULL", alwaysMasked: true },
      { pattern: "order_note", maskingType: "REDACT", alwaysMasked: false },
    ]);
    log.mockRestore();
  });
});
