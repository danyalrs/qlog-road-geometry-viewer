'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const VDC = require('../lib/viewer_display_corrections');
const VMB = require('../lib/viewer_map_build');
const SLM = require('../lib/segment_local_map');
const CBAO = require('../lib/combined_boundary_anchored_orientation');
const CRB = require('../lib/combined_route_boundary_bridge');

const ROOT = path.join(__dirname, '..');
const SEG0_FILE = 'qlog_f449c_0.bz2';
const SEG2_FILE = 'qlog_f449c_2.bz2';
const SEG0_SHA = '9ddfc49b6061357e648a096d13749e30f9597827fd86786951241f098ea29fa5';

function processSelection(segments) {
  const files = segments.map((s) => `qlog_f449c_${s}.bz2`);
  const loaded = require('../lib/qlog_data').loadSegmentsData(ROOT, files, VMB.VIEWER_DEFAULT_PROCESS_OPTIONS);
  const { processRoute, buildTimeline } = require('../lib/process_route');
  const { qualifySegments } = require('../lib/segment_qualify');
  const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
  const sq = qualifySegments(loaded.audits);
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
    ...VMB.VIEWER_DEFAULT_PROCESS_OPTIONS,
    segmentQualifications: sq,
    fileAudits: loaded.audits,
  });
  return {
    ...result,
    timeline: enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath),
    fileAudits: loaded.audits,
  };
}

function buildMap(pd, segmentFile) {
  const idx = pd.timeline.findIndex((t) => t.sourceFile === segmentFile);
  return SLM.buildSegmentLocalMap(pd, {
    geometrySource: 'pointAccumulated',
    timelineIndex: idx >= 0 ? idx : 0,
  });
}

function candidateMap(segments) {
  const pd = processSelection(segments);
  return CBAO.applyBoundaryAnchoredOrientation(buildMap(pd, SEG2_FILE), pd, { mirrorChecked: true });
}

function handednessAgreement(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 100;
  let agree = 0;
  for (let i = 0; i < n; i++) {
    if ((a[i] >= 0) === (b[i] >= 0) || (Math.abs(a[i]) < 1e-6 && Math.abs(b[i]) < 1e-6)) agree += 1;
  }
  return (agree / n) * 100;
}

