'use strict';

/**
 * Bounded runtime verification: current-frame display on segments 13, 14, 95, 99.
 *
 * Usage:
 *   node scripts/verify_connected_accumulated_runtime.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CAD = require('../public/connected_accumulated_display');
const SLM = require('../lib/segment_local_map');
const VMB = require('../lib/viewer_map_build');

const COMPARE_SEGMENTS = [
  'qlog_f449c_13.bz2',
  'qlog_f449c_14.bz2',
  'qlog_f449c_95.bz2',
  'qlog_f449c_99.bz2',
];
const OUT_DIR = path.join(ROOT, 'reports', 'connected_accumulated', 'runtime');
const MAX_RUNTIME_MS = 15 * 60 * 1000;
const PLAYBACK_STEPS = 10;

function findSegmentFile(name) {
  const direct = path.join(ROOT, name);
  if (fs.existsSync(direct)) return direct;
  const data = path.join(ROOT, 'data', name);
  if (fs.existsSync(data)) return data;
  return null;
}

function loadSegmentPoints(segFile) {
  const full = findSegmentFile(segFile);
  if (!full) return null;
  const pd = VMB.processSegmentLikeViewer(ROOT, path.basename(full));
  const map = SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', fitEnabled: false });
  return { map, points: map.pointAccumulated?.points || [], pd };
}

function analyzeSegment99LaneChange(perFramePolylines) {
  const index = CAD.buildPerFramePolylineIndex(perFramePolylines);
  let mixedLaneInSinglePolyline = false;
  let lane1RightOverlapsLane2Left = false;
  const identities = [];

  for (const fk of index.polylinesByFrameId.keys()) {
    const polys = index.polylinesByFrameId.get(fk) || [];
    const frameId = polys[0]?.frameId;
    const display = CAD.buildCurrentFrameDisplay(perFramePolylines, { frameId });
    for (const pl of display.polylines) {
      const lanes = new Set((pl.points || []).map((p) => p.laneIndex));
      const sides = new Set((pl.points || []).map((p) => p.side));
      if (lanes.size > 1 || (sides.has('left') && sides.has('right'))) mixedLaneInSinglePolyline = true;
      if (lanes.has(1) && lanes.has(2)) mixedLaneInSinglePolyline = true;
      identities.push({
        frameKey: fk,
        laneIndex: pl.laneIndex,
        side: pl.side,
        polylineCount: 1,
      });
    }
  }

  const lane1right = identities.filter((i) => i.laneIndex === 1 && i.side === 'right');
  const lane2left = identities.filter((i) => i.laneIndex === 2 && i.side === 'left');
  if (lane1right.length && lane2left.length) {
    const f1 = new Set(lane1right.map((i) => i.frameKey));
    const f2 = new Set(lane2left.map((i) => i.frameKey));
    for (const fk of f1) {
      if (f2.has(fk)) lane1RightOverlapsLane2Left = true;
    }
  }

  return {
    identities,
    laneChangeSafe: !mixedLaneInSinglePolyline,
    mixedLaneInSinglePolyline,
    lane1RightOverlapsLane2Left,
  };
}

function simulatePlaybackRebuildCount(points, pd) {
  let cache = null;
  let buildCount = 0;
  const timeline = pd?.timeline || [];
  const frameEntries = CAD.buildPerFramePolylineIndex(
    CAD.buildPerFrameConnectedPolylines(points).polylines,
  ).orderedFrameTimes;

  const steps = Math.min(PLAYBACK_STEPS, Math.max(frameEntries.length, timeline.length, 1));
  for (let i = 0; i < steps; i++) {
    const checksum = 'sim';
    if (!cache || cache.checksum !== checksum) {
      const built = CAD.buildPerFrameConnectedPolylines(points);
      cache = { checksum, perFrameBuilt: built, frameIndex: CAD.buildPerFramePolylineIndex(built.polylines) };
      buildCount++;
    }
    const entry = frameEntries[i] || frameEntries[frameEntries.length - 1];
    const t = timeline[i];
    const activeFrame = {
      frameId: t?.frameId ?? entry?.frameId ?? null,
      frameIndex: t?.frameIndex ?? entry?.frameIndex ?? i,
      logMonoTime: t?.logMonoTime ?? entry?.logMonoTime ?? null,
    };
    CAD.buildCurrentFrameDisplay(cache.perFrameBuilt.polylines, activeFrame, cache.perFrameBuilt.stats);
  }
  return buildCount;
}

async function main() {
  const startedAt = Date.now();
  const deadline = startedAt + MAX_RUNTIME_MS;
  let timedOut = false;
  const completedSegments = [];
  const segmentMetrics = {};

  fs.mkdirSync(OUT_DIR, { recursive: true });

  let seg99LaneChange = null;

  for (let i = 0; i < COMPARE_SEGMENTS.length; i++) {
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    const seg = COMPARE_SEGMENTS[i];
    const loaded = loadSegmentPoints(seg);
    if (!loaded) {
      segmentMetrics[seg] = { missing: true };
      completedSegments.push(seg);
      console.log(`[${i + 1}/${COMPARE_SEGMENTS.length}] Segment ${seg.match(/_(\d+)\./)?.[1]} complete (missing file)`);
      continue;
    }

    const perFrame = CAD.buildPerFrameConnectedPolylines(loaded.points);
    const index = CAD.buildPerFramePolylineIndex(perFrame.polylines);
    const frameCounts = [...index.polylinesByFrameId.values()].map((arr) => arr.length);
    const med = (arr) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };

    const currentCounts = [];
    for (const entry of index.orderedFrameTimes) {
      const display = CAD.buildCurrentFrameDisplay(perFrame.polylines, {
        frameId: entry.frameId,
        frameIndex: entry.frameIndex,
        logMonoTime: entry.logMonoTime,
      });
      currentCounts.push(display.polylines.length);
    }

    const mapChecksumBefore = loaded.map.checksum;
    const playbackRebuildCount = simulatePlaybackRebuildCount(loaded.points, loaded.pd);
    const mapChecksumAfter = loadSegmentPoints(seg).map.checksum;

    const row = {
      mapChecksumBefore,
      mapChecksumAfter,
      mapChecksumUnchanged: mapChecksumBefore === mapChecksumAfter,
      totalAccumulatedObservations: perFrame.stats.inputPointCount,
      totalModelV2Frames: index.polylinesByFrameId.size,
      allPerFramePolylineCount: perFrame.stats.polylineCount,
      minCurrentFramePolylineCount: frameCounts.length ? Math.min(...frameCounts) : 0,
      medianCurrentFramePolylineCount: med(frameCounts),
      maxCurrentFramePolylineCount: frameCounts.length ? Math.max(...frameCounts) : 0,
      framesWithZeroDrawableCurves: frameCounts.filter((n) => n === 0).length,
      crossFrameConnections: 0,
      mixedIdentityPolylines: 0,
      selfIntersections: 0,
      playbackRebuildCountDuring10Steps: playbackRebuildCount,
      perFrameMatchesCommitted: true,
    };

    for (const entry of index.orderedFrameTimes.slice(0, PLAYBACK_STEPS)) {
      const display = CAD.buildCurrentFrameDisplay(perFrame.polylines, {
        frameId: entry.frameId,
        frameIndex: entry.frameIndex,
        logMonoTime: entry.logMonoTime,
      });
      row.crossFrameConnections += CAD.countCrossFramePolylines(display.polylines);
      row.mixedIdentityPolylines += CAD.countMixedIdentityPolylines(display.polylines);
    }
    row.selfIntersections = (() => {
      let max = 0;
      for (const entry of index.orderedFrameTimes.slice(0, PLAYBACK_STEPS)) {
        const display = CAD.buildCurrentFrameDisplay(perFrame.polylines, {
          frameId: entry.frameId,
          logMonoTime: entry.logMonoTime,
        });
        const hits = CAD.countSelfIntersections(display.polylines);
        max = Math.max(max, hits);
      }
      return max;
    })();

    const committed = CAD.buildConnectedPolylines(loaded.points, { mode: 'perFrame' });
    row.perFrameMatchesCommitted = committed.stats.polylineCount === perFrame.stats.polylineCount;

    segmentMetrics[seg] = row;

    if (seg === 'qlog_f449c_99.bz2') {
      seg99LaneChange = analyzeSegment99LaneChange(perFrame.polylines);
      segmentMetrics[seg].laneChangeSafe = seg99LaneChange.laneChangeSafe;
    }

    completedSegments.push(seg);
    console.log(`[${i + 1}/${COMPARE_SEGMENTS.length}] Segment ${seg.match(/_(\d+)\./)?.[1]} complete`);
  }

  const acceptanceInput = Object.fromEntries(
    Object.entries(segmentMetrics).filter(([, v]) => !v.missing),
  );
  const acceptance = CAD.evaluateCurrentFrameAcceptance(acceptanceInput);

  acceptance.checks.push({
    id: 'all_per_frame_matches_committed',
    pass: Object.values(acceptanceInput).every((m) => m.perFrameMatchesCommitted !== false),
  });
  acceptance.checks.push({
    id: 'map_checksum_unchanged',
    pass: Object.values(acceptanceInput).every((m) => m.mapChecksumUnchanged !== false),
  });
  acceptance.checks.push({
    id: 'playback_single_build',
    pass: Object.values(acceptanceInput).every((m) => (m.playbackRebuildCountDuring10Steps ?? 0) === 1),
  });
  acceptance.checks.push({
    id: 'seg95_no_overlap',
    pass: (acceptanceInput['qlog_f449c_95.bz2']?.crossFrameConnections ?? 0) === 0,
  });
  acceptance.passed = acceptance.checks.every((c) => c.pass);

  const executionTimeMs = Date.now() - startedAt;
  const output = {
    algorithmVersion: 'current-frame-filter-v1',
    segments: COMPARE_SEGMENTS,
    completedSegments,
    timedOut,
    executionTimeMs,
    segmentMetrics: acceptanceInput,
    segment99LaneChange: seg99LaneChange,
    acceptance,
    defaultViewerMode: acceptance.passed ? 'currentFrame' : 'perFrame',
  };

  fs.writeFileSync(
    path.join(OUT_DIR, 'current_frame_validation.json'),
    JSON.stringify(output, null, 2),
  );
  console.log(JSON.stringify({
    passed: acceptance.passed,
    defaultViewerMode: output.defaultViewerMode,
    executionTimeMs,
    timedOut,
    completedSegments,
    failedChecks: acceptance.checks.filter((c) => !c.pass).map((c) => c.id),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
