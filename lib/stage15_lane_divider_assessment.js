/**
 * Stage 15 orchestrator — lane-divider evidence assessment (read-only).
 * Does not modify v11 geometry, fusion, pose, or validation.
 */
const fs = require('fs');
const path = require('path');
const { loadSegmentsData } = require('./qlog_data');
const { qualifySegments } = require('./segment_qualify');
const { processRoute } = require('./process_route');
const { PROCESSING_VERSION } = require('./version');
const { buildSignalInventoryReport, summarizeCoverageOutliers } = require('./stage15_signal_inventory');
const { buildSegmentEvidence, mergeSegmentDistributions, buildClassificationAudit } = require('./stage15_lane_evidence');
const { V11_MIN_LANE_PROB_USAGE } = require('./stage15a_classification_audit');
const {
  LANE_COUNT_SCHEMA_VERSION,
  FROZEN_ROAD_SURFACE_VERSION,
  buildLaneCountRecordTemplate,
  buildProblemDefinition,
  buildCandidatePipeline,
  proposeThresholdCandidates,
  buildValidationPlan,
  buildAmbiguityClasses,
  buildImplementationStages,
  generateAssessmentMarkdown,
  generateDesignMarkdown,
  verifyStage15DeliverableConsistency,
} = require('./stage15_lane_counting_design');

const DEFAULT_ROUTE_OPTS = {
  minLaneProb: 0.5,
  maxAccuracyM: 50,
  maxModelGpsDeltaNs: 2e9,
  maxForwardM: 120,
  fusionIntervalM: 2,
  minSpeedForGpsBearing: 2,
  maxTimeGapSec: 3,
  maxGpsGapM: 30,
  maxImpliedSpeedMps: 55,
  maxLaneFragmentGapM: 10,
  maxRoadEdgeGapM: 10,
  pipelineMode: 'C',
  laneTrackingEnabled: true,
  localSupportFilter: true,
};

function listSegmentFiles(root) {
  return fs.readdirSync(root)
    .filter((f) => /^qlog_f449c.*\.bz2$/i.test(f))
    .sort((a, b) => parseInt(a.match(/_(\d+)/)[1]) - parseInt(b.match(/_(\d+)/)[1]));
}

function segmentIdFromFilename(filename) {
  const m = filename.match(/_(\d+)\.bz2$/i);
  return m ? parseInt(m[1], 10) : null;
}

function summarizeSegmentForAudit(seg) {
  const e = seg.evidence;
  return {
    segmentId: seg.segmentId,
    filename: seg.filename,
    modelV2FrameCount: seg.modelV2FrameCount,
    chunkCount: seg.chunkCount,
    totalV11Polygons: seg.totalV11Polygons,
    frameCoverageRate: e.frameCoverage?.anyLines ?? (e.framesWithAnyLines / Math.max(e.totalFrames, 1)),
    probFilteredCoverageRate: e.frameCoverage?.probFiltered ?? (e.framesWithProbFilteredLines / Math.max(e.totalFrames, 1)),
    linesPerFrameMean: e.linesPerFrame?.mean,
    laneLineProbMedian: e.laneLineProb?.median,
    laneLineStdMedian: e.laneLineStd?.median,
    egoLaneWidthMedian: e.egoLaneWidthM?.median,
    orderCrossings: e.orderCrossings,
    missingLineFrames: e.missingLineFrames,
    laneChangeFrames: e.behaviourFlags?.laneChangeFrames,
    classificationTotals: e.classificationTotals,
    edgeAgreementInsideRate: e.roadEdgeIntervalMetrics?.pctLineObservationsInside
      ?? e.edgeAgreement?.pctLineObservationsInside,
    frameOutcomes: e.frameOutcomes,
    chunkSummaries: (seg.chunkSummaries || []).map((c) => ({
      chunkId: c.chunkId,
      frameCount: c.frameCount,
      polygonCount: c.polygonCount,
      v11PolygonIds: c.v11PolygonIds,
      frameCoverageRate: c.evidence.framesWithAnyLines / Math.max(c.evidence.totalFrames, 1),
    })),
  };
}

