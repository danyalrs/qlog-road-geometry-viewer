'use strict';

/**
 * Segment 2 lane-continuity Stage 1: disconnection audit and root-cause classification.
 * Read-only investigation — does not modify geometry.
 */

const { dist2d } = require('./chunking');
const { endpointCompatibility, SEP_CLASSES } = require('./lane_run_audit');
const {
  traceLaneTrackFusion,
  findFusedFragmentGaps,
  mappedObsInRange,
  modelV2FramesInRange,
  classifyGapMechanism,
} = require('./fusion_gap_trace');

const S_EPS = 0.05;
const MAX_CANDIDATE_EUCLIDEAN_M = 80;
const MAX_CANDIDATE_ROUTE_GAP_M = 300;

const PRIMARY_CAUSES = [
  'real_missing_observation',
  'low_confidence_observation_rejected',
  'tracker_identity_split',
  'cleaned_run_split',
  'fusion_failure',
  'chunk_boundary',
  'pass_boundary',
  'spatial_revisit',
  'lane_order_change',
  'branching_or_merging_road',
  'gps_discontinuity',
  'heading_discontinuity',
  'pose_transform_discontinuity',
  'excessive_lateral_offset',
  'excessive_heading_difference',
  'duplicate_or_competing_boundary',
  'intentionally_preserved_unsupported_gap',
  'renderer_only_separation',
  'route_terminus',
  'unknown',
];

function headingDegFromPoints(points) {
  if (!points?.length || points.length < 2) return null;
  const a = points[0];
  const b = points[points.length - 1];
  return (Math.atan2(b.north - a.north, b.east - a.east) * 180) / Math.PI;
}

function endpointHeading(run, side) {
  const pts = run.points || [];
  const sd = run.sdPoints || [];
  if (side === 'end') {
    if (pts.length >= 2) {
      const a = pts[pts.length - 2];
      const b = pts[pts.length - 1];
      return (Math.atan2(b.north - a.north, b.east - a.east) * 180) / Math.PI;
    }
    return headingDegFromPoints(sd.slice(-2));
  }
  if (pts.length >= 2) {
    const a = pts[0];
    const b = pts[1];
    return (Math.atan2(b.north - a.north, b.east - a.east) * 180) / Math.PI;
  }
  return headingDegFromPoints(sd.slice(0, 2));
}

function headingDeltaDeg(h1, h2) {
  if (h1 == null || h2 == null) return null;
  return Math.abs(((h2 - h1 + 540) % 360) - 180);
}

function getEndpointCoord(run, side) {
  const pts = run.points || [];
  if (!pts.length) return null;
  return side === 'start' ? pts[0] : pts[pts.length - 1];
}

function getEndpointRouteS(run, side) {
  if (side === 'start') return run.sMin ?? run.sdPoints?.[0]?.s;
  return run.sMax ?? run.sdPoints?.[run.sdPoints.length - 1]?.s;
}

function groupRunsByPb(cleaned) {
  const byPb = new Map();
  for (const run of cleaned) {
    const pb = run.physicalBoundaryId || `PB-${run.laneTrackId}`;
    if (!byPb.has(pb)) byPb.set(pb, []);
    byPb.get(pb).push(run);
  }
  for (const runs of byPb.values()) {
    runs.sort((a, b) => (a.sMin ?? 0) - (b.sMin ?? 0));
  }
  return byPb;
}

function fusedFragmentId(frag, idx) {
  return frag.fragmentId ?? frag.fusedIndex ?? `F-${frag.laneTrackId}-${idx}`;
}

