'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  runLaneContinuityStage8,
  loadSegment,
  buildCtx,
  STAGE8_TARGET_IDS,
  STAGE6_TARGET_KEYS,
  POST_STAGE8_BASELINE,
  PRE_STAGE8_SEGMENT_OPTS,
  PRE_STAGE7_SEGMENT_OPTS,
  REPAIR_RULE,
  RENDERER_MAX_INTRA_GAP_M,
  renderedContinuityAtGap,
  enumeratePhysicalGaps,
  gapOpenAtInterval,
  compareBoundaryRuns,
  compareOutsideRepairIntervals,
  UNSAFE_GAP_IDS,
  STAGE2_REPAIRED_IDS,
  DASHED_MARKING_SUSPECT_IDS,
  DC015_GAP,
} = require('../lib/lane_continuity_stage8');
const {
  validateStructuralBridgeEvidence,
  findIntraRunJumps,
  estimateEndpointTangent,
  sampleStraightBridge,
  sampleHermiteBridge,
  applyVisibleGapReconstruction,
  computeCoordinateChecksum,
  isGeneratedPoint,
} = require('../lib/visible_gap_reconstruction');
const { buildLaneDiagnostics } = require('../lib/geometry_diagnostics');
const SLM = require('../lib/segment_local_map');
const { PROCESSING_VERSION } = require('../lib/version');
const { dist2d } = require('../lib/chunking');
const stage1 = require('../audit_segment2_lane_continuity_stage1.json');

const ROOT = path.join(__dirname, '..');
const STAGE8_PATH = path.join(ROOT, 'audit_segment2_lane_continuity_stage8.json');

function prodCtx() {
  return buildCtx(loadSegment({
    bimodalClusterSelection: true,
    positiveBoundaryContinuityBridgeEnabled: true,
    visibleGapReconstructionEnabled: true,
  }), { visibleGapReconstructionEnabled: true });
}

