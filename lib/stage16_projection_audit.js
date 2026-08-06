/**
 * Stage 16 orchestrator — full-dataset projection audit (read-only).
 */
const fs = require('fs');
const path = require('path');
const { loadSegmentsData } = require('./qlog_data');
const { qualifySegments } = require('./segment_qualify');
const { processRoute } = require('./process_route');
const { PROCESSING_VERSION } = require('./version');
const { FROZEN_ROAD_SURFACE_VERSION } = require('./stage15_lane_counting_design');
const { buildSlotSemantics } = require('./stage15a_classification_audit');
const { summarizeNumeric } = require('./stage15_distributions');
const { summarizeCoverageOutliers } = require('./stage15_signal_inventory');
const {
  PROJECTION_SCHEMA_VERSION,
  STAGE16_PROCESSING_VERSION,
  PROJECTION_STATUSES,
  TRANSFORM_CONVENTIONS,
  PERPENDICULAR_DISTANCE_SEMANTICS,
  DEFAULT_FRAGMENT_ASSESSMENT,
  BEV_REQUIRED_CATEGORIES,
} = require('./stage16_projection_schema');
const {
  segmentIdFromFilename,
  projectSegment,
  summarizeObservations,
  verifyProjectionConsistency,
} = require('./stage16_lane_line_projection');
const { generateBevInspections } = require('./stage16_bev_inspection');

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
  poseContinuityEnabled: true,
};

function listSegmentFiles(root) {
  return fs.readdirSync(root)
    .filter((f) => /^qlog_f449c.*\.bz2$/i.test(f))
    .sort((a, b) => parseInt(a.match(/_(\d+)/)[1]) - parseInt(b.match(/_(\d+)/)[1]));
}

function summarizeSegmentProjection(segmentId, filename, observations, chunkSummaries) {
  const summary = summarizeObservations(observations);
  return {
    segmentId,
    filename,
    modelV2FrameCount: new Set(observations.map((o) => o.logMonoTime)).size,
    chunkCount: chunkSummaries.length,
    ...summary,
    chunkSummaries,
  };
}

