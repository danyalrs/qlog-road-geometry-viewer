'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  runLaneContinuityStage7,
  loadSegment,
  buildCtx,
  TARGET_IDS,
  STAGE6_TARGET_KEYS,
  POST_STAGE7_BASELINE,
  PRE_STAGE7_SEGMENT_OPTS,
  REPAIR_RULE,
  DEFAULT_TRACKER_CONTINUITY_BRIDGE,
  canBridgeTrackerContinuousFusionGap,
  trackerContinuityBridgeEligibility,
  enumeratePhysicalGaps,
  gapOpenAtInterval,
  UNSAFE_GAP_IDS,
  STAGE2_REPAIRED_IDS,
  DASHED_MARKING_SUSPECT_IDS,
  DC015_GAP,
  DC014_INTERVAL,
  STAGE3_ACCEPTED_LANE_CHECKSUM,
} = require('../lib/lane_continuity_stage7');
const { PROCESSING_VERSION } = require('../lib/version');
const stage1 = require('../audit_segment2_lane_continuity_stage1.json');

const ROOT = path.join(__dirname, '..');
const STAGE7_PATH = path.join(ROOT, 'audit_segment2_lane_continuity_stage7.json');

function prodCtx() {
  return buildCtx(loadSegment({ bimodalClusterSelection: true, positiveBoundaryContinuityBridgeEnabled: true }));
}

