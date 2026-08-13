'use strict';
/**
 * Attempt automated marking-presence evidence for each outer-line case.
 * For each frame, estimate where the predicted outer line would appear and
 * look for a bright line-like feature there. This is EVIDENCE ONLY, not
 * ground truth; all results are labelled 'unclear' unless the feature is
 * unambiguous, and the report treats automated results as provisional.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'reports', 'outer_line_diagnosis');
const ROWS = require(path.join(OUT, 'outer_line_review_table.json'));

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
  let hasFrame = 0, noFrame = 0, markFound = 0, markUnclear = 0;
  for (const row of ROWS) {
    if (!row.framePath || !fs.existsSync(row.framePath)) { row.automatedMarking = 'NO_FRAME'; noFrame++; continue; }
    const img = readPng(row.framePath);
    const ch = Math.round(img.raw.length / (img.info.width * img.info.height));
    const W = img.info.width, H = img.info.height;
    // Lower near-field band: rows 0.72H..0.92H. Look for bright line-like
    // vertical bands that persist across rows (a painted marking).
    const rowsY = [];
    for (let y = Math.floor(H * 0.92); y >= Math.floor(H * 0.72); y -= 5) rowsY.push(y);
    // Column score: sum of brightness over the band; find columns that are
    // bright local peaks (marking-like).
    const colScore = new Array(W).fill(0);
    for (const y of rowsY) for (let x = 0; x < W; x++) colScore[x] += lum(img, x, y, ch);
    const bandAvg = colScore.reduce((a, b) => a + b, 0) / W;
    const peaks = [];
    for (let x = 2; x < W - 2; x++) {
      if (colScore[x] > bandAvg + colScore.reduce((a, b) => a + b, 0) * 0.25 && colScore[x] > 60 * rowsY.length) {
        // require local peak vs neighbors
        let isPeak = true;
        for (let d = 3; d <= 8; d++) {
          if (x - d >= 0 && colScore[x] < colScore[x - d]) { isPeak = false; break; }
          if (x + d < W && colScore[x] < colScore[x + d]) { isPeak = false; break; }
        }
        if (isPeak) peaks.push(x);
      }
    }
    // merge adjacent peaks into bands
    const bands = [];
    for (const p of peaks) {
      if (bands.length && p - bands[bands.length - 1].last <= 4) bands[bands.length - 1].last = p;
      else bands.push({ first: p, last: p });
    }
    // Determine predicted screen position: we do NOT have a camera projection.
    // The video frames are 526x330; the vehicle forward is near center (~263).
    // Outer lines at |lateral| 4-5m would appear near frame edges in the
    // near field, but without projection we cannot map meters->pixels.
    // Therefore automated marking detection cannot place the prediction;
    // we mark it 'unclear_position' and just report the detected bands count.
    hasFrame++;
    const bandCx = bands.map((b) => Math.round((b.first + b.last) / 2));
    // A single clear marking band is weak evidence; without projection we
    // cannot confirm it is the predicted outer line.
    row.automatedMarking = bandCx.length ? `bands_at_x=[${bandCx.join(',')}]` : 'no_band';
    row.automatedPlacement = 'unclear_position_no_projection';
    row.visualMarking = 'unclear'; // provisional; requires manual review
    if (bandCx.length) markFound++; else markUnclear++;
  }
  fs.writeFileSync(path.join(OUT, 'outer_line_review_table.json'), JSON.stringify(ROWS, null, 2));
  console.log('frames reviewed:', hasFrame, 'noFrame:', noFrame);
  console.log('automated band found:', markFound, 'no band:', markUnclear);
  console.log('NOTE: automated placement is unreliable (no camera projection); all visualMarking = unclear pending manual review.');
}
main();
