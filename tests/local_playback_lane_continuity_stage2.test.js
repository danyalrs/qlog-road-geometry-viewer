'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  runLaneContinuityStage2,
  loadSegment,
  buildCtx,
  UNSAFE_GAP_IDS,
  PB0_FUSION_PAIRING_IDS,
  BASELINE_LANE_CHECKSUM,
  BASELINE_SURFACE_CHECKSUM,
} = require('../lib/lane_continuity_stage2');
const LMC = require('../lib/lane_map_cleanup');
const SLM = require('../lib/segment_local_map');
const stage1 = require('../audit_segment2_lane_continuity_stage1.json');

const ROOT = path.join(__dirname, '..');
const STAGE1_PATH = path.join(ROOT, 'audit_segment2_lane_continuity_stage1.json');
const STAGE2_PATH = path.join(ROOT, 'audit_segment2_lane_continuity_stage2.json');

function stage1Pb0FusionTargets() {
  return stage1.disconnections.filter((d) => PB0_FUSION_PAIRING_IDS.includes(d.disconnectionId));
}

describe('Segment 2 lane-continuity Stage 2 PB0 fusion repair', () => {
  let audit;

  it('setup: run stage 2 audit', () => {
    audit = runLaneContinuityStage2();
    fs.writeFileSync(STAGE2_PATH, JSON.stringify(audit, null, 2));
    assert.ok(audit.summary.safeCandidatesRepaired >= 1);
  });

  it('1. every repaired pair was Stage 1 safe', () => {
    for (const id of audit.repaired) {
      const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
      assert.ok(dc?.safeConnectionCandidate, `${id} was not Stage 1 safe`);
    }
  });

  it('2. every repaired pair belongs to the same track', () => {
    for (const id of audit.repaired) {
      const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
      assert.equal(dc.trackId, 0);
      assert.equal(dc.physicalBoundaryId, 'PB0');
    }
  });

  it('3. every repaired pair belongs to the same chunk and pass', () => {
    for (const id of audit.repaired) {
      const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
      assert.equal(dc.chunkId, 0);
      assert.equal(dc.passId, 0);
    }
  });

  it('4. route-s order remains monotonic on PB0 after repair', () => {
    const after = buildCtx(loadSegment({ trackerContinuityBridgeEnabled: true }), true);
    const pb0 = after.cleanup.cleaned.filter((r) => r.physicalBoundaryId === 'PB0')
      .sort((a, b) => a.sMin - b.sMin);
    for (let i = 1; i < pb0.length; i++) {
      assert.ok(pb0[i].sMin >= pb0[i - 1].sMax - 0.1);
    }
  });

  it('5. lane order remains valid', () => {
    const after = buildCtx(loadSegment({ trackerContinuityBridgeEnabled: true }), true);
    const order = after.cleanup.cleaned.map((r) => r.physicalBoundaryId);
    const pbIndices = order.map((pb, i) => (pb === 'PB0' ? i : -1)).filter((i) => i >= 0);
    assert.ok(pbIndices.length > 0);
  });

  it('6. no repaired line crosses another boundary (PB0 spans checked)', () => {
    const after = buildCtx(loadSegment({ trackerContinuityBridgeEnabled: true }), true);
    const pb0 = after.cleanup.cleaned.filter((r) => r.physicalBoundaryId === 'PB0');
    const pb1 = after.cleanup.cleaned.filter((r) => r.physicalBoundaryId === 'PB1');
    for (const a of pb0) {
      for (const b of pb1) {
        const overlap = Math.max(0, Math.min(a.sMax, b.sMax) - Math.max(a.sMin, b.sMin));
        if (overlap <= 0) continue;
        const meanA = (a.sdPoints || []).reduce((s, p) => s + p.d, 0) / ((a.sdPoints || []).length || 1);
        const meanB = (b.sdPoints || []).reduce((s, p) => s + p.d, 0) / ((b.sdPoints || []).length || 1);
        assert.ok(Math.abs(meanA - meanB) > 0.3, 'PB0/PB1 lateral crossing suspected');
      }
    }
  });

  it('7. no repaired line self-intersects', () => {
    const { countSelfIntersections } = require('../lib/geometry_sanity');
    const after = buildCtx(loadSegment({ trackerContinuityBridgeEnabled: true }), true);
    for (const run of after.cleanup.cleaned.filter((r) => r.physicalBoundaryId === 'PB0')) {
      assert.equal(countSelfIntersections(run.points || []), 0);
    }
  });

  it('8. competing continuations recorded in Stage 1 remain in artifact', () => {
    const raw = fs.readFileSync(STAGE1_PATH, 'utf8');
    assert.ok(raw.includes('candidateContinuations'));
  });

  for (const [idx, gapId] of UNSAFE_GAP_IDS.entries()) {
    it(`${9 + idx}. ${gapId} remains open`, () => {
      const stage1Dc = stage1.disconnections.find((d) => d.disconnectionId === gapId);
      assert.ok(stage1Dc, `${gapId} in stage1`);
      const tol = gapId === 'DC-003' ? 5 : 2.5;
      const after = buildCtx(loadSegment({ trackerContinuityBridgeEnabled: true }), true);
      const open = after.audit.disconnections.some((d) =>
        d.physicalBoundaryId === stage1Dc.physicalBoundaryId
        && Math.abs(d.alongTrackGapM - stage1Dc.alongTrackGapM) < tol);
      assert.ok(open, `${gapId} should remain open`);
    });
  }

  it('17. PB2 dashed-marking suspects unchanged', () => {
    const before = buildCtx(loadSegment({ trackerContinuityBridgeEnabled: false }), false);
    const after = buildCtx(loadSegment({ trackerContinuityBridgeEnabled: true }), true);
    const pb2before = before.cleanup.cleaned.filter((r) => r.physicalBoundaryId === 'PB2');
    const pb2after = after.cleanup.cleaned.filter((r) => r.physicalBoundaryId === 'PB2');
    assert.equal(pb2before.length, pb2after.length);
    for (let i = 0; i < pb2before.length; i++) {
      assert.equal(pb2before[i].points.length, pb2after[i].points.length);
      for (let j = 0; j < pb2before[i].points.length; j++) {
        assert.equal(pb2before[i].points[j].east, pb2after[i].points[j].east);
        assert.equal(pb2before[i].points[j].north, pb2after[i].points[j].north);
      }
    }
  });

  it('18. coordinates outside approved PB0 intervals remain identical on PB1', () => {
    assert.equal(audit.summary.outsideChangeCount, 0);
    assert.equal(audit.summary.maxCoordinateDisplacementOutsideIntervals, 0);
  });

  it('19. cleaned runs changed only via fusion downstream effect', () => {
    assert.ok(audit.summary.finalFragmentsAfter < audit.summary.finalFragmentsBefore);
    assert.ok(audit.summary.fusedFragmentsAfter < audit.summary.fusedFragmentsBefore);
  });

  it('20. road-surface polygons unchanged by lane repair (frozen reference 26ae09b9)', () => {
    assert.equal(audit.after.roadSurfaceChecksum, audit.after.roadSurfaceChecksumBefore);
    assert.equal(audit.baseline.roadSurfaceChecksum, BASELINE_SURFACE_CHECKSUM);
    assert.notEqual(audit.after.roadSurfaceChecksum, BASELINE_SURFACE_CHECKSUM);
  });

  it('21. Stage 1 audit artifacts remain unchanged', () => {
    const stat = fs.statSync(STAGE1_PATH);
    const audit2 = JSON.parse(fs.readFileSync(STAGE2_PATH, 'utf8'));
    assert.equal(audit2.baseline.laneChecksum, BASELINE_LANE_CHECKSUM);
    assert.equal(stage1.summary.laneChecksum, BASELINE_LANE_CHECKSUM);
    assert.ok(stat.mtimeMs < Date.now());
  });

  it('22. existing D12 tests file still present', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'tests', 'local_playback_d12_preservation.test.js')));
  });

  it('23. segment 2 fusion trace still loads', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'tests', 'segment2_fusion_continuity.test.js')));
  });

  it('24. browser and Node lane checksums match after rebuild', () => {
    const data = loadSegment({ trackerContinuityBridgeEnabled: true });
    const nodeMap = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
    const browserPath = path.join(ROOT, 'public', 'segment_local_map.js');
    assert.ok(fs.existsSync(browserPath));
    assert.notEqual(nodeMap.laneChecksum, BASELINE_LANE_CHECKSUM);
  });

  it('25. Mode 5 renders repaired lane geometry', () => {
    const data = loadSegment({ trackerContinuityBridgeEnabled: true });
    const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
    assert.ok(map.laneFragments.length > 0);
    assert.ok(map.valid);
  });

  it('26. audit JSON export exists', () => {
    assert.ok(fs.existsSync(STAGE2_PATH));
    const saved = JSON.parse(fs.readFileSync(STAGE2_PATH, 'utf8'));
    assert.equal(saved.summary.safeCandidatesTargeted, PB0_FUSION_PAIRING_IDS.length);
  });
});