describe('Segment 2 lane-continuity Stage 7 PB1 supported fusion-gap repair', () => {
  let audit;

  it('setup: run stage 7 audit', () => {
    audit = runLaneContinuityStage7();
    fs.writeFileSync(STAGE7_PATH, JSON.stringify(audit, null, 2));
    assert.equal(audit.productionGeometryModified, true);
    assert.equal(audit.processingVersion, PROCESSING_VERSION);
  });

  for (const id of TARGET_IDS) {
    it(`1. target ${id} resolved from Stage 6 geometry`, () => {
      const t = audit.targets.find((x) => x.disconnectionId === id);
      assert.ok(t);
      assert.equal(t.reconfirmed.identityMatch, true);
      assert.equal(t.reconfirmed.stablePhysicalGapKey, STAGE6_TARGET_KEYS[id]);
    });
  }

  for (const id of TARGET_IDS) {
    it(`2. target ${id} receives independent verdict`, () => {
      const t = audit.targets.find((x) => x.disconnectionId === id);
      assert.ok(t.verdict);
      assert.ok(t.verdictLabel);
    });
  }

  it('3. rule requires same physical boundary', () => {
    assert.ok(REPAIR_RULE.description.includes('positive-mean-d'));
    for (const t of audit.targets) {
      assert.equal(t.reconfirmed.physicalBoundaryId, 'PB1');
    }
  });

  it('4. rule requires same track', () => {
    for (const t of audit.targets) assert.equal(t.reconfirmed.trackId, 2);
  });

  it('5. rule requires same chunk and pass', () => {
    for (const t of audit.targets) {
      assert.equal(t.reconfirmed.chunkId, 0);
      assert.equal(t.reconfirmed.passId, 0);
    }
  });

  it('6. route-s ordering required', () => {
    for (const t of audit.targets) {
      const [a, b] = t.reconfirmed.routeSInterval;
      assert.ok(b > a);
    }
  });

  it('7. tracker provenance required', () => {
    for (const t of audit.targets) {
      assert.equal(t.reconfirmed.trackerContinuity.sameTrackIdThroughout, true);
      assert.ok(t.reconfirmed.mappedObservations.count >= 2);
    }
  });

  it('8. lateral compatibility required', () => {
    for (const t of audit.targets) {
      assert.ok(t.reconfirmed.endpointCompatibility);
      assert.ok((t.reconfirmed.endpointCompatibility.dDelta ?? 99) < 1);
    }
  });

  it('9. heading compatibility required', () => {
    for (const t of audit.targets) {
      const h = t.reconfirmed.endpointCompatibility?.headingDelta;
      if (h != null) assert.ok(h < DEFAULT_TRACKER_CONTINUITY_BRIDGE.maxJoinHeadingDeltaDeg);
    }
  });

  it('10. curvature compatibility required via endpointCompatibility', () => {
    for (const t of audit.targets) assert.equal(t.reconfirmed.endpointCompatibility.compatible, true);
  });

  it('11. competing continuations rejected', () => {
    for (const t of audit.targets) assert.equal(t.reconfirmed.competingContinuations.length, 0);
  });

  it('12. lane-order changes rejected', () => {
    for (const t of audit.targets) assert.equal(t.reconfirmed.laneOrderConsistent, true);
  });

  it('13. crossings rejected', () => {
    for (const t of audit.targets) assert.equal(t.reconfirmed.crossingRisk, false);
  });

  it('14. self-intersections rejected', () => {
    for (const t of audit.targets) assert.equal(t.reconfirmed.selfIntersectionRisk, false);
  });

  it('15. long unsupported dropouts rejected', () => {
    const br = canBridgeTrackerContinuousFusionGap(
      { s: 0, d: 0 }, { s: 35, d: 0 }, [{ s: 0, d: 0 }], { s: 35, d: 0 },
      [{ laneTrackId: 2, s: 10, d: 0, frameId: 1 }, { laneTrackId: 2, s: 20, d: 0, frameId: 2 }],
      { laneTrackId: 2, trackerContinuityBridgeEnabled: true, allLaneObservations: [] },
    );
    assert.equal(br.bridge, false);
    assert.equal(br.reason, 'notProvenBoundaryTrack');
  });

  it('16. endpoint distance alone cannot authorize repair', () => {
    const laneObs = Array.from({ length: 8 }, (_, i) => ({
      laneTrackId: 2, s: 12 + i, d: 0, frameId: i % 2,
    }));
    const br = canBridgeTrackerContinuousFusionGap(
      { s: 10, d: 5 }, { s: 22, d: -5 }, [{ s: 10, d: 5 }], { s: 22, d: -5 },
      laneObs,
      { laneTrackId: 2, trackerContinuityBridgeEnabled: true, allLaneObservations: laneObs },
    );
    assert.equal(br.bridge, false);
  });

  for (const id of TARGET_IDS) {
    it(`17–20. ${id} closes only if all conditions pass`, () => {
      const t = audit.targets.find((x) => x.disconnectionId === id);
      assert.equal(t.verdict, 'A');
      assert.equal(t.repaired, true);
      assert.equal(t.physicallyOpenAfter, false);
    });
  }

  for (const id of ['DC-000', 'DC-005', 'DC-007']) {
    it(`21–23. dashed interval ${id} remains open`, () => {
      const row = audit.preservation.dashedStillOpen.find((x) => x.id === id);
      assert.equal(row.open, true);
    });
  }

  it('24. DC-015 remains open', () => {
    assert.equal(audit.preservation.dc015Open, true);
  });

  it('25. all eight unsafe gaps remain open', () => {
    assert.equal(UNSAFE_GAP_IDS.length, 8);
    assert.ok(audit.preservation.unsafeStillOpen.every((g) => g.open));
  });

  it('26. DC-014 remains closed', () => {
    assert.equal(audit.preservation.dc014Closed, true);
  });

  for (const id of STAGE2_REPAIRED_IDS) {
    it(`27. Stage 2 repair ${id} remains closed`, () => {
      const row = audit.preservation.stage2RepairsClosed.find((x) => x.id === id);
      assert.equal(row.closed, true);
    });
  }

  it('28. PB0 remains unchanged', () => {
    assert.equal(audit.displacement.pb0.unchanged, true);
    assert.equal(audit.displacement.pb0.maxDisplacement, 0);
  });

  it('29. PB2 remains unchanged', () => {
    assert.equal(audit.displacement.pb2.unchanged, true);
    assert.equal(audit.displacement.pb2.maxDisplacement, 0);
  });

  it('30. PB1 outside approved intervals remains unchanged', () => {
    assert.equal(audit.displacement.pb1OutsideRepairs.unchanged, true);
  });

  it('31. no new physical gaps appear beyond expected count', () => {
    assert.equal(audit.after.stablePhysicalDisconnections, POST_STAGE7_BASELINE.stablePhysicalDisconnections);
    assert.ok(audit.after.stablePhysicalDisconnections < audit.baseline.stablePhysicalDisconnections);
  });

  it('32–33. no crossings or self-intersections', () => {
    assert.equal(audit.summary.crossings, 0);
    assert.equal(audit.summary.selfIntersections, 0);
  });

  it('34. lane order remains valid', () => {
    assert.equal(audit.summary.laneOrderViolations, 0);
  });

  it('35–36. Node lane and surface checksums recorded', () => {
    assert.ok(audit.after.laneChecksum);
    assert.ok(audit.after.roadSurfaceChecksum);
    assert.equal(audit.parity.nodeLaneChecksum, audit.after.laneChecksum);
    assert.equal(audit.parity.nodeSurfaceChecksum, audit.after.roadSurfaceChecksum);
  });

  it('37. road-surface generator source unchanged', () => {
    assert.equal(audit.summary.roadSurfaceGeneratorChanged, false);
  });

  it('38. reprocessing produces deterministic checksums', () => {
    const a = prodCtx();
    const b = prodCtx();
    assert.equal(a.mode5.laneChecksum, b.mode5.laneChecksum);
  });

  it('39. pre-stage7 baseline reproducible with flag', () => {
    const pre = buildCtx(loadSegment(PRE_STAGE7_SEGMENT_OPTS));
    assert.equal(pre.mode5.laneChecksum, STAGE3_ACCEPTED_LANE_CHECKSUM);
    assert.equal(pre.chunk.fusedLaneLines.length, 22);
  });

  it('40. geometry accounting matches expected repair outcome', () => {
    assert.deepEqual(audit.acceptedRepairs, TARGET_IDS);
    assert.equal(audit.baseline.laneChecksum, STAGE3_ACCEPTED_LANE_CHECKSUM);
    assert.equal(audit.after.fusedFragments, POST_STAGE7_BASELINE.fusedFragments);
    assert.equal(audit.after.cleanedRuns, POST_STAGE7_BASELINE.cleanedRuns);
    assert.equal(audit.after.pbDisconnections.PB1, POST_STAGE7_BASELINE.pbDisconnections.PB1);
    assert.equal(audit.summary.stage7Accepted, true);
    assert.equal(audit.summary.generatedGeometryLengthM, 0);
  });
});
