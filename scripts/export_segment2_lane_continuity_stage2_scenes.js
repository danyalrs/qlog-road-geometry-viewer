'use strict';

const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const SLM = require('../lib/segment_local_map');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const stage1 = require('../audit_segment2_lane_continuity_stage1.json');
const stage2 = require('../audit_segment2_lane_continuity_stage2.json');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots', 'segment2_lane_continuity_stage2');
const OUT = path.join(OUT_DIR, 'verification_scenes.json');
const PB0 = '#2563eb';

function loadData(bridgeEnabled) {
  const seg = path.join(ROOT, 'qlog_f449c_2.bz2');
  const model = extractModel(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const gps = extractGps(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  return processRoute(model, gps, { pipelineMode: 'C', trackerContinuityBridgeEnabled: bridgeEnabled });
}

function boundsForPoints(pts, pad = 6) {
  if (!pts.length) return null;
  return {
    minE: Math.min(...pts.map((p) => p.east)) - pad,
    maxE: Math.max(...pts.map((p) => p.east)) + pad,
    minN: Math.min(...pts.map((p) => p.north)) - pad,
    maxN: Math.max(...pts.map((p) => p.north)) + pad,
  };
}

function pb0Frags(map) {
  return map.laneFragments.filter((f) => f.physicalBoundaryId === 'PB0');
}

function main() {
  const beforeData = loadData(false);
  const afterData = loadData(true);
  const beforeMap = SLM.buildSegmentLocalMap(beforeData, { geometrySource: 'cleaned', timelineIndex: 0 });
  const afterMap = SLM.buildSegmentLocalMap(afterData, { geometrySource: 'cleaned', timelineIndex: 0 });
  const allPts = afterMap.laneFragments.flatMap((f) => f.points || []);
  const pb0Pts = pb0Frags(afterMap).flatMap((f) => f.points || []);
  const scenes = [];

  const overviewBounds = boundsForPoints(allPts, 10);
  for (const [label, map, checksum] of [
    ['before', beforeMap, beforeMap.laneChecksum],
    ['after', afterMap, afterMap.laneChecksum],
  ]) {
    scenes.push({
      sceneId: `lc_stage2_overview_${label}`,
      modeLabel: `laneContinuityStage2_${label}`,
      geometrySource: 'cleaned',
      bounds: overviewBounds,
      fragments: map.laneFragments.map((f) => ({
        points: f.points,
        physicalBoundaryId: f.physicalBoundaryId,
        color: f.physicalBoundaryId === 'PB0' ? PB0 : '#64748b',
        width: f.physicalBoundaryId === 'PB0' ? 3 : 2,
      })),
      laneChecksum: checksum,
      laneContinuityHud: true,
    });
  }

  const pb0Bounds = boundsForPoints(pb0Pts, 8);
  for (const [label, map, checksum] of [
    ['before', beforeMap, beforeMap.laneChecksum],
    ['after', afterMap, afterMap.laneChecksum],
  ]) {
    scenes.push({
      sceneId: `lc_stage2_pb0_chain_${label}`,
      modeLabel: `pb0Chain_${label}`,
      geometrySource: 'cleaned',
      bounds: pb0Bounds,
      fragments: pb0Frags(map).map((f) => ({
        points: f.points,
        color: PB0,
        width: 3,
        physicalBoundaryId: 'PB0',
      })),
      laneChecksum: checksum,
      laneContinuityHud: true,
    });
  }

  const targets = stage1.disconnections.filter((d) => stage2.repaired.includes(d.disconnectionId)
    || stage2.unresolved.includes(d.disconnectionId));
  for (const dc of targets) {
    const prev = afterMap.laneFragments.find((f) => f.fragmentIndex === dc.cleanedRunIds?.preceding
      || f.runId === dc.cleanedRunIds?.preceding);
    const next = afterMap.laneFragments.find((f) => f.fragmentIndex === dc.cleanedRunIds?.following
      || f.runId === dc.cleanedRunIds?.following);
    const pts = [...(prev?.points || []), ...(next?.points || [])];
    if (!pts.length) continue;
    const bounds = boundsForPoints(pts, 8);
    scenes.push({
      sceneId: `lc_stage2_${dc.disconnectionId}_after`,
      disconnectionMeta: {
        disconnectionId: dc.disconnectionId,
        repaired: stage2.repaired.includes(dc.disconnectionId),
        gapM: dc.alongTrackGapM,
      },
      bounds,
      fragments: [prev, next].filter(Boolean).map((f) => ({
        points: f.points, color: PB0, width: 3, physicalBoundaryId: 'PB0',
      })),
      diagnosticLabels: [
        { text: `${dc.disconnectionId} ${stage2.repaired.includes(dc.disconnectionId) ? 'REPAIRED' : 'OPEN'}`, east: (bounds.minE + bounds.maxE) / 2, north: bounds.maxN - 1 },
        { text: `gap=${dc.alongTrackGapM.toFixed(1)}m checksum=${afterMap.laneChecksum}`, east: (bounds.minE + bounds.maxE) / 2, north: bounds.minN + 1 },
      ],
      laneChecksum: afterMap.laneChecksum,
      laneContinuityHud: true,
    });
  }

  for (const id of stage2.summary.unsafeGapsStillOpen) {
    const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
    if (!dc) continue;
    const pb0Runs = beforeMap.laneFragments.filter((f) => f.physicalBoundaryId === dc.physicalBoundaryId);
    const pts = pb0Runs.flatMap((f) => f.points || []);
    const bounds = boundsForPoints(pts.filter((p) => {
      const s = p.s;
      return s == null || (s >= dc.endpointRouteS - 20 && s <= dc.candidateStartRouteS + 20);
    }).length ? pts : pts, 8);
    scenes.push({
      sceneId: `lc_stage2_${id}_unsafe_open`,
      bounds,
      fragments: pb0Runs.map((f) => ({ points: f.points, color: '#dc2626', width: 2.5, physicalBoundaryId: f.physicalBoundaryId })),
      diagnosticLabels: [{ text: `${id} MUST REMAIN OPEN`, east: (bounds.minE + bounds.maxE) / 2, north: bounds.maxN - 1 }],
      laneChecksum: afterMap.laneChecksum,
      laneContinuityHud: true,
    });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    scenes,
    beforeChecksum: beforeMap.laneChecksum,
    afterChecksum: afterMap.laneChecksum,
  }, null, 2));
  console.log(`exported ${scenes.length} scenes -> ${OUT}`);
}

main();