function mapSepClassToPrimary(sep, gapCtx = {}) {
  const cls = sep?.classification ?? sep?.currentRejectionCondition;
  const reason = sep?.reason ?? sep?.currentRejectionCondition ?? '';
  if (gapCtx.preservedGapId) return 'intentionally_preserved_unsupported_gap';
  if (cls === SEP_CLASSES.NO_DETECTION || reason === 'dropoutScaleGap') return 'real_missing_observation';
  if (cls === SEP_CLASSES.FUSION_INSUFFICIENT_OBS || reason === 'sparseFusionGap') return 'fusion_failure';
  if (cls === SEP_CLASSES.FUSION_SPIKE_OUTLIER || reason === 'headingMismatch') return 'excessive_heading_difference';
  if (reason === 'lateralMismatch') return 'excessive_lateral_offset';
  if (cls === SEP_CLASSES.TRACK_REJECTED) return 'low_confidence_observation_rejected';
  if (cls === SEP_CLASSES.TRACK_ID_CHANGE) return 'tracker_identity_split';
  if (cls === SEP_CLASSES.CHUNK_BOUNDARY) return 'chunk_boundary';
  if (cls === SEP_CLASSES.PASS_BOUNDARY) return 'pass_boundary';
  if (cls === SEP_CLASSES.DIFFERENT_BOUNDARY || reason === 'competingBoundaryInGap') {
    return 'duplicate_or_competing_boundary';
  }
  if (reason === 'differentPhysicalBoundary') return 'branching_or_merging_road';
  if (gapCtx.rendererOnly) return 'renderer_only_separation';
  if (gapCtx.routeTerminus) return 'route_terminus';
  return 'cleaned_run_split';
}

function tracePipelineStage(ctx) {
  const {
    gapStartS, gapEndS, trackId, frames, observations, fusedLanes, trace,
    mergeDecision, preservedGapId, modelV2, drawableBreak,
  } = ctx;

  const stages = {
    rawModelV2: {
      connected: (modelV2?.frameCount ?? 0) > 0 && (modelV2?.observationCount ?? 0) > 0,
      frameCount: modelV2?.frameCount ?? 0,
      observationCount: modelV2?.observationCount ?? 0,
    },
    vehicleRelative: { connected: null, note: 'not re-audited in stage1' },
    gpsPoseTransformed: { connected: null, note: 'not re-audited in stage1' },
    trackerOutput: {
      connected: trace?.binRecords?.some((b) =>
        b.binCentreS >= gapStartS - 1 && b.binCentreS <= gapEndS + 1),
      binsInGap: trace?.binRecords?.filter((b) =>
        b.binCentreS >= gapStartS - 1 && b.binCentreS <= gapEndS + 1).length ?? 0,
    },
    cleanedRuns: { connected: false, separationRecorded: !!mergeDecision },
    fusedFragments: {
      connected: false,
      fragmentGap: ctx.fragGap != null,
    },
    preservationD12: {
      preserved: !!preservedGapId,
      gapId: preservedGapId ?? null,
    },
    mode5Geometry: { connected: false },
    browserRendering: {
      rendererBreak: !!drawableBreak,
      shareOneCanvasPath: drawableBreak?.shareOneCanvasPath ?? false,
    },
  };

  let firstDisconnectedStage = 'mode5_geometry';
  if (!stages.rawModelV2.connected) firstDisconnectedStage = 'raw_modelV2';
  else if (!stages.trackerOutput.connected) firstDisconnectedStage = 'tracker_output';
  else if (stages.fusedFragments.fragmentGap) firstDisconnectedStage = 'fused_fragments';
  else if (mergeDecision && !mergeDecision.wasJoined) firstDisconnectedStage = 'cleaned_runs';
  else if (preservedGapId) firstDisconnectedStage = 'preservation_d12';
  else if (drawableBreak) firstDisconnectedStage = 'browser_rendering';

  return { stages, firstDisconnectedStage };
}

