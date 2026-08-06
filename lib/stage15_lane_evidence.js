/**
 * Stage 15 Part 2 — lane-line evidence characterization (read-only).
 */
const { extractModelGeometry } = require('./transform');
const { NEAR_FORWARD_X, meanYAtForwardX, lateralAtForwardX } = require('./stage15_geometry');
const {
  classifyFrameLines,
  classifyFrameLinesBeforeFix,
  roadEdgeIntervalMetrics,
  buildClassificationAudit,
  ASSESSMENT_THRESHOLDS,
} = require('./stage15a_classification_audit');
const { summarizeNumeric, buildHistogram, PROB_BINS, STD_BINS_M, LANE_WIDTH_BINS_M } = require('./stage15_distributions');

function detectOrderCrossing(prevOrder, nextOrder) {
  if (!prevOrder?.length || !nextOrder?.length) return false;
  const shared = prevOrder.filter((i) => nextOrder.includes(i));
  if (shared.length < 2) return false;
  const prevRank = Object.fromEntries(prevOrder.map((id, r) => [id, r]));
  const nextRank = Object.fromEntries(nextOrder.map((id, r) => [id, r]));
  for (let i = 0; i < shared.length; i++) {
    for (let j = i + 1; j < shared.length; j++) {
      const a = shared[i];
      const b = shared[j];
      const prevDiff = prevRank[a] - prevRank[b];
      const nextDiff = nextRank[a] - nextRank[b];
      if (prevDiff * nextDiff < 0) return true;
    }
  }
  return false;
}

/** @deprecated use roadEdgeIntervalMetrics */
function edgeAgreement(modelV2, frameClass) {
  const fc = frameClass || classifyFrameLines(modelV2);
  const m = roadEdgeIntervalMetrics(modelV2, fc);
  return {
    comparable: m.comparable,
    linesInsideEdges: m.bothRetainedEgoCandidatesInside,
    outerLineBeyondEdge: m.comparable && m.pctLineObservationsInside != null && m.pctLineObservationsInside < 0.5,
    ...m,
  };
}

