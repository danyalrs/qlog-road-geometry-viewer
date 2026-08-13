'use strict';
/**
 * Build side-by-side annotated review images:
 *   left  = enhanced video frame
 *   right = schematic road cross-section from model lane/edge geometry
 *           (not image-overlaid; no camera projection assumed)
 * Uses ffmpeg to compose. Diagnosis-only.
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'reports', 'road_relative_diagnosis');
const DATA = require(path.join(OUT, 'road_relative_analysis.json'));

function esc(s) { return s.replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, ','); }

function drawCrossSection(rows, edges, seg, idx) {
  // produce a small PNG schematic: a horizontal road strip with lane marks at
  // model y positions (scaled: 1m = 20px), vehicle at center.
  const width = 640, height = 220;
  const scale = 22; // px per metre
  // collect extents
  const ys = rows.map((r) => r.y);
  const minY = Math.min(-1, ...ys, ...edges.map((e) => e.y));
  const maxY = Math.max(1, ...ys, ...edges.map((e) => e.y));
  // raw pixel via a tiny node script that writes a PPM then ffmpeg converts? Simpler: use ffmpeg drawgrid + drawbox per line.
  // We'll compose with drawbox (filled rect for lane marks) at computed x.
  const cx = width / 2; // vehicle at center
  const toX = (y) => Math.round(cx - y * scale); // +y(left) -> left of center
  const marks = [];
  const colors = { 0: '0x2563eb', 1: '0xdc2626', 2: '0x16a34a', 3: '0xca8a04' };
  for (const r of rows) {
    const x = toX(r.y);
    const w = 6;
    marks.push(`drawbox=x=${x - w / 2}:y=80:w=${w}:h=60:color=${colors[r.laneIndex] ?? '0x888888'}@0.9:t=fill`);
  }
  for (const e of edges) {
    const x = toX(e.y);
    marks.push(`drawbox=x=${x - 2}:y=60:w=4:h=100:color=0x888888@0.6:t=fill`);
  }
  // vehicle marker at center
  marks.push(`drawbox=x=${cx - 4}:y=70:w=8:h=80:color=0x111111@0.8:t=fill`);
  // labels per mark
  const labels = [];
  for (const r of rows) {
    const x = toX(r.y);
    labels.push(`drawtext=fontfile=C\\\\:/Windows/Fonts/arial.ttf:text='L${r.laneIndex} T${r.trackId} ${r.prob}':x=${Math.max(4, x - 30)}:y=${height - 26}:fontsize=11:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=2`);
  }
  const edgeLabels = [];
  for (const e of edges) {
    const x = toX(e.y);
    edgeLabels.push(`drawtext=fontfile=C\\\\:/Windows/Fonts/arial.ttf:text='E${e.edgeIndex}':x=${Math.max(4, x - 10)}:y=44:fontsize=10:fontcolor=0xCCCCCC:box=1:boxcolor=black@0.5:boxborderw=2`);
  }
  const header = `drawtext=fontfile=C\\\\:/Windows/Fonts/arial.ttf:text='seg${seg} idx${idx} vehicle-in-lane (model) cross-section (right side = -y)':x=8:y=8:fontsize=13:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=3`;
  const vf = ['drawbox=x=0:y=0:w=' + width + ':h=' + height + ':color=0x222222@0.9:t=fill',
    `drawbox=x=0:y=0:w=${width}:h=${height}:color=0x333333:t=fill`,
    ...marks, header, ...labels, ...edgeLabels].join(',');
  const png = path.join(OUT, `seg${seg}_idx${idx}_schematic.png`);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=size=${width}x${height}:rate=1:duration=0.04`, '-vf', vf, '-frames:v', '1', '-y', png], { maxBuffer: 20 * 1024 * 1024 });
  return png;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const done = [];
  for (const [seg, r] of Object.entries(DATA)) {
    for (const fr of r.frames) {
      const vid = path.join(OUT, `seg${seg}_idx${fr.timelineIdx}_frame${fr.videoFrameIndex}.png`);
      const enh = path.join(OUT, `seg${seg}_idx${fr.timelineIdx}_enh.png`);
      const schematic = drawCrossSection(fr.lanes, fr.edges, seg, fr.timelineIdx);
      // compose side by side: video (resized 480) + schematic (640) = 1120 wide
      const composite = path.join(OUT, `seg${seg}_idx${fr.timelineIdx}_annotated.png`);
      execFileSync('ffmpeg', ['-v', 'error', '-i', enh, '-i', schematic, '-filter_complex',
        '[0:v]scale=480:270[v0];[1:v]scale=560:270[v1];[v0][v1]hstack=2',
        '-frames:v', '1', '-y', composite], { maxBuffer: 30 * 1024 * 1024 });
      done.push(composite);
      console.log('wrote', path.basename(composite));
    }
  }
  console.log('annotated images:', done.length);
}
main();
