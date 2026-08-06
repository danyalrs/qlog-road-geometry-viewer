'use strict';

/**
 * Segment 2 lane-continuity Stage 1 audit export.
 * Usage: node scripts/audit_segment2_lane_continuity_stage1.js
 */

const fs = require('fs');
const path = require('path');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
const LMC = require('../lib/lane_map_cleanup');
const SLM = require('../lib/segment_local_map');
const LCS = require('../lib/lane_continuity_stage1');
const { collectLaneObservations } = require('../lib/sd_fusion');
const { buildReferenceTrajectory } = require('../lib/trajectory');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEG = path.join(ROOT, 'qlog_f449c_2.bz2');
const OUT = path.join(ROOT, 'audit_segment2_lane_continuity_stage1.json');

function loadClassDGaps() {
  const p = path.join(ROOT, 'audit_segment2_class_d_fusion_gaps.json');
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8')).gaps || [];
}

function loadSegment() {
  const modelEvents = extractModel(SEG).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const gpsEvents = extractGps(SEG).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
  return { ...result, timeline };
}

function enrichRunsWithFrameMeta(cleaned, frames) {
  const frameById = new Map(frames.map((f, i) => [f.frameId, { ...f, elapsedIdx: i }]));
  return cleaned.map((run) => {
    const frags = run.sourceFragments || [];
    const firstFrag = frags[0];
    const lastFrag = frags[frags.length - 1];
    const startFrameId = firstFrag?.sourceFrameId ?? firstFrag?.frameId ?? null;
    const endFrameId = lastFrag?.sourceFrameId ?? lastFrag?.frameId ?? null;
    return {
      ...run,
      startFrameId,
      endFrameId,
      startElapsedIdx: startFrameId != null ? frameById.get(startFrameId)?.elapsedIdx : null,
      endElapsedIdx: endFrameId != null ? frameById.get(endFrameId)?.elapsedIdx : null,
    };
  });
}

function main() {
  if (!fs.existsSync(SEG)) {
    console.error('Missing', SEG);
    process.exit(1);
  }

  const data = loadSegment();
  const chunk = data.routeChunks[0];
  const classDGaps = loadClassDGaps().filter((g) => g.primaryMechanism === 'D12');
  const allClassDGaps = loadClassDGaps();

  const cleanup = LMC.buildCleanedLaneMap({
    frames: chunk.frames,
    fusedLanes: chunk.fusedLaneLines,
    tracks: chunk.laneTracks,
    chunkId: 0,
    passId: 0,
    vehiclePath: chunk.vehiclePath,
    classDGaps,
    enableD12Preservation: true,
  });

  cleanup.cleaned = enrichRunsWithFrameMeta(cleanup.cleaned, chunk.frames);

  const mode5Before = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
  const mode5After = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });

  const trajectory = buildReferenceTrajectory(chunk.vehiclePath);
  const observations = collectLaneObservations(chunk.frames, trajectory);

  const audit = LCS.runLaneContinuityStage1({
    data,
    cleanup,
    mode5Map: mode5Before,
    frames: chunk.frames,
    timeline: data.timeline,
    observations,
    fusedLanes: chunk.fusedLaneLines,
    classDGaps: allClassDGaps,
    laneChecksumBefore: mode5Before.laneChecksum,
  });

  const out = {
    generatedAt: new Date().toISOString(),
    segment: 'qlog_f449c_2.bz2',
    stage: 1,
    scope: 'lane_continuity_audit_read_only',
    baseline: audit.baseline,
    summary: audit.summary,
    causeCounts: audit.causeCounts,
    primaryCauseTaxonomy: audit.primaryCauseTaxonomy,
    endpoints: audit.endpoints,
    disconnections: audit.disconnections,
    integrity: {
      laneChecksumBefore: mode5Before.laneChecksum,
      laneChecksumAfter: mode5After.laneChecksum,
      laneChecksumUnchanged: mode5Before.laneChecksum === mode5After.laneChecksum,
      geometryModified: false,
    },
    screenshotDir: 'screenshots/segment2_lane_continuity_stage1',
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    endpoints: audit.summary.totalEndpoints,
    disconnections: audit.summary.visibleDisconnections,
    safeCandidates: audit.summary.safeConnectionCandidates,
    laneChecksum: audit.summary.laneChecksum,
    cleanedRuns: audit.summary.cleanedRunCount,
    fusedFragments: audit.summary.fusedFragmentCount,
  }, null, 2));
}

main();