function analyzeModelEvents(modelEvents, options = {}) {
  const opts = { ...ASSESSMENT_THRESHOLDS, ...options };
  const probs = [];
  const lineStds = [];
  const edgeStds = [];
  const linesPerFrame = [];
  const edgesPerFrame = [];
  const egoWidths = [];
  const allLaneWidths = [];
  const classificationCounts = {
    ego_lane_boundaries: 0,
    probable_adjacent_dividers: 0,
    uncertain_outer_lines: 0,
    unclassifiable: 0,
  };
  const frameOutcomes = {};
  let framesWithAnyLines = 0;
  let framesWithProbFilteredLines = 0;
  let framesWithRoadEdges = 0;
  let missingLineFrames = 0;
  let orderCrossings = 0;
  let laneChangeFrames = 0;
  let desireActiveFrames = 0;
  let continuityGaps = 0;
  let prevHadLines = false;
  let prevOrder = null;

  let roadEdgeComparableFrames = 0;
  let roadEdgeComparableLineObs = 0;
  let roadEdgeInsideLineObs = 0;
  let framesBothRetainedEgoInside = 0;
  let framesAtLeastOneRetainedEgoInside = 0;

  for (const ev of modelEvents) {
    const mv = ev.modelV2 || {};
    const rawLines = mv.laneLines || [];
    const rawProbs = mv.laneLineProbs || [];
    const rawStds = mv.laneLineStds || [];

    if (rawLines.length) framesWithAnyLines++;
    else if (prevHadLines) continuityGaps++;

    const geom = extractModelGeometry(mv, { minLaneProb: opts.assessmentMinProb, maxForwardM: 120 });
    if (geom.laneLines.length) framesWithProbFilteredLines++;
    if (geom.roadEdges.length) framesWithRoadEdges++;

    linesPerFrame.push(rawLines.length);
    edgesPerFrame.push((mv.roadEdges || []).length);
    if (rawLines.length > 0 && rawLines.length < 4) missingLineFrames++;

    for (let i = 0; i < rawProbs.length; i++) probs.push(rawProbs[i]);
    for (let i = 0; i < rawStds.length; i++) lineStds.push(rawStds[i]);
    for (let i = 0; i < (mv.roadEdgeStds || []).length; i++) {
      const es = mv.roadEdgeStds[i];
      if (Number.isFinite(es)) edgeStds.push(es);
    }

    const frameClass = classifyFrameLines(mv, opts);
    for (const [k, ids] of Object.entries(frameClass.classifications)) {
      classificationCounts[k] += ids.length;
    }
    frameOutcomes[frameClass.frameOutcome] = (frameOutcomes[frameClass.frameOutcome] || 0) + 1;

    if (frameClass.egoLaneWidthM != null) egoWidths.push(frameClass.egoLaneWidthM);
    if (frameClass.egoLeft && frameClass.egoRight) {
      allLaneWidths.push(frameClass.egoLaneWidthM);
    }

    if (prevOrder && detectOrderCrossing(prevOrder, frameClass.lateralOrder)) orderCrossings++;
    prevOrder = frameClass.lateralOrder;
    prevHadLines = rawLines.length > 0;

    const edgeM = roadEdgeIntervalMetrics(mv, frameClass, opts);
    if (edgeM.comparable) {
      roadEdgeComparableFrames++;
      roadEdgeComparableLineObs += edgeM.comparableLineObservations;
      roadEdgeInsideLineObs += edgeM.lineObservationsInsideInterval;
      if (edgeM.bothRetainedEgoCandidatesInside) framesBothRetainedEgoInside++;
      if (edgeM.atLeastOneRetainedEgoCandidateInside) framesAtLeastOneRetainedEgoInside++;
    }

    const meta = mv.meta || {};
    if (meta.laneChangeState != null && meta.laneChangeState !== 0 && meta.laneChangeState !== 'off') laneChangeFrames++;
    if (Array.isArray(meta.desireState) && meta.desireState.some((v) => v > 0.1)) desireActiveFrames++;
  }

  const totalFrames = modelEvents.length;
  return {
    totalFrames,
    framesWithAnyLines,
    framesWithProbFilteredLines,
    framesWithRoadEdges,
    rawProbValues: probs,
    rawStdValues: lineStds,
    rawEdgeStdValues: edgeStds,
    frameCoverage: {
      anyLines: totalFrames ? framesWithAnyLines / totalFrames : 0,
      probFiltered: totalFrames ? framesWithProbFilteredLines / totalFrames : 0,
      roadEdges: totalFrames ? framesWithRoadEdges / totalFrames : 0,
    },
    linesPerFrame: summarizeNumeric(linesPerFrame),
    edgesPerFrame: summarizeNumeric(edgesPerFrame),
    laneLineProb: summarizeNumeric(probs),
    laneLineStd: summarizeNumeric(lineStds),
    roadEdgeStd: summarizeNumeric(edgeStds),
    laneLineProbHistogram: buildHistogram(probs, PROB_BINS),
    laneLineStdHistogram: buildHistogram(lineStds, STD_BINS_M),
    egoLaneWidthM: summarizeNumeric(egoWidths),
    adjacentLaneWidthM: summarizeNumeric(allLaneWidths),
    laneWidthHistogram: buildHistogram(allLaneWidths, LANE_WIDTH_BINS_M),
    classificationTotals: classificationCounts,
    frameOutcomes,
    missingLineFrames,
    continuityGaps,
    orderCrossings,
    roadEdgeIntervalMetrics: {
      evalForwardXM: opts.evalForwardXM,
      comparableFrames: roadEdgeComparableFrames,
      comparableLineObservations: roadEdgeComparableLineObs,
      lineObservationsInsideInterval: roadEdgeInsideLineObs,
      pctLineObservationsInside: roadEdgeComparableLineObs
        ? roadEdgeInsideLineObs / roadEdgeComparableLineObs
        : null,
      framesBothRetainedEgoInside,
      framesAtLeastOneRetainedEgoInside,
      note: 'Frame inside metrics use retained valid ego only; see stage15a for denominators.',
    },
    edgeAgreement: {
      comparableFrames: roadEdgeComparableFrames,
      comparableLineObservations: roadEdgeComparableLineObs,
      lineObservationsInsideInterval: roadEdgeInsideLineObs,
      pctLineObservationsInside: roadEdgeComparableLineObs
        ? roadEdgeInsideLineObs / roadEdgeComparableLineObs
        : null,
      framesBothRetainedEgoInside,
      framesAtLeastOneRetainedEgoInside,
    },
    behaviourFlags: { laneChangeFrames, desireActiveFrames },
  };
}