function assessConnectionEvidence(candidate, ctx) {
  const issues = [];
  if (candidate.sourceRun.chunkId !== candidate.candidateRun.chunkId) {
    issues.push('different_chunk');
  }
  if (candidate.sourceRun.passId !== candidate.candidateRun.passId) {
    issues.push('different_pass');
  }
  if (candidate.sourceRun.physicalBoundaryId !== candidate.candidateRun.physicalBoundaryId) {
    issues.push('different_physical_boundary');
  }
  if (candidate.routeGapM < -S_EPS) issues.push('invalid_route_order');
  if (candidate.lateralOffsetM > 1.2) issues.push('excessive_lateral_offset');
  if (candidate.headingDifferenceDeg > 25) issues.push('excessive_heading_difference');
  if (candidate.competingCandidates?.length > 1) issues.push('competing_continuation');
  const safe = issues.length === 0
    && candidate.samePhysicalBoundary
    && candidate.endpointCompatible
    && candidate.routeGapM >= 0
    && candidate.routeGapM < 30;
  return {
    safeConnectionCandidate: safe,
    unsafeConnectionCandidate: !safe && candidate.samePhysicalBoundary,
    connectionIssues: issues,
    recommendedFix: safe ? recommendFix(candidate, ctx) : null,
  };
}

function recommendFix(candidate, ctx) {
  const stage = ctx.firstDisconnectedStage;
  if (stage === 'raw_modelV2') return 'none_until_detection_improves';
  if (stage === 'tracker_output') return 'tracker_association';
  if (stage === 'fused_fragments') return 'fusion_pairing';
  if (stage === 'cleaned_runs') {
    if (ctx.primaryCause === 'excessive_heading_difference') return 'cleanup_preservation_or_join_threshold_review';
    if (ctx.primaryCause === 'excessive_lateral_offset') return 'cleanup_preservation';
    if (ctx.primaryCause === 'fusion_failure') return 'fusion_pairing';
    return 'cleanup_join_review';
  }
  if (stage === 'preservation_d12') return 'none_preserve_gap';
  if (stage === 'browser_rendering') return 'renderer_correction';
  return 'evidence_review';
}

function detectDashedMarking(gapCtx) {
  const { modelV2, gapM, observations } = gapCtx;
  const dashLike = gapM > 0.5 && gapM < 8
    && (modelV2?.frameCount ?? 0) > 0
    && (observations?.length ?? 0) > 0;
  return {
    markingTypeAvailable: false,
    rawModelV2Continuous: (modelV2?.observationCount ?? 0) > 2,
    repeatedDashSpacingSuspected: dashLike,
    modelRepresentsSingleLaneObject: (modelV2?.frameCount ?? 0) >= 2,
    pipelineBreaksAtPaintGap: dashLike && gapCtx.firstDisconnectedStage !== 'raw_modelV2',
    verdict: dashLike ? 'possible_dashed_marking_not_geometry_gap' : 'not_dashed_marking',
  };
}

function findNearestCandidates(sourceRun, sourceSide, allRuns, byPb) {
  const sourceCoord = getEndpointCoord(sourceRun, sourceSide);
  const sourceS = getEndpointRouteS(sourceRun, sourceSide);
  if (!sourceCoord) return [];

  const candidates = [];
  for (const run of allRuns) {
    if (run.runId === sourceRun.runId) continue;
    for (const side of ['start', 'end']) {
      const coord = getEndpointCoord(run, side);
      const routeS = getEndpointRouteS(run, side);
      if (!coord) continue;
      const eucl = dist2d(sourceCoord, coord);
      if (eucl > MAX_CANDIDATE_EUCLIDEAN_M) continue;
      const routeGap = side === 'start' ? routeS - sourceS : sourceS - routeS;
      if (Math.abs(routeGap) > MAX_CANDIDATE_ROUTE_GAP_M) continue;
      const prevFrag = sourceSide === 'end' ? sourceRun : run;
      const nextFrag = sourceSide === 'end' ? run : sourceRun;
      const compat = endpointCompatibility(
        { sdPoints: prevFrag.sdPoints },
        { sdPoints: nextFrag.sdPoints },
      );
      candidates.push({
        candidateRunId: run.runId,
        candidateSide: side,
        candidateTrackId: run.laneTrackId,
        candidatePb: run.physicalBoundaryId,
        candidateFusedFragmentIds: (run.sourceFragments || []).map((f, i) => fusedFragmentId(f, i)),
        routeGapM: routeGap,
        euclideanGapM: eucl,
        lateralOffsetM: compat.dDelta ?? null,
        headingDifferenceDeg: compat.headingDelta ?? null,
        endpointCompatible: compat.compatible,
        samePhysicalBoundary: run.physicalBoundaryId === sourceRun.physicalBoundaryId,
        sameChunkPass: run.chunkId === sourceRun.chunkId && run.passId === sourceRun.passId,
      });
    }
  }
  candidates.sort((a, b) => {
    const scoreA = (a.samePhysicalBoundary ? 0 : 1000) + a.euclideanGapM + Math.abs(a.routeGapM) * 0.1;
    const scoreB = (b.samePhysicalBoundary ? 0 : 1000) + b.euclideanGapM + Math.abs(b.routeGapM) * 0.1;
    return scoreA - scoreB;
  });
  return candidates;
}

