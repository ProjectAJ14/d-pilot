/**
 * Builds the `srcdoc` for an artifact `html` block — a rich page (layout, CSS,
 * inline SVG diagrams) written by a colleague or an agent, shown to everyone
 * who opens the link.
 *
 * That HTML is untrusted, so it never touches the app's DOM. It renders in an
 * iframe whose `sandbox` omits `allow-same-origin` (see `ArtifactHtmlFrame`),
 * which gives it an opaque origin: no JWT in `localStorage`, no cookies, no
 * parent DOM, no `/api`. On top of that, the CSP below is the first thing in
 * the document:
 *
 * - `default-src 'none'` — no fetch, no remote images/fonts/frames, so nothing
 *   the page contains can be sent anywhere.
 * - `script-src 'nonce-…'` — only our own height reporter runs. The nonce is
 *   fresh per render, so author HTML cannot carry a script that matches it;
 *   `onload=`/`javascript:` handlers are blocked the same way.
 * - `form-action 'none'` — no form can post what a reader types.
 *
 * A later `<meta>` CSP in the author's HTML can only tighten this, never
 * loosen it — that is how multiple policies combine.
 */

/**
 * Theme roles copied from the app into the frame. The frame cannot see the
 * parent's CSS variables, so the resolved values are inlined at render time and
 * the author writes `var(--ink)`, `var(--spot)`… exactly as the app does.
 */
const TOKENS = [
  "--bg",
  "--panel",
  "--mass",
  "--well",
  "--ink",
  "--dim",
  "--faint",
  "--line",
  "--line-2",
  "--spot",
  "--spot-ink",
  "--spot-soft",
  "--success",
  "--error",
  "--warning",
  "--info",
  "--font-disp",
  "--font-body",
  "--font-mono",
  "--tracking-display",
  "--tracking-tight",
  "--tracking-snug",
  "--tracking-caps",
];

export function readThemeTokens(el: Element): string {
  const style = getComputedStyle(el);
  return TOKENS.map((t) => `${t}:${style.getPropertyValue(t).trim()}`).join(
    ";",
  );
}

/**
 * A ready-made vocabulary so an author writes content, not a stylesheet: the
 * same class names the tool descriptions in `server/routes/mcp.ts` teach
 * (`.lede`, `.callout`, `.card`/`.grid`, `.stat`, `.chip`, `figure` with the
 * `.svg-*` classes). Role tokens only, so every page reads in both themes.
 */
const BASE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 var(--font-body)}
body{padding:2px 0}
h1{font:800 30px/1.1 var(--font-disp);letter-spacing:var(--tracking-tight);margin:0 0 .4em}
h2{font:800 22px/1.2 var(--font-disp);letter-spacing:var(--tracking-snug);margin:1.8em 0 .6em;padding-top:.8em;border-top:1px solid var(--line-2)}
h2:first-child,h1+h2{border-top:0;padding-top:0;margin-top:0}
h3{font:700 17px/1.3 var(--font-disp);margin:1.4em 0 .4em}
p,ul,ol{margin:0 0 1em}
li{margin:.2em 0}
.lede{color:var(--dim);font-size:17px;max-width:640px}
.muted{color:var(--dim)}
a{color:var(--spot)}
strong{font-weight:600}
code{font-family:var(--font-mono);font-size:.88em;background:var(--mass);padding:.1em .38em}
pre{background:var(--panel);border:1px solid var(--line-2);padding:12px 14px;overflow:auto;font-size:13px;line-height:1.5}
pre code{background:none;padding:0}
table{width:100%;border-collapse:collapse;margin:1em 0;font-size:14px}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line-2);vertical-align:top}
th{font:600 11px var(--font-mono);letter-spacing:var(--tracking-caps);text-transform:uppercase;color:var(--faint)}
td.num,th.num{text-align:right;font-family:var(--font-mono);font-variant-numeric:tabular-nums}
blockquote{margin:1em 0;padding:.2em 0 .2em 16px;border-left:2px solid var(--spot);color:var(--dim)}
.callout{border:1px solid var(--spot);background:var(--spot-soft);padding:12px 16px;margin:1.2em 0}
.callout.warn{border-color:var(--warning);background:color-mix(in srgb,var(--warning) 12%,transparent)}
.callout.bad{border-color:var(--error);background:color-mix(in srgb,var(--error) 12%,transparent)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:1.2em 0}
.card{background:var(--panel);border:1px solid var(--line);padding:18px}
.card h3{margin-top:0}
.card p{color:var(--dim);font-size:14px;margin:0}
.stat{border:1px solid var(--line-2);padding:14px 16px}
.stat .k{font:600 11px var(--font-mono);letter-spacing:var(--tracking-caps);text-transform:uppercase;color:var(--faint)}
.stat .v{font:800 32px/1.1 var(--font-disp);letter-spacing:var(--tracking-tight);margin-top:4px}
.stat .d{color:var(--dim);font-size:13px}
.chip{display:inline-block;font:12px var(--font-mono);color:var(--spot);background:var(--spot-soft);border:1px solid var(--spot);padding:1px 8px}
.chip.warn{color:var(--warning);border-color:var(--warning)}
.chip.bad{color:var(--error);border-color:var(--error)}
figure{margin:1.4em 0;background:var(--panel);border:1px solid var(--line-2);padding:18px;text-align:center}
figure svg{max-width:100%;height:auto}
figcaption{margin-top:10px;color:var(--dim);font-size:13px}
.svg-ink{fill:var(--ink)} .svg-muted{fill:var(--dim)}
.svg-box{fill:var(--mass);stroke:var(--line-2);stroke-width:1}
.svg-box-spot{fill:var(--spot-soft);stroke:var(--spot);stroke-width:1.5}
.svg-box-warn{fill:color-mix(in srgb,var(--warning) 12%,transparent);stroke:var(--warning);stroke-width:1.5}
.svg-box-bad{fill:color-mix(in srgb,var(--error) 12%,transparent);stroke:var(--error);stroke-width:1.5}
.svg-line{stroke:var(--faint);stroke-width:1.5;fill:none}
.svg-line-spot{stroke:var(--spot);stroke-width:1.5;fill:none}
.svg-label{font:500 13px var(--font-body);fill:var(--ink)}
.svg-small{font:11px var(--font-mono);fill:var(--dim)}
`;

/** The message the frame posts up so the parent can size it to its content. */
export const HEIGHT_MESSAGE = "d-pilot-artifact-height";

export function buildArtifactSrcdoc(
  body: string,
  tokens: string,
  nonce: string,
): string {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    `script-src 'nonce-${nonce}'`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  // Links open in a new tab (the sandbox allows escaping popups) instead of
  // navigating the frame away from the document. The height reporter sits in
  // <head>, ahead of the author's HTML, so an unclosed `<!--` or `<textarea>`
  // in the body cannot swallow it. It measures <body>, not
  // `documentElement.scrollHeight`: the latter never drops below the frame's
  // own height, so a frame that once grew (e.g. laid out narrow on first
  // paint) could never shrink back. `body` padding stops child margins
  // collapsing out of the measurement.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>:root{${tokens}}${BASE_CSS}</style><script nonce="${nonce}">(function(){function post(){parent.postMessage({type:"${HEIGHT_MESSAGE}",height:Math.ceil(document.body.getBoundingClientRect().height)},"*")}document.addEventListener("DOMContentLoaded",function(){new ResizeObserver(post).observe(document.body);post()});addEventListener("load",post)})()</script></head><body>${body}</body></html>`;
}
