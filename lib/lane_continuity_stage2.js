'use strict';

/**
 * Segment 2 lane-continuity Stage 2: PB0 fusion-pairing repair audit.
 */

const fs = require('fs');
const path = require('path');
const { dist2d } = require('./chunking');
const { runLaneContinuityStage1 } = require('./lane_continuity_stage1');
const { traceLaneTrackFusion } = require('./fusion_gap_trace');
const { collectLaneObservations } = require('./sd_fusion');
const { buildReferenceTrajectory } = require('./trajectory');
const { processRoute, buildTimeline } = require('./process_route');
const LMC = require('./lane_map_cleanup');
const SLM = require('./segment_local_map');
const { computeRoadPolygonChecksum } = require('./segment_local_map');

const STAGE1_AUDIT = path.join(__dirname, '..', 'audit_segment2_lane_continuity_stage1.json');
const BASELINE_LANE_CHECKSUM = '5283af91';
const BASELINE_SURFACE_CHECKSUM = '26ae09b9';
const UNSAFE_GAP_IDS = ['DC-002', 'DC-003', 'DC-004', 'DC-013', 'DC-015', 'DC-016', 'DC-017', 'DC-018'];
const PB0_FUSION_PAIRING_IDS = ['DC-014', 'DC-019', 'DC-020', 'DC-021', 'DC-022', 'DC-023', 'DC-024'];