function buildEndpointRecords(cleaned, frames, timeline) {
  const byPb = groupRunsByPb(cleaned);
  const endpoints = [];
  let epIdx = 0;

  for (const run of cleaned) {
    for (const side of ['start', 'end']) {
      const coord = getEndpointCoord(run, side);
      const routeS = getEndpointRouteS(run, side);
      const pbRuns = byPb.get(run.physicalBoundaryId) || [];
      const idx = pbRuns.findIndex((r) => r.runId === run.runId);
      const prevRun = side === 'start' ? pbRuns[idx - 1] : run;
      const nextRun = side === 'end' ? pbRuns[idx + 1] : run;
      const adjacentRun = side === 'start' ? prevRun : nextRun;
      const hasAdjacent = !!adjacentRun && adjacentRun.runId !== run.runId;

      const frameId = side === 'start' ? run.startFrameId : run.endFrameId;
      const elapsedIdx = side === 'start' ? run.startElapsedIdx : run.endElapsedIdx;
      const tlEntry = elapsedIdx != null ? timeline?.[elapsedIdx] : null;

      endpoints.push({
        endpointId: `EP-${run.physicalBoundaryId}-${run.runId}-${side}`,
        endpointIndex: epIdx++,
        sourceFragmentId: run.runId,
        cleanedRunId: run.runId,
        fusedFragmentIds: (run.sourceFragments || []).map((f, i) => fusedFragmentId(f, i)),
        physicalBoundaryId: run.physicalBoundaryId,
        trackId: run.laneTrackId,
        logicalGroupTrackIds: run.logicalGroupTrackIds || [run.laneTrackId],
        chunkId: run.chunkId ?? 0,
        passId: run.passId ?? 0,
        side,
        routeS,
        endpointCoord: coord,
        endpointHeadingDeg: endpointHeading(run, side),
        frameId,
        elapsedIdx,
        logMonoTime: tlEntry?.logMonoTime ?? null,
        movementState: tlEntry?.movementState ?? null,
        hasAdjacentOnSameBoundary: hasAdjacent,
        adjacentRunId: hasAdjacent ? adjacentRun.runId : null,
      });
    }
  }
  return endpoints;
}

