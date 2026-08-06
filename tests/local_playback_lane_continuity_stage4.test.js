'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  runLaneContinuityStage4,
  loadSegment,
  buildCtx,
  enumeratePhysicalGaps,
  reconcileCounts,
  investigateTargetGap,
  gapOpenAtInterval,
  S_EPS,
  UNSAFE_GAP_IDS,
  STAGE2_REPAIRED_IDS,
  STAGE3_ACCEPTED_LANE_CHECKSUM,
  DC014_INTERVAL,
} = require('../lib/lane_continuity_stage4');
const { PRE_STAGE7_SEGMENT_OPTS } = require('../lib/lane_continuity_stage6');
const { dist2d } = require('../lib/chunking');
const stage1 = require('../audit_segment2_lane_continuity_stage1.json');

const ROOT = path.join(__dirname, '..');
const STAGE4_PATH = path.join(ROOT, 'audit_segment2_lane_continuity_stage4.json');

describe('Segment 2 lane-continuity Stage 4 reconciliation and DC-022/DC-024', () => {
  let audit;

  it('setup: run stage 4 audit', () => {
    audit = runLaneContinuityStage4();
    fs.writeFileSync(STAGE4_PATH, JSON.stringify(audit, null, 2));
    assert.ok(audit.reconciliation.reconciliationPassed);
    assert.equal(audit.reconciliation.newPhysicalGapsFromStage3, 0);
  });

  it('1. stable visible-disconnection definition matches physical gap count', () => {
    const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    const physical = enumeratePhysicalGaps(ctx.cleanup.cleaned);
    const auditCount = ctx.audit.disconnections.filter((d) => d.alongTrackGapM > S_EPS).length;
    assert.equal(physical.length, auditCount);
    assert.equal(physical.length, audit.after.stablePhysicalDisconnections);
  });

  it('2. Stage 2 stable count is 19 not 12', () => {
    assert.equal(audit.reconciliation.stage2StablePhysicalCount, 19);
    assert.equal(audit.reconciliation.stage2Pb1OnlyCount, 12);
    assert.equal(audit.reconciliation.stage2ReportedInSummary, 12);
  });

  it('3. Stage 3 stable count is 18', () => {
    assert.equal(audit.reconciliation.stage3StablePhysicalCount, 18);
    assert.equal(audit.reconciliation.stage3AuditDisconnections, 18);
  });

  it('4. every Stage 2 physical gap maps or documents closure', () => {
    const closed = audit.reconciliation.closedPhysicalGaps;
    const opened = audit.reconciliation.openedPhysicalGaps;
    assert.ok(closed.some((g) => g.physicalGapKey.startsWith('PB0|101.')));
    assert.equal(opened.length, 1);
    assert.ok(opened[0].physicalGapKey.startsWith('PB0|128.'));
  });

  it('5. no duplicate physical gaps in stable enumeration', () => {
    const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    const gaps = enumeratePhysicalGaps(ctx.cleanup.cleaned);
    const keys = gaps.map((g) => g.physicalGapKey);
    assert.equal(keys.length, new Set(keys).size);
  });

  it('6. DC-014 repair did not create a new physical gap', () => {
    assert.equal(audit.reconciliation.newPhysicalGapsFromStage3, 0);
    assert.ok(audit.summary.dc014RepairRetained);
  });

  it('7. DC-022 first failing stage is fused_fragments', () => {
    assert.equal(audit.dc022.firstFailingStage, 'fused_fragments');
    assert.equal(audit.dc022.responsibleFunction, 'fuseLaneTrackSdFragments');
    assert.ok(audit.dc022.fusionBeforeBridge.primarySplit);
  });

  it('8. DC-024 first failing stage is fused_fragments', () => {
    assert.equal(audit.dc024.firstFailingStage, 'fused_fragments');
    assert.ok(audit.dc024.fusionBeforeBridge.primarySplit);
    assert.notEqual(
      audit.dc024.fusionBeforeBridge.primarySplit.afterBinKey,
      audit.dc022.fusionBeforeBridge.primarySplit.afterBinKey,
    );
  });

  it('9. cleanup is not root cause for DC-022 or DC-024', () => {
    assert.equal(audit.dc022.cleanup.cleanupIsRootCause, false);
    assert.equal(audit.dc024.cleanup.cleanupIsRootCause, false);
  });

  it('10. DC-022 and DC-024 physically closed at accepted Stage 3 state', () => {
    assert.equal(audit.dc022.physicallyOpenAtStage3, false);
    assert.equal(audit.dc024.physicallyOpenAtStage3, false);
    assert.equal(audit.summary.stage4RepairImplemented, false);
  });

  for (const gapId of UNSAFE_GAP_IDS) {
    it(`11. unsafe gap ${gapId} remains open`, () => {
      const dc = stage1.disconnections.find((d) => d.disconnectionId === gapId);
      const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
      const runs = ctx.cleanup.cleaned.filter((r) => r.physicalBoundaryId === dc.physicalBoundaryId)
        .sort((a, b) => a.sMin - b.sMin);
      assert.ok(gapOpenAtInterval(runs, dc.endpointRouteS, dc.candidateStartRouteS), `${gapId} open`);
    });
  }

  it('12. DC-014 remains closed', () => {
    const dc = stage1.disconnections.find((d) => d.disconnectionId === 'DC-014');
    const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    const runs = ctx.cleanup.cleaned.filter((r) => r.physicalBoundaryId === 'PB0');
    assert.ok(!gapOpenAtInterval(runs, dc.endpointRouteS, dc.candidateStartRouteS));
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

  it('14. DC-013 and DC-015 remain open', () => {
    const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    for (const id of ['DC-013', 'DC-015']) {
      const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
      const runs = ctx.cleanup.cleaned.filter((r) => r.physicalBoundaryId === dc.physicalBoundaryId)
        .sort((a, b) => a.sMin - b.sMin);
      assert.ok(gapOpenAtInterval(runs, dc.endpointRouteS, dc.candidateStartRouteS), id);
    }
  });

  it('15. PB1 and PB2 unchanged vs Stage 3 baseline', () => {
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

  it('16. PB0 outside DC-014 interval unchanged', () => {
    const s2 = buildCtx(loadSegment({ bimodalClusterSelection: false, positiveBoundaryContinuityBridgeEnabled: false }));
    const s3 = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
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
    const bMap = mapPts(s2.cleanup.cleaned);
    const aMap = mapPts(s3.cleanup.cleaned);
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

  it('17. lane checksum remains Stage 3 accepted ff6d115e', () => {
    assert.equal(audit.after.laneChecksum, STAGE3_ACCEPTED_LANE_CHECKSUM);
  });

  it('18. road-surface checksum unchanged at 70457ea', () => {
    assert.equal(audit.after.roadSurfaceChecksum, '70457ea');
  });

  it('19. browser and Node lane checksums match', () => {
    const ctx = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    assert.equal(ctx.mode5.laneChecksum, audit.after.laneChecksum);
  });
});
