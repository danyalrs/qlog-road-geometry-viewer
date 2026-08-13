'use strict';

/**
 * Export selected verification frames as lossless PNG.
 * Investigation/experiment only — read-only. Extracts frames by PTS using
 * ffmpeg (no re-encode of the source; each selected frame decoded to PNG).
 * Produces for each selected frame:
 *   1. clean video frame
 *   2. frame with timestamp + segment metadata burned in
 * Mapping diagnostic overlays are NOT drawn (no validated camera projection).
 *
 * Outputs to reports/video_verification/frames/{segment}/.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const SELECTION = require('../reports/video_verification/verification_frame_selection.json');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'reports', 'video_verification', 'frames');

function videoPathFor(seg) {
  return path.join(ROOT, `f449c322f59e6943---2026-07-20--09-34-13--${seg}---qcamera.ts`);
}

function exportFrame(seg, frameIdx, outBase) {
  const ts = videoPathFor(seg);
  const args = ['-v', 'error', '-i', ts, '-vf', `select='eq(n,${frameIdx})'`, '-frames:v', '1', '-pix_fmt', 'rgb24', '-y', outBase];
  execFileSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
}

function burnMetadata(seg, frame, inPng, outPng) {
  const font = 'C\\\\:/Windows/Fonts/arial.ttf';
  const label = `seg ${seg}  frame ${frame.videoFrameIndex}  t=${frame.videoPtsSec}s`;
  const sub = frame.nearestModelV2FrameId
    ? `modelV2 ${frame.nearestModelV2FrameId}  cat=${frame.movementCategory}  err=${frame.timestampDiffMs}ms`
    : 'no matched ModelV2';
  const esc = (s) => s.replace(/:/g, '\\:').replace(/'/g, '\\\'');
  const args = ['-v', 'error', '-i', inPng, '-vf',
    `drawtext=fontfile=${font}:text='${esc(label)}':x=8:y=8:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4,` +
    `drawtext=fontfile=${font}:text='${esc(sub)}':x=8:y=30:fontsize=14:fontcolor=yellow:box=1:boxcolor=black@0.5:boxborderw=3`,
    '-y', outPng];
  execFileSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
}

function main() {
  const report = { generatedAt: new Date().toISOString(), exported: [] };
  for (const [segId, sel] of Object.entries(SELECTION.selections)) {
    const segOut = path.join(OUT_DIR, String(segId));
    fs.mkdirSync(segOut, { recursive: true });
    for (const f of sel.selected) {
      const base = `seg${segId}_frame${String(f.videoFrameIndex).padStart(5, '0')}_t${String(f.videoPtsSec).replace('.', '_')}`;
      const cleanPng = path.join(segOut, `${base}_clean.png`);
      const metaPng = path.join(segOut, `${base}_meta.png`);
      try {
        exportFrame(segId, f.videoFrameIndex, cleanPng);
        burnMetadata(segId, f, cleanPng, metaPng);
        report.exported.push({
          segmentId: segId,
          videoFrameIndex: f.videoFrameIndex,
          videoPtsSec: f.videoPtsSec,
          cleanPng, metaPng,
          nearestModelV2FrameId: f.nearestModelV2FrameId,
          movementCategory: f.movementCategory,
        });
      } catch (e) {
        report.exported.push({ segmentId: segId, videoFrameIndex: f.videoFrameIndex, error: e.message });
        console.log(`seg${segId} frame ${f.videoFrameIndex}: ERROR ${e.message.split('\n')[0]}`);
      }
      console.log(`seg${segId} frame ${f.videoFrameIndex} (t=${f.videoPtsSec}) exported`);
    }
  }
  fs.writeFileSync(path.join(ROOT, 'reports', 'video_verification', 'exported_frames.json'), JSON.stringify(report, null, 2));
  console.log('wrote reports/video_verification/exported_frames.json');
}

main();
