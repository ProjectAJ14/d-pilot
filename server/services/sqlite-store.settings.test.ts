import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  initDatabase,
  getAiColumnValuesEnabled,
  setSetting,
} from "./sqlite-store.js";

describe("getAiColumnValuesEnabled", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "d-pilot-settings-"));
  const prev = process.env.DATA_DIR;
  beforeAll(() => {
    process.env.DATA_DIR = dir;
    initDatabase();
  });
  afterAll(() => {
    process.env.DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to on in a fresh database", () => {
    expect(getAiColumnValuesEnabled()).toBe(true);
  });

  it("follows the stored setting", () => {
    setSetting("ai_column_values_enabled", "false");
    expect(getAiColumnValuesEnabled()).toBe(false);
    setSetting("ai_column_values_enabled", "true");
    expect(getAiColumnValuesEnabled()).toBe(true);
  });
});