function buildStage16ProjectionAudit(root, options = {}) {
  const filenames = options.filenames || listSegmentFiles(root);
  const routeOpts = { ...DEFAULT_ROUTE_OPTS, ...options.routeOpts };
  const createdAt = new Date().toISOString();

  const allObservations = [];
  const allModelEvents = [];
  const segmentSummaries = [];
  let totalChunks = 0;

  for (const filename of filenames) {
    const segmentId = segmentIdFromFilename(filename);
    const loaded = loadSegmentsData(root, [filename], options.loadOpts || {});
    const modelEvents = loaded.modelEvents.filter((e) => e.sourceFile === filename);
    allModelEvents.push(...modelEvents);
    const quals = qualifySegments(loaded.audits || [loaded.audit]);
    const routeResult = processRoute(modelEvents, loaded.gpsEvents, {
      segmentQualifications: quals,
      ...routeOpts,
    });

    const slotSemantics = buildSlotSemantics(modelEvents);
    const slotRoleByIndex = Object.fromEntries(slotSemantics.map((s) => [s.index, s.inferredRole]));

    const observations = projectSegment({
      segmentId,
      filename,
      modelEvents,
      routeResult,
      slotRoleByIndex,
      options: {
        ...routeOpts,
        frozenBaselineVersion: FROZEN_ROAD_SURFACE_VERSION,
        frozenV11ProcessingVersion: PROCESSING_VERSION,
        createdAt,
      },
    });

    const chunkSummaries = (routeResult.routeChunks || []).map((c) => ({
      chunkId: c.chunkId,
      frameCount: c.frameCount,
      observationCount: observations.filter((o) => o.chunkId === c.chunkId).length,
      projectedCount: observations.filter((o) => o.chunkId === c.chunkId && o.projectionStatus === PROJECTION_STATUSES.PROJECTED).length,
    }));

    totalChunks += chunkSummaries.length;
    allObservations.push(...observations);
    segmentSummaries.push(summarizeSegmentProjection(segmentId, filename, observations, chunkSummaries));
  }

  const datasetSummary = summarizeObservations(allObservations);
  const consistency = verifyProjectionConsistency(allObservations, {
    expectedTotalObservations: allObservations.length,
    expectedProjectedObservations: datasetSummary.projectedObservations,
    expectedProjectedPoints: datasetSummary.projectedPointCount,
  });

  const probs = [];
  const stds = [];
  for (const ob of allObservations) {
    if (ob.laneLineProb != null) probs.push(ob.laneLineProb);
    if (ob.laneLineStd != null) stds.push(ob.laneLineStd);
  }

  const sparseSegments = segmentSummaries
    .filter((s) => (s.pctProjected ?? 0) < 0.5 || s.modelV2FrameCount < 5)
    .map((s) => ({
      segmentId: s.segmentId,
      projectedObservations: s.projectedObservations,
      decodedObservations: s.decodedObservations,
      pctProjected: s.pctProjected,
      modelV2FrameCount: s.modelV2FrameCount,
      sparseCriteria: [
        ...(s.pctProjected < 0.5 ? ['observation_projection_rate_below_50pct'] : []),
        ...(s.modelV2FrameCount < 5 ? ['modelV2_frame_count_below_5'] : []),
      ],
    }));

  const stage15Outliers = summarizeCoverageOutliers(
    segmentSummaries.map((s) => ({
      segmentId: s.segmentId,
      filename: s.filename,
      modelV2FrameCount: s.modelV2FrameCount,
      chunkCount: s.chunkCount,
      frameCoverageRate: 1,
      probFilteredCoverageRate: s.pctProjected,
      flags: s.pctProjected < 0.5 ? ['low_projection_rate'] : [],
    })).filter((s) => s.flags.length),
  );

  return {
    auditedAt: createdAt,
    stage16Status: 'approved',
    stagePurpose: 'projected_lane_line_observation_prototype',
    laneCountingComplete: false,
    productionLaneCountImplemented: false,
    v11GeometryModified: false,
    frozenRoadSurfaceVersion: FROZEN_ROAD_SURFACE_VERSION,
    frozenV11ProcessingVersion: PROCESSING_VERSION,
    projectionSchemaVersion: PROJECTION_SCHEMA_VERSION,
    stage16ProcessingVersion: STAGE16_PROCESSING_VERSION,
    transformConventions: TRANSFORM_CONVENTIONS,
    perpendicularDistanceSemantics: PERPENDICULAR_DISTANCE_SEMANTICS,
    fragmentAssessment: DEFAULT_FRAGMENT_ASSESSMENT,
    bevRequiredCategories: BEV_REQUIRED_CATEGORIES,
    physicalRouteSegments: filenames.length,
    totalRouteChunks: totalChunks,
    datasetSummary: {
      ...datasetSummary,
      totalModelV2Frames: new Set(allObservations.map((o) => `${o.sourceFile}|${o.logMonoTime}`)).size,
      totalSourceSlots: allObservations.length,
      laneLineProb: summarizeNumeric(probs),
      laneLineStd: summarizeNumeric(stds),
      pctProjectedLabel: `${datasetSummary.projectedObservations} / ${datasetSummary.decodedObservations}`,
      pointAccountingLabel: datasetSummary.pointAccounting,
    },
    projectionQualitySummaries: datasetSummary.qualitySummaries,
    segmentSummaries,
    sparseSegments,
    stage15CoverageOutlierCrossRef: stage15Outliers,
    projectionConsistency: consistency,
    observations: options.includeAllObservations ? allObservations : undefined,
    modelEvents: options.includeAllObservations ? allModelEvents : undefined,
    observationCount: allObservations.length,
  };
}

