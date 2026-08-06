'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const LMC = require('../lib/lane_map_cleanup');
const {
  auditPartialTails,
  PROVENANCE_TYPE,
  DEDUP_S_TOLERANCE_M,
} = require('../lib/source_polyline_preservation');
const {
  computeCoverageAccounting,
  intervalUnionLength,
  DEFAULT_TOLERANCE_M,
} = require('../lib/coverage_accounting');
const { buildReferenceTrajectory } = require('../lib/trajectory');
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

describe('D12 partial-tail audit and coverage accounting', () => {
  it('1. coverage totals reconcile within tolerance', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const without = buildCleanup(data, false);
    const withPres = buildCleanup(data, true);
    const cov = withPres.coverageAccounting;
    assert.ok(cov);
    const { acceptedFusedUnionM, d12PreservedUnionM, combinedSupportedUnionM, overlapAcceptedAndPreservedM } = cov.routeSIntervalCoverage;
    const expectedUnion = acceptedFusedUnionM + d12PreservedUnionM - overlapAcceptedAndPreservedM;
    assert.ok(Math.abs(combinedSupportedUnionM - expectedUnion) <= DEFAULT_TOLERANCE_M + 0.01);
  });

  it('2. interval coverage and polyline arc length reported separately', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cov = buildCleanup(loadSegment(), true).coverageAccounting;
    assert.ok(cov.routeSIntervalCoverage.acceptedFusedUnionM > 0);
    assert.ok(cov.polylineArcLength.acceptedFusedArcM > 0);
    assert.notEqual(
      cov.routeSIntervalCoverage.acceptedFusedUnionM,
      cov.polylineArcLength.acceptedFusedArcM,
    );
  });

  it('3. combined supported coverage uses interval union not naive sum', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cov = buildCleanup(loadSegment(), true).coverageAccounting;
    const naive = cov.routeSIntervalCoverage.naiveAcceptedPlusPreservedM;
    const union = cov.routeSIntervalCoverage.combinedSupportedUnionM;
    assert.ok(union <= naive + DEFAULT_TOLERANCE_M);
  });

  it('4. every tail-extended point exists in its source polyline', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const chunk = data.routeChunks[0];
    const traj = buildReferenceTrajectory(chunk.vehiclePath);
    const cleanup = buildCleanup(data, true);
    const tails = cleanup.preservedIntervals.filter((p) => p.isTailExtension);
    assert.ok(tails.length >= 2);
    for (const interval of tails) {
      const frame = chunk.frames.find((f) => f.frameId === interval.sourceFrameId);
      const lane = frame?.lanes?.find((l) => l.laneTrackId === interval.trackId);
      assert.ok(lane, `lane for ${interval.gapId}`);
      for (const p of interval.points) {
        const src = lane.points[p.provenance.originalPointIndex];
        assert.ok(src);
        assert.ok(Math.hypot(p.east - src.east, p.north - src.north) < 0.5);
      }
    }
  });

  it('5. no interpolation introduced in tail extensions', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    for (const interval of cleanup.preservedIntervals.filter((p) => p.isTailExtension)) {
      for (const p of interval.points) {
        assert.equal(p.provenanceType, PROVENANCE_TYPE);
        assert.ok(p.provenance.originalPointIndex != null);
      }
    }
  });

  it('6. separate source polylines not connected across unsupported interval', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    for (const gapId of ['CD-10', 'CD-18']) {
      const primary = cleanup.preservedIntervals.find((p) => p.gapId === gapId);
      const tail = cleanup.preservedIntervals.find((p) => p.parentGapId === gapId && p.isTailExtension);
      assert.ok(primary && tail);
      const gap = tail.startS - primary.endS;
      assert.ok(gap > DEDUP_S_TOLERANCE_M, `gap ${gapId} must remain open between primary and tail`);
    }
  });

  it('7. CD-10 and CD-18 never share provenance across PB1 and PB2', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    const cd10pts = cleanup.preservedIntervals
      .filter((p) => p.gapId === 'CD-10' || p.parentGapId === 'CD-10')
      .flatMap((p) => p.points);
    const cd18pts = cleanup.preservedIntervals
      .filter((p) => p.gapId === 'CD-18' || p.parentGapId === 'CD-18')
      .flatMap((p) => p.points);
    assert.equal(cd10pts.every((p) => p.provenance.physicalBoundaryGroup === 'PB1'), true);
    assert.equal(cd18pts.every((p) => p.provenance.physicalBoundaryGroup === 'PB2'), true);
    const cd10Keys = new Set(cd10pts.map((p) => `${p.provenance.sourceFrameId}:${p.provenance.originalPointIndex}`));
    const cd18Keys = new Set(cd18pts.map((p) => `${p.provenance.sourceFrameId}:${p.provenance.originalPointIndex}`));
    for (const k of cd10Keys) {
      if (cd18Keys.has(k)) {
        const p10 = cd10pts.find((p) => `${p.provenance.sourceFrameId}:${p.provenance.originalPointIndex}` === k);
        const p18 = cd18pts.find((p) => `${p.provenance.sourceFrameId}:${p.provenance.originalPointIndex}` === k);
        assert.notEqual(p10.provenance.trackId, p18.provenance.trackId);
      }
    }
  });

  it('8. track and PB identity unchanged after tail extension', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    const cd10 = cleanup.preservedIntervals.find((p) => p.parentGapId === 'CD-10' && p.isTailExtension);
    const cd18 = cleanup.preservedIntervals.find((p) => p.parentGapId === 'CD-18' && p.isTailExtension);
    assert.equal(cd10.trackId, 2);
    assert.equal(cd10.physicalBoundaryGroup, 'PB1');
    assert.equal(cd18.trackId, 3);
    assert.equal(cd18.physicalBoundaryGroup, 'PB2');
  });

  it('9. CD-10 tail partially covered (T2) via frame 3123', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    const tail = cleanup.preservationResults.find((r) => r.parentGapId === 'CD-10' && r.isTailExtension);
    assert.ok(tail?.eligibility.passed);
    assert.equal(tail.classification, 'T2');
    assert.equal(tail.sourceFrameId, 3123);
    assert.ok(tail.preservedLengthM > 4);
    assert.ok(tail.remainingOpenLengthM > 1);
  });

  it('10. CD-18 tail partially covered (T2) via frame 3123 lane 3', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    const tail = cleanup.preservationResults.find((r) => r.parentGapId === 'CD-18' && r.isTailExtension);
    assert.ok(tail?.eligibility.passed);
    assert.equal(tail.classification, 'T2');
    assert.equal(tail.sourceFrameId, 3123);
  });

  it('11. CD-12 tail remains open (T7) — no interior mapped points', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    const tail = cleanup.preservationResults.find((r) => r.parentGapId === 'CD-12' && r.isTailExtension);
    assert.ok(tail);
    assert.equal(tail.eligibility.passed, false);
    assert.equal(tail.classification, 'T3');
    assert.ok(!cleanup.preservedIntervals.some((p) => p.parentGapId === 'CD-12' && p.isTailExtension && p.preservedLengthM > 0));
  });

  it('12. fused fragment count matches accepted baseline (18)', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { POST_STAGE7_BASELINE } = require('../lib/lane_continuity_stage7');
    assert.equal(buildCleanup(loadSegment(), true).stats.fusedFragmentCount, POST_STAGE7_BASELINE.fusedFragments);
  });

  it('13. CD-00 and CD-02 remain fully resolved', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const cleanup = buildCleanup(loadSegment(), true);
    for (const id of ['CD-00', 'CD-02']) {
      const p = cleanup.preservedIntervals.find((x) => x.gapId === id);
      assert.ok(p?.fullCoverage);
    }
  });

  it('14. display span sum discrepancy vs naive span sum explained (post-repair baseline)', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { POST_STAGE7_BASELINE } = require('../lib/lane_continuity_stage7');
    const cov = buildCleanup(loadSegment(), true).coverageAccounting;
    const displaySpan = cov.routeSIntervalCoverage.displayCleanedSpanSumM;
    const naiveSpan = cov.routeSIntervalCoverage.naiveSpanSumM;
    const delta = displaySpan - naiveSpan;
    // Stable structural offset after Stage 2/3 lane repairs — not runtime drift
    assert.ok(Math.abs(delta + 45.562405372404896) < 0.01, `display-naive span delta ${delta}`);
    assert.ok(cov.reconciliation.explanation);
    assert.ok(cov.routeSIntervalCoverage.acceptedSpanSumM > cov.routeSIntervalCoverage.acceptedFusedUnionM);
    assert.equal(buildCleanup(loadSegment(), true).stats.fusedFragmentCount, POST_STAGE7_BASELINE.fusedFragments);
  });

  it('15. auditPartialTails inspects frames beyond 3083 and 3203', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const chunk = data.routeChunks[0];
    const traj = buildReferenceTrajectory(chunk.vehiclePath);
    const cleanup = buildCleanup(data, true);
    const without = buildCleanup(data, false);
    const audits = auditPartialTails({
      preservedIntervals: cleanup.preservedIntervals,
      frames: chunk.frames,
      trajectory: traj,
      cleaned: without.cleanedFusedOnly,
      chunkId: 0,
      passId: 0,
    });
    const cd10 = audits.find((a) => a.gapId === 'CD-10');
    assert.ok(cd10.inspectedSourceFrames.includes(3123));
    assert.ok(cd10.inspectedSourceFrames.length > 5);
    const cd12 = audits.find((a) => a.gapId === 'CD-12');
    assert.ok(cd12.inspectedSourceFrames.includes(3163));
    assert.ok(cd12.inspectedSourceFrames.includes(3243));
  });
});
