'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const capnp = require('capnp-ts');
const Log = require('@commaai/log_reader/capnp/log.capnp');
const { iterateEventsFromFile } = require('../lib/qlog_decoder');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const { processRoute, buildTimeline } = require('../lib/process_route');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'reports', 'road_relative_diagnosis');

function videoPath(seg) { return path.join(ROOT, `f449c322f59e6943---2026-07-20--09-34-13--${seg}---qcamera.ts`); }
function qlogPath(seg) { return path.join(ROOT, `qlog_f449c_${seg}.bz2`); }

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const report = {};
  for (const seg of [14, 16]) {
    // build frameId -> timestampSof (ns) map from EncodeIndex
    const encodeTs = new Map();
    for (const ev of iterateEventsFromFile(qlogPath(seg))) {
      if (ev.unionTag === 14) {
        const idx = capnp.Struct.getStruct(0, Log.EncodeIndex, ev.event);
        encodeTs.set(String(idx.getFrameId()), Number(BigInt(String(idx.getTimestampSof()))));
      }
    }
    // probe video PTS list
    const csv = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', videoPath(seg)], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }).trim();
    const pts = csv.split('\n').filter((l) => l.trim()).map(parseFloat);
    // process route
    const f = `qlog_f449c_${seg}.bz2`;
    const me = extractModel(qlogPath(seg)).map((e) => ({ ...e, sourceFile: f }));
    const ge = extractGps(qlogPath(seg)).map((e) => ({ ...e, sourceFile: f }));
    const r = processRoute(me, ge, { pipelineMode: 'C' });
    const entry = { segmentId: seg, frames: [] };
    for (const idx of [0, 16, 29]) {
      const frame = r.frames[idx];
      const tsSofNs = encodeTs.get(String(frame.frameId));
      let bestFi = -1, bestErr = Infinity;
      if (tsSofNs != null) {
        const target = tsSofNs / 1e9;
        for (let i = 0; i < pts.length; i++) {
          const e = Math.abs(pts[i] - target);
          if (e < bestErr) { bestErr = e; bestFi = i; }
        }
      }
      // extract frame
      let png = null;
      if (bestFi >= 0) {
        png = path.join(OUT, `seg${seg}_idx${idx}_frame${bestFi}.png`);
        execFileSync('ffmpeg', ['-v', 'error', '-i', videoPath(seg), '-vf', `select='eq(n,${bestFi})'`, '-frames:v', '1', '-y', png], { maxBuffer: 20 * 1024 * 1024 });
      }
      entry.frames.push({
        timelineIdx: idx, frameId: frame.frameId, logMonoTime: String(frame.logMonoTime),
        videoFrameIndex: bestFi, tsErrorMs: +(bestErr * 1000).toFixed(3), png,
      });
      console.log(`seg${seg} idx${idx}: frameId=${frame.frameId} videoFrame=${bestFi} err=${(bestErr * 1000).toFixed(3)}ms ${png ? 'extracted' : 'NO FRAME'}`);
    }
    report[seg] = entry;
  }
  fs.writeFileSync(path.join(OUT, 'frame_targets.json'), JSON.stringify(report, null, 2));
}
main();