function generateStage16Markdown(audit) {
  const d = audit.datasetSummary;
  const pa = d.pointAccounting || {};
  const lines = [
    '# Stage 16 — Projected Lane-Line Observations',
    '',
    `**Date:** ${audit.auditedAt?.slice(0, 10)}`,
    `**Status:** ${audit.stage16Status}`,
    `**Projection schema:** \`${audit.projectionSchemaVersion}\``,
    `**Frozen v11 baseline:** \`${audit.frozenRoadSurfaceVersion}\``,
    `**v11 geometry modified:** ${audit.v11GeometryModified}`,
    '',
    '## Scope',
    '',
    'Stage 16 projects modelV2 lane-line observations from device frame into route coordinates.',
    'It does **not** implement divider tracking, run fusion, lane intervals, or lane-count estimation.',
    '',
    '## Transform conventions',
    '',
    `- Device frame: x forward, y left, z up`,
    `- Global: east/north from first GPS fix; heading clockwise from north`,
    `- Route s: arc length along section-scoped vehicle path`,
    `- Route d: signed lateral offset (positive = left of travel)`,
    `- Pose: \`interpolateGpsAtTime\` (frozen GPS model)`,
    `- Projection: \`projectPointTemporal\` within pass+section boundary`,
    '',
    '## Perpendicular-distance semantics',
    '',
    `- **Definition:** ${audit.perpendicularDistanceSemantics?.definition || 'see schema'}`,
    `- **Units:** ${audit.perpendicularDistanceSemantics?.units || 'metres'}`,
    `- **Assessment limit:** ${audit.perpendicularDistanceSemantics?.assessmentLimitM ?? 25} m`,
    `- **Trajectory scope:** ${audit.perpendicularDistanceSemantics?.trajectoryScope || 'pass+section'}`,
    `- **Temporal window:** ${audit.perpendicularDistanceSemantics?.temporalSearchWindow || '±4 segments'}`,
    `- **Tie resolution:** ${audit.perpendicularDistanceSemantics?.tieResolution || 'minimum perp dist'}`,
    `- **Point-level filter rationale:** ${audit.perpendicularDistanceSemantics?.pointLevelFilterRationale || ''}`,
    `- **Curved roads:** ${audit.perpendicularDistanceSemantics?.curvedRoadBehaviour || ''}`,
    `- **Pose-section ends:** ${audit.perpendicularDistanceSemantics?.poseSectionEndBehaviour || ''}`,
    '',
    '## Fragment assessment (prototype)',
    '',
    'Disconnected projected point runs are split into fragments; only the primary fragment (longest route-s span) is retained.',
    '',
    '| Check | Threshold |',
    '|-------|-----------|',
    `| min projected points | ${audit.fragmentAssessment?.minProjectedPoints ?? 2} |`,
    `| min retained fraction | ${audit.fragmentAssessment?.minRetainedPointFraction ?? 0.05} |`,
    `| min route-s span | ${audit.fragmentAssessment?.minProjectedRouteSpanM ?? 2} m |`,
    `| max source-index gap | ${audit.fragmentAssessment?.maxInternalSourceIndexGap ?? 1} |`,
    `| monotonic route-s | ${audit.fragmentAssessment?.requireMonotonicRouteS ?? true} |`,
    '',
    '## Dataset totals',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Physical segments | ${audit.physicalRouteSegments} |`,
    `| Route chunks | ${audit.totalRouteChunks} |`,
    `| modelV2 frames | ${d.totalModelV2Frames} |`,
    `| Source slot observations | ${d.totalSourceSlots} |`,
    `| Projected observations | ${d.projectedObservations} (${(d.pctProjected * 100).toFixed(1)}% of ${d.decodedObservations}) |`,
    `| Projected frames | ${d.projectedFrames} / ${d.framesWithObservations} |`,
    '',
    '## Source-point accounting (exhaustive)',
    '',
    `| Bucket | Count | % of raw |`,
    `|--------|-------|----------|`,
    `| Raw decoded device points | ${pa.rawDecodedDevicePoints} | 100% (${pa.rawDecodedDevicePoints} / ${pa.rawDecodedDevicePoints}) |`,
    `| Raw nonfinite | ${pa.rawNonfinitePoints} | ${pa.rawDecodedDevicePoints ? (pa.rawNonfinitePoints / pa.rawDecodedDevicePoints * 100).toFixed(1) : 0}% (${pa.rawNonfinitePoints} / ${pa.rawDecodedDevicePoints}) |`,
    `| Rejected outside x ∈ [−5, 120] m window | ${pa.rejectedByXWindow} | ${pa.rawDecodedDevicePoints ? (pa.rejectedByXWindow / pa.rawDecodedDevicePoints * 100).toFixed(1) : 0}% (${pa.rejectedByXWindow} / ${pa.rawDecodedDevicePoints}) |`,
    `| After x-window | ${pa.afterXWindow} | ${pa.pctAfterXWindowOfRaw || ''} |`,
    `| In observation-rejected records | ${pa.inObservationRejected} | ${pa.rawDecodedDevicePoints ? (pa.inObservationRejected / pa.rawDecodedDevicePoints * 100).toFixed(1) : 0}% (${pa.inObservationRejected} / ${pa.rawDecodedDevicePoints}) |`,
    `| Submitted to projection | ${pa.submittedToProjection} | ${pa.rawDecodedDevicePoints ? (pa.submittedToProjection / pa.rawDecodedDevicePoints * 100).toFixed(1) : 0}% (${pa.submittedToProjection} / ${pa.rawDecodedDevicePoints}) |`,
    `| Successfully projected | ${pa.projected} | ${pa.pctProjectedOfSubmitted || ''} |`,
    `| Rejected perp distance | ${pa.rejectedPerpDist} | ${pa.submittedToProjection ? (pa.rejectedPerpDist / pa.submittedToProjection * 100).toFixed(1) : 0}% (${pa.rejectedPerpDist} / ${pa.submittedToProjection}) |`,
    `| Rejected pose unavailable/gap | ${pa.rejectedPoseUnavailable} | ${pa.submittedToProjection ? (pa.rejectedPoseUnavailable / pa.submittedToProjection * 100).toFixed(1) : 0}% (${pa.rejectedPoseUnavailable} / ${pa.submittedToProjection}) |`,
    `| Rejected forward window | ${pa.rejectedForwardWindow} | ${pa.submittedToProjection ? (pa.rejectedForwardWindow / pa.submittedToProjection * 100).toFixed(1) : 0}% (${pa.rejectedForwardWindow} / ${pa.submittedToProjection}) |`,
    `| Rejected nonfinite output | ${pa.rejectedNonfiniteOutput} | ${pa.submittedToProjection ? (pa.rejectedNonfiniteOutput / pa.submittedToProjection * 100).toFixed(1) : 0}% (${pa.rejectedNonfiniteOutput} / ${pa.submittedToProjection}) |`,
    `| Rejected fragment discarded | ${pa.rejectedFragmentDiscarded} | ${pa.submittedToProjection ? (pa.rejectedFragmentDiscarded / pa.submittedToProjection * 100).toFixed(1) : 0}% (${pa.rejectedFragmentDiscarded} / ${pa.submittedToProjection}) |`,
    `| **Reconciliation** | ${pa.reconciliationPassed ? 'PASSED' : 'FAILED'} | accounted ${pa.accountedPoints} / expected ${pa.expectedRawPoints} |`,
    '',
    '### Point-level outcome distribution',
    '',
  ];

  for (const [outcome, count] of Object.entries(pa.byOutcome || {}).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${outcome}\`: ${count} (${pa.rawDecodedDevicePoints ? (count / pa.rawDecodedDevicePoints * 100).toFixed(2) : 0}% of ${pa.rawDecodedDevicePoints})`);
  }

  lines.push('', '## Rejection breakdown (observation-level)', '');
  for (const [status, count] of Object.entries(d.byStatus || {}).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${status}\`: ${count} (${(count / d.decodedObservations * 100).toFixed(1)}% of ${d.decodedObservations})`);
  }

  lines.push(
    '',
    '## Coverage by slot',
    '',
    '| Slot | Total | Projected | % |',
    '|------|-------|-----------|---|',
  );
  for (const [slot, v] of Object.entries(d.bySlot || {})) {
    lines.push(`| ${slot} | ${v.total} | ${v.projected} | ${(v.projected / v.total * 100).toFixed(1)}% |`);
  }

  const qs = audit.projectionQualitySummaries?.bySlot || {};
  lines.push('', '## Projection quality by slot', '', '| Slot | Obs rate | Point retention | Median route-s span | Median retained frac | Fragmented | Non-monotonic s |', '|------|----------|-----------------|---------------------|----------------------|------------|-----------------|');
  for (const [slot, v] of Object.entries(qs)) {
    lines.push(`| ${slot} | ${(v.observationProjectionRate * 100).toFixed(1)}% | ${(v.pointRetentionRate * 100).toFixed(1)}% | ${v.medianProjectedRouteSpanM?.toFixed(1) ?? '—'} m | ${v.medianRetainedPointFraction?.toFixed(2) ?? '—'} | ${v.fragmentedRunCount} | ${v.nonMonotonicRouteSCount} |`);
  }

  lines.push(
    '',
    '## Sparse segments (named criteria)',
    '',
  );
  for (const s of audit.sparseSegments || []) {
    lines.push(`- Segment ${s.segmentId}: ${s.sparseCriteria?.join(', ')} — projected ${s.projectedObservations}/${s.decodedObservations}`);
  }

  lines.push(
    '',
    '## BEV inspection categories',
    '',
    `Required: ${(audit.bevRequiredCategories || []).join(', ')}`,
    '',
    '## Consistency checks',
    '',
    `- Projection consistency: ${audit.projectionConsistency?.passed ? '**passed**' : '**FAILED**'}`,
    `- Point reconciliation: ${pa.reconciliationPassed ? '**passed**' : '**FAILED**'}`,
    `- Projected observations: ${audit.projectionConsistency?.projectedObservationCount}`,
    `- Projected points: ${audit.projectionConsistency?.projectedPointCount}`,
    `- Nonfinite outputs: ${d.nonfiniteOutputCount}`,
    `- Pose-gap rejections: ${d.poseGapCount}`,
    `- Fragment-policy rejections: ${d.fragmentPolicyRejections ?? 0}`,
    `- Boundary rejections: ${d.boundaryRejectionCount}`,
    '',
    '## Limitations',
    '',
    '- Assessment thresholds are Stage 15A values (not production)',
    '- Fragment assessment thresholds are prototype values (not production)',
    '- Slot roles are dataset-specific metadata from Stage 15A',
    '- Road edges and v11 polygons are geometric context only',
    '- Camera validation blocked (Stage 12B) — no physical-road accuracy claims',
    '- Lane counting **not implemented**',
    '',
    '## Tests',
    '',
    'Run `node --test tests/stage16_lane_line_projection.test.js`',
  );

  return lines.join('\n');
}

module.exports = {
  DEFAULT_ROUTE_OPTS,
  listSegmentFiles,
  buildStage16ProjectionAudit,
  generateStage16Markdown,
};
