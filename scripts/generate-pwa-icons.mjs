// Generates the PWA / favicon PNGs in public/ from the app's brand colors.
//
// Zero-dependency on purpose: there is no SVG rasterizer in the toolchain and
// adding sharp/canvas for five static files is not worth the install cost. The
// icons are committed, so contributors only rerun this when the mark changes:
//
//   npm run icons:pwa
//
// Keep the mark company-agnostic (see the cross-cutting rules in CLAUDE.md) —
// a deployment's own logo comes from LOGO_URL, not from these files.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Brand colors, mirroring src/styles/global.css (--accent4 / primary[6]).
const NAVY = [0x0c, 0x23, 0x40];
const TEAL = [0x43, 0xd0, 0xd6];

// ── Minimal PNG encoder (8-bit RGBA, no interlace) ──────────────────────────

const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor + alpha
  // bytes 10-12: deflate compression, adaptive filtering, no interlace — all 0.

  // Each scanline is prefixed with its filter type (0 = none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const at = y * (size * 4 + 1);
    raw[at] = 0;
    rgba.copy(raw, at + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Signed-distance drawing ─────────────────────────────────────────────────

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Coverage from a signed distance in pixels, antialiased over ~1px.
const coverage = (d) => clamp01(0.5 - d);

function roundedBoxDistance(px, py, half, radius) {
  const qx = Math.abs(px - half) - (half - radius);
  const qy = Math.abs(py - half) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

// Distance to a thick round-capped segment.
function segmentDistance(px, py, ax, ay, bx, by, halfWidth) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = clamp01(t);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) - halfWidth;
}

// The mark is a terminal prompt — a chevron plus a cursor rule ( >_ ) — drawn
// in a unit square so the same geometry scales to every icon size.
const CHEVRON = [
  [0.06, 0.1, 0.44, 0.5],
  [0.44, 0.5, 0.06, 0.9],
];
const CURSOR = [0.56, 0.86, 0.96, 0.86];
const STROKE = 0.085;

function drawIcon(size, { radius, inset }) {
  const rgba = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const radiusPx = radius * size;
  const insetPx = inset * size;
  const span = size - 2 * insetPx;
  const strokePx = STROKE * span;
  const toPx = (u) => insetPx + u * span;

  const strokes = [...CHEVRON, CURSOR].map(([ax, ay, bx, by]) => [
    toPx(ax),
    toPx(ay),
    toPx(bx),
    toPx(by),
  ]);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      const bgAlpha = coverage(roundedBoxDistance(px, py, half, radiusPx));

      let glyph = Infinity;
      for (const [ax, ay, bx, by] of strokes) {
        glyph = Math.min(
          glyph,
          segmentDistance(px, py, ax, ay, bx, by, strokePx),
        );
      }
      const glyphAlpha = coverage(glyph);

      // Straight-alpha "over" composite: teal mark on the navy tile.
      const outAlpha = glyphAlpha + bgAlpha * (1 - glyphAlpha);
      const at = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[at + c] = outAlpha
          ? Math.round(
              (TEAL[c] * glyphAlpha + NAVY[c] * bgAlpha * (1 - glyphAlpha)) /
                outAlpha,
            )
          : 0;
      }
      rgba[at + 3] = Math.round(outAlpha * 255);
    }
  }

  return encodePng(size, rgba);
}

// ── Outputs ─────────────────────────────────────────────────────────────────

const publicDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
);

// `radius` and `inset` are fractions of the icon's size.
//   - Regular icons get a rounded tile and a roomy mark.
//   - Maskable icons must bleed to the edges and keep the mark inside the
//     central 80% safe zone, since launchers crop them to their own shape.
//   - Apple applies its own mask, so the touch icon is also full-bleed.
const OUTPUTS = [
  ["pwa-192.png", 192, { radius: 0.2, inset: 0.22 }],
  ["pwa-512.png", 512, { radius: 0.2, inset: 0.22 }],
  ["pwa-maskable-512.png", 512, { radius: 0, inset: 0.3 }],
  ["apple-touch-icon.png", 180, { radius: 0, inset: 0.24 }],
  ["favicon-32.png", 32, { radius: 0.2, inset: 0.18 }],
];

for (const [name, size, opts] of OUTPUTS) {
  const png = drawIcon(size, opts);
  writeFileSync(path.join(publicDir, name), png);
  console.log(
    `  ${name}  ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`,
  );
}
