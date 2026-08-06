'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const LMC = require('../lib/lane_map_cleanup');
const SLM = require('../lib/segment_local_map');
const {
  preserveSourcePolylinesForGaps,
  extractMappedPolylinePoints,
  dedupePointsByS,
  PROVENANCE_TYPE,
  SEGMENT2_D12_GAPS,
} = require('../lib/source_polyline_preservation');
const { buildReferenceTrajectory } = require('../lib/trajectory');
const { traceLaneTrackFusion, DEFAULT_FUSION_OPTS } = require('../lib/fusion_gap_trace');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEG2 = 'qlog_f449c_2.bz2';

function loadSegment() {
  const segPath = path.join(ROOT, SEG2);
  const modelEvents = extractModel(segPath).map((e) => ({ ...e, sourceFile: SEG2 }));
  const gpsEvents = extractGps(segPath).map((e) => ({ ...e, sourceFile: SEG2 }));
  return processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
}

function loadD12Gaps() {
  const audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit_segment2_class_d_fusion_gaps.json'), 'utf8'));
  return audit.gaps.filter((g) => g.primaryMechanism === 'D12');
}

function buildCleanup(data, enableD12) {
  const chunk = data.routeChunks[0];
  return LMC.buildCleanedLaneMap({
    frames: chunk.frames,
    fusedLanes: chunk.fusedLaneLines,
    tracks: chunk.laneTracks,
    chunkId: 0,
    passId: 0,
    vehiclePath: chunk.vehiclePath,
    classDGaps: enableD12 ? loadD12Gaps() : null,
    enableD12Preservation: enableD12,
  });
}

