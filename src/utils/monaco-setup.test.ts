// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const defineTheme = vi.fn();
const loaderConfig = vi.fn();
const readGround = vi.fn();

vi.mock("monaco-editor", () => ({ editor: { defineTheme } }));
vi.mock("@monaco-editor/react", () => ({
  loader: { config: (...a: unknown[]) => loaderConfig(...a) },
}));
vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
  default: class {
    kind = "editor";
  },
}));
vi.mock("monaco-editor/esm/vs/language/typescript/ts.worker?worker", () => ({
  default: class {
    kind = "ts";
  },
}));
vi.mock("monaco-editor/esm/vs/language/json/json.worker?worker", () => ({
  default: class {
    kind = "json";
  },
}));
vi.mock("./theme-tokens", async (orig) => ({
  ...(await orig<typeof import("./theme-tokens")>()),
  readGround: (...a: unknown[]) => readGround(...a),
}));

const palette = (ground: string, names: readonly string[]) =>
  Object.fromEntries(
    names.map((n) => [n, ground === "dark" ? "#111111" : "#eeeeee"]),
  );

beforeEach(() => {
  vi.resetModules();
  defineTheme.mockReset();
  loaderConfig.mockReset();
  readGround.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe("monaco-setup", () => {
  it("defines both themes from the design tokens and wires the loader", async () => {
    readGround.mockImplementation(palette);
    await import("./monaco-setup");

    expect(defineTheme).toHaveBeenCalledTimes(2);
    const [lightName, light] = defineTheme.mock.calls[0];
    const [darkName, dark] = defineTheme.mock.calls[1];
    expect(lightName).toBe("d-pilot-light");
    expect(light.base).toBe("vs");
    expect(light.colors["editor.background"]).toBe("#eeeeee");
    expect(darkName).toBe("d-pilot-dark");
    expect(dark.base).toBe("vs-dark");
    expect(dark.colors["editor.selectionBackground"]).toBe("#1111112e");
    expect(dark.rules[0]).toEqual({
      token: "keyword",
      foreground: "111111",
      fontStyle: "bold",
    });
    expect(loaderConfig).toHaveBeenCalledWith({
      monaco: expect.objectContaining({ editor: { defineTheme } }),
    });
  });

  it("picks a language worker by label", async () => {
    readGround.mockImplementation(palette);
    await import("./monaco-setup");
    const env = self.MonacoEnvironment!;
    const kind = (label: string) =>
      (env.getWorker!("id", label) as unknown as { kind: string }).kind;
    expect(kind("typescript")).toBe("ts");
    expect(kind("javascript")).toBe("ts");
    expect(kind("json")).toBe("json");
    expect(kind("sql")).toBe("editor");
  });

  it("falls back to the stock theme when tokens are unresolved", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readGround.mockImplementation((ground: string, names: string[]) => ({
      ...palette(ground, names),
      "--info": "",
    }));
    await import("./monaco-setup");
    expect(defineTheme).toHaveBeenCalledWith("d-pilot-light", {
      base: "vs",
      inherit: true,
      rules: [],
      colors: {},
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain("--info");
  });
});
