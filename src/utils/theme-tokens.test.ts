// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { bare, readGround, withAlpha } from "./theme-tokens";

afterEach(() => {
  document.head.innerHTML = "";
});

describe("readGround", () => {
  it("resolves tokens for the requested ground and removes its probe", () => {
    const style = document.createElement("style");
    style.textContent = `
      [data-mantine-color-scheme="light"] { --surface: #ffffff; }
      [data-mantine-color-scheme="dark"] { --surface:  #101010 ; }
    `;
    document.head.appendChild(style);
    const before = document.body.childElementCount;
    expect(readGround("dark", ["--surface", "--missing"])).toEqual({
      "--surface": "#101010",
      "--missing": "",
    });
    expect(readGround("light", ["--surface"])).toEqual({
      "--surface": "#ffffff",
    });
    expect(document.body.childElementCount).toBe(before);
  });
});

describe("colour helpers", () => {
  it("strips the hash", () => {
    expect(bare("#79d5c4")).toBe("79d5c4");
    expect(bare("79d5c4")).toBe("79d5c4");
  });

  it("appends a clamped alpha byte", () => {
    expect(withAlpha("#79d5c4", 0.18)).toBe("#79d5c42e");
    expect(withAlpha("#000000", -1)).toBe("#00000000");
    expect(withAlpha("#000000", 2)).toBe("#000000ff");
  });
});