function estimateSameDirectionLanes(frameClassifications) {
  const { ego_lane_boundaries, probable_adjacent_dividers } = frameClassifications;
  const dividerCount = ego_lane_boundaries.length + probable_adjacent_dividers.length;
  if (dividerCount < 2) return { estimate: null, reason: 'insufficient_dividers' };
  return { estimate: dividerCount - 1, reason: 'heuristic_from_visible_dividers' };
}

function buildChunkEvidenceSummary(chunk, segmentId, modelEvents) {
  const start = chunk.startLogMonoTime;
  const end = chunk.endLogMonoTime;
  const chunkEvents = (modelEvents || []).filter((ev) => {
    const t = BigInt(ev.logMonoTime);
    return t >= BigInt(start) && t <= BigInt(end);
  });
  const evidence = analyzeModelEvents(chunkEvents);
  const lastOutcome = Object.entries(evidence.frameOutcomes || {}).sort((a, b) => b[1] - a[1])[0];
  return {
    segmentId,
    chunkId: chunk.chunkId,
    frameCount: chunkEvents.length,
    passCount: chunk.passDiagnostics?.length ?? chunk.passes?.length ?? null,
    polygonCount: (chunk.roadSurfacePolygons || []).length,
    v11PolygonIds: (chunk.roadSurfacePolygons || []).map((p) => p.id || p.polygonId).filter(Boolean),
    evidence,
    dominantFrameOutcome: lastOutcome ? lastOutcome[0] : null,
    note: 'Frame outcomes are diagnostic only — not lane counts',
  };
}

function buildSegmentEvidence(modelEvents, segmentId, routeResult = null) {
  const evidence = analyzeModelEvents(modelEvents);
  const chunks = routeResult?.routeChunks || [];
  const chunkSummaries = chunks.map((c) => buildChunkEvidenceSummary(c, segmentId, modelEvents));
  return {
    segmentId,
    filename: modelEvents[0]?.sourceFile ?? null,
    modelV2FrameCount: modelEvents.length,
    evidence,
    chunkCount: chunks.length,
    chunkSummaries,
    totalV11Polygons: chunks.reduce((n, c) => n + (c.roadSurfacePolygons || []).length, 0),
  };
}

