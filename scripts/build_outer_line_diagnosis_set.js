'use strict';
/**
 * Build the outer-line diagnosis set across all segments with synchronized
 * video. For each segment, identify L0 (right outer) and L3 (left outer)
 * predictions with meaningful support, and pick a representative observation
 * with its synchronized video frame index.
 * Signals recorded: prob, std, temporal support, lateral dist from ego
 * boundary, dist from corresponding roadEdge, roadEdgeStd, opposite-outer
 * support, Candidate D presence.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const capnp = require('capnp-ts');
const Log = require('@commaai/log_reader/capnp/log.capnp');
const { iterateEventsFromFile } = require('../lib/qlog_decoder');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const { processRoute, buildTimeline } = require('../lib/process_route');
const SLM = require('../lib/segment_local_map');
const EB = require('../lib/experimental_boundaries');

const ROOT = path.join(__dirname, '..');

function videoPath(seg) { return path.join(ROOT, `f449c322f59e6943---2026-07-20--09-34-13--${seg}---qcamera.ts`); }
function qlogPath(seg) { return path.join(ROOT, `qlog_f449c_${seg}.bz2`); }

function encodeTsMap(seg) {
  const map = new Map();
  for (const ev of iterateEventsFromFile(qlogPath(seg))) {
    if (ev.unionTag === 14) {
      const idx = capnp.Struct.getStruct(0, Log.EncodeIndex, ev.event);
      map.set(String(idx.getFrameId()), Number(BigInt(String(idx.getTimestampSof()))));
    }
  }
  return map;
}

function videoFrameIndexForTs(seg, targetNs) {
  const csv = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', videoPath(seg)], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }).trim();
  const pts = csv.split('\n').filter((l) => l.trim()).map(parseFloat);
  const target = targetNs / 1e9;
  let best = -1, be = Infinity;
  for (let i = 0; i < pts.length; i++) { const e = Math.abs(pts[i] - target); if (e < be) { be = e; best = i; } }
  return { frameIndex: best, errMs: +(be * 1000).toFixed(3) };
}

function main() {
  const files = fs.readdirSync('.').filter((f) => /^qlog_f449c_(\d+)\.bz2$/.test(f));
  const out = {};
  for (const f of files) {
    const seg = parseInt(f.match(/^qlog_f449c_(\d+)\.bz2$/)[1], 10);
    if (!fs.existsSync(videoPath(seg))) continue;
    const me = extractModel(qlogPath(seg)).map((e) => ({ ...e, sourceFile: f }));
    const ge = extractGps(qlogPath(seg)).map((e) => ({ ...e, sourceFile: f }));
    const r = processRoute(me, ge, { pipelineMode: 'C' });
    if (!r.frames.length) continue;
    // Candidate D boundary sections for lane1/2
    const paOut = SLM.buildSegmentLocalMap(r, { geometrySource: 'pointAccumulated', timelineIndex: 16 });
    const eb = EB.buildExperimentalBoundaries(paOut.pointAccumulated?.points || [], { candidate: 'D' });
    const dSections = { lane1: (eb.lanes?.[1]?.sections || []).length, lane2: (eb.lanes?.[2]?.sections || []).length };
    const enc = encodeTsMap(seg);
    // per-lane stats
    const laneStats = { 0: { ys: [], probs: [], stds: [], frames: [] }, 1: { ys: [], probs: [], stds: [], frames: [] }, 2: { ys: [], probs: [], stds: [], frames: [] }, 3: { ys: [], probs: [], stds: [], frames: [] } };
    const edgeYs = { right: [], left: [] };
    let repFrame = null; // a representative frame with outer-line support
    for (let i = 0; i < r.frames.length; i++) {
      const frame = r.frames[i];
      const mv = me[i]?.modelV2;
      const rawProbs = mv?.laneLineProbs || [];
      const rawStds = mv?.laneLineStds || [];
      for (const l of frame.lanes || []) {
        const p = (l.points || []).filter((q) => Math.abs(q.modelX) < 4).sort((a, b) => Math.abs(a.modelX) - Math.abs(b.modelX))[0];
        if (!p) continue;
        if (laneStats[l.laneIndex]) {
          laneStats[l.laneIndex].ys.push(p.modelY);
          laneStats[l.laneIndex].probs.push(l.prob ?? 0);
          laneStats[l.laneIndex].stds.push(rawStds[l.laneIndex] ?? 1);
          laneStats[l.laneIndex].frames.push(frame.frameId);
        }
      }
      for (const e of frame.edges || []) {
        const p = (e.points || []).filter((q) => Math.abs(q.modelX) < 4).sort((a, b) => Math.abs(a.modelX) - Math.abs(b.modelX))[0];
        if (p) { if (p.modelY < 0) edgeYs.right.push(p.modelY); else edgeYs.left.push(p.modelY); }
      }
      if (!repFrame && (laneStats[0].ys.length && laneStats[0].frames.length)) repFrame = i;
      if (!repFrame && (laneStats[3].ys.length && laneStats[3].frames.length)) repFrame = i;
    }
    if (repFrame == null) repFrame = 0;
    const agg = (s) => s.ys.length ? { n: s.ys.length, meanProb: +(s.probs.reduce((a, b) => a + b, 0) / s.ys.length).toFixed(3), meanStd: +(s.stds.reduce((a, b) => a + b, 0) / s.ys.length).toFixed(3), meanY: +(s.ys.reduce((a, b) => a + b, 0) / s.ys.length).toFixed(2), frames: new Set(s.frames).size } : null;
    const lane = { 0: agg(laneStats[0]), 1: agg(laneStats[1]), 2: agg(laneStats[2]), 3: agg(laneStats[3]) };
    const rightEdgeMean = edgeYs.right.length ? edgeYs.right.reduce((a, b) => a + b, 0) / edgeYs.right.length : null;
    const leftEdgeMean = edgeYs.left.length ? edgeYs.left.reduce((a, b) => a + b, 0) / edgeYs.left.length : null;
    // representative observation for sync
    const repFrameId = r.frames[repFrame].frameId;
    const encNs = enc.get(String(repFrameId));
    let vf = null;
    if (encNs != null) vf = videoFrameIndexForTs(seg, encNs);
    out[f] = {
      seg,
      frames: r.frames.length,
      lanes: lane,
      rightEdgeY: rightEdgeMean != null ? +rightEdgeMean.toFixed(2) : null,
      leftEdgeY: leftEdgeMean != null ? +leftEdgeMean.toFixed(2) : null,
      repTimelineIdx: repFrame,
      repFrameId,
      repVideoFrame: vf,
      candidateD: dSections,
    };
  }
  fs.mkdirSync(path.join(ROOT, 'reports', 'outer_line_diagnosis'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'reports', 'outer_line_diagnosis', 'diagnosis_set.json'), JSON.stringify(out, null, 2));
  console.log('wrote reports/outer_line_diagnosis/diagnosis_set.json for', Object.keys(out).length, 'segments');
}
main();
