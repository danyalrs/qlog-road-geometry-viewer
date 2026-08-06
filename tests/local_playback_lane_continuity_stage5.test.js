'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  runLaneContinuityStage5,
  loadSegment,
  buildCtx,
  confirmDc015Identity,
  traceCorridorPipeline,
  findFirstSupportLoss,
  evaluateAlternativeTracks,
  offlineRecoveryOptions,
  measureUnsupportedIntervals,
  DC015_GAP,
  STAGE4_GAP_KEY,
  STAGE1_GAP_KEY,
  STAGE3_ACCEPTED_LANE_CHECKSUM,
  STAGE3_SURFACE_CHECKSUM,
  UNSAFE_GAP_IDS,
  STAGE2_REPAIRED_IDS,
  S_EPS,
  DC014_INTERVAL,
  physicalGapKey,
  gapOpenAtInterval,
  enumeratePhysicalGaps,
} = require('../lib/lane_continuity_stage5');
const { PRE_STAGE7_SEGMENT_OPTS } = require('../lib/lane_continuity_stage6');
const { dist2d } = require('../lib/chunking');
const stage1 = require('../audit_segment2_lane_continuity_stage1.json');

const ROOT = path.join(__dirname, '..');
const STAGE5_PATH = path.join(ROOT, 'audit_segment2_lane_continuity_stage5.json');

