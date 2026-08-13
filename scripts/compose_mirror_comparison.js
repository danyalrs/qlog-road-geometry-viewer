'use strict';
/**
 * Compose three-panel comparison images: synchronized video | current display |
 * mirrored display, for the mirror-diagnosis report (Segments 14, 16).
 */
const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const MD = path.join(ROOT, 'reports', 'mirror_diagnosis');
const RRD = path.join(ROOT, 'reports', 'road_relative_diagnosis');

function hstack(panels, out) {
  // panels: array of image paths; force same height, hstack
  const inputs = [];
  const filter = [];
  panels.forEach((p, i) => { inputs.push('-i', p); filter.push(`[${i}:v]scale=420:270[v${i}]`); });
  const stack = panels.map((_, i) => `[v${i}]`).join('') + `hstack=3`;
  execFileSync('ffmpeg', ['-v', 'error', ...inputs, '-filter_complex', filter.join(';') + ';' + stack, '-frames:v', '1', '-y', out], { maxBuffer: 30 * 1024 * 1024 });
}

function main() {
  fs.mkdirSync(MD, { recursive: true });
  for (const seg of [14, 16]) {
    const video = path.join(RRD, `seg${seg}_idx16_enh.png`);
    const current = path.join(MD, `qlog_f449c_${seg}_idx16_current.png`);
    const mirrored = path.join(MD, `qlog_f449c_${seg}_idx16_mirrored.png`);
    const out = path.join(MD, `seg${seg}_idx16_video_current_mirrored.png`);
    if (!fs.existsSync(video) || !fs.existsSync(current) || !fs.existsSync(mirrored)) { console.log('missing panel for seg', seg); continue; }
    hstack([video, current, mirrored], out);
    console.log('wrote', out);
  }
}
main();