function mergeSegmentDistributions(segmentResults) {
  const probs = [];
  const stds = [];
  const edgeStds = [];
  const egoWidths = [];
  const laneWidths = [];
  const frameOutcomes = {};
  let totalFrames = 0;
  let framesWithLines = 0;
  let framesWithFiltered = 0;
  let totalChunks = 0;
  let orderCrossings = 0;
  let laneChangeFrames = 0;
  let missingLineFrames = 0;
  let continuityGaps = 0;
  let roadEdgeComparableFrames = 0;
  let roadEdgeComparableLineObs = 0;
  let roadEdgeInsideLineObs = 0;
  let framesBothRetainedEgoInside = 0;
  let framesAtLeastOneRetainedEgoInside = 0;
  const classificationTotals = {
    ego_lane_boundaries: 0,
    probable_adjacent_dividers: 0,
    uncertain_outer_lines: 0,
    unclassifiable: 0,
  };
  const linesPerFrame = [];

  for (const seg of segmentResults) {
    const e = seg.evidence;
    totalFrames += e.totalFrames;
    framesWithLines += e.framesWithAnyLines;
    framesWithFiltered += e.framesWithProbFilteredLines;
    totalChunks += seg.chunkCount;
    orderCrossings += e.orderCrossings;
    laneChangeFrames += e.behaviourFlags.laneChangeFrames;
    missingLineFrames += e.missingLineFrames;
    continuityGaps += e.continuityGaps;
    for (const [k, v] of Object.entries(e.classificationTotals)) classificationTotals[k] += v;
    for (const [k, v] of Object.entries(e.frameOutcomes || {})) {
      frameOutcomes[k] = (frameOutcomes[k] || 0) + v;
    }
    const re = e.roadEdgeIntervalMetrics || e.edgeAgreement || {};
    roadEdgeComparableFrames += re.comparableFrames || 0;
    roadEdgeComparableLineObs += re.comparableLineObservations || 0;
    roadEdgeInsideLineObs += re.lineObservationsInsideInterval || 0;
    framesBothRetainedEgoInside += re.framesBothRetainedEgoInside || 0;
    framesAtLeastOneRetainedEgoInside += re.framesAtLeastOneRetainedEgoInside || 0;
    probs.push(...(e.rawProbValues || []));
    stds.push(...(e.rawStdValues || []));
    edgeStds.push(...(e.rawEdgeStdValues || []));
    if (e.linesPerFrame?.mean != null) linesPerFrame.push(e.linesPerFrame.mean);
    if (e.egoLaneWidthM?.median != null) egoWidths.push(e.egoLaneWidthM.median);
    if (e.adjacentLaneWidthM?.median != null) laneWidths.push(e.adjacentLaneWidthM.median);
  }

  return {
    physicalSegments: segmentResults.length,
    totalRouteChunks: totalChunks,
    totalModelV2Frames: totalFrames,
    framesWithLaneLines: framesWithLines,
    framesWithProbFilteredLines: framesWithFiltered,
    frameCoverageRate: totalFrames ? framesWithLines / totalFrames : 0,
    probFilteredCoverageRate: totalFrames ? framesWithFiltered / totalFrames : 0,
    meanLinesPerFrame: summarizeNumeric(linesPerFrame),
    classificationTotals,
    frameOutcomes,
    orderCrossings,
    missingLineFrames,
    continuityGaps,
    laneChangeFrames,
    roadEdgeIntervalMetrics: {
      comparableFrames: roadEdgeComparableFrames,
      comparableLineObservations: roadEdgeComparableLineObs,
      lineObservationsInsideInterval: roadEdgeInsideLineObs,
      pctLineObservationsInside: roadEdgeComparableLineObs
        ? roadEdgeInsideLineObs / roadEdgeComparableLineObs
        : null,
      framesBothRetainedEgoInside,
      framesAtLeastOneRetainedEgoInside,
    },
    edgeAgreement: {
      comparableFrames: roadEdgeComparableFrames,
      comparableLineObservations: roadEdgeComparableLineObs,
      lineObservationsInsideInterval: roadEdgeInsideLineObs,
      pctLineObservationsInside: roadEdgeComparableLineObs
        ? roadEdgeInsideLineObs / roadEdgeComparableLineObs
        : null,
      framesBothRetainedEgoInside,
      framesAtLeastOneRetainedEgoInside,
    },
    laneLineProb: summarizeNumeric(probs),
    laneLineProbHistogram: buildHistogram(probs, PROB_BINS),
    laneLineStd: summarizeNumeric(stds),
    laneLineStdHistogram: buildHistogram(stds, STD_BINS_M),
    roadEdgeStd: summarizeNumeric(edgeStds),
    egoLaneWidthM: summarizeNumeric(egoWidths),
    adjacentLaneWidthM: summarizeNumeric(laneWidths),
    laneWidthHistogram: buildHistogram(laneWidths, LANE_WIDTH_BINS_M),
  };
}

module.exports = {
  NEAR_FORWARD_X,
  meanYAtForwardX,
  lateralAtForwardX,
  classifyFrameLines,
  classifyFrameLinesBeforeFix,
  edgeAgreement,
  roadEdgeIntervalMetrics,
  detectOrderCrossing,
  analyzeModelEvents,
  estimateSameDirectionLanes,
  buildClassificationAudit,
  buildChunkEvidenceSummary,
  buildSegmentEvidence,
  mergeSegmentDistributions,
};