function buildDisconnections(ctx) {
  const {
    cleaned, mergeDecisions, preservedIntervals, interRunBreaks,
    frames, observations, fusedLanes, tracesByTrack, classDGaps, timeline,
  } = ctx;

  const byPb = groupRunsByPb(cleaned);
  const disconnections = [];
  let dcIdx = 0;

  for (const [pbId, pbRuns] of byPb.entries()) {
    for (let i = 0; i < pbRuns.length - 1; i++) {
      const prevRun = pbRuns[i];
      const nextRun = pbRuns[i + 1];
      const gapStartS = prevRun.sMax ?? getEndpointRouteS(prevRun, 'end');
      const gapEndS = nextRun.sMin ?? getEndpointRouteS(nextRun, 'start');
      const alongGap = gapEndS - gapStartS;
      const prevCoord = getEndpointCoord(prevRun, 'end');
      const nextCoord = getEndpointCoord(nextRun, 'start');
      const euclGap = prevCoord && nextCoord ? dist2d(prevCoord, nextCoord) : null;
      const hPrev = endpointHeading(prevRun, 'end');
      const hNext = endpointHeading(nextRun, 'start');
      const hDiff = headingDeltaDeg(hPrev, hNext);
      const compat = endpointCompatibility(
        { sdPoints: prevRun.sdPoints },
        { sdPoints: nextRun.sdPoints },
      );

      const mergeDecision = mergeDecisions.find((d) =>
        Math.abs((d.endS ?? d.prevRunS ?? 0) - gapStartS) < 2.5
        && Math.abs((d.startS ?? d.nextRunS ?? 0) - gapEndS) < 2.5
        && d.physicalBoundaryId === pbId) || null;

      const preserved = (preservedIntervals || []).find((p) =>
        p.physicalBoundaryGroup === pbId
        && p.startS <= gapEndS + S_EPS && p.endS >= gapStartS - S_EPS) || null;
      const classDGap = (classDGaps || []).find((g) =>
        g.physicalBoundaryGroup === pbId
        && Math.abs(g.startS - gapStartS) < 2.5
        && Math.abs(g.endS - gapEndS) < 2.5);

      const drawableBreak = (interRunBreaks || []).find((b) =>
        b.physicalBoundaryId === pbId
        && Math.abs(b.openIntervalStartS - gapStartS) < 2.5) || null;

      const trackId = prevRun.laneTrackId;
      const trace = tracesByTrack.get(trackId);
      const fragGaps = findFusedFragmentGaps(fusedLanes, trackId);
      const fragGap = fragGaps.find((g) =>
        Math.abs(g.endS - gapStartS) < 2.5 && Math.abs(g.startS - gapEndS) < 2.5) || null;

      const modelV2 = modelV2FramesInRange(frames, trackId, gapStartS, gapEndS, observations, ctx.frameIdToIdx);
      const obsInGap = mappedObsInRange(observations, trackId, gapStartS, gapEndS);

      const sep = mergeDecision ? {
        classification: mergeDecision.classification,
        reason: mergeDecision.reason,
        currentRejectionCondition: mergeDecision.reason,
      } : null;

      const gapCtx = {
        gapStartS, gapEndS, trackId, frames, observations, fusedLanes, trace,
        mergeDecision, preservedGapId: classDGap?.gapId ?? preserved?.gapId ?? null,
        modelV2, drawableBreak, fragGap,
        rendererOnly: drawableBreak?.shareOneCanvasPath === false && alongGap < 0.5,
      };

      const pipeline = tracePipelineStage(gapCtx);
      const primaryCause = mapSepClassToPrimary(sep, {
        preservedGapId: gapCtx.preservedGapId,
        rendererOnly: pipeline.stages.browserRendering.rendererBreak && alongGap < 1,
        routeTerminus: false,
      });

      const contributingCauses = [];
      if (compat.reason) contributingCauses.push(compat.reason);
      if (fragGap) contributingCauses.push('fused_fragment_split');
      if (classDGap?.primaryMechanism) contributingCauses.push(classDGap.primaryMechanism);
      if (obsInGap.length === 0) contributingCauses.push('no_mapped_obs_in_gap');
      else if (obsInGap.length < 4) contributingCauses.push('sparse_mapped_obs_in_gap');

      const candidate = {
        sourceRun: prevRun,
        candidateRun: nextRun,
        routeGapM: alongGap,
        euclideanGapM: euclGap,
        lateralOffsetM: compat.dDelta,
        headingDifferenceDeg: compat.headingDelta ?? hDiff,
        endpointCompatible: compat.compatible,
        samePhysicalBoundary: true,
        competingCandidates: [],
      };
      const connection = assessConnectionEvidence(candidate, {
        ...gapCtx,
        primaryCause,
        firstDisconnectedStage: pipeline.firstDisconnectedStage,
      });

      const dashed = detectDashedMarking({ ...gapCtx, gapM: alongGap, observations: obsInGap });

      const sameBoundary = prevRun.physicalBoundaryId === nextRun.physicalBoundaryId;
      let preliminaryVerdict = 'open_gap';
      if (alongGap < S_EPS) preliminaryVerdict = 'continuous';
      else if (connection.safeConnectionCandidate) preliminaryVerdict = 'safe_connection_candidate';
      else if (gapCtx.preservedGapId) preliminaryVerdict = 'intentional_open';
      else if (primaryCause === 'real_missing_observation') preliminaryVerdict = 'unsupported_open';
      else preliminaryVerdict = 'visible_disconnection';

      disconnections.push({
        disconnectionId: `DC-${String(dcIdx++).padStart(3, '0')}`,
        sourceFragmentId: prevRun.runId,
        candidateContinuationFragmentId: nextRun.runId,
        physicalBoundaryId: pbId,
        trackId,
        cleanedRunIds: { preceding: prevRun.runId, following: nextRun.runId },
        fusedFragmentIds: {
          preceding: (prevRun.sourceFragments || []).map((f, j) => fusedFragmentId(f, j)),
          following: (nextRun.sourceFragments || []).map((f, j) => fusedFragmentId(f, j)),
        },
        chunkId: prevRun.chunkId ?? 0,
        passId: prevRun.passId ?? 0,
        endpointRouteS: gapStartS,
        candidateStartRouteS: gapEndS,
        alongTrackGapM: alongGap,
        euclideanGapM: euclGap,
        lateralOffsetM: compat.dDelta,
        endpointHeadingsDeg: { preceding: hPrev, following: hNext },
        headingDifferenceDeg: hDiff,
        widthLanePositionConsistent: compat.compatible,
        timeSeparation: {
          precedingLogMonoTime: timeline?.[prevRun.endElapsedIdx]?.logMonoTime ?? null,
          followingLogMonoTime: timeline?.[nextRun.startElapsedIdx]?.logMonoTime ?? null,
        },
        observationIndices: {
          mappedObsInGap: obsInGap.length,
          modelV2Frames: modelV2?.frameCount ?? 0,
        },
        existingSplitReason: mergeDecision?.reason ?? classDGap?.primaryMechanism ?? null,
        samePhysicalBoundaryEvidence: sameBoundary,
        confidence: connection.safeConnectionCandidate ? 'high' : (compat.compatible ? 'medium' : 'low'),
        preliminaryVerdict,
        primaryCause,
        contributingCauses,
        pipelineTrace: pipeline,
        firstPipelineStageDisconnected: pipeline.firstDisconnectedStage,
        dashedMarkingAnalysis: dashed,
        preservedGapId: gapCtx.preservedGapId,
        classDGapId: classDGap?.gapId ?? null,
        ...connection,
      });
    }
  }

  return disconnections;
}

