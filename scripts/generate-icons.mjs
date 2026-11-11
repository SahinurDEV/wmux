#!/usr/bin/env node
// Generates the Wmux application icon set (PNG + multi-size ICO) with no
// native dependencies. The mark is an original design: a rounded dark tile
// containing a split-pane layout (one tall pane, two stacked panes) with a
// terminal prompt chevron in the main pane.
//
// Usage: node scripts/generate-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "apps/desktop/src-tauri/icons");
mkdirSync(outDir, { recursive: true });

const BG = [17, 19, 26];
const PANE = [34, 38, 52];
const ACCENT = [124, 140, 255];
const ACCENT2 = [94, 234, 212];

// Signed distance to a rounded rectangle centred at (cx, cy).
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// Distance from point to segment.
function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

function render(size) {
  const px = new Uint8Array(size * size * 4);
  const s = size;
  const cov = (d) => Math.max(0, Math.min(1, 0.5 - d * s)); // anti-aliasing
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      // normalized coords in [0,1]
      const u = (x + 0.5) / s, v = (y + 0.5) / s;
      let r = 0, g = 0, b = 0, a = 0;
      const blend = (col, alpha) => {
        r = r * (1 - alpha) + col[0] * alpha;
        g = g * (1 - alpha) + col[1] * alpha;
        b = b * (1 - alpha) + col[2] * alpha;
        a = a * (1 - alpha) + alpha;
      };
      // Tile
      blend(BG, cov(sdRoundRect(u, v, 0.5, 0.5, 0.46, 0.46, 0.2) / 1));
      // Panes: left tall pane, right two stacked panes.
      const pad = 0.14, gap = 0.04, rad = 0.05;
      const left = { x0: pad, x1: 0.56, y0: pad, y1: 1 - pad };
      const rt = { x0: 0.56 + gap, x1: 1 - pad, y0: pad, y1: 0.5 - gap / 2 };
      const rb = { x0: 0.56 + gap, x1: 1 - pad, y0: 0.5 + gap / 2, y1: 1 - pad };
      const pane = (p, col) => {
        const d = sdRoundRect(u, v, (p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, (p.x1 - p.x0) / 2, (p.y1 - p.y0) / 2, rad);
        blend(col, cov(d));
      };
      pane(left, PANE);
      pane(rt, ACCENT);
      pane(rb, ACCENT2);
      // Prompt chevron ">" and cursor underscore in the left pane.
      const w = 0.035;
      const chevron = Math.min(
        sdSegment(u, v, 0.23, 0.38, 0.35, 0.5),
        sdSegment(u, v, 0.35, 0.5, 0.23, 0.62),
      ) - w;
      blend(ACCENT, cov(chevron));
      const cursor = sdSegment(u, v, 0.38, 0.64, 0.47, 0.64) - w;
      blend([230, 233, 240], cov(cursor));

      const i = (y * s + x) * 4;
      // un-premultiply
      px[i] = a > 0 ? Math.round(r / a) : 0;
      px[i + 1] = a > 0 ? Math.round(g / a) : 0;
      px[i + 2] = a > 0 ? Math.round(b / a) : 0;
      px[i + 3] = Math.round(a * 255);
    }
  }
  return px;
}

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const rgba = render(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function ico(sizes) {
  const images = sizes.map((s) => ({ s, data: png(s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ s, data }) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;
    e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const files = {
  "32x32.png": png(32),
  "128x128.png": png(128),
  "128x128@2x.png": png(256),
  "icon.png": png(512),
  "icon.ico": ico([16, 24, 32, 48, 64, 256]),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(outDir, name), data);
  console.log(`wrote ${name} (${data.length} bytes)`);
}
// Also used as the in-app logo / favicon.
writeFileSync(join(root, "apps/desktop/public/icon.png"), files["128x128.png"]);