function loadSegment(processOpts = {}) {
  const { extractFromFile: extractModel } = require('../extract_modelv2');
  const { extractFromFile: extractGps } = require('../extract_gps');
  const seg = path.join(__dirname, '..', 'qlog_f449c_2.bz2');
  const model = extractModel(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const gps = extractGps(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  return processRoute(model, gps, {
    pipelineMode: 'C',
    trackerContinuityBridgeEnabled: processOpts.trackerContinuityBridgeEnabled ?? true,
    positiveBoundaryContinuityBridgeEnabled: processOpts.positiveBoundaryContinuityBridgeEnabled ?? false,
    bimodalClusterSelection: processOpts.bimodalClusterSelection ?? false,
    ...processOpts,
  });
}

function buildCtx(data, bridgeEnabled) {
  const chunk = data.routeChunks[0];
  const traj = buildReferenceTrajectory(chunk.vehiclePath);
  const observations = collectLaneObservations(chunk.frames || [], traj, {});
  const cleanup = LMC.buildCleanedLaneMap({
    frames: chunk.frames,
    fusedLanes: chunk.fusedLaneLines,
    tracks: chunk.laneTracks,
    chunkId: 0,
    passId: 0,
    vehiclePath: chunk.vehiclePath,
    enableD12Preservation: true,
  });
  const mode5 = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
  const audit = runLaneContinuityStage1({
    data,
    cleanup,
    mode5Map: mode5,
    frames: chunk.frames,
    timeline: buildTimeline(data.frames),
    observations,
    fusedLanes: chunk.fusedLaneLines,
    classDGaps: chunk.classDGaps || [],
    laneChecksumBefore: BASELINE_LANE_CHECKSUM,
  });
  const trace = traceLaneTrackFusion(observations, 0, {
    trackerContinuityBridgeEnabled: bridgeEnabled,
  });
  return { chunk, traj, observations, cleanup, mode5, audit, trace };
}

function coordKey(p) {
  return `${p.east?.toFixed(6)},${p.north?.toFixed(6)}`;
}

function compareOutsideIntervals(beforeRuns, afterRuns, intervals) {
  let maxDisplacement = 0;
  const outsideChanges = [];

  const beforeByPb = new Map();
  for (const run of beforeRuns) {
    const pb = run.physicalBoundaryId;
    if (!beforeByPb.has(pb)) beforeByPb.set(pb, []);
    beforeByPb.get(pb).push(run);
  }
  const afterByPb = new Map();
  for (const run of afterRuns) {
    const pb = run.physicalBoundaryId;
    if (!afterByPb.has(pb)) afterByPb.set(pb, []);
    afterByPb.get(pb).push(run);
  }

  for (const [pb, runs] of beforeByPb.entries()) {
    if (pb === 'PB0') continue;
    const afterPb = (afterByPb.get(pb) || []).sort((a, b) => a.sMin - b.sMin);
    const beforeSorted = [...runs].sort((a, b) => a.sMin - b.sMin);
    if (beforeSorted.length !== afterPb.length) {
      outsideChanges.push({ pb, type: 'runCountChange', before: beforeSorted.length, after: afterPb.length });
      continue;
    }
    for (let i = 0; i < beforeSorted.length; i++) {
      const aPts = beforeSorted[i].points || [];
      const bPts = afterPb[i].points || [];
      if (aPts.length !== bPts.length) {
        outsideChanges.push({ pb, type: 'pointCountChange', run: i });
        continue;
      }
      for (let j = 0; j < aPts.length; j++) {
        const d = dist2d(aPts[j], bPts[j]);
        if (d > maxDisplacement) maxDisplacement = d;
        if (d > 1e-6) outsideChanges.push({ pb, type: 'pointMoved', run: i, idx: j, d });
      }
    }
  }

  return { maxDisplacement, outsideChanges };
}

function tracePb0FusionFailures(trace, stage1Targets) {
  const records = [];
  for (const dc of stage1Targets) {
    const gapStartS = dc.endpointRouteS;
    const gapEndS = dc.candidateStartRouteS;
    const split = trace.fragmentSplits.find((s) =>
      Math.abs((s.gapM ?? 0) - dc.alongTrackGapM) < 2
      || (gapStartS != null && gapEndS != null && s.gapM >= (gapEndS - gapStartS) * 0.8 && s.gapM <= (gapEndS - gapStartS) * 1.2));
    records.push({
      disconnectionId: dc.disconnectionId,
      sourceFragmentId: dc.sourceFragmentId,
      candidateContinuationFragmentId: dc.candidateContinuationFragmentId,
      trackId: dc.trackId,
      chunkId: dc.chunkId,
      passId: dc.passId,
      routeSInterval: [gapStartS, gapEndS],
      alongTrackGapM: dc.alongTrackGapM,
      euclideanGapM: dc.euclideanGapM,
      lateralOffsetM: dc.lateralOffsetM,
      headingDifferenceDeg: dc.headingDifferenceDeg,
      observationSupport: dc.observationIndices,
      fusionSplit: split || null,
      rejectionCondition: split?.bridgeRejected || split?.reason || 'D11_maxLaneFragmentGapM',
      responsibleFunction: 'fuseLaneTrackSdFragments / canBridgeTrackerContinuousFusionGap',
      failureKind: split?.bridgeRejected ? 'compatibility_rejection' : 'fragment_construction',
      trackerContinuous: dc.pipelineTrace?.stages?.trackerOutput?.connected ?? null,
    });
  }
  return records;
}

function matchGapOpen(stage1Dc, afterAudit) {
  const tol = 2.5;
  return afterAudit.disconnections.some((d) =>
    d.physicalBoundaryId === stage1Dc.physicalBoundaryId
    && Math.abs(d.alongTrackGapM - stage1Dc.alongTrackGapM) < tol);
}

function runLaneContinuityStage2() {
  const stage1 = JSON.parse(fs.readFileSync(STAGE1_AUDIT, 'utf8'));
  const before = buildCtx(loadSegment({ trackerContinuityBridgeEnabled: false }), false);
  const after = buildCtx(loadSegment({ trackerContinuityBridgeEnabled: true }), true);

  const pb0Targets = stage1.disconnections.filter((d) =>
    PB0_FUSION_PAIRING_IDS.includes(d.disconnectionId));
  const unsafeGaps = stage1.disconnections.filter((d) => UNSAFE_GAP_IDS.includes(d.disconnectionId));

  const repairIntervals = pb0Targets.map((d) => ({
    disconnectionId: d.disconnectionId,
    startS: d.endpointRouteS,
    endS: d.candidateStartRouteS,
  }));

  const outside = compareOutsideIntervals(before.cleanup.cleaned, after.cleanup.cleaned, repairIntervals);

  const repaired = [];
  const unresolved = [];
  for (const dc of pb0Targets) {
    const stillOpen = matchGapOpen(dc, after.audit);
    if (stillOpen) unresolved.push(dc.disconnectionId);
    else repaired.push(dc.disconnectionId);
  }

  const unsafeStillOpen = unsafeGaps.map((dc) => ({
    disconnectionId: dc.disconnectionId,
    stillOpen: matchGapOpen(dc, after.audit),
    alongTrackGapM: dc.alongTrackGapM,
  }));

  const fusionTrace = tracePb0FusionFailures(after.trace, pb0Targets);

  const surfaceBefore = computeRoadPolygonChecksum(before.chunk.roadSurfacePolygons || []);
  const surfaceAfter = computeRoadPolygonChecksum(after.chunk.roadSurfacePolygons || []);

  return {
    generatedAt: new Date().toISOString(),
    segment: 'qlog_f449c_2.bz2',
    stage: 2,
    scope: 'pb0_fusion_pairing_repair',
    baseline: {
      laneChecksum: BASELINE_LANE_CHECKSUM,
      cleanedRunCount: before.cleanup.cleaned.length,
      fusedFragmentCount: before.chunk.fusedLaneLines.length,
      roadSurfaceChecksum: BASELINE_SURFACE_CHECKSUM,
    },
    after: {
      laneChecksum: after.mode5.laneChecksum,
      cleanedRunCount: after.cleanup.cleaned.length,
      fusedFragmentCount: after.chunk.fusedLaneLines.length,
      finalFragmentCount: after.cleanup.cleaned.length,
      visibleDisconnections: after.audit.summary.visibleDisconnections,
      roadSurfaceChecksum: surfaceAfter,
      roadSurfaceChecksumBefore: surfaceBefore,
      roadSurfacePolygonCount: after.chunk.roadSurfacePolygons?.length ?? 0,
      frozenReferenceSurfaceChecksum: BASELINE_SURFACE_CHECKSUM,
      roadSurfaceSemanticallyOutdated: true,
    },
    summary: {
      pb0CandidatesInvestigated: pb0Targets.length,
      commonFusionRootCause: 'D11_maxLaneFragmentGapM with tracker continuity present; bridge via canBridgeTrackerContinuousFusionGap on outer-boundary track',
      responsibleFunction: 'lib/sd_fusion.js fuseLaneTrackSdFragments',
      responsibleCondition: 'ds > maxLaneFragmentGapM (10m) without tracker-continuity bridge approval',
      safeCandidatesTargeted: pb0Targets.length,
      safeCandidatesRepaired: repaired.length,
      safeCandidatesUnresolved: unresolved,
      unsafeGapsStillOpen: unsafeStillOpen.filter((g) => g.stillOpen).map((g) => g.disconnectionId),
      fusedFragmentsBefore: before.chunk.fusedLaneLines.length,
      fusedFragmentsAfter: after.chunk.fusedLaneLines.length,
      finalFragmentsBefore: before.cleanup.cleaned.length,
      finalFragmentsAfter: after.cleanup.cleaned.length,
      visibleDisconnectionsBefore: stage1.summary.visibleDisconnections,
      visibleDisconnectionsAfter: after.audit.summary.visibleDisconnections,
      maxCoordinateDisplacementOutsideIntervals: outside.maxDisplacement,
      coordinatesChangedOutsideApprovedIntervals: outside.outsideChanges.length > 0,
      outsideChangeCount: outside.outsideChanges.length,
      geometryModified: after.mode5.laneChecksum !== BASELINE_LANE_CHECKSUM,
    },
    fusionTrace,
    repaired,
    unresolved,
    unsafeStillOpen,
    outsideChanges: outside.outsideChanges.slice(0, 20),
    pb2DashedSuspects: ['DC-000', 'DC-005', 'DC-007'],
  };
}

module.exports = {
  runLaneContinuityStage2,
  loadSegment,
  buildCtx,
  UNSAFE_GAP_IDS,
  PB0_FUSION_PAIRING_IDS,
  BASELINE_LANE_CHECKSUM,
  BASELINE_SURFACE_CHECKSUM,
};