function runLaneContinuityStage1(ctx) {
  const {
    data, cleanup, mode5Map, frames, timeline, observations, fusedLanes,
    classDGaps, laneChecksumBefore,
  } = ctx;

  const cleaned = cleanup.cleaned || [];
  const mergeDecisions = cleanup.mergeDecisions || [];
  const drawable = cleanup.drawablePathAnalysis || {};
  const preservedIntervals = cleanup.preservedIntervals || [];

  const frameIdToIdx = new Map(frames.map((f, i) => [f.frameId, i]));
  const tracesByTrack = new Map();
  const trackIds = [...new Set(cleaned.map((r) => r.laneTrackId))];
  for (const tid of trackIds) {
    tracesByTrack.set(tid, traceLaneTrackFusion(observations, tid));
  }

  const endpoints = buildEndpointRecords(cleaned, frames, timeline);
  const disconnections = buildDisconnections({
    cleaned, mergeDecisions, preservedIntervals,
    interRunBreaks: drawable.interRunBreaks,
    frames, observations, fusedLanes, tracesByTrack, classDGaps, timeline,
    frameIdToIdx,
  });

  for (const ep of endpoints) {
    ep.candidateContinuations = findNearestCandidates(
      cleaned.find((r) => r.runId === ep.cleanedRunId),
      ep.side,
      cleaned,
      groupRunsByPb(cleaned),
    ).slice(0, 5);
    ep.visibleDisconnection = !ep.hasAdjacentOnSameBoundary
      || (ep.candidateContinuations[0]?.euclideanGapM ?? 0) > S_EPS;
  }

  const causeCounts = {};
  for (const d of disconnections) {
    causeCounts[d.primaryCause] = (causeCounts[d.primaryCause] || 0) + 1;
  }

  const summary = {
    totalFinalLaneFragments: mode5Map?.laneFragmentCount ?? cleaned.length,
    totalEndpoints: endpoints.length,
    visibleDisconnections: disconnections.filter((d) => d.alongTrackGapM > S_EPS).length,
    plausibleSameBoundaryContinuations: disconnections.filter((d) => d.samePhysicalBoundaryEvidence).length,
    intentionalOpenGaps: disconnections.filter((d) => d.primaryCause === 'intentionally_preserved_unsupported_gap').length,
    rawDetectionGaps: disconnections.filter((d) => d.primaryCause === 'real_missing_observation').length,
    trackerSplits: disconnections.filter((d) => d.primaryCause === 'tracker_identity_split').length,
    cleanupSplits: disconnections.filter((d) => d.primaryCause === 'cleaned_run_split').length,
    fusionSplits: disconnections.filter((d) => d.primaryCause === 'fusion_failure').length,
    transformPoseSplits: disconnections.filter((d) => d.primaryCause === 'pose_transform_discontinuity').length,
    chunkBoundaryGaps: disconnections.filter((d) => d.primaryCause === 'chunk_boundary').length,
    passBoundaryGaps: disconnections.filter((d) => d.primaryCause === 'pass_boundary').length,
    rendererOnlyGaps: disconnections.filter((d) => d.primaryCause === 'renderer_only_separation').length,
    branchMergeCases: disconnections.filter((d) => d.primaryCause === 'branching_or_merging_road').length,
    dashedMarkingCases: disconnections.filter((d) => d.dashedMarkingAnalysis?.repeatedDashSpacingSuspected).length,
    unknownCases: disconnections.filter((d) => d.primaryCause === 'unknown').length,
    safeConnectionCandidates: disconnections.filter((d) => d.safeConnectionCandidate).length,
    unsafeConnectionCandidates: disconnections.filter((d) => d.unsafeConnectionCandidate).length,
    laneChecksum: mode5Map?.laneChecksum ?? laneChecksumBefore,
    cleanedRunCount: cleaned.length,
    logicalCleanedRunCount: drawable.logicalCleanedRunCount ?? cleaned.length,
    fusedFragmentCount: fusedLanes.length,
    geometryModified: false,
  };

  return {
    endpoints,
    disconnections,
    summary,
    baseline: {
      laneChecksum: summary.laneChecksum,
      cleanedRunCount: summary.cleanedRunCount,
      fusedFragmentCount: summary.fusedFragmentCount,
      roadSurfacePolygonCount: 14,
      roadSurfaceChecksum: '26ae09b9',
    },
    causeCounts,
    primaryCauseTaxonomy: PRIMARY_CAUSES,
  };
}

module.exports = {
  runLaneContinuityStage1,
  buildEndpointRecords,
  buildDisconnections,
  findNearestCandidates,
  mapSepClassToPrimary,
  tracePipelineStage,
  assessConnectionEvidence,
  PRIMARY_CAUSES,
};
