// A link to json.nonstopio.com with the payload already loaded.
//
// The cell inspector is a reader, not a tool: once a value is a few hundred lines, what you want
// is search, filter, a diff and a graph of the shape. That viewer has all of it, so D-Pilot hands
// the payload over rather than growing a second one.
//
// Contract: `#data=` is base64url of RAW deflate (not gzip, not zlib — the header makes it
// undecodable), and it goes in the FRAGMENT because a browser never transmits one. That matters
// here: a cell can hold PHI, and the fragment keeps it out of request logs, CDN logs, Referer
// headers and analytics. The viewer also accepts `?data=`, which must never be used for a real
// payload — a query string IS sent.
//
// Over 4000 compacted characters proxies start rejecting the request line, so the documented
// hand-off is `?data=clipboard` (no payload in the URL at all) with the sender putting the JSON
// on the clipboard. That write has to happen inside the click, which is why this returns
// `needsClipboard` and leaves the writing to the caller.

const BASE = "https://json.nonstopio.com/";
const MAX = 4000;

export interface JsonViewerLink {
  url: string;
  needsClipboard: boolean;
}

export async function jsonViewerLink(
  text: string,
  base = BASE,
): Promise<JsonViewerLink> {
  const packed = await compact(text);
  if (packed != null && packed.length <= MAX) {
    return { url: `${base}#data=${packed}`, needsClipboard: false };
  }
  // No CompressionStream: the viewer reads a fragment starting with `{`, `[` or `"` as raw
  // percent-encoded JSON, so a small payload still opens without the compressor.
  if (packed == null) {
    const raw = encodeURIComponent(text);
    if (raw.length <= MAX)
      return { url: `${base}#data=${raw}`, needsClipboard: false };
  }
  return { url: `${base}?data=clipboard`, needsClipboard: true };
}

async function compact(text: string): Promise<string | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const bytes = new TextEncoder().encode(text);
    const source = new ReadableStream<BufferSource>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
    const out = new Uint8Array(
      await new Response(
        source.pipeThrough(new CompressionStream("deflate-raw")),
      ).arrayBuffer(),
    );
    // One char at a time, not `String.fromCharCode(...out)`: spreading a big array into a call
    // blows the argument limit on exactly the large payloads this is for.
    let s = "";
    for (let i = 0; i < out.length; i += 1) s += String.fromCharCode(out[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch {
    return null;
  }
}
