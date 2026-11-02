import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePassword } from "./password";

afterEach(() => vi.unstubAllGlobals());

const classes = (p: string) => ({
  lower: /[a-z]/.test(p),
  upper: /[A-Z]/.test(p),
  digit: /[0-9]/.test(p),
  symbol: /[!@#$%^&*\-_=+]/.test(p),
});

describe("generatePassword", () => {
  it("is 16 chars by default with every class and no ambiguous characters", () => {
    for (let i = 0; i < 20; i++) {
      const p = generatePassword();
      expect(p).toHaveLength(16);
      expect(classes(p)).toEqual({
        lower: true,
        upper: true,
        digit: true,
        symbol: true,
      });
      expect(p).not.toMatch(/[0O1lI]/);
    }
  });

  it("never goes below 12 characters, and honours longer lengths", () => {
    expect(generatePassword(4)).toHaveLength(12);
    expect(generatePassword(30)).toHaveLength(30);
  });

  it("rejection-samples values that would bias the modulo", () => {
    const values = [0xffffffff, 5];
    let n = 0;
    const getRandomValues = vi.fn((buf: Uint32Array) => {
      buf[0] = values[n++ % 2];
      return buf;
    });
    vi.stubGlobal("crypto", { getRandomValues });
    const p = generatePassword(12);
    expect(p).toHaveLength(12);
    // Each pick drew twice: the out-of-range value was thrown away.
    expect(getRandomValues.mock.calls.length % 2).toBe(0);
    expect(p).not.toMatch(/[0O1lI]/);
  });

  it("falls back to Math.random without crypto", () => {
    vi.stubGlobal("crypto", undefined);
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const p = generatePassword(12);
    expect(random).toHaveBeenCalled();
    // Index 0 of each class, then shuffled: a, A, 2, ! and eight more `a`s.
    expect([...p].sort().join("")).toBe("!2Aaaaaaaaaa");
    random.mockRestore();
  });
});
