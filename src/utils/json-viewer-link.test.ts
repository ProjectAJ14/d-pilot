// What is worth pinning is not the exact bytes: the payload must ride in the FRAGMENT (never
// transmitted, which is the only reason a cell that may hold PHI can go here at all), a payload
// too big for a URL must fall back to the clipboard hand-off rather than produce a link proxies
// reject, and the compacted form must actually round-trip through raw inflate.
import { describe, it, expect } from "vitest";
import { inflateRawSync } from "node:zlib";
import { jsonViewerLink } from "./json-viewer-link";

describe("jsonViewerLink", () => {
  it("puts the payload in the fragment, never the query string", async () => {
    const { url, needsClipboard } = await jsonViewerLink('{"id":42}');
    expect(url.startsWith("https://json.nonstopio.com/#data=")).toBe(true);
    expect(url).not.toContain("?data=");
    expect(needsClipboard).toBe(false);
  });

  it("compacts to base64url of raw deflate — it inflates back to the JSON", async () => {
    const text = JSON.stringify({ table: "orders", rows: [1, 2, 3] });
    const b64 = (await jsonViewerLink(text)).url.split("#data=")[1];
    expect(b64).not.toMatch(/[+/=]/); // base64url, not plain base64
    expect(b64[0]).not.toMatch(/[{["]/); // …so the viewer reads it as compacted, not raw
    expect(inflateRawSync(Buffer.from(b64, "base64url")).toString()).toBe(text);
  });

  it("hands a payload too big for a URL over via the clipboard", async () => {
    // Random-ish content so it will not compress under the 4000-char cap.
    const big = JSON.stringify(
      Array.from(
        { length: 40000 },
        (_, i) => `${i}-${(i * 2654435761) % 999983}`,
      ),
    );
    const { url, needsClipboard } = await jsonViewerLink(big);
    expect(url).toBe("https://json.nonstopio.com/?data=clipboard");
    expect(needsClipboard).toBe(true);
  });

  it("without CompressionStream a small payload still opens, percent-encoded", async () => {
    const saved = globalThis.CompressionStream;
    // @ts-expect-error — simulating an environment without the compressor
    delete globalThis.CompressionStream;
    try {
      const { url } = await jsonViewerLink('{"a":1}');
      expect(url).toBe("https://json.nonstopio.com/#data=%7B%22a%22%3A1%7D");
    } finally {
      globalThis.CompressionStream = saved;
    }
  });
});
