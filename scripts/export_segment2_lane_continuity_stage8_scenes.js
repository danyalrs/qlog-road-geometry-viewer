'use strict';

const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const SLM = require('../lib/segment_local_map');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const { PRE_STAGE8_SEGMENT_OPTS } = require('../lib/lane_continuity_stage8');
const { STAGE8_TARGET_IDS } = require('../lib/lane_continuity_stage8');
const stage1 = require('../audit_segment2_lane_continuity_stage1.json');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots', 'segment2_lane_continuity_stage8');
const OUT = path.join(OUT_DIR, 'verification_scenes.json');
const PB1 = '#16a34a';

function loadData(opts) {
  const seg = path.join(ROOT, 'qlog_f449c_2.bz2');
  const model = extractModel(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const gps = extractGps(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  return processRoute(model, gps, { pipelineMode: 'C', ...opts });
}

function boundsForPoints(pts, pad = 8) {
  if (!pts.length) return null;
  return {
    minE: Math.min(...pts.map((p) => p.east)) - pad,
    maxE: Math.max(...pts.map((p) => p.east)) + pad,
    minN: Math.min(...pts.map((p) => p.north)) - pad,
    maxN: Math.max(...pts.map((p) => p.north)) + pad,
  };
}

function gapPts(map, id) {
  const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
  const frags = map.laneFragments.filter((f) => f.physicalBoundaryId === 'PB1');
  const run = frags.find((f) => f.sMin <= dc.endpointRouteS + 1 && f.sMax >= dc.candidateStartRouteS - 1);
  const pts = run?.points || [];
  const near = pts.filter((p, i) => {
    const s = run.sdPoints?.[i]?.s;
    return s >= dc.endpointRouteS - 5 && s <= dc.candidateStartRouteS + 5;
  });
  return { run, near, dc };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const beforeData = loadData(PRE_STAGE8_SEGMENT_OPTS);
  const afterData = loadData({
    bimodalClusterSelection: true,
    positiveBoundaryContinuityBridgeEnabled: true,
    visibleGapReconstructionEnabled: true,
  });
  const beforeMap = SLM.buildSegmentLocalMap(beforeData, { geometrySource: 'cleaned', timelineIndex: 0 });
  const afterMap = SLM.buildSegmentLocalMap(afterData, { geometrySource: 'cleaned', timelineIndex: 0 });
  const scenes = [];
  const overviewBounds = boundsForPoints(afterMap.laneFragments.flatMap((f) => f.points || []), 12);

  for (const [label, map, checksum] of [
    ['before', beforeMap, beforeMap.laneChecksum],
    ['after', afterMap, afterMap.laneChecksum],
  ]) {
    scenes.push({
      sceneId: `lc_stage8_overview_mode5_${label}`,
      geometrySource: 'cleaned',
      bounds: overviewBounds,
      laneChecksum: checksum,
      coordinateChecksum: map.laneCleanup?.stats?.coordinateChecksum,
      layers: { cleanedLanes: true, physicalBoundaryColors: true },
    });
  }

  for (const id of STAGE8_TARGET_IDS) {
    const { near, dc } = gapPts(beforeMap, id);
    const bBounds = boundsForPoints(near, 6);
    scenes.push({
      sceneId: `lc_stage8_${id}_before`,
      geometrySource: 'cleaned',
      bounds: bBounds,
      disconnectionMeta: { disconnectionId: id, repaired: false },
      layers: { cleanedLanes: true, endpoints: true },
    });
    const afterGap = gapPts(afterMap, id);
    scenes.push({
      sceneId: `lc_stage8_${id}_after`,
      geometrySource: 'cleaned',
      bounds: boundsForPoints(afterGap.near, 6),
      disconnectionMeta: { disconnectionId: id, repaired: true, method: 'straight' },
      layers: { cleanedLanes: true, interpolated: true, endpoints: true },
    });
  }

  scenes.push({
    sceneId: 'lc_stage8_diagnostic_interpolation_layer',
    geometrySource: 'cleaned',
    bounds: boundsForPoints(gapPts(afterMap, 'DC-010').near.concat(gapPts(afterMap, 'DC-012').near), 10),
    layers: { cleanedLanes: true, interpolatedOnly: true, tangentArrows: true },
  });

  const payload = {
    beforeChecksum: beforeMap.laneChecksum,
    afterChecksum: afterMap.laneChecksum,
    beforeCoordinateChecksum: beforeMap.laneCleanup?.stats?.coordinateChecksum,
    afterCoordinateChecksum: afterMap.laneCleanup?.stats?.coordinateChecksum,
    scenes,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log('Wrote', OUT, scenes.length, 'scenes');
}

main();