function buildLaneDividerAssessment(root, options = {}) {
  const filenames = options.filenames || listSegmentFiles(root);
  const includeRouteProcessing = options.includeRouteProcessing !== false;
  const routeOpts = { ...DEFAULT_ROUTE_OPTS, ...options.routeOpts };

  const signalInventory = buildSignalInventoryReport(root, filenames);
  const segmentResults = [];
  const allModelEvents = [];

  for (const filename of filenames) {
    const segmentId = segmentIdFromFilename(filename);
    const loaded = loadSegmentsData(root, [filename], options.loadOpts || {});
    const modelEvents = loaded.modelEvents.filter((e) => e.sourceFile === filename);
    allModelEvents.push(...modelEvents);

    let routeResult = null;
    if (includeRouteProcessing) {
      const quals = qualifySegments(loaded.audits || [loaded.audit]);
      routeResult = processRoute(modelEvents, loaded.gpsEvents, {
        segmentQualifications: quals,
        ...routeOpts,
      });
    }

    segmentResults.push(buildSegmentEvidence(modelEvents, segmentId, routeResult));
  }

  const datasetEvidence = mergeSegmentDistributions(segmentResults);
  const stage15aClassificationAudit = buildClassificationAudit(allModelEvents);
  const problemDefinition = buildProblemDefinition();
  const candidatePipeline = buildCandidatePipeline();
  const thresholdPolicy = proposeThresholdCandidates(datasetEvidence);
  const validationPlan = buildValidationPlan();
  const ambiguityClasses = buildAmbiguityClasses(datasetEvidence);
  const implementationStages = buildImplementationStages();
  const coverageOutliers = summarizeCoverageOutliers(segmentResults.map(summarizeSegmentForAudit));
  const deliverableConsistency = verifyStage15DeliverableConsistency({
    datasetEvidence,
    stage15aClassificationAudit,
    segmentSummaries: segmentResults.map(summarizeSegmentForAudit),
    physicalRouteSegments: datasetEvidence.physicalSegments,
    outputSchemaTemplate: buildLaneCountRecordTemplate(),
  });

  return {
    auditedAt: new Date().toISOString(),
    stage15Status: 'approved',
    stage15aStatus: 'approved',
    stagePurpose: 'read_only_investigation_and_design',
    laneCountingComplete: false,
    productionLaneCountImplemented: false,
    frozenRoadSurfaceVersion: FROZEN_ROAD_SURFACE_VERSION,
    processingVersionUnchanged: PROCESSING_VERSION,
    v11GeometryModified: false,
    laneCountSchemaVersion: LANE_COUNT_SCHEMA_VERSION,
    outputSchemaTemplate: buildLaneCountRecordTemplate(),
    signalInventory: {
      coordinateSystem: signalInventory.coordinateSystem,
      signals: signalInventory.signals,
      segmentCoverage: signalInventory.segmentCoverage,
      posePipelineCompatibility: signalInventory.posePipelineCompatibility,
      unionTagSummary: signalInventory.unionTagSummary,
    },
    datasetEvidence,
    stage15aClassificationAudit,
    v11MinLaneProbUsage: V11_MIN_LANE_PROB_USAGE,
    segmentSummaries: segmentResults.map(summarizeSegmentForAudit),
    problemDefinition,
    candidatePipeline,
    thresholdPolicy,
    validationPlan,
    ambiguityClasses,
    implementationStages,
    coverageOutliers,
    deliverableConsistency,
    feasibility: {
      sameDirectionLaneCounting: 'feasible_with_separate_pipeline',
      caveats: [
        'Requires explicit unknown handling at junctions, merges, lane changes',
        'modelV2 lane lines are not guaranteed physical dividers',
        'Camera validation blocked (Stage 12B)',
        'No production thresholds selected in Stage 15',
      ],
      withoutCameraImagery: 'Internal and BEV consistency checks possible; physical-road accuracy unverified',
    },
    segmentCount: filenames.length,
    physicalRouteSegments: datasetEvidence.physicalSegments,
    routeChunksDiscovered: datasetEvidence.totalRouteChunks,
  };
}

module.exports = {
  DEFAULT_ROUTE_OPTS,
  listSegmentFiles,
  segmentIdFromFilename,
  summarizeSegmentForAudit,
  buildLaneDividerAssessment,
  generateAssessmentMarkdown,
  generateDesignMarkdown,
};
