import { describe, it, expect } from "vitest";
import { settingBool } from "./setting-bool";

describe("settingBool", () => {
  it("accepts the same truthy spellings as the server", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"])
      expect(settingBool(v), v).toBe(true);
    for (const v of ["0", "false", "no", "off", "", undefined, null])
      expect(settingBool(v), String(v)).toBe(false);
  });
});
