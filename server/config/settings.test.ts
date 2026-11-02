import { describe, it, expect, vi } from "vitest";

// A row read back as `undefined` (not the store's `null` for "unset") is the
// only way a defaulted key resolves to nothing; the store stays in memory.
vi.mock("../services/sqlite-store.js", () => ({
  getSetting: vi.fn(() => undefined),
  setSetting: vi.fn(),
  deleteSetting: vi.fn(),
}));
vi.mock("./secrets.js", () => ({
  decryptSecret: vi.fn(),
  encryptSecret: vi.fn(),
}));

const { jwtExpiresIn } = await import("./settings.js");

describe("jwtExpiresIn", () => {
  it("falls back to the default when the setting resolves to nothing", () => {
    expect(jwtExpiresIn()).toBe("24h");
  });
});
