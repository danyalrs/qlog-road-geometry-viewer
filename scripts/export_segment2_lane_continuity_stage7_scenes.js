'use strict';

const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const SLM = require('../lib/segment_local_map');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const { PRE_STAGE7_SEGMENT_OPTS } = require('../lib/lane_continuity_stage6');
const { TARGET_IDS, STAGE6_TARGET_KEYS } = require('../lib/lane_continuity_stage7');
const stage1 = require('../audit_segment2_lane_continuity_stage1.json');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots', 'segment2_lane_continuity_stage7');
const OUT = path.join(OUT_DIR, 'verification_scenes.json');
const PB1 = '#16a34a';
const PB0 = '#2563eb';
const PB2 = '#9333ea';

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

function fragsNear(map, pb, s0, s1) {
  return map.laneFragments.filter((f) => f.physicalBoundaryId === pb
    && f.points?.some((p, i) => {
      const s = f.sdPoints?.[i]?.s;
      return s == null || (s >= s0 - 15 && s <= s1 + 15);
    }));
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const beforeData = loadData(PRE_STAGE7_SEGMENT_OPTS);
  const afterData = loadData({ bimodalClusterSelection: true, positiveBoundaryContinuityBridgeEnabled: true });
  const beforeMap = SLM.buildSegmentLocalMap(beforeData, { geometrySource: 'cleaned', timelineIndex: 0 });
  const afterMap = SLM.buildSegmentLocalMap(afterData, { geometrySource: 'cleaned', timelineIndex: 0 });
  const allPts = afterMap.laneFragments.flatMap((f) => f.points || []);
  const overviewBounds = boundsForPoints(allPts, 12);
  const scenes = [];

  for (const [label, map, checksum] of [
    ['before', beforeMap, beforeMap.laneChecksum],
    ['after', afterMap, afterMap.laneChecksum],
  ]) {
    scenes.push({
      sceneId: `lc_stage7_overview_mode5_${label}`,
      modeLabel: `laneContinuityStage7_${label}`,
      geometrySource: 'cleaned',
      bounds: overviewBounds,
      fragments: map.laneFragments.map((f) => ({
        points: f.points,
        physicalBoundaryId: f.physicalBoundaryId,
        color: f.physicalBoundaryId === 'PB1' ? PB1 : (f.physicalBoundaryId === 'PB0' ? PB0 : PB2),
        width: 2,
      })),
      laneChecksum: checksum,
      laneContinuityHud: true,
    });
  }

  for (const id of TARGET_IDS) {
    const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
    const [s0, s1] = [dc.endpointRouteS, dc.candidateStartRouteS];
    const bounds = boundsForPoints(
      fragsNear(afterMap, 'PB1', s0, s1).flatMap((f) => f.points || []),
      6,
    );
    for (const [label, map, checksum] of [
      ['before', beforeMap, beforeMap.laneChecksum],
      ['after', afterMap, afterMap.laneChecksum],
    ]) {
      scenes.push({
        sceneId: `lc_stage7_${id}_${label}`,
        geometrySource: 'cleaned',
        bounds,
        fragments: fragsNear(map, 'PB1', s0, s1).map((f) => ({
          points: f.points,
          color: PB1,
          width: 3,
        })),
        laneChecksum: checksum,
        disconnectionMeta: {
          disconnectionId: id,
          stableKey: STAGE6_TARGET_KEYS[id],
          physicalBoundaryId: 'PB1',
          trackId: 2,
          routeSInterval: [s0, s1],
          gapM: s1 - s0,
          repaired: label === 'after',
          verdict: label === 'after' ? 'A' : 'open',
        },
        laneContinuityHud: true,
      });
    }
  }

  for (const id of ['DC-000', 'DC-005', 'DC-007', 'DC-015']) {
    const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
    const [s0, s1] = [dc.endpointRouteS, dc.candidateStartRouteS];
    const pb = dc.physicalBoundaryId;
    const bounds = boundsForPoints(fragsNear(afterMap, pb, s0, s1).flatMap((f) => f.points || []), 5);
    scenes.push({
      sceneId: `lc_stage7_preserve_${id}_after`,
      geometrySource: 'cleaned',
      bounds,
      fragments: fragsNear(afterMap, pb, s0, s1).map((f) => ({ points: f.points, color: pb === 'PB2' ? PB2 : PB1, width: 3 })),
      laneChecksum: afterMap.laneChecksum,
      disconnectionMeta: { disconnectionId: id, repaired: false, verdict: 'remain_open' },
      laneContinuityHud: true,
    });
  }

  for (const pb of ['PB0', 'PB2']) {
    const color = pb === 'PB0' ? PB0 : PB2;
    const fr = afterMap.laneFragments.filter((f) => f.physicalBoundaryId === pb);
    scenes.push({
      sceneId: `lc_stage7_${pb.toLowerCase()}_overview_after`,
      geometrySource: 'cleaned',
      bounds: boundsForPoints(fr.flatMap((f) => f.points || []), 10),
      fragments: fr.map((f) => ({ points: f.points, color, width: 2 })),
      laneChecksum: afterMap.laneChecksum,
      laneContinuityHud: true,
    });
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    beforeChecksum: beforeMap.laneChecksum,
    afterChecksum: afterMap.laneChecksum,
    scenes,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${scenes.length} scenes to ${OUT}`);
}

main();
