'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  runLaneContinuityStage6,
  loadSegment,
  buildCtx,
  proveD12ExpectationDrift,
  SAFE_FUSION_CANDIDATE_IDS,
  DASHED_MARKING_SUSPECT_IDS,
  ACCEPTED_BASELINE,
  STAGE1_STALE_D12,
  STAGE3_ACCEPTED_LANE_CHECKSUM,
  STAGE3_SURFACE_CHECKSUM,
  UNSAFE_GAP_IDS,
  STAGE2_REPAIRED_IDS,
  DC015_GAP,
  enumeratePhysicalGaps,
  gapOpenAtInterval,
  S_EPS,
  PRE_STAGE7_SEGMENT_OPTS,
} = require('../lib/lane_continuity_stage6');
const stage1 = require('../audit_segment2_lane_continuity_stage1.json');

const ROOT = path.join(__dirname, '..');
const STAGE6_PATH = path.join(ROOT, 'audit_segment2_lane_continuity_stage6.json');

describe('Segment 2 lane-continuity Stage 6 remaining-candidate classification', () => {
  let audit;

  it('setup: run stage 6 audit', () => {
    audit = runLaneContinuityStage6();
    fs.writeFileSync(STAGE6_PATH, JSON.stringify(audit, null, 2));
    assert.equal(audit.investigationOnly, true);
    assert.equal(audit.productionGeometryModified, false);
  });

  it('1. D12 stale failures corrected — expectations match accepted baseline', () => {
    const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    assert.equal(ctx.chunk.fusedLaneLines.length, ACCEPTED_BASELINE.fusedFragments);
    assert.equal(ctx.cleanup.cleaned.length, ACCEPTED_BASELINE.cleanedRuns);
    assert.notEqual(ACCEPTED_BASELINE.fusedFragments, STAGE1_STALE_D12.fusedFragments);
    assert.notEqual(ACCEPTED_BASELINE.cleanedRuns, STAGE1_STALE_D12.cleanedRuns);
  });

  it('2. D12 expectation drift proof — runtime geometry unchanged', () => {
    const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    const drift = proveD12ExpectationDrift(ctx);
    assert.equal(drift.runtimeGeometryUnchanged, true);
    assert.equal(drift.laneChecksum, STAGE3_ACCEPTED_LANE_CHECKSUM);
    assert.equal(drift.productionGeometryModifiedByTestFix, false);
    assert.equal(drift.failureCause, 'test_expected_stage1_fragment_run_counts_not_post_repair_baseline');
  });

  it('3. four safe fusion candidates identified with stable keys', () => {
    assert.deepEqual(audit.safeFusionCandidates.ids, SAFE_FUSION_CANDIDATE_IDS);
    assert.equal(audit.safeFusionCandidates.candidates.length, 4);
    for (const c of audit.safeFusionCandidates.candidates) {
      assert.ok(c.stablePhysicalGapKey.startsWith('PB1|'));
      assert.ok(c.routeSInterval[1] - c.routeSInterval[0] > S_EPS);
    }
  });

  for (const id of SAFE_FUSION_CANDIDATE_IDS) {
    it(`4. safe candidate ${id} has independent verdict and first failing stage`, () => {
      const c = audit.safeFusionCandidates.candidates.find((x) => x.stage1DisconnectionId === id);
      assert.ok(c);
      assert.ok(c.verdict);
      assert.ok(c.firstFailingStage);
      assert.ok(c.responsibleFunction);
    });
  }

  it('5. three dashed-marking suspects identified', () => {
    assert.deepEqual(audit.dashedMarkingSuspects.ids, DASHED_MARKING_SUSPECT_IDS);
    assert.equal(audit.dashedMarkingSuspects.candidates.length, 3);
  });

  for (const id of DASHED_MARKING_SUSPECT_IDS) {
    it(`6. dashed suspect ${id} assessed independently`, () => {
      const c = audit.dashedMarkingSuspects.candidates.find((x) => x.stage1DisconnectionId === id);
      assert.ok(c);
      assert.ok(c.dashedMarkingAnalysis);
      assert.ok(c.verdict);
    });
  }

  it('7. PB2 dashed suspect DC-000 on PB2 boundary', () => {
    const c = audit.dashedMarkingSuspects.candidates.find((x) => x.stage1DisconnectionId === 'DC-000');
    assert.equal(c.physicalBoundaryId, 'PB2');
    assert.equal(c.stablePhysicalGapKey, 'PB2|428.76|430.23');
  });

  it('8. safe fusion candidates verdict A — eligible for later repair', () => {
    for (const c of audit.safeFusionCandidates.candidates) {
      assert.equal(c.verdict, 'A');
      assert.equal(c.repairable, true);
      assert.equal(c.remainOpen, true);
    }
  });

  it('9. dashed suspects verdict D — continuous boundary identity', () => {
    for (const c of audit.dashedMarkingSuspects.candidates) {
      assert.equal(c.verdict, 'D');
      assert.equal(c.repairable, false);
    }
  });

  it('10. DC-015 preserved open', () => {
    assert.ok(audit.dc015Preserved.remainsOpen);
    assert.equal(audit.dc015Preserved.stableKey, 'PB0|128.15|260.57');
  });

  for (const gapId of UNSAFE_GAP_IDS) {
    it(`11. unsafe gap ${gapId} remains open`, () => {
      const dc = stage1.disconnections.find((d) => d.disconnectionId === gapId);
      const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
      const runs = ctx.cleanup.cleaned.filter((r) => r.physicalBoundaryId === dc.physicalBoundaryId)
        .sort((a, b) => a.sMin - b.sMin);
      const interval = gapId === 'DC-015' ? DC015_GAP : [dc.endpointRouteS, dc.candidateStartRouteS];
      assert.ok(gapOpenAtInterval(runs, interval[0], interval[1]));
    });
  }

  it('12. DC-014 remains closed', () => {
    const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    const runs = ctx.cleanup.cleaned.filter((r) => r.physicalBoundaryId === 'PB0');
    assert.ok(!gapOpenAtInterval(runs, 101.4, 128.2));
  });

  for (const id of STAGE2_REPAIRED_IDS) {
    it(`13. Stage 2 repair ${id} remains closed`, () => {
      const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
      const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
      const runs = ctx.cleanup.cleaned.filter((r) => r.physicalBoundaryId === dc.physicalBoundaryId)
        .sort((a, b) => a.sMin - b.sMin);
      assert.ok(!gapOpenAtInterval(runs, dc.endpointRouteS, dc.candidateStartRouteS));
    });
  }

  it('14. lane checksum ff6d115e unchanged', () => {
    assert.equal(audit.after.laneChecksum, STAGE3_ACCEPTED_LANE_CHECKSUM);
  });

  it('15. fused fragments 22, cleaned runs 21, disconnections 18', () => {
    assert.equal(audit.after.fusedFragmentCount, 22);
    assert.equal(audit.after.cleanedRunCount, 21);
    assert.equal(audit.after.stablePhysicalDisconnections, 18);
  });

  it('16. road-surface checksum 70457ea unchanged', () => {
    assert.equal(audit.after.roadSurfaceChecksum, STAGE3_SURFACE_CHECKSUM);
  });

  it('17. production geometry unchanged by stage 6', () => {
    const a = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    const b = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    assert.equal(a.mode5.laneChecksum, b.mode5.laneChecksum);
    assert.equal(a.mode5.laneChecksum, ACCEPTED_BASELINE.laneChecksum);
  });

  it('18. seven candidates total assessed', () => {
    assert.equal(
      audit.safeFusionCandidates.candidates.length + audit.dashedMarkingSuspects.candidates.length,
      7,
    );
  });
});