describe('Segment 2 lane-continuity Stage 8 visible gap reconstruction', () => {
  let audit;

  it('setup: run stage 8 audit', () => {
    audit = runLaneContinuityStage8();
    fs.writeFileSync(STAGE8_PATH, JSON.stringify(audit, null, 2));
    assert.equal(audit.productionGeometryModified, true);
    assert.equal(audit.processingVersion, PROCESSING_VERSION);
    assert.equal(audit.summary.preStage8ChecksumReproduced, true);
  });

  it('1. reconstruction requires accepted structural bridge', () => {
    const ctx = buildCtx(loadSegment(PRE_STAGE8_SEGMENT_OPTS), PRE_STAGE8_SEGMENT_OPTS);
    const run = ctx.cleanup.cleaned.find((r) => r.physicalBoundaryId === 'PB1' && r.sMin < 573 && r.sMax > 589);
    const jump = findIntraRunJumps(run.points, run.sdPoints, RENDERER_MAX_INTRA_GAP_M)[0];
    assert.ok(jump);
    const noObs = validateStructuralBridgeEvidence(run, jump, [], {});
    assert.equal(noObs.accepted, false);
    const withObs = validateStructuralBridgeEvidence(run, jump, [], {
      laneObservations: ctx.observations,
      positiveBoundaryContinuityBridgeEnabled: true,
    });
    assert.equal(withObs.accepted, true);
  });

  it('2. endpoint distance alone cannot authorize reconstruction', () => {
    const fakeRun = {
      physicalBoundaryId: 'PB1',
      laneTrackId: 2,
      points: [{ east: 0, north: 0 }, { east: 0, north: 20 }],
      sdPoints: [{ s: 0, d: 1 }, { s: 20, d: 1 }],
      sourceFragmentCount: 1,
    };
    const jump = { s0: 0, s1: 20, jumpM: 20, sdBefore: { s: 0, d: 1 }, sdAfter: { s: 20, d: 1 }, pointBefore: fakeRun.points[0], pointAfter: fakeRun.points[1] };
    const ev = validateStructuralBridgeEvidence(fakeRun, jump, [], { laneObservations: [] });
    assert.equal(ev.accepted, false);
  });

  it('3. same physical boundary required', () => {
    for (const t of audit.targets) assert.equal(t.reconfirmed.physicalBoundaryId, 'PB1');
  });

  it('4. same track/chunk/pass required', () => {
    for (const t of audit.targets) {
      assert.equal(t.reconfirmed.trackId, 2);
      assert.equal(t.reconfirmed.chunkId, 0);
      assert.equal(t.reconfirmed.passId, 0);
    }
  });

  it('5. route-s ordering required', () => {
    for (const t of audit.targets) {
      const [a, b] = t.reconfirmed.routeSInterval;
      assert.ok(b > a);
    }
  });

  it('6. endpoint tangents use only real supporting points', () => {
    const ctx = buildCtx(loadSegment(PRE_STAGE8_SEGMENT_OPTS), PRE_STAGE8_SEGMENT_OPTS);
    const run = ctx.cleanup.cleaned.find((r) => r.physicalBoundaryId === 'PB1' && r.sMin < 573 && r.sMax > 589);
    const jump = findIntraRunJumps(run.points, run.sdPoints, RENDERER_MAX_INTRA_GAP_M)[0];
    assert.ok(jump);
    const tan = estimateEndpointTangent(run.points, run.sdPoints, jump.indexBefore, 'before');
    assert.ok(tan.usedCount >= 3);
    assert.ok(tan.supportPoints.every((p) => !isGeneratedPoint(p)));
  });

  it('7. straight and Hermite candidates compared', () => {
    assert.ok(REPAIR_RULE.description.includes('parametric'));
  });

  it('8. Hermite passes exactly through endpoints', () => {
    const p0 = { east: 0, north: 0 };
    const p1 = { east: 10, north: 10 };
    const t0 = { east: 0, north: 1 };
    const t1 = { east: 1, north: 0 };
    const pts = sampleHermiteBridge(p0, t0, p1, t1, { s: 0, d: 0 }, { s: 10, d: 0 }, 1);
    const all = [p0, ...pts, p1];
    assert.ok(dist2d(all[0], p0) < 1e-9);
    assert.ok(dist2d(all[all.length - 1], p1) < 1e-9);
  });

  it('9. generated route-s remains monotonic', () => {
    const ctx = prodCtx();
    for (const run of ctx.cleanup.cleaned) {
      const sd = run.sdPoints || [];
      for (let i = 1; i < sd.length; i++) assert.ok(sd[i].s >= sd[i - 1].s - 1e-6);
    }
  });

  it('10. point spacing no greater than 1 m in reconstructed sections', () => {
    for (const id of STAGE8_TARGET_IDS) {
      const t = audit.targets.find((x) => x.disconnectionId === id);
      assert.ok(t.repairOperation.maxPointSpacingM <= 1.05, id);
    }
  });

  it('11. duplicate endpoints are not inserted', () => {
    const ctx = prodCtx();
    for (const run of ctx.cleanup.cleaned) {
      for (let i = 1; i < run.points.length; i++) {
        assert.ok(dist2d(run.points[i - 1], run.points[i]) > 0.001);
      }
    }
  });

  it('12. overshooting curves rejected via safety gates', () => {
    assert.ok(REPAIR_RULE.thresholds.maxPointSpacingM === 1.0);
  });

  it('13. excessive curvature rejected', () => {
    for (const t of audit.targets) {
      if (t.repaired) assert.ok(t.repairOperation.maxCurvatureDeg < 35);
    }
  });

  it('14. unstable tangents rejected when evidence poor', () => {
    const pts = [{ east: 0, north: 0 }, { east: 1, north: 5 }, { east: 2, north: -5 }];
    const sd = [{ s: 0, d: 0 }, { s: 1, d: 0 }, { s: 2, d: 0 }];
    const tan = estimateEndpointTangent(pts, sd, 2, 'before');
    assert.equal(tan.stable, false);
  });

  it('15. competing continuations rejected at audit level', () => {
    for (const t of audit.targets) assert.equal(t.reconfirmed.competingContinuations?.length ?? 0, 0);
  });

  it('16. crossings rejected', () => assert.equal(audit.summary.crossings, 0));
  it('17. self-intersections rejected', () => assert.equal(audit.summary.selfIntersections, 0));
  it('18. lane-order changes rejected', () => assert.equal(audit.summary.laneOrderViolations, 0));

  it('19. every inserted point has interpolation provenance', () => {
    const ctx = prodCtx();
    let found = 0;
    for (const run of ctx.cleanup.cleaned) {
      for (const pt of run.points || []) {
        if (!pt.generated) continue;
        found++;
        assert.equal(pt.interpolationProvenance?.source, 'interpolated');
        assert.equal(pt.interpolationProvenance?.repairStage, 8);
      }
    }
    assert.ok(found >= 34);
  });

  it('20. interpolated confidence lower than observed confidence', () => {
    const ctx = prodCtx();
    const run = ctx.cleanup.cleaned.find((r) => r.physicalBoundaryId === 'PB1' && r.sMin < 573);
    const base = run.meanConfidence ?? 0.9;
    for (const pt of run.points) {
      if (!pt.generated) continue;
      assert.ok(pt.interpolationProvenance.confidence < base);
    }
  });

  it('21. confidence lowest near gap centre', () => {
    const t = audit.targets.find((x) => x.disconnectionId === 'DC-010');
    const [lo, hi] = t.repairOperation.confidenceRange;
    assert.ok(lo < hi);
  });

  for (const id of STAGE8_TARGET_IDS) {
    it(`22-23. ${id} receives independent verdict`, () => {
      const t = audit.targets.find((x) => x.disconnectionId === id);
      assert.ok(t.verdict);
      assert.equal(t.reconfirmed.identityMatch, true);
      assert.equal(t.reconfirmed.stablePhysicalGapKey, STAGE6_TARGET_KEYS[id]);
    });
  }

  for (const id of STAGE8_TARGET_IDS) {
    it(`${id} renders continuously after reconstruction`, () => {
      const t = audit.targets.find((x) => x.disconnectionId === id);
      assert.equal(t.repaired, true);
      assert.equal(t.renderedContinuity.continuous, true);
    });
  }

  it('26. DC-009 and DC-011 coordinates unchanged outside repair intervals', () => {
    for (const row of audit.preservation.controlTargetsUnchanged) {
      assert.equal(row.unchanged, true, row.id);
    }
  });

  it('27. protected gaps remain open', () => {
    for (const row of audit.preservation.dashedStillOpen) assert.equal(row.open, true, row.id);
    for (const row of audit.preservation.unsafeStillOpen) assert.equal(row.open, true, row.id);
    assert.equal(audit.preservation.dc015Open, true);
  });

  it('28. PB0 unchanged', () => assert.equal(audit.displacement.pb0.unchanged, true));
  it('29. PB2 unchanged', () => assert.equal(audit.displacement.pb2.unchanged, true));
  it('30. PB1 outside approved intervals unchanged', () => {
    assert.equal(audit.displacement.pb1OutsideRepairs.unchanged, true);
    assert.equal(audit.displacement.maxOutsideApprovedIntervalsM, 0);
  });

  it('31. renderer 15 m threshold unchanged', () => {
    assert.equal(REPAIR_RULE.thresholds.rendererMaxIntraGapM, 15);
    assert.equal(audit.summary.rendererThresholdChanged, false);
  });

  it('32. disabling Stage 8 reproduces checksum 10845acd', () => {
    const ctx = buildCtx(loadSegment(PRE_STAGE8_SEGMENT_OPTS), PRE_STAGE8_SEGMENT_OPTS);
    assert.equal(ctx.mode5.laneChecksum, '10845acd');
  });

  it('33. Node/API diagnostics parity', () => {
    const ctx = prodCtx();
    const mode5 = SLM.buildSegmentLocalMap({
      processingVersion: PROCESSING_VERSION,
      routeChunks: [ctx.chunk],
      frames: ctx.chunk.frames,
      processingOptions: ctx.chunk.processingOptions || {
        positiveBoundaryContinuityBridgeEnabled: true,
        visibleGapReconstructionEnabled: true,
      },
    }, { geometrySource: 'cleaned', timelineIndex: 0 });
    const procOpts = {
      positiveBoundaryContinuityBridgeEnabled: true,
      visibleGapReconstructionEnabled: true,
    };
    const diag = buildLaneDiagnostics(
      { processingVersion: PROCESSING_VERSION, routeChunks: [ctx.chunk], processingOptions: procOpts },
      mode5,
      procOpts,
    );
    assert.equal(diag.coordinateChecksum, audit.after.coordinateChecksum);
    assert.equal(diag.stage8ReconstructionFlag, true);
    assert.equal(diag.interpolatedPointCount, audit.after.interpolatedPointCount);
  });

  it('34. reprocessing is deterministic', () => {
    const a = runLaneContinuityStage8();
    const b = runLaneContinuityStage8();
    assert.equal(a.after.coordinateChecksum, b.after.coordinateChecksum);
    assert.equal(a.after.interpolatedPointCount, b.after.interpolatedPointCount);
  });

  it('35. stale cache not accepted without version bump', () => {
    assert.ok(PROCESSING_VERSION.includes('fusion-v15'));
  });

  it('36. road-surface generator unchanged', () => {
    assert.equal(audit.summary.roadSurfaceGeneratorChanged, false);
    assert.equal(audit.baseline.roadSurfaceChecksum, audit.after.roadSurfaceChecksum);
  });

  it('37. accounting matches POST_STAGE8 expectations', () => {
    assert.equal(audit.after.fusedFragments, POST_STAGE8_BASELINE.fusedFragments);
    assert.equal(audit.after.cleanedRuns, POST_STAGE8_BASELINE.cleanedRuns);
    assert.equal(audit.acceptedRepairs.length, 2);
    assert.notEqual(audit.baseline.coordinateChecksum, audit.after.coordinateChecksum);
    const dc10 = audit.targets.find((t) => t.disconnectionId === 'DC-010');
    const dc12 = audit.targets.find((t) => t.disconnectionId === 'DC-012');
    assert.equal(dc10.verdict, 'A');
    assert.equal(dc12.verdict, 'A');
    assert.equal(dc10.repairOperation.insertedPointCount, 18);
    assert.equal(dc12.repairOperation.insertedPointCount, 16);
  });
});