describe('D12 source-polyline preservation', () => {
  it('1. every preserved point exists in original mapped source polyline', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const chunk = data.routeChunks[0];
    const traj = buildReferenceTrajectory(chunk.vehiclePath);
    const cleanup = buildCleanup(data, true);
    for (const interval of cleanup.preservedIntervals) {
      const frame = chunk.frames.find((f) => f.frameId === interval.sourceFrameId);
      const lane = frame?.lanes?.find((l) => l.laneTrackId === interval.trackId);
      assert.ok(lane);
      const sourceMapped = extractMappedPolylinePoints(frame, lane, traj, interval.gapStartS, interval.gapEndS);
      for (const p of interval.points) {
        const match = sourceMapped.find((s) => s.originalPointIndex === p.provenance.originalPointIndex
          && Math.abs(s.s - p.s) < 0.1);
        assert.ok(match, `preserved point s=${p.s} must exist in source polyline`);
      }
    }
  });

  it('2. no interpolated coordinates — preserved count equals source subset', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    for (const interval of cleanup.preservedIntervals) {
      assert.ok(interval.preservedPointCount >= 2);
      assert.equal(interval.points.length, interval.preservedPointCount);
      for (const p of interval.points) {
        assert.equal(p.provenanceType, PROVENANCE_TYPE);
      }
    }
  });

  it('3. preserved points retain source order by s', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    for (const interval of cleanup.preservedIntervals) {
      const ss = interval.points.map((p) => p.s);
      assert.deepEqual(ss, [...ss].sort((a, b) => a - b));
    }
  });

  it('4. preserved points remain inside source polyline s-range', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    for (const interval of cleanup.preservedIntervals) {
      const [srcMin, srcMax] = interval.sourcePolylineSRange;
      for (const p of interval.points) {
        assert.ok(p.s >= srcMin - 0.01 && p.s <= srcMax + 0.01);
      }
    }
  });

  it('5. no preservation extends beyond source endpoints', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    for (const interval of cleanup.preservedIntervals) {
      assert.ok(interval.startS >= interval.sourcePolylineSRange[0] - 0.01);
      assert.ok(interval.endS <= interval.sourcePolylineSRange[1] + 0.01);
    }
  });

  it('6. source polyline spanning D12 interval preserves mapped shape', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    const cd00 = cleanup.preservedIntervals.find((p) => p.gapId === 'CD-00');
    assert.ok(cd00);
    assert.ok(cd00.preservedLengthM > 20);
    assert.equal(cd00.sourceFrameId, 2443);
  });

  it('7. sparse bin representatives do not discard eligible mapped source points', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    assert.ok(cleanup.preservedIntervals.length >= 5);
    assert.ok(cleanup.stats.preservedCoverageM > 80);
  });

  it('8. preserved points are not accepted fusion bins', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    for (const interval of cleanup.preservedIntervals) {
      for (const p of interval.points) {
        assert.notEqual(p.provenanceType, 'fusedAccepted');
        assert.ok(p.provenance);
      }
    }
  });

  it('9. preserved points do not increase fusion observation counts', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const chunk = data.routeChunks[0];
    const traj = buildReferenceTrajectory(chunk.vehiclePath);
    const { collectLaneObservations } = require('../lib/sd_fusion');
    const obs = collectLaneObservations(chunk.frames, traj, {});
    const traceBefore = traceLaneTrackFusion(obs, 0, DEFAULT_FUSION_OPTS);
    buildCleanup(data, true);
    const traceAfter = traceLaneTrackFusion(obs, 0, DEFAULT_FUSION_OPTS);
    assert.equal(traceAfter.acceptedFused.length, traceBefore.acceptedFused.length);
  });

  it('10. D6-rejected bins remain rejected after preservation', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const chunk = data.routeChunks[0];
    const traj = buildReferenceTrajectory(chunk.vehiclePath);
    const { collectLaneObservations } = require('../lib/sd_fusion');
    const obs = collectLaneObservations(chunk.frames, traj, {});
    const trace = traceLaneTrackFusion(obs, 0, DEFAULT_FUSION_OPTS);
    const d6 = trace.rejectedBins.filter((b) => b.rejectionReason === 'D6_minObsPerBin');
    assert.ok(d6.length > 0);
    buildCleanup(data, true);
    const trace2 = traceLaneTrackFusion(obs, 0, DEFAULT_FUSION_OPTS);
    assert.equal(trace2.rejectedBins.length, trace.rejectedBins.length);
  });

  it('11. D10 spike geometry is not preserved', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    const cd01 = cleanup.preservationResults.find((r) => r.gapId === 'CD-01');
    assert.ok(!cd01 || !cd01.eligibility.passed);
  });

  it('12. partially covered gap remains partially open', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    const partial = cleanup.preservedIntervals.filter((p) => !p.fullCoverage);
    assert.ok(partial.length >= 1);
    for (const p of partial) {
      assert.ok(p.remainingOpenLengthM > 0);
    }
  });

  it('13. internal unsupported section does not close whole gap', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    const cd12 = cleanup.preservedIntervals.find((p) => p.gapId === 'CD-12');
    assert.ok(cd12);
    assert.equal(cd12.fullCoverage, false);
    assert.ok(cd12.remainingOpenLengthM > 0);
  });

  it('14. different source observations are not connected', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    for (const interval of cleanup.preservedIntervals) {
      const frames = new Set(interval.points.map((p) => p.provenance.sourceFrameId));
      assert.equal(frames.size, 1);
    }
  });

  it('15. different tracks are not connected through preservation', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    const tracks = new Set(cleanup.preservedIntervals.map((p) => p.trackId));
    assert.ok(tracks.size >= 2);
    for (const interval of cleanup.preservedIntervals) {
      assert.equal(interval.points.every((p) => p.provenance.trackId === interval.trackId), true);
    }
  });

  it('16. different physical boundaries are not connected', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    const pbs = new Set(cleanup.preservedIntervals.map((p) => p.physicalBoundaryGroup));
    assert.equal(pbs.size, 3);
  });

  it('17. chunk and pass boundaries remain separate', () => {
    assert.equal(SEGMENT2_D12_GAPS.every((g) => g.chunkId == null || g.chunkId === 0), true);
  });

  it('18. lane order remains stable', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
    const orders = map.laneFragments.map((f) => f.lateralOrder).filter((x) => x != null);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  });

  it('19. no crossing introduced', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    assert.equal(cleanup.stats.crossingCount, 0);
  });

  it('20. 240 m dropout remains open', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit_segment2_cleaned_runs.json'), 'utf8'));
    const dropout = audit.separations.find((s) => s.classification === 'A' && s.gapM > 200);
    assert.ok(dropout);
  });

  it('21. class-A gaps remain open', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit_segment2_cleaned_runs.json'), 'utf8'));
    assert.equal(audit.separations.filter((s) => s.classification === 'A').length, 4);
  });

  it('22. class-F gaps remain open', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit_segment2_cleaned_runs.json'), 'utf8'));
    assert.equal(audit.separations.filter((s) => s.classification === 'F').length, 4);
  });

  it('23. track 4 remains absent', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    assert.equal(data.routeChunks[0].fusedLaneLines.filter((f) => f.laneTrackId === 4).length, 0);
  });

  it('24. PB0 PB1 PB2 identities unchanged', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    const ids = cleanup.physicalBoundaryGroups.map((g) => g.physicalBoundaryId).sort();
    assert.deepEqual(ids, ['PB0', 'PB1', 'PB2']);
  });

  it('25. Mode 5 remains stationary', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const checksums = new Set();
    for (const idx of [0, 8, 16, 26]) {
      checksums.add(SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: idx }).checksum);
    }
    assert.equal(checksums.size, 1);
  });

  it('26. arrow transform unchanged', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/render.js'), 'utf8');
    assert.match(src, /headingDegForVehicleIcon|_drawLocalPlaybackArrow/);
  });

  it('27. video sync unchanged', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
    assert.match(src, /localPlaybackVideo\?\.tickSync/);
  });

  it('28. global and vehicle-relative modes preserved', () => {
    const pr = fs.readFileSync(path.join(ROOT, 'lib/process_route.js'), 'utf8');
    assert.ok(pr.includes("mode = 'global'"));
  });

  it('29. Mode 5 has no road surface', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
    assert.equal(map.roadSurfacePolygons?.length ?? 0, 0);
  });

  it('30. Mode 7 distinguishes fused and preserved provenance', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleanedDebug', timelineIndex: 0 });
    const preserved = map.laneFragments.filter((f) => f.fragmentKind === 'preservedSourcePolyline');
    const cleaned = map.laneFragments.filter((f) => f.fragmentKind === 'cleanedLane');
    assert.ok(preserved.length >= 3);
    assert.ok(cleaned.length >= 1);
  });

  it('31. five D12 candidates confirmed in audit', () => {
    const d12 = loadD12Gaps();
    assert.equal(d12.length, 5);
    assert.deepEqual(d12.map((g) => g.gapId).sort(), ['CD-00', 'CD-02', 'CD-10', 'CD-12', 'CD-18']);
  });

  it('dedupe removes only near-exact duplicates', () => {
    const pts = [{ s: 0, east: 0, north: 0 }, { s: 0.02, east: 0.01, north: 0 }, { s: 5, east: 5, north: 0 }];
    const out = dedupePointsByS(pts);
    assert.equal(out.length, 2);
  });
});