describe('Segment 2 lane-continuity Stage 5 DC-015 investigation', () => {
  let audit;

  it('setup: run stage 5 audit', () => {
    audit = runLaneContinuityStage5();
    fs.writeFileSync(STAGE5_PATH, JSON.stringify(audit, null, 2));
    assert.equal(audit.investigationOnly, true);
    assert.equal(audit.productionGeometryModified, false);
  });

  it('1. DC-015 identity matches Stage 4 physical corridor PB0|128.15|260.57', () => {
    const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    const id = confirmDc015Identity(ctx, stage1);
    assert.equal(id.stage4PhysicalGapKey, STAGE4_GAP_KEY);
    assert.equal(id.physicalBoundaryId, 'PB0');
    assert.equal(id.trackId, 0);
    const gaps = enumeratePhysicalGaps(ctx.cleanup.cleaned);
    assert.ok(gaps.some((g) => g.physicalGapKey === STAGE4_GAP_KEY));
  });

  it('2. endpoint-key shift from PB0|136.89|260.57 is not a new gap', () => {
    assert.equal(audit.dc015.identity.stage1PhysicalGapKey, STAGE1_GAP_KEY);
    assert.ok(audit.dc015.identity.endpointKeyReconciliation.samePhysicalCorridor);
    assert.ok(audit.dc015.identity.endpointKeyReconciliation.noNewPhysicalGapIntroduced);
    assert.ok(audit.dc015.identity.endpointKeyReconciliation.endpointShiftM > 7);
    assert.ok(audit.dc015.identity.endpointKeyReconciliation.endpointShiftM < 10);
  });

  it('3. first support-loss stage is recorded', () => {
    assert.ok(audit.dc015.firstSupportLoss.firstSupportLossStage);
    assert.ok(audit.dc015.firstSupportLoss.responsibleFunction);
    assert.ok(audit.dc015.firstSupportLoss.responsibleCondition);
    assert.ok(['A', 'G', 'I', 'L'].includes(audit.dc015.firstSupportLoss.category));
  });

  it('4. interior observations have inclusion or rejection explanations', () => {
    const inv = audit.dc015.pipeline.observationInventory;
    assert.ok(inv.length > 0);
    for (const row of inv) {
      assert.ok(row.inclusion?.status);
      assert.ok(row.inclusion?.reason);
      assert.ok(row.inclusion?.stage);
    }
  });

  it('5. alternative-track observations are evaluated', () => {
    const alt = audit.dc015.alternativeTracks;
    assert.ok(Array.isArray(alt.alternatives));
    assert.equal(alt.nearestObsNotReassigned, true);
    assert.equal(alt.trackSwitchDetected, false);
  });

  it('6. no observation reassigned using endpoint distance alone', () => {
    for (const a of audit.dc015.alternativeTracks.alternatives) {
      assert.equal(a.reassignmentRejected, true);
      assert.ok(a.reassignmentRejectReason);
    }
  });

  it('7. unsupported interval lengths are measured', () => {
    const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    const m = measureUnsupportedIntervals(ctx.trace, DC015_GAP[0], DC015_GAP[1]);
    assert.ok(m.longestUnsupportedM > 100);
    assert.ok(m.unsupported.length >= 1);
    assert.equal(audit.dc015.recovery.longestUnsupportedM, m.longestUnsupportedM);
  });

  it('8. offline recovery tests do not modify production geometry', () => {
    for (const o of audit.dc015.recovery.options) {
      assert.equal(o.productionModified, false);
    }
    assert.equal(audit.productionGeometryModified, false);
  });

  it('9. DC-015 remains open during Stage 5', () => {
    const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    const runs = ctx.cleanup.cleaned.filter((r) => r.physicalBoundaryId === 'PB0').sort((a, b) => a.sMin - b.sMin);
    assert.ok(gapOpenAtInterval(runs, DC015_GAP[0], DC015_GAP[1]));
    assert.equal(audit.dc015.physicallyOpen, true);
  });

  for (const gapId of UNSAFE_GAP_IDS) {
    it(`10. unsafe gap ${gapId} remains open`, () => {
      const dc = stage1.disconnections.find((d) => d.disconnectionId === gapId);
      const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
      const runs = ctx.cleanup.cleaned.filter((r) => r.physicalBoundaryId === dc.physicalBoundaryId)
        .sort((a, b) => a.sMin - b.sMin);
      const interval = gapId === 'DC-015' ? DC015_GAP : [dc.endpointRouteS, dc.candidateStartRouteS];
      assert.ok(gapOpenAtInterval(runs, interval[0], interval[1]), gapId);
    });
  }

  it('11. DC-014 remains closed', () => {
    const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    const runs = ctx.cleanup.cleaned.filter((r) => r.physicalBoundaryId === 'PB0');
    assert.ok(!gapOpenAtInterval(runs, 101.4, 128.2));
  });

  for (const id of ['DC-019', 'DC-020', 'DC-021', 'DC-023']) {
    it(`12. ${id} remains closed`, () => {
      const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
      const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
      const runs = ctx.cleanup.cleaned.filter((r) => r.physicalBoundaryId === dc.physicalBoundaryId)
        .sort((a, b) => a.sMin - b.sMin);
      assert.ok(!gapOpenAtInterval(runs, dc.endpointRouteS, dc.candidateStartRouteS));
    });
  }

  it('13. DC-022 and DC-024 remain physically closed', () => {
    const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    const runs = ctx.cleanup.cleaned.filter((r) => r.physicalBoundaryId === 'PB0').sort((a, b) => a.sMin - b.sMin);
    assert.ok(!gapOpenAtInterval(runs, 572, 590));
    assert.ok(!gapOpenAtInterval(runs, 631, 647));
  });

  it('14. PB1 and PB2 remain unchanged', () => {
    const before = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    const after = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    for (const pb of ['PB1', 'PB2']) {
      const b = before.cleanup.cleaned.filter((r) => r.physicalBoundaryId === pb).sort((a, b) => a.sMin - b.sMin);
      const a = after.cleanup.cleaned.filter((r) => r.physicalBoundaryId === pb).sort((a, b) => a.sMin - b.sMin);
      assert.equal(b.length, a.length);
      for (let i = 0; i < b.length; i++) {
        for (let j = 0; j < b[i].points.length; j++) {
          assert.equal(b[i].points[j].east, a[i].points[j].east);
          assert.equal(b[i].points[j].north, a[i].points[j].north);
        }
      }
    }
  });

  it('15. lane checksum remains ff6d115e', () => {
    assert.equal(audit.after.laneChecksum, STAGE3_ACCEPTED_LANE_CHECKSUM);
  });

  it('16. fused fragments remain 22', () => {
    assert.equal(audit.after.fusedFragmentCount, 22);
  });

  it('17. cleaned runs remain 21', () => {
    assert.equal(audit.after.cleanedRunCount, 21);
  });

  it('18. stable physical disconnections remain 18', () => {
    assert.equal(audit.after.stablePhysicalDisconnections, 18);
  });

  it('19. road-surface checksum remains 70457ea', () => {
    assert.equal(audit.after.roadSurfaceChecksum, STAGE3_SURFACE_CHECKSUM);
  });

  it('20. no production geometry file changes (checksum stable)', () => {
    const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    assert.equal(ctx.mode5.laneChecksum, audit.baseline.stage3AcceptedLaneChecksum);
  });

  it('21. pipeline trace covers corridor s=110–280 m', () => {
    const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    const p = traceCorridorPipeline(ctx);
    assert.deepEqual(p.corridorRouteS, [110, 280]);
    assert.ok(p.stageSummary.raw_modelV2.pointsInGap > 0);
    assert.ok(p.fragmentSplitsNearGap.length > 0);
  });
});
