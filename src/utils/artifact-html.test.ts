import { describe, it, expect, vi } from "vitest";
import { buildArtifactSrcdoc } from "./artifact-html";

describe("buildArtifactSrcdoc", () => {
  const body = '<h2>Hi</h2><script>alert(1)</script><img src=x onerror="x()">';
  const doc = buildArtifactSrcdoc(body, "--ink:#000", "n0nce");

  it("puts the CSP before any author content", () => {
    const csp = doc.indexOf("Content-Security-Policy");
    expect(csp).toBeGreaterThan(-1);
    expect(csp).toBeLessThan(doc.indexOf(body));
  });

  it("blocks network and allows only the nonced script", () => {
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("script-src 'nonce-n0nce'");
    expect(doc).not.toMatch(/script-src[^;"]*unsafe-inline/);
    expect(doc).toContain("form-action 'none'");
  });

  it("runs the height reporter before author HTML can swallow it", () => {
    const broken = buildArtifactSrcdoc("<p>hi <!-- <textarea>", "", "n0nce");
    expect(broken.indexOf('<script nonce="n0nce">')).toBeLessThan(
      broken.indexOf("<body>"),
    );
  });

  it("inlines the theme tokens", () => {
    expect(doc).toContain(":root{--ink:#000}");
  });
});

describe("readThemeTokens", () => {
  it("serialises each theme token from the element's computed style", async () => {
    const { readThemeTokens } = await import("./artifact-html");
    const seen: string[] = [];
    vi.stubGlobal("getComputedStyle", () => ({
      getPropertyValue: (t: string) => (seen.push(t), ` v${seen.length} `),
    }));
    const out = readThemeTokens({} as Element);
    vi.unstubAllGlobals();
    expect(seen).toContain("--font-mono");
    expect(out.split(";")).toHaveLength(seen.length);
    expect(out.startsWith(`${seen[0]}:v1;`)).toBe(true);
  });
});
