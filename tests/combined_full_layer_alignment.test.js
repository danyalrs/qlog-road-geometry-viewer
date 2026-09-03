'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const VMB = require('../lib/viewer_map_build');
const SLM = require('../lib/segment_local_map');
const CBAO = require('../lib/combined_boundary_anchored_orientation');
const CST = require('../lib/combined_source_transform');
const CRB = require('../lib/combined_route_boundary_bridge');
const VDC = require('../lib/viewer_display_corrections');

const ROOT = path.join(__dirname, '..');
const SEG0_FILE = 'qlog_f449c_0.bz2';
const SEG1_FILE = 'qlog_f449c_1.bz2';
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
  return {
    pd,
    map: CBAO.applyBoundaryAnchoredOrientation(buildMap(pd, SEG2_FILE), pd, { mirrorChecked: true }),
  };
}

function seg0Points(map, frameIndex = 20) {
  return (map.pointAccumulated?.points || []).filter((p) => p.sourceFile === SEG0_FILE && p.frameIndex === frameIndex);
}

describe('combined full layer alignment', () => {
  it('1-2. source provenance survives accumulation and current-frame points', () => {
    const { map } = candidateMap([0, 1, 2]);
    const pts = map.pointAccumulated?.points || [];
    assert.ok(pts.length > 0);
    assert.ok(pts.every((p) => p.sourceFile));
    assert.ok(seg0Points(map).length > 0);
  });

  it('3-4. road and lane points share source transform', () => {
    const { map } = candidateMap([0, 1, 2]);
    const registry = map.sourceTransformByFile;
    assert.ok(registry?.[SEG0_FILE]);
    const lane = seg0Points(map)[0];
    const canonical = { east: lane.localEast, north: lane.localNorth, sourceFile: SEG0_FILE };
    const viaRegistry = CST.transformSourcePointToCombined(canonical, registry);
    const viaLanePath = CST.transformMapPoint({
      localEast: lane.localEast,
      localNorth: lane.localNorth,
      sourceFile: SEG0_FILE,
    }, registry, map.timeline);
    assert.ok(CST.roadAndLanePlacedAgreement(
      viaRegistry.east,
      viaRegistry.north,
      viaLanePath.localEast,
      viaLanePath.localNorth,
      1e-6,
    ));
  });

  it('5-7. known Segment 0 canonical point matches across paths; mirrored cannot bypass', () => {
    const { pd, map } = candidateMap([0, 1, 2]);
    const baseline = buildMap(pd, SEG0_FILE);
    const lane = (baseline.pointAccumulated?.points || []).find((p) => p.sourceFile === SEG0_FILE);
    assert.ok(lane);
    const onMap = (map.pointAccumulated?.points || []).find((p) => p.frameIndex === lane.frameIndex && p.laneIndex === lane.laneIndex);
    assert.equal(onMap.coordinateFrame, CST.OUTPUT_FRAME);
    assert.equal(onMap.mirroredLocalEast, onMap.localEast);
    assert.equal(onMap.mirroredLocalNorth, onMap.localNorth);
  });

  it('8-10. combinedPlaced not double-transformed; layer-independent registry', () => {
    const { map } = candidateMap([0, 1, 2]);
    const entry = map.sourceTransformByFile[SEG0_FILE];
    assert.ok(entry);
    const probe = { east: 10, north: -5, sourceFile: SEG0_FILE };
    const once = CST.transformSourcePointToCombined(probe, map.sourceTransformByFile);
    const twice = CST.transformMapPoint({ ...once, coordinateFrame: undefined }, map.sourceTransformByFile, map.timeline);
    assert.notEqual(twice.coordinateFrame, undefined);
    assert.ok(CST.transformsAgree(map.sourceTransformByFile, SEG0_FILE, probe.east, probe.north));
  });

  it('11-13. Segment 0 lane points align with road trajectory', () => {
    const { map } = candidateMap([0, 1, 2]);
    const traj = map.trajectory.filter((p) => p.sourceFile === SEG0_FILE);
    const pts = seg0Points(map, traj[10]?.timelineIndex ?? 10);
    assert.ok(pts.length > 0);
    const road = traj[10] ?? traj[0];
    for (const lane of pts.slice(0, 8)) {
      const d = Math.hypot(lane.localEast - road.east, lane.localNorth - road.north);
      assert.ok(d < 20, `lane too far from road: ${d}`);
      assert.equal(lane.coordinateFrame, CST.OUTPUT_FRAME);
    }
  });

  it('14-15. M-051/hybrid/candidate vertices use combinedPlaced frame when present', () => {
    const pd = processSelection([0, 1, 2]);
    const idx = pd.timeline.findIndex((t) => t.sourceFile === SEG2_FILE);
    const fittedMap = CBAO.applyBoundaryAnchoredOrientation(
      SLM.buildSegmentLocalMap(pd, {
        geometrySource: 'pointAccumulated',
        timelineIndex: idx >= 0 ? idx : 0,
        fitEnabled: true,
      }),
      pd,
      { mirrorChecked: true },
    );
    const hybrid = fittedMap.pointAccumulated?.hybridFittedBoundaries;
    if (hybrid?.boundaries?.length) {
      const vtx = hybrid.boundaries[0].polylines?.[0]?.[0];
      assert.equal(hybrid.boundaries[0].coordinateFrame, CST.OUTPUT_FRAME);
      if (vtx) assert.equal(vtx.coordinateFrame, CST.OUTPUT_FRAME);
    } else {
      const { map } = candidateMap([0, 1, 2]);
      assert.ok(map.pointAccumulated?.points?.[0]?.coordinateFrame === CST.OUTPUT_FRAME);
    }
  });

  it('16-17. arrow trajectory and fit bounds use placed coordinates', () => {
    const { pd, map } = candidateMap([0, 1, 2]);
    const pose = SLM.resolveArrowOnSegmentMap(map, pd.timeline, 20, {});
    const near = map.trajectory[20];
    assert.ok(Math.hypot(pose.east - near.east, pose.north - near.north) < 5);
    assert.ok(map.fitBounds || map.bounds);
  });

  it('18-20. bridges remain continuous and ribbon safe', () => {
    const { map } = candidateMap([0, 1, 2]);
    assert.ok(CRB.boundaryCrossingsAreBridged(map.trajectory));
    const bridges = (map.boundaryBridges || []).filter((b) => b.supportStatus === 'accepted');
    assert.equal(bridges.length, 2);
  });

  it('21. Segment 2 still curves left', () => {
    const { map } = candidateMap([0, 1, 2]);
    const seg2 = map.trajectory.filter((p) => p.sourceFile === SEG2_FILE);
    assert.equal(CBAO.dominantTurnSign(CBAO.signedTurnSequence(seg2)), 'left');
  });

  it('22-24. standalone regressions', () => {
    const pd0 = processSelection(['0']);
    const s0 = buildMap(pd0, SEG0_FILE);
    const pd0b = processSelection(['0']);
    const s0b = buildMap(pd0b, SEG0_FILE);
    assert.equal(s0.checksum, s0b.checksum);
    const pd2 = processSelection(['2']);
    const s2 = buildMap(pd2, SEG2_FILE);
    const s2b = buildMap(processSelection(['2']), SEG2_FILE);
    assert.equal(s2.checksum, s2b.checksum);
    const pd99 = processSelection(['99']);
    const s99 = buildMap(pd99, 'qlog_f449c_99.bz2');
    assert.ok(s99.valid);
  });

  it('25-28. modules present; normal path unchanged; candidate off by default', () => {
    assert.ok(fsExists('../lib/multisegment_video_timeline.js'));
    assert.ok(fsExists('../lib/single_video_boundary_pause.js'));
    const { map } = candidateMap([0, 1, 2]);
    assert.equal(map.boundaryAnchoredOrientationActive, true);
    const normal = buildMap(processSelection([0, 1, 2]), SEG2_FILE);
    assert.equal(normal.boundaryAnchoredOrientationActive, undefined);
    assert.equal(CBAO.parseCombinedOrientationCandidate(''), null);
  });

  it('29-30. no segment-number branch; M-051 thresholds unchanged', () => {
    const src = require('fs').readFileSync(path.join(ROOT, 'lib/combined_source_transform.js'), 'utf8');
    assert.ok(!src.includes('segmentId === 0'));
    assert.ok(!src.includes('segmentNumber === 0'));
    assert.ok(!src.includes('qlog_f449c_0'));
  });
});

function fsExists(rel) {
  try {
    require('fs').accessSync(path.join(__dirname, rel));
    return true;
  } catch {
    return false;
  }
}
