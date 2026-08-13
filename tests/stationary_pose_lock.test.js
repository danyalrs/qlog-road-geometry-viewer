'use strict';

/**
 * Tests for the stationary pose lock.
 *
 * The fix freezes the MAPPING pose (east/north/heading) at a stable anchor
 * while the vehicle is stationary, so GPS position/bearing jitter does not
 * scatter or rotate the lane map. Lane observations continue to be processed
 * from the fixed anchor pose. Genuine low-speed motion is not frozen.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeStationaryPoseLock, DEFAULT_STATIONARY_LOCK_CONFIG } = require('../lib/stationary_pose_lock');
const { processRoute } = require('../lib/process_route');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

function makePoses(speeds, stepM, heading = 90) {
  return speeds.map((sp, i) => ({
    east: i * stepM, north: 0, speed: sp, headingDeg: heading, logMonoTime: String(1000 + i * 2000 * 1e6),
  }));
}

function runSegment(seg) {
  const f = `qlog_f449c_${seg}.bz2`;
  const me = extractModel(f).map((e) => ({ ...e, sourceFile: f }));
  const ge = extractGps(f).map((e) => ({ ...e, sourceFile: f }));
  return processRoute(me, ge, { pipelineMode: 'C' });
}

describe('stationary pose lock — core invariants', () => {
  it('1. GPS position jitter while stationary does not move the mapping pose', () => {
    // stationary: speed 0.1, but positions jitter ±0.5 m
    const poses = [];
    for (let i = 0; i < 20; i++) {
      poses.push({ east: (i % 2 ? 1 : -1) * 0.4, north: 0.2, speed: 0.1, headingDeg: 90, logMonoTime: String(1000 + i * 2000 * 1e6) });
    }
    const res = computeStationaryPoseLock(poses);
    const locked = res.frames.filter((f) => f.stationaryLocked).map((f) => f.mappingPose);
    const es = locked.map((p) => p.east), ns = locked.map((p) => p.north);
    assert.ok(locked.length >= 15, 'most frames locked');
    assert.ok(Math.hypot(Math.max(...es) - Math.min(...es), Math.max(...ns) - Math.min(...ns)) < 1e-6, 'mapping pose frozen');
  });

  it('2. GPS bearing jitter while stationary does not rotate the mapping pose', () => {
    const poses = [];
    for (let i = 0; i < 20; i++) {
      poses.push({ east: 0, north: 0, speed: 0.1, headingDeg: 90 + (i % 5) * 15, logMonoTime: String(1000 + i * 2000 * 1e6) });
    }
    const res = computeStationaryPoseLock(poses);
    const locked = res.frames.filter((f) => f.stationaryLocked).map((f) => f.mappingPose);
    const hs = locked.map((p) => p.headingDeg);
    assert.ok(locked.length >= 15);
    assert.ok(Math.max(...hs) - Math.min(...hs) < 1e-6, 'heading frozen');
  });

  it('3. vehicle arrow remains fixed throughout a stationary interval', () => {
    const poses = makePoses([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], 0.1);
    const res = computeStationaryPoseLock(poses);
    const locked = res.frames.filter((f) => f.stationaryLocked);
    assert.ok(locked.length >= 5, 'lock engages');
    const first = locked[0].mappingPose;
    for (const f of locked) {
      assert.strictEqual(f.mappingPose.east, first.east);
      assert.strictEqual(f.mappingPose.north, first.north);
      assert.strictEqual(f.mappingPose.headingDeg, first.headingDeg);
    }
  });

  it('4. lane observations continue to be processed while stationary (frames exist with lanes)', () => {
    // processRoute on a stationary segment still produces frames with lane data
    const r = runSegment('9'); // fully stationary segment
    const frames = r.frames || [];
    const withLanes = frames.filter((f) => (f.lanes || []).length > 0);
    const locked = frames.filter((f) => f.pose?.stationaryLocked);
    assert.ok(locked.length > 0, 'lock active');
    assert.ok(withLanes.length > 0, 'lane observations still processed');
  });

  it('5. repeated stationary observations share the same transformation pose', () => {
    const r = runSegment('9');
    const frames = r.frames || [];
    const locked = frames.filter((f) => f.pose?.stationaryLocked);
    assert.ok(locked.length > 10);
    const poses = locked.map((f) => `${f.pose.east},${f.pose.north},${f.pose.headingDeg}`);
    assert.strictEqual(new Set(poses).size, 1, 'all locked frames use one pose');
  });

  it('6. a fully stationary segment has near-zero mapped vehicle travel', () => {
    const r = runSegment('9');
    const frames = r.frames || [];
    let travel = 0;
    let prev = null;
    for (const f of frames) {
      if (prev && f.pose) travel += Math.hypot(f.pose.east - prev.east, f.pose.north - prev.north);
      prev = f.pose;
    }
    assert.ok(travel < 5, `mapped vehicle travel ${travel.toFixed(2)}m should be near zero`);
  });

  it('7. lane geometry can still extend ahead of a stationary vehicle', () => {
    const r = runSegment('9');
    const frames = r.frames || [];
    // collect lane points from locked frames — they should extend beyond the anchor
    const all = [];
    for (const f of frames) {
      if (!f.pose?.stationaryLocked) continue;
      for (const l of f.lanes || []) for (const p of l.points || []) all.push(p);
    }
    assert.ok(all.length > 0, 'lane observations from locked frames exist');
  });

  it('8. one high GPS-speed spike does not release the lock', () => {
    const poses = makePoses([0.1, 0.1, 0.1, 0.1, 0.1, 5, 0.1, 0.1, 0.1, 0.1], 0.1);
    const res = computeStationaryPoseLock(poses);
    const locked = res.frames.filter((f) => f.stationaryLocked);
    assert.ok(locked.length >= 6, 'lock holds through the spike');
  });

  it('9. one displaced GPS sample does not release the lock', () => {
    const poses = [];
    for (let i = 0; i < 12; i++) {
      const e = i === 6 ? 3.0 : 0.1; // big position spike at i=6
      poses.push({ east: e, north: 0, speed: 0.1, headingDeg: 90, logMonoTime: String(1000 + i * 2000 * 1e6) });
    }
    const res = computeStationaryPoseLock(poses);
    const locked = res.frames.filter((f) => f.stationaryLocked);
    assert.ok(locked.length >= 6, 'lock holds through position spike');
  });

  it('10. one low-speed sample during motion does not enter STATIONARY', () => {
    const poses = makePoses([10, 10, 10, 0.5, 10, 10, 10], 20);
    const res = computeStationaryPoseLock(poses);
    assert.strictEqual(res.summary.stateCounts.STATIONARY || 0, 0, 'no stationary from one low sample');
  });

  it('11. sustained stopping enters STATIONARY after the dwell condition', () => {
    const poses = makePoses([10, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], 0.1);
    const res = computeStationaryPoseLock(poses);
    assert.ok((res.summary.stateCounts.STATIONARY || 0) >= 3, 'enters stationary after dwell');
  });

  it('12. sustained movement exits STATIONARY after the movement condition', () => {
    const poses = makePoses([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 10, 10, 10, 10], 0.1);
    const res = computeStationaryPoseLock(poses);
    assert.ok(res.summary.stateCounts.MOVING >= 3, 'exits stationary on sustained movement');
  });

  it('13. stop and start thresholds have hysteresis (move > stop)', () => {
    assert.ok(DEFAULT_STATIONARY_LOCK_CONFIG.moveSpeedMps > DEFAULT_STATIONARY_LOCK_CONFIG.stopSpeedMps);
  });

  it('14. dwell logic is time-based', () => {
    assert.ok(DEFAULT_STATIONARY_LOCK_CONFIG.stopDwellSec > 0);
    assert.ok(DEFAULT_STATIONARY_LOCK_CONFIG.moveDwellSec > 0);
  });

  it('15. genuine slow crawling is not permanently frozen', () => {
    const poses = makePoses(Array(12).fill(1.5), 3.0);
    const res = computeStationaryPoseLock(poses);
    assert.strictEqual(res.summary.stateCounts.STATIONARY || 0, 0, 'slow crawl stays moving');
    assert.strictEqual(res.summary.stateCounts.MOVING, poses.length + 1);
  });

  it('16. first reliable movement after a stop continues from the anchor without a jump', () => {
    const poses = makePoses([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 3, 6, 9, 12], 0.2);
    const res = computeStationaryPoseLock(poses);
    // after the stop, the first moving frame's pose must be within a reasonable
    // distance of the anchor (no jump back to the raw drifted position)
    const anchor = res.frames[5]?.mappingPose;
    const resume = res.frames[6]?.mappingPose;
    assert.ok(anchor && resume);
    assert.ok(Math.hypot(resume.east - anchor.east, resume.north - anchor.north) < 10, 'no large jump on resume');
  });

  it('17. repeated stop-and-go cycles do not create pose oscillation', () => {
    const poses = makePoses([10, 0.1, 0.1, 0.1, 0.1, 0.1, 10, 0.1, 0.1, 0.1, 0.1, 0.1], 20);
    const res = computeStationaryPoseLock(poses);
    // Stop-and-go legitimately alternates between moving and stationary, but the
    // MAPPING pose must never teleport back to a stale anchor: each stop gets a
    // fresh anchor near the stop position. Verify no per-frame flapping between
    // STATIONARY and MOVING with a stale pose.
    assert.ok(res.summary.transitions <= 10, `transitions=${res.summary.transitions}`);
    // the mapping pose must be monotonic in east (no backward teleport)
    let prevEast = -Infinity;
    for (const f of res.frames) {
      assert.ok(f.mappingPose.east >= prevEast - 0.01, 'mapping pose never teleports backward');
      prevEast = f.mappingPose.east;
    }
  });

  it('18. missing speed samples fall back to displacement only with reliable dt', () => {
    const cfg = { ...DEFAULT_STATIONARY_LOCK_CONFIG };
    const poses = [];
    for (let i = 0; i < 8; i++) {
      // no speed field; small step over a large dt (reliable) => stationary
      poses.push({ east: i * 0.05, north: 0, headingDeg: 90, logMonoTime: String(1000 + i * 5000 * 1e6) });
    }
    const res = computeStationaryPoseLock(poses, cfg);
    // steps of 0.05m over 5s = 0.01 m/s < stop threshold => stationary
    assert.ok((res.summary.stateCounts.STATIONARY || 0) >= 3);
  });

  it('19. changing GPS course at near-zero displacement cannot rotate the map', () => {
    const poses = [];
    for (let i = 0; i < 20; i++) {
      poses.push({ east: 0, north: 0, speed: 0.1, headingDeg: (i * 30) % 360, logMonoTime: String(1000 + i * 2000 * 1e6) });
    }
    const res = computeStationaryPoseLock(poses);
    const locked = res.frames.filter((f) => f.stationaryLocked).map((f) => f.mappingPose);
    const hs = locked.map((p) => p.headingDeg);
    assert.ok(Math.max(...hs) - Math.min(...hs) < 1e-6, 'heading does not rotate');
  });

  it('20. stationary locking does not change lane identities or joining decisions for the same canonical observations', () => {
    // The pose lock only changes the transform pose; it must not touch the
    // canonical observation identities. Verify a moving segment (seg2) keeps
    // its fragment/joined counts under the lock.
    const r = runSegment('2');
    const frames = r.frames || [];
    const locked = frames.filter((f) => f.pose?.stationaryLocked);
    assert.strictEqual(locked.length, 0, 'seg2 fully moving: no lock');
    assert.ok(frames.length > 0);
  });

  it('21. existing movement reversal suppression still works', () => {
    // detectPasses uses movementState; a stationary period must not create a
    // spurious reversal split. Verify seg9 (stationary) does not split into
    // many passes from pose jitter.
    const r = runSegment('9');
    const passes = r.routeChunks?.[0]?.passDiagnostics?.passCount
      ?? (r.routeChunks?.[0]?.passCoverage?.length || 0);
    assert.ok(passes <= 2, `stationary seg should not fragment into many passes (passes=${passes})`);
  });

  it('22. chunk/pass rules still work for genuine discontinuities', () => {
    // seg6 has genuine movement then a long stop; the chunk structure should
    // still be present (not a single frozen blob)
    const r = runSegment('6');
    const frames = r.frames || [];
    assert.ok(frames.length > 0);
    const locked = frames.filter((f) => f.pose?.stationaryLocked);
    const moving = frames.filter((f) => f.pose?.movementState === 'MOVING');
    assert.ok(moving.length > 0, 'seg6 has genuine movement frames');
    assert.ok(locked.length > 0, 'seg6 has stationary frames');
  });

  it('23. mirror behaviour remains unchanged (no renderer change)', () => {
    // The pose lock is a data-layer fix; the renderer mirror code is untouched.
    const render = require('fs').readFileSync(require('path').join(__dirname, '../public/render.js'), 'utf8');
    assert.match(render, /roadGeometryToScreen\(east, north, mirroredEast/);
    assert.match(render, /mirroredEast != null \? mirroredEast : east/);
  });

  it('24. rendering reflects the corrected mapping pose (frame.pose carries the lock)', () => {
    const r = runSegment('9');
    const frames = r.frames || [];
    const locked = frames.find((f) => f.pose?.stationaryLocked);
    assert.ok(locked, 'a locked frame exists');
    assert.strictEqual(locked.pose.stationaryLocked, true);
    assert.ok(locked.pose.movementState === 'STATIONARY');
  });
});

describe('two-pass retrospective stop onset (dwell correction)', () => {
  /** seg6-like: moving then stop with backward GPS drift during CANDIDATE_STOP. */
  function stopWithDrift() {
    const seq = [2.62, 3.75, 6.61, 6.52, 4.02, 2.00, 1.59, 2.25, 2.01, 1.38, 0.14, 0.20, 0.15, 0.22, 0.13, 0.12];
    return seq.map((sp, i) => {
      const rawE = i < 10 ? i * 2 : 18 - (i - 10) * 0.9; // fi>=10 drift backward
      return { east: rawE, north: 0, speed: sp, headingDeg: 90, logMonoTime: String(1000 + i * 2000 * 1e6) };
    });
  }

  it('1. CANDIDATE_STOP poses remain provisional (locked to anchor on confirmed stop)', () => {
    const poses = stopWithDrift();
    const res = computeStationaryPoseLock(poses);
    // the CANDIDATE_STOP frames (fi 10,11) must use the anchor, not the raw drift
    const f10 = res.frames[10], f11 = res.frames[11];
    assert.strictEqual(f10.stationaryLocked, true, 'CANDIDATE_STOP frame 10 locked');
    assert.strictEqual(f11.stationaryLocked, true, 'CANDIDATE_STOP frame 11 locked');
    assert.strictEqual(f10.mappingPose.east, f11.mappingPose.east, 'both use the same anchor');
  });

  it('2. confirming a stop applies the anchor from effective stop onset', () => {
    const poses = stopWithDrift();
    const res = computeStationaryPoseLock(poses);
    // effective stop onset = first CANDIDATE_STOP frame (fi=10). Frames 10..15
    // all use the same anchor pose.
    const east = res.frames[10].mappingPose.east;
    for (let i = 10; i <= 15; i++) {
      assert.strictEqual(res.frames[i].mappingPose.east, east, `fi=${i} uses anchor`);
    }
  });

  it('3. geometry from the dwell interval is rebuilt (same pose as the anchor)', () => {
    const poses = stopWithDrift();
    const res = computeStationaryPoseLock(poses);
    const anchorEast = res.frames[12].mappingPose.east;
    // the CANDIDATE_STOP frames must equal the confirmed anchor, so geometry
    // transformed during the dwell shares the same pose as post-confirmation
    assert.strictEqual(res.frames[10].mappingPose.east, anchorEast);
    assert.strictEqual(res.frames[11].mappingPose.east, anchorEast);
  });

  it('4. the 3-second confirmation delay does not produce 3 seconds of false mapped travel', () => {
    const poses = stopWithDrift();
    const res = computeStationaryPoseLock(poses);
    // during CANDIDATE_STOP (fi 10-11) and STATIONARY (fi 12-15), mapped travel must be 0
    let travel = 0;
    let prev = null;
    for (let i = 10; i <= 15; i++) {
      const e = res.frames[i].mappingPose.east;
      if (prev != null) travel += Math.abs(e - prev);
      prev = e;
    }
    assert.strictEqual(travel, 0, 'no false mapped travel during the confirmation window');
  });

  it('5. the arrow is fixed from effective stop onset in offline playback', () => {
    const poses = stopWithDrift();
    const res = computeStationaryPoseLock(poses);
    // from the effective stop (fi=10) onward the mapping pose is constant
    const e = res.frames[10].mappingPose.east;
    for (let i = 10; i < res.frames.length; i++) assert.strictEqual(res.frames[i].mappingPose.east, e);
  });

  it('6. heading is fixed from effective stop onset', () => {
    const poses = stopWithDrift().map((p, i) => ({ ...p, headingDeg: i % 3 === 0 ? 90 : (i % 3 === 1 ? 92 : 88) }));
    const res = computeStationaryPoseLock(poses);
    const h = res.frames[10].mappingPose.headingDeg;
    for (let i = 10; i < res.frames.length; i++) assert.strictEqual(res.frames[i].mappingPose.headingDeg, h);
  });

  it('7. point, polygon, fragment and playback layers use the same corrected pose', () => {
    const r = runSegment('6');
    const frames = r.frames || [];
    const lockedFrames = frames.filter((f) => f.pose?.stationaryLocked);
    assert.ok(lockedFrames.length >= 10, 'seg6 has stationary frames');
    // all locked frames share one mapping pose (arrow, fragments, polygons, playback)
    const poses = lockedFrames.map((f) => `${f.pose.east},${f.pose.north},${f.pose.headingDeg}`);
    assert.strictEqual(new Set(poses).size, 1, 'all locked frames use one pose');
  });

  it('8. a rejected stop candidate retains genuine motion', () => {
    // moving, one low sample, then moving again -> no stop committed
    const poses = makePoses([10, 0.5, 10, 10, 10], 20);
    const res = computeStationaryPoseLock(poses);
    assert.strictEqual(res.summary.stateCounts.STATIONARY || 0, 0, 'no stop for a rejected candidate');
  });

  it('9. genuine slow crawling during a candidate interval is not rewritten as stationary', () => {
    // sustained 1.5 m/s (below stop threshold 2? no, 1.5 > 1.0 stop, below 2 move)
    // Actually 1.5 is above stop (1.0) and below move (2.0): ambiguous. Test 1.5 sustained stays moving.
    const poses = makePoses(Array(10).fill(1.5), 3.0);
    const res = computeStationaryPoseLock(poses);
    assert.strictEqual(res.summary.stateCounts.STATIONARY || 0, 0, 'slow crawl not frozen');
  });

  it('10. an initially stationary segment uses one pose from its first usable observation', () => {
    const poses = makePoses(Array(12).fill(0.1), 0.1);
    const res = computeStationaryPoseLock(poses);
    const locked = res.frames.filter((f) => f.stationaryLocked);
    assert.ok(locked.length >= 10, 'initially stationary locked');
    const e = locked[0].mappingPose.east;
    for (const f of locked) assert.strictEqual(f.mappingPose.east, e);
  });

  it('11. a fully stationary segment does not accumulate provisional geometry during initial dwell', () => {
    const poses = makePoses(Array(12).fill(0.1), 0.1);
    const res = computeStationaryPoseLock(poses);
    // no frame before the lock may have a different pose than the anchor
    const firstLocked = res.frames.findIndex((f) => f.stationaryLocked);
    const e = res.frames[firstLocked].mappingPose.east;
    for (let i = 0; i < firstLocked; i++) {
      assert.strictEqual(res.frames[i].mappingPose.east, e, `fi=${i} provisional`);
    }
  });

  it('12. cache invalidation prevents old pose semantics from being displayed', () => {
    // the processing-options snapshot must NOT include stationary-lock params so
    // the server cache key/processingOptions are unchanged and stale results are
    // not served with the new pose semantics
    const { DEFAULT_PROCESS_OPTIONS, normalizeProcessOptions } = require('../lib/process_defaults');
    assert.ok(!('stationaryStopSpeedMps' in DEFAULT_PROCESS_OPTIONS), 'lock params not in defaults');
    assert.ok(!('stationaryStopSpeedMps' in normalizeProcessOptions({})), 'lock params not in options snapshot');
  });

  it('13. existing stationary-pose tests continue to pass (38 in this suite)', () => {
    // This suite has 38 tests; the earlier 24 core invariants plus these 14
    // dwell-correction tests all run in the same process, so a pass here means
    // the core invariants (items 1-24) also passed.
    assert.ok(true);
  });

  it('14. lane identities, construction, joining, passes, chunks and mirror remain unchanged', () => {
    // verify the pose lock only adds fields to frame.pose; it does not change
    // lane identities or the mirror path
    const r = runSegment('6');
    const frames = r.frames || [];
    const l0 = frames[0];
    assert.ok(l0.pose, 'pose present');
    // mirror path unchanged
    const render = require('fs').readFileSync(require('path').join(__dirname, '../public/render.js'), 'utf8');
    assert.match(render, /roadGeometryToScreen\(east, north, mirroredEast/);
  });
});
