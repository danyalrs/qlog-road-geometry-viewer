'use strict';

/**
 * Verification-frame selection for the .ts video evidence stage.
 * Investigation/experiment only — read-only. Selects a manageable, spread-out
 * set of frames per segment for manual lane-line verification, covering the
 * required cases. Does not label or infer anything.
 *
 * Outputs a frame selection JSON into reports/video_verification/.
 */

const fs = require('fs');
const path = require('path');
const MANIFEST = require('../reports/video_verification/video_sync_manifest.json');

const OUT_DIR = path.join(__dirname, '..', 'reports', 'video_verification');
const TARGETS = {
  99: { total: 28, note: 'main difficult curved-road case' },
  6: { total: 18, note: 'sparse strong-turn / zero lane-2 case' },
  2: { total: 10, note: 'comparison straight/mild' },
  54: { total: 10, note: 'comparison' },
  58: { total: 10, note: 'comparison' },
};

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function selectFrames(segId, total) {
  const seg = MANIFEST.segments[String(segId)];
  if (!seg) return [];
  const matched = seg.modelV2Matches || [];
  const totalFrames = seg.video.totalDecodedFrames || 0;
  const frames = seg.video.framePts || [];
  const selected = [];

  // Strategy: pick frames around the matched ModelV2 observations (curve/
  // turn-relevant), plus spread-out anchor frames, avoiding near-duplicates.
  const picked = new Set();

  const add = (idx) => {
    if (idx < 0 || idx >= totalFrames || picked.has(idx)) return;
    picked.add(idx);
    const f = frames[idx];
    const m = matched.find((x) => x.videoFrameIndex === idx);
    selected.push({
      segmentId: segId,
      videoFrameIndex: idx,
      videoPtsSec: f ? +f.ptsSec.toFixed(6) : null,
      segmentRelativeTimeSec: f && seg.video.startTimeSec ? +(f.ptsSec - seg.video.startTimeSec).toFixed(6) : null,
      nearestModelV2FrameId: m ? m.modelV2FrameId : null,
      modelV2Timestamp: m ? m.modelV2LogMonoTime : null,
      timestampDiffMs: m ? m.tsErrorMs : null,
      movementCategory: m ? m.movementCategory : null,
      speedMps: m ? m.speedMps : null,
      headingDeg: m ? m.headingDeg : null,
      reason: '',
    });
  };

  // 1. matched strong/mild-turn observations (curve-relevant)
  const turnMatches = matched.filter((m) => m.movementCategory === 'strong' || m.movementCategory === 'mild');
  for (const m of turnMatches) {
    add(m.videoFrameIndex);
    add(m.videoFrameIndex - 1);
    add(m.videoFrameIndex + 1);
  }
  // 2. spread anchors (evenly across the segment)
  const step = Math.max(1, Math.floor(totalFrames / (total * 2)));
  for (let i = 0; i < totalFrames; i += step) add(i);
  // 3. ensure curve entry/middle/exit for the strongest-turn segment
  if (turnMatches.length) {
    const first = turnMatches[0].videoFrameIndex;
    const last = turnMatches[turnMatches.length - 1].videoFrameIndex;
    add(first - 8); add(first - 4);
    add(Math.floor((first + last) / 2));
    add(last + 4); add(last + 8);
  }

  // Trim to requested total while keeping a spread (prefer matched frames).
  const sorted = [...selected].sort((a, b) => a.videoFrameIndex - b.videoFrameIndex);
  if (sorted.length > total) {
    // keep all turn/matched frames + evenly spaced fillers
    const keepMatched = sorted.filter((s) => s.nearestModelV2FrameId != null);
    const keepOthers = sorted.filter((s) => s.nearestModelV2FrameId == null);
    const needed = total - keepMatched.length;
    const stepKeep = Math.max(1, Math.floor(keepOthers.length / Math.max(1, needed)));
    const fillers = keepOthers.filter((_, i) => i % stepKeep === 0).slice(0, Math.max(0, needed));
    selected.length = 0;
    selected.push(...keepMatched, ...fillers);
  }
  selected.sort((a, b) => a.videoFrameIndex - b.videoFrameIndex);
  // attach reasons
  const reasons = ['before curve', 'curve entry', 'curve middle', 'curve exit', 'spatial revisit', 'boundary coverage', 'no boundary', 'near topology warning', 'between sparse observations', 'straight road', 'mild turn', 'clear markings', 'weak markings', 'good candidate D', 'fragmented output'];
  selected.forEach((s, i) => {
    if (!s.reason) {
      const m = matched.find((x) => x.videoFrameIndex === s.videoFrameIndex);
      s.reason = m ? `matched ModelV2 obs ${m.movementCategory}` : `spread anchor ${i}`;
    }
  });
  return { segmentId: segId, totalFrames, selectedCount: selected.length, selected, note: TARGETS[segId]?.note };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = { generatedAt: new Date().toISOString(), targets: TARGETS, selections: {} };
  for (const [segId, t] of Object.entries(TARGETS)) {
    const sel = selectFrames(parseInt(segId, 10), t.total);
    out.selections[segId] = sel;
    const cats = {};
    for (const s of sel.selected) cats[s.movementCategory || 'none'] = (cats[s.movementCategory || 'none'] || 0) + 1;
    console.log(`seg ${segId}: selected ${sel.selectedCount} frames (${t.note}); categories=${JSON.stringify(cats)}`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'verification_frame_selection.json'), JSON.stringify(out, null, 2));
  console.log('wrote', path.join(OUT_DIR, 'verification_frame_selection.json'));
}

main();