describe('combined boundary anchoring continuity', () => {
  it('1. Candidate B 303.26 m tear remains rejected', () => {
    const pd = processSelection([0, 1, 2]);
    const map = buildMap(pd, SEG2_FILE);
    const shaByFile = CBAO.buildSourceSha256Lookup(pd.fileAudits);
    const rejected = CBAO.buildRejectedCandidateBReport(map.trajectory, shaByFile, pd.timeline);
    assert.ok(rejected.seamDistanceAfterCandidateBM[0] > 300);
  });

  it('2. Candidate C retains Segment 2 left curve', () => {
    const standalone = buildMap(processSelection(['2']), SEG2_FILE);
    const combined = candidateMap([0, 1, 2]);
    const s = standalone.trajectory.filter((p) => p.sourceFile === SEG2_FILE);
    const c = combined.trajectory.filter((p) => p.sourceFile === SEG2_FILE);
    assert.equal(CBAO.dominantTurnSign(CBAO.signedTurnSequence(c)), 'left');
    assert.ok(handednessAgreement(CBAO.signedTurnSequence(s), CBAO.signedTurnSequence(c)) >= 80);
  });

  it('3-4. Segment 0→1 and 1→2 centerlines are bridged', () => {
    const map = candidateMap([0, 1, 2]);
    assert.ok(CRB.boundaryCrossingsAreBridged(map.trajectory));
    const accepted = (map.boundaryBridges || []).filter((b) => b.supportStatus === 'accepted');
    assert.equal(accepted.length, 2);
  });

  it('5. grey road ribbon covers accepted boundary sections', () => {
    const map = candidateMap([0, 1, 2]);
    const bridgePolys = (map.roadSurfacePolygons || []).filter((p) => p.fragmentKind === 'combinedRouteBoundaryBridge');
    assert.equal(bridgePolys.length, 2);
    for (const poly of bridgePolys) {
      assert.ok(poly.ring?.length >= 4);
      assert.equal(poly.bridgeProvenance?.supportStatus, 'accepted');
    }
  });

  it('6. no direct source-boundary jump exceeds continuity step', () => {
    const map = candidateMap([0, 1, 2]);
    for (let i = 0; i < map.trajectory.length - 1; i++) {
      const a = map.trajectory[i];
      const b = map.trajectory[i + 1];
      if (a.sourceFile && b.sourceFile && a.sourceFile !== b.sourceFile) {
        assert.fail('direct source adjacency without bridge');
      }
    }
  });

  it('7. bridge ribbons do not self-intersect', () => {
    const map = candidateMap([0, 1, 2]);
    const bridgePolys = (map.roadSurfacePolygons || []).filter((p) => p.fragmentKind === 'combinedRouteBoundaryBridge');
    for (const poly of bridgePolys) {
      assert.equal(CRB.ringSelfIntersects(poly.ring), false);
    }
  });

  it('8. arrow path has bridged boundary steps only', () => {
    const map = candidateMap([0, 1, 2]);
    const bridgeSteps = [];
    for (let i = 1; i < map.trajectory.length; i++) {
      const a = map.trajectory[i - 1];
      const b = map.trajectory[i];
      if (a.bridgeSection || b.bridgeSection) {
        bridgeSteps.push(Math.hypot(b.east - a.east, b.north - a.north));
      }
    }
    assert.ok(bridgeSteps.length > 0);
    assert.ok(bridgeSteps.every((d) => d <= CRB.CONTINUITY_MAX_STEP_M));
  });

  it('9. lane gaps remain honest (no fabricated lane bridge)', () => {
    const map = candidateMap([0, 1, 2]);
    const laneBridge = (map.laneFragments || []).some((f) => f.fragmentKind === 'combinedRouteBoundaryBridge');
    assert.equal(laneBridge, false);
  });

  it('10. standalone Segment 0 unchanged', () => {
    const pd = processSelection(['0']);
    const map = buildMap(pd, SEG0_FILE);
    assert.equal(map.sourceQlogSha256, SEG0_SHA);
    assert.equal(VDC.isExactDisplayCorrectionActive(true, map.sourceQlogSha256), true);
  });

  it('11. standalone Segment 2 unchanged', () => {
    const pd = processSelection(['2']);
    const map = buildMap(pd, SEG2_FILE);
    assert.equal(VDC.isExactDisplayCorrectionActive(true, map.sourceQlogSha256), false);
  });

  it('12. combined Segment 2 curves left', () => {
    const map = candidateMap([0, 1, 2]);
    const seg2 = map.trajectory.filter((p) => p.sourceFile === SEG2_FILE);
    assert.equal(CBAO.dominantTurnSign(CBAO.signedTurnSequence(seg2)), 'left');
  });

  it('13. Segment 99 remains undistorted', () => {
    const pd = processSelection(['99']);
    const map = buildMap(pd, 'qlog_f449c_99.bz2');
    assert.ok(map.valid);
  });

  it('14. [1,2] works without Segment 0', () => {
    const map = candidateMap([1, 2]);
    assert.ok(CRB.boundaryCrossingsAreBridged(map.trajectory));
  });

  it('15. [0,1,2] works in route order', () => {
    const map = candidateMap([0, 1, 2]);
    assert.ok(map.combinedRouteContinuity?.bridgeCount >= 2);
  });

  it('16. [2,1,0] uses same route ordering policy', () => {
    const a = buildMap(processSelection([0, 1, 2]), SEG2_FILE);
    const b = buildMap(processSelection([2, 1, 0]), SEG2_FILE);
    assert.equal(a.checksum, b.checksum);
  });

  it('17. non-consecutive selection does not receive a false bridge', () => {
    const pd = processSelection([0, 2]);
    const map = CBAO.applyBoundaryAnchoredOrientation(buildMap(pd, SEG2_FILE), pd, { mirrorChecked: true });
    const accepted = (map.boundaryBridges || []).filter((b) => b.supportStatus === 'accepted');
    assert.equal(accepted.length, 0);
  });

  it('18-19. video and boundary pause modules remain', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'tests/single_video_boundary_pause.test.js')));
    assert.ok(fs.existsSync(path.join(ROOT, 'tests/multisegment_video_switch.test.js')));
  });

  it('20. normal viewer path unchanged when candidate off', () => {
    const renderSrc = fs.readFileSync(path.join(ROOT, 'public', 'render.js'), 'utf8');
    assert.doesNotMatch(renderSrc, /_mapIsMultiSource/);
    const pd = processSelection([0, 1, 2]);
    const map = buildMap(pd, SEG2_FILE);
    assert.equal(map.boundaryAnchoredOrientationActive, undefined);
  });
});
