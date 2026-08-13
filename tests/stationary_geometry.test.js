'use strict';

/**
 * Regression tests: fully-stationary segments must still produce drawable
 * local lane geometry (fusion-v16 two-pass pose-lock correction).
 *
 * Before the fix, Segment 9 (fully stationary) reported
 *   valid=false, reason='noGeometry'   (renderer drew "Stationary local map
 *   unavailable") even though 910 valid lane observations had been
 *   accumulated. Root cause: the map validity gate in buildSegmentLocalMap
 *   only checked laneFragments/edgeFragments/roadSurfacePolygons/trajectory;
 *   it never counted the point-accumulated cloud, which is the drawable
 *   geometry in Point-accumulated mode. A fully stationary segment also builds
 *   a zero-length reference trajectory (all poses locked to one anchor), which
 *   collapsed every observation onto s=0,d=0 and prevented constructed
 *   fragments from forming.
 *
 * Fix:
 *  1. hasDrawableGeometry includes pointAccumulated.points.length > 0, so
 *     `noGeometry` means EVERY drawable layer is empty.
 *  2. A degenerate (zero-length) reference trajectory is treated as absent, so
 *     s/d fall back to the fixed-anchor forward/lateral frame (s = forward
 *     distance, d = lateral offset), preserving lane geometry extent.
 *
 * No artificial vehicle motion is introduced and the mapping pose stays at the
 * stationary anchor.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SLM = require('../lib/segment_local_map');
const PA = require('../lib/point_accumulation');
const { computeStationaryPoseLock } = require('../lib/stationary_pose_lock');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');

function runSegment(seg) {
  const f = `qlog_f449c_${seg}.bz2`;
  const segPath = path.join(ROOT, f);
  if (!fs.existsSync(segPath)) return null;
  const me = extractModel(segPath).map((e) => ({ ...e, sourceFile: f }));
  const ge = extractGps(segPath).map((e) => ({ ...e, sourceFile: f }));
  const r = processRoute(me, ge, { pipelineMode: 'C' });
  r.timeline = buildTimeline(r.frames);
  return r;
}

function buildPointMap(r) {
  return SLM.buildSegmentLocalMap(
    { ...r, processingOptions: r.processingOptions },
    { geometrySource: 'pointAccumulated', timelineIndex: 0, chunkId: 0, passId: 0 },
  );
}

const SEG9 = runSegment('9');
const SEG6 = runSegment('6');

describe('stationary segment 9 — local lane geometry present after pose lock', () => {
  it('1. a fully stationary segment can output local lane geometry', () => {
    if (!SEG9) return;
    const map = buildPointMap(SEG9);
    assert.equal(map.valid, true, 'map must be valid (has drawable points)');
    assert.equal(map.reason, null, 'reason must not be noGeometry');
    assert.ok(map.pointAccumulatedPointCount > 0, 'accumulated point cloud non-empty');
    assert.ok((map.pointAccumulated?.points || []).length > 0);
  });

  it('2. zero vehicle travel does not imply zero observed road extent', () => {
    if (!SEG9) return;
    const map = buildPointMap(SEG9);
    const pts = map.pointAccumulated?.points || [];
    assert.ok(pts.length >= 100, `expected a large cloud, got ${pts.length}`);
    const forward = pts.map((p) => p.localEast);
    const span = Math.max(...forward) - Math.min(...forward);
    assert.ok(span > 50, `forward extent should exceed 50 m, got ${span.toFixed(1)} m`);
    const lateral = pts.map((p) => p.localNorth);
    const latSpan = Math.max(...lateral) - Math.min(...lateral);
    assert.ok(latSpan > 1, `lateral extent should exist, got ${latSpan.toFixed(2)} m`);
  });

  it('3. fixed mapping poses preserve lane-point forward coordinates', () => {
    if (!SEG9) return;
    const map = buildPointMap(SEG9);
    const pts = map.pointAccumulated?.points || [];
    const forwardMin = Math.min(...pts.map((p) => p.modelX));
    const forwardMax = Math.max(...pts.map((p) => p.modelX));
    assert.ok(forwardMax > 100, `forward modelX should extend past 100 m, got ${forwardMax.toFixed(1)}`);
    assert.ok(forwardMin <= 1, 'forward should start near the vehicle');
    // modelX (vehicle-relative forward) must be preserved through the anchor.
    const atFar = pts.filter((p) => p.modelX > 80);
    assert.ok(atFar.length > 0, 'points far ahead of the vehicle exist');
  });

  it('4. repeated observations from one pose are not all discarded', () => {
    if (!SEG9) return;
    const map = buildPointMap(SEG9);
    const st = map.pointAccumulated?.stats;
    assert.ok(st && st.displayedPoints === st.totalValidSourcePoints, 'parity must be 100%');
    assert.ok(st.displayedPoints > 500);
    assert.ok((st.repeatedSupportCount ?? 0) > 500, 'most points have repeated-frame support');
  });

  it('5. partial lane geometry renders (with or without a road polygon)', () => {
    if (!SEG9) return;
    const map = buildPointMap(SEG9);
    // Seg9 has one supported ego-lane boundary pair (lane1 ego-right, 30 frames;
    // lane2 ego-left, frames 4/28/29) -> a stationary local polygon may form
    // between them. Regardless of polygon availability, the point cloud must
    // remain drawable.
    assert.ok(map.pointAccumulatedPointCount > 0, 'points still drawable');
    assert.equal(map.pointAccumulatedPointCount, 910);
    // If a polygon formed it must be the ego-lane corridor pair (never a
    // fabricated opposite boundary).
    for (const poly of map.roadSurfacePolygons || []) {
      assert.ok(poly.sourceLeftLaneIndex != null && poly.sourceRightLaneIndex != null,
        'polygon must have identified source boundaries');
      assert.notEqual(poly.sourceLeftLaneIndex, poly.sourceRightLaneIndex,
        'polygon must span two distinct boundaries');
    }
  });

  it('6. noGeometry appears only when every drawable geometry layer is empty', () => {
    // A frame with a valid pose but NO lanes/edges/path/points: every drawable
    // layer is empty -> noGeometry.
    const empty = SLM.buildSegmentLocalMap(
      {
        frames: [{
          frameId: 1, logMonoTime: '1', chunkId: 0, passId: 0,
          pose: { east: 0, north: 0, headingDeg: 90 },
          lanes: [], edges: [], path: null,
        }],
        timeline: [{ logMonoTime: '1', chunkId: 0, passId: 0 }],
        routeChunks: [{ chunkId: 0, vehiclePath: [{ east: 0, north: 0, logMonoTime: '1' }], fusedLaneLines: [] }],
        processingOptions: {},
      },
      { geometrySource: 'pointAccumulated', timelineIndex: 0, chunkId: 0, passId: 0 },
    );
    assert.equal(empty.valid, false);
    assert.equal(empty.reason, 'noGeometry');
    // A cloud with one real point must be valid.
    const one = SLM.buildSegmentLocalMap(
      {
        frames: [{
          frameId: 1, logMonoTime: '1', chunkId: 0, passId: 0,
          pose: { east: 0, north: 0, headingDeg: 90 },
          lanes: [{ laneIndex: 1, prob: 0.6, laneTrackId: 0,
            points: [{ east: 0, north: 0, modelX: 0, modelY: -1.5, modelZ: 0, t: 0 },
              { east: 5, north: 0, modelX: 5, modelY: -1.5, modelZ: 0, t: 1 }] }],
        }],
        timeline: [{ logMonoTime: '1', chunkId: 0, passId: 0 }],
        routeChunks: [{ chunkId: 0, vehiclePath: [], fusedLaneLines: [] }],
        processingOptions: {},
      },
      { geometrySource: 'pointAccumulated', timelineIndex: 0, chunkId: 0, passId: 0 },
    );
    assert.equal(one.valid, true, 'a single valid lane observation is drawable geometry');
    assert.equal(one.reason, null);
  });

  it('7. tracking diagnostics and playback-frame track counts are consistent', () => {
    if (!SEG9) return;
    const chunk = SEG9.routeChunks[0];
    const summary = chunk?.laneTrackingSummary?.passes?.[0];
    assert.ok(summary, 'tracking summary present');
    assert.ok(summary.createdTracks >= 1, 'tracks were created while stationary');
    assert.ok((summary.continuedTracks ?? 0) >= 1);
    assert.equal(summary.rejectedMatches, 0);
    // Frame-level track assignment must match a subset of created track IDs.
    const trackedLaneIds = new Set();
    for (const f of SEG9.frames) {
      for (const l of f.lanes || []) if (l.laneTrackId != null) trackedLaneIds.add(l.laneTrackId);
    }
    for (const tid of trackedLaneIds) {
      assert.ok((summary.tracks || []).some((t) => t.trackId === tid),
        `frame track ${tid} must exist in the tracking summary`);
    }
  });

  it('8. causal playback does not expose future observations', () => {
    if (!SEG9) return;
    const map = buildPointMap(SEG9);
    const pts = map.pointAccumulated?.points || [];
    const at0 = pts.filter((p) => p.frameIndex <= 0);
    const at10 = pts.filter((p) => p.frameIndex <= 10);
    assert.ok(at0.length > 0);
    assert.ok(at0.every((p) => p.frameIndex === 0), 'frame-0 causal set contains only frame-0');
    assert.ok(at10.length > at0.length, 'points accumulate as the timeline advances');
  });

  it('9. complete-map mode includes all accepted stationary observations', () => {
    if (!SEG9) return;
    const map = buildPointMap(SEG9);
    let raw = 0;
    for (const f of SEG9.frames) {
      for (const l of f.lanes || []) raw += (l.points || []).length;
    }
    assert.equal(map.pointAccumulatedPointCount, raw, 'complete map equals raw source set');
  });

  it('10. a foreground vehicle may reduce evidence but does not suppress unrelated visible boundaries', () => {
    if (!SEG9) return;
    // Lane 1 (ego boundary) is observed in ALL frames; lanes 0/2 only appear in
    // a few frames (occlusion). All accepted observations must still be drawn.
    const map = buildPointMap(SEG9);
    const pts = map.pointAccumulated?.points || [];
    const laneIndexes = new Set(pts.map((p) => p.laneIndex));
    assert.ok(laneIndexes.size >= 2, `expected >= 2 boundaries, got ${[...laneIndexes]}`);
    const lane1 = pts.filter((p) => p.laneIndex === 1);
    assert.ok(lane1.length > 500, `lane 1 (visible throughout) must be well represented, got ${lane1.length}`);
  });

  it('11. no artificial vehicle movement is introduced', () => {
    if (!SEG9) return;
    const locked = SEG9.frames.filter((f) => f.pose?.stationaryLocked);
    assert.ok(locked.length > 20, 'most frames locked');
    const poses = locked.map((f) => f.pose);
    const east0 = poses[0].east, north0 = poses[0].north, head0 = poses[0].headingDeg;
    for (const p of poses) {
      assert.equal(p.east, east0);
      assert.equal(p.north, north0);
      assert.equal(p.headingDeg, head0);
    }
    // mapping travel is exactly zero while locked
    const map = buildPointMap(SEG9);
    const traj = map.trajectory || [];
    if (traj.length >= 2) {
      let travel = 0;
      for (let i = 1; i < traj.length; i++) travel += Math.hypot(traj[i].east - traj[i - 1].east, traj[i].north - traj[i - 1].north);
      assert.ok(travel < 1e-6, 'no artificial trajectory travel');
    }
  });

  it('12. Segment 6 pose-lock behaviour remains unchanged', () => {
    if (!SEG6) return;
    const map = buildPointMap(SEG6);
    assert.equal(map.valid, true);
    const locked6 = SEG6.frames.filter((f) => f.pose?.stationaryLocked);
    assert.ok(locked6.length >= 15, 'seg 6 retains its stationary lock');
    assert.ok(map.pointAccumulatedPointCount > 0, 'seg 6 still produces points');
  });

  it('13. constructed fragments preserve partial stationary geometry', () => {
    if (!SEG9) return;
    const map = buildPointMap(SEG9);
    const cf = map.pointAccumulated?.constructedFragments;
    assert.ok(cf && cf.fragments.length >= 1, 'at least one constructed fragment');
    for (const f of cf.fragments) {
      assert.ok(f.points.length >= 2, 'fragment has a polyline');
      assert.ok(f.lengthM > 10, `fragment has meaningful length, got ${f.lengthM}`);
    }
    // No artificial opposite boundary: boundaries remain distinct groups.
    const groups = new Set(cf.fragments.map((f) => f.groupTrackId));
    assert.ok(groups.size >= 1);
  });
});

describe('stationary geometry — degenerate trajectory fallback', () => {
  it('a zero-length reference trajectory does not collapse s/d to zero', () => {
    const ref = { east: 0, north: 0, headingDeg: 90 };
    const vehiclePath = Array.from({ length: 6 }, () => ({ east: 1, north: 2, logMonoTime: '1' }));
    const built = PA.buildReferenceTrajectory(vehiclePath);
    assert.equal(built.totalLength, 0, 'trajectory is degenerate');
    const frames = [{
      frameId: 1, logMonoTime: '1', chunkId: 0, passId: 0,
      lanes: [{
        laneIndex: 1, laneTrackId: 0, prob: 0.6,
        points: [
          { east: 1, north: 2, modelX: 0, modelY: -1.5, modelZ: 0, t: 0 },
          { east: 51, north: 2, modelX: 50, modelY: -1.5, modelZ: 0, t: 1 },
          { east: 101, north: 2, modelX: 100, modelY: -1.5, modelZ: 0, t: 2 },
        ],
      }],
    }];
    const acc = PA.accumulatePointObservations({
      frames, timeline: [], referencePose: ref, chunkId: 0, passId: 0,
      trajectory: built, options: {},
    });
    const sVals = acc.observations.map((o) => o.s);
    assert.ok(Math.max(...sVals) > 80, 'forward s must be preserved, not collapsed to 0');
  });
});
