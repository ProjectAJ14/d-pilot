import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Mantine's ScrollArea paints its scrollbar ON TOP of the content. With no
 * offset, a one-row result table (the write-request preview) had its only row
 * half-covered by the horizontal bar. The fix is a theme-wide default plus a
 * small gap in global.css; both live in files a component test cannot load
 * (main.tsx renders on import), so these read the source instead.
 */
const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("ScrollArea scrollbar offset", () => {
  it("defaults every ScrollArea to offset its scrollbars", () => {
    expect(read("main.tsx")).toMatch(
      /ScrollArea\.extend\(\{[\s\S]*?defaultProps:\s*\{\s*offsetScrollbars:\s*"present"/,
    );
  });

  it("leaves a gap between the last row and the horizontal bar", () => {
    const css = read("styles/global.css");
    const rule = css.match(
      /\.mantine-ScrollArea-viewport\[data-offset-scrollbars="present"\]:not\(\s*\[data-horizontal-hidden\]\s*\)\s*\{([^}]*)\}/,
    );
    expect(rule?.[1]).toMatch(
      /padding-bottom:\s*calc\(var\(--scrollarea-scrollbar-size\)\s*\+\s*[1-9]\d*px\)/,
    );
  });
});
