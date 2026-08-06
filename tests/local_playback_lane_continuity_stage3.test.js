'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  runLaneContinuityStage3,
  loadSegment,
  buildCtx,
  reconcileStage1FusionPairing,
  gapOpenAtInterval,
  UNSAFE_GAP_IDS,
  STAGE2_REPAIRED_IDS,
  STAGE2_UNCHANGED_IDS,
  STAGE2_ACCEPTED_LANE_CHECKSUM,
  DC014_INTERVAL,
  PB0_FUSION_PAIRING_IDS,
  PB1_FUSION_PAIRING_IDS,
} = require('../lib/lane_continuity_stage3');
const { dist2d } = require('../lib/chunking');
const stage1 = require('../audit_segment2_lane_continuity_stage1.json');

const ROOT = path.join(__dirname, '..');
const STAGE3_PATH = path.join(ROOT, 'audit_segment2_lane_continuity_stage3.json');

describe('Segment 2 lane-continuity Stage 3 DC-014 investigation', () => {
  let audit;

  it('setup: run stage 3 audit', () => {
    audit = runLaneContinuityStage3();
    fs.writeFileSync(STAGE3_PATH, JSON.stringify(audit, null, 2));
    assert.equal(audit.dc014.firstFailingStage, 'bin_aggregation');
    assert.ok(audit.dc014.repaired);
  });

  it('1. Stage 1 fusion_pairing candidates fully accounted (13)', () => {
    const rec = reconcileStage1FusionPairing(stage1);
    assert.equal(rec.length, 13);
    assert.equal(audit.stage1Stage2Reconciliation.stage1FusionPairingCount, 13);
    assert.equal(audit.stage1Stage2Reconciliation.stage2Pb0CandidateCount, 7);
    const outside = rec.filter((c) => c.classification === 'outside_pb0');
    assert.equal(outside.length, PB1_FUSION_PAIRING_IDS.length);
    const pb0 = rec.filter((c) => PB0_FUSION_PAIRING_IDS.includes(c.disconnectionId));
    assert.equal(pb0.length, 7);
  });

  it('2. DC-014 first failing stage recorded as bin aggregation', () => {
    assert.equal(audit.dc014.firstFailingStageIndex, 5);
    assert.equal(audit.dc014.spikeBinKey, 58);
    assert.ok(Math.abs(audit.dc014.lateralResidualM) > 4);
  });

  it('3. bimodal rule uses contamination evidence not segment IDs', () => {
    const after = buildCtx(loadSegment({ bimodalClusterSelection: true }));
    const bin58 = after.trace.binRecords.find((b) => b.binKey === 58);
    assert.ok(bin58?.bimodalClusterSelection?.selected);
    assert.ok(bin58.bimodalClusterSelection.reason.includes('bimodal'));
    assert.notEqual(bin58.preliminaryD, bin58.fusedPoint.d);
  });

  it('4. neighbouring curved observations retained in DC-014 interval', () => {
    const after = buildCtx(loadSegment({ bimodalClusterSelection: true }));
    const accepted = after.trace.binRecords.filter((b) => b.accepted && b.binCentreS >= 90 && b.binCentreS <= 140);
    assert.ok(accepted.length >= 5);
    const good = accepted.filter((b) => Math.abs(b.fusedPoint.d) < 6);
    assert.ok(good.length >= 4);
  });

  it('5. DC-014 repair does not cross PB1', () => {
    const after = buildCtx(loadSegment({ bimodalClusterSelection: true }));
    const pb0 = after.cleanup.cleaned.filter((r) => r.physicalBoundaryId === 'PB0');
    const pb1 = after.cleanup.cleaned.filter((r) => r.physicalBoundaryId === 'PB1');
    for (const a of pb0) {
      for (const b of pb1) {
        const overlap = Math.max(0, Math.min(a.sMax, b.sMax) - Math.max(a.sMin, b.sMin));
        if (overlap <= 0) continue;
        const meanA = (a.sdPoints || []).reduce((s, p) => s + p.d, 0) / ((a.sdPoints || []).length || 1);
        const meanB = (b.sdPoints || []).reduce((s, p) => s + p.d, 0) / ((b.sdPoints || []).length || 1);
        assert.ok(Math.abs(meanA - meanB) > 0.3);
      }
    }
  });

  it('6. DC-013 and DC-015 remain open', () => {
    const after = buildCtx(loadSegment({ bimodalClusterSelection: true }));
    for (const id of ['DC-013', 'DC-015']) {
      const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
      const runs = after.cleanup.cleaned.filter((r) => r.physicalBoundaryId === dc.physicalBoundaryId)
        .sort((a, b) => a.sMin - b.sMin);
      assert.ok(gapOpenAtInterval(runs, dc.endpointRouteS, dc.candidateStartRouteS), `${id} must stay open`);
    }
  });

  for (const gapId of UNSAFE_GAP_IDS) {
    it(`7. unsafe gap ${gapId} remains open`, () => {
      const dc = stage1.disconnections.find((d) => d.disconnectionId === gapId);
      const after = buildCtx(loadSegment({ bimodalClusterSelection: true }));
      const runs = after.cleanup.cleaned.filter((r) => r.physicalBoundaryId === dc.physicalBoundaryId)
        .sort((a, b) => a.sMin - b.sMin);
      assert.ok(gapOpenAtInterval(runs, dc.endpointRouteS, dc.candidateStartRouteS), `${gapId} must stay open`);
    });
  }

  for (const id of STAGE2_REPAIRED_IDS) {
    it(`8. Stage 2 repair ${id} remains closed`, () => {
      const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
      const after = buildCtx(loadSegment({ bimodalClusterSelection: true }));
      const runs = after.cleanup.cleaned.filter((r) => r.physicalBoundaryId === dc.physicalBoundaryId)
        .sort((a, b) => a.sMin - b.sMin);
      assert.ok(!gapOpenAtInterval(runs, dc.endpointRouteS, dc.candidateStartRouteS), `${id} should stay repaired`);
    });
  }

  it('9. DC-022 and DC-024 geometry unchanged vs Stage 2 accepted baseline', () => {
    const before = buildCtx(loadSegment({ bimodalClusterSelection: false }));
    const after = buildCtx(loadSegment({ bimodalClusterSelection: true }));
    for (const id of STAGE2_UNCHANGED_IDS) {
      const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
      const bRuns = before.cleanup.cleaned.filter((r) => r.physicalBoundaryId === dc.physicalBoundaryId)
        .sort((a, b) => a.sMin - b.sMin);
      const aRuns = after.cleanup.cleaned.filter((r) => r.physicalBoundaryId === dc.physicalBoundaryId)
        .sort((a, b) => a.sMin - b.sMin);
      assert.equal(
        gapOpenAtInterval(bRuns, dc.endpointRouteS, dc.candidateStartRouteS),
        gapOpenAtInterval(aRuns, dc.endpointRouteS, dc.candidateStartRouteS),
        `${id} open/closed state must match Stage 2 baseline`,
      );
    }
  });

  it('10. PB1 and PB2 coordinates unchanged', () => {
    const before = buildCtx(loadSegment({ bimodalClusterSelection: false }));
    const after = buildCtx(loadSegment({ bimodalClusterSelection: true }));
    for (const pb of ['PB1', 'PB2']) {
      const b = before.cleanup.cleaned.filter((r) => r.physicalBoundaryId === pb).sort((a, b) => a.sMin - b.sMin);
      const a = after.cleanup.cleaned.filter((r) => r.physicalBoundaryId === pb).sort((a, b) => a.sMin - b.sMin);
      assert.equal(b.length, a.length);
      for (let i = 0; i < b.length; i++) {
        assert.equal(b[i].points.length, a[i].points.length);
        for (let j = 0; j < b[i].points.length; j++) {
          assert.equal(b[i].points[j].east, a[i].points[j].east);
          assert.equal(b[i].points[j].north, a[i].points[j].north);
        }
      }
    }
  });

  it('11. no coordinates change outside DC-014 interval on PB0 (by route-s)', () => {
    const before = buildCtx(loadSegment({ bimodalClusterSelection: false }));
    const after = buildCtx(loadSegment({ bimodalClusterSelection: true }));
    const mapPts = (runs) => {
      const m = new Map();
      for (const run of runs.filter((r) => r.physicalBoundaryId === 'PB0')) {
        for (let j = 0; j < (run.points || []).length; j++) {
          const s = (run.sdPoints || [])[j]?.s;
          if (s == null) continue;
          m.set(s.toFixed(3), run.points[j]);
        }
      }
      return m;
    };
    const bMap = mapPts(before.cleanup.cleaned);
    const aMap = mapPts(after.cleanup.cleaned);
    let max = 0;
    for (const [sKey, bp] of bMap.entries()) {
      const s = Number(sKey);
      if (s >= DC014_INTERVAL[0] && s <= DC014_INTERVAL[1]) continue;
      const ap = aMap.get(sKey);
      if (!ap) continue;
      const d = dist2d(bp, ap);
      if (d > max) max = d;
    }
    assert.equal(max, 0);
  });

  it('12. browser and Node lane checksums match', () => {
    const after = buildCtx(loadSegment({ bimodalClusterSelection: true }));
    assert.equal(after.mode5.laneChecksum, audit.after.laneChecksum);
    assert.notEqual(audit.after.laneChecksum, STAGE2_ACCEPTED_LANE_CHECKSUM);
  });

  it('13. road-surface checksum documents lane-geometry dependency', () => {
    const stage2Surface = audit.after.roadSurfaceChecksumBefore;
    assert.equal(stage2Surface, 'cd437093');
    assert.notEqual(audit.after.roadSurfaceChecksum, stage2Surface);
    assert.equal(audit.summary.roadSurfaceChecksumDiscrepancy.expectedFromLaneRepair, true);
  });
});
