'use strict';
/**
 * Lane-marking ray tracking: follow bright column peaks across multiple rows.
 * A real lane marking appears at a screen-x that changes smoothly with row
 * (perspective), and has a bright core narrower than ~20px. We track peaks
 * from the bottom row upward and group them into persistent markings.
 */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function readPng(p) {
  const b = fs.readFileSync(p);
  let pos = 8, idat = [], info = null;
  while (pos < b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString('ascii', pos + 4, pos + 8);
    const data = b.slice(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') info = { width: data.readUInt32BE(0), height: data.readUInt32BE(4) };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  return { info, raw: zlib.inflateSync(Buffer.concat(idat)) };
}
function lum(img, x, y, ch) { const i = (y * img.info.width + x) * ch; return 0.299 * img.raw[i] + 0.587 * img.raw[i + 1] + 0.114 * img.raw[i + 2]; }

function main() {
  const dir = path.join(__dirname, '..', 'reports', 'road_relative_diagnosis');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
  for (const f of files) {
    const img = readPng(path.join(dir, f));
    const ch = Math.round(img.raw.length / (img.info.width * img.info.height));
    const W = img.info.width, H = img.info.height;
    // bottom band rows: 0.72H..0.95H (near field, markings widest)
    const rows = [];
    for (let y = Math.floor(H * 0.95); y >= Math.floor(H * 0.72); y -= 6) rows.push(y);
    // for each row, find bright local peaks above row-mean + 30
    const rowPeaks = rows.map((y) => {
      const prof = [];
      for (let x = 0; x < W; x++) prof.push(lum(img, x, y, ch));
      const mean = prof.reduce((a, b) => a + b, 0) / W;
      const peaks = [];
      for (let x = 2; x < W - 2; x++) {
        if (prof[x] >= prof[x - 1] && prof[x] >= prof[x + 1] && prof[x] > mean + 28 && prof[x] > 60) peaks.push(x);
      }
      // merge adjacent
      const merged = [];
      for (const x of peaks) {
        if (merged.length && x - merged[merged.length - 1].last <= 2) merged[merged.length - 1].last = x;
        else merged.push({ first: x, last: x });
      }
      return { y, mean: Math.round(mean), centers: merged.map((m) => Math.round((m.first + m.last) / 2)) };
    });
    console.log(`\n${f}:`);
    for (const rp of rowPeaks) {
      console.log(`  y=${rp.y} mean=${rp.mean} markings@x: ${rp.centers.join(',') || 'none'}`);
    }
  }
}
main();
