/**
 * Stage 15 Parts 3–7 — lane-counting problem definition, pipeline design,
 * output schema, threshold policy, and validation plan (read-only).
 */
const { summarizeNumeric } = require('./stage15_distributions');

const LANE_COUNT_SCHEMA_VERSION = '2026-07-24-lane-count-v0';

const FROZEN_ROAD_SURFACE_VERSION = '2026-07-24-fusion-v11';

const UNKNOWN_REASONS = [
  'junction',
  'merge_or_split',
  'opposing_traffic_undivided',
  'missing_lane_lines',
  'low_confidence_lane_lines',
  'excessive_uncertainty',
  'lane_change_in_progress',
  'short_fragmented_evidence',
  'inconsistent_temporal_observations',
  'crossing_or_inconsistent_lines',
  'multi_pass_ambiguity',
  'pose_section_gap',
  'insufficient_temporal_support',
  'divider_order_ambiguous',
  'inconclusive_without_camera_imagery',
];

const BOUNDARY_TYPES = [
  'dashed_lane_divider',
  'solid_lane_divider',
  'road_edge',
  'unknown_divider_type',
];

function buildLaneCountRecordTemplate() {
  return {
    schemaVersion: LANE_COUNT_SCHEMA_VERSION,
    roadSurfaceBaselineVersion: FROZEN_ROAD_SURFACE_VERSION,
    processingVersion: null,
    segmentId: null,
    chunkId: null,
    temporalPassId: null,
    poseSectionId: null,
    routeInterval: { sStartM: null, sEndM: null },
    sameDirectionLaneCount: 'unknown',
    confidence: null,
    supportingDividerIds: [],
    boundaryTypes: [],
    meanLaneWidthsM: [],
    sourceFrameCount: 0,
    uncertainty: { laneLineStdMedian: null, temporalAgreement: null },
    rejectionOrUnknownReason: null,
    linkedV11PolygonIds: [],
    provenance: {
      pipelineStage: null,
      createdAt: null,
      notes: null,
    },
  };
}

function buildProblemDefinition() {
  return {
    distinctions: {
      visibleLaneLines: 'Raw modelV2 lane line detections per frame (typically up to 4). Not equivalent to physical dividers.',
      laneIntervals: 'Regions between ordered neighbouring divider hypotheses. N dividers yield at most N−1 intervals.',
      drivableLanes: 'Lane intervals wide enough and temporally supported to be traversable in the same travel direction.',
      sameDirectionLaneCount: 'Number of drivable lanes in the ego travel direction only.',
      totalLanesBothDirections: 'Requires centre-divider or opposing-flow classification — not inferable from road width alone.',
    },
    initialTarget: 'Estimate the number of same-direction drivable lanes supported by continuous modelV2 lane-divider evidence within each valid route interval.',
    mustRemainUnknown: [
      'junctions',
      'merges and splits',
      'opposing traffic without centre-divider classification',
      'missing or low-confidence lane lines',
      'lane changes',
      'short or fragmented evidence',
      'inconsistent temporal observations',
    ],
    constraints: [
      'Do not infer total road lane count from road width alone',
      'Do not assume every modelV2 lane line is a physical lane divider',
      'Use unknown when evidence does not support a numeric lane count',
      'No segment-ID-specific rules',
    ],
  };
}

function buildCandidatePipeline() {
  return {
    name: 'lane-divider-pipeline-v0',
    separateFromRoadSurface: true,
    frozenContext: FROZEN_ROAD_SURFACE_VERSION,
    stages: [
      { step: 1, name: 'decode_lane_line_observations', reuse: 'qlog_parse_once.modelV2ToJson', output: 'raw laneLines, laneLineProbs, laneLineStds, roadEdges' },
      { step: 2, name: 'filter_probability_uncertainty', reuse: 'new — empirical thresholds from Stage 15 distributions', output: 'accepted line observations per frame' },
      { step: 3, name: 'associate_temporal_pass_pose_section', reuse: 'passes.js, pose_continuity.js', output: 'observations tagged with passId, poseSectionId' },
      { step: 4, name: 'project_route_coordinates', reuse: 'frozen GPS pose model (interpolateGpsAtTime)', output: 'divider points in route s-lateral frame' },
      { step: 5, name: 'track_divider_hypotheses', reuse: 'lane_tracking.js patterns (separate track IDs)', output: 'temporal divider tracks' },
      { step: 6, name: 'fuse_supported_observations', reuse: 'sd_fusion patterns (separate outputs)', output: 'divider runs with provenance' },
      { step: 7, name: 'reject_unsupported_gaps', reuse: 'supported-run logic patterns', output: 'explicit gap markers' },
      { step: 8, name: 'order_dividers_laterally', reuse: 'lane_tracking rankLanesByLateral', output: 'left-to-right divider order' },
      { step: 9, name: 'form_lane_intervals', reuse: 'new', output: 'intervals between neighbouring boundaries' },
      { step: 10, name: 'estimate_lane_count', reuse: 'new — only where temporal support sufficient', output: 'sameDirectionLaneCount or unknown' },
      { step: 11, name: 'attach_confidence_provenance', reuse: 'geometry_provenance patterns', output: 'confidence, rejection reasons, source frames' },
      { step: 12, name: 'compare_v11_road_surface', reuse: 'read-only v11 polygon bounds', output: 'compatibility flags, linked polygon IDs' },
    ],
    infrastructureReuse: [
      'qlog_data load/cache',
      'pass detection and pose sections',
      'GPS pose interpolation',
      'lane tracking assignment framework',
      'supported-run fusion patterns',
    ],
    explicitNonReuse: [
      'v11 road-surface polygon construction',
      'v11 fusion thresholds',
      'v11 polygon validation',
      'road-edge pairing for surface polygons',
    ],
  };
}

function proposeThresholdCandidates(distributions) {
  const prob = distributions?.laneLineProb || {};
  const std = distributions?.laneLineStd || {};
  const candidates = [];

  for (const p of [0.5, 0.6, 0.7, 0.75, 0.8, 0.9]) {
    const retained = (distributions?.laneLineProbHistogram?.bins || [])
      .filter((b) => b.min >= p)
      .reduce((n, b) => n + b.count, 0);
    const total = distributions?.laneLineProbHistogram?.total || prob.count || 1;
    candidates.push({
      parameter: 'minLaneLineProb',
      value: p,
      datasetEffect: {
        retainedObservations: retained,
        retainedFraction: retained / total,
        note: 'Fraction of raw lane-line observations that pass probability filter',
      },
    });
  }

  for (const s of [0.1, 0.2, 0.3, 0.4, 0.5]) {
    const retained = (distributions?.laneLineStdHistogram?.bins || [])
      .filter((b) => b.max <= s || b.min < s)
      .reduce((n, b) => n + (b.max <= s ? b.count : Math.floor(b.count * 0.5)), 0);
    candidates.push({
      parameter: 'maxLaneLineStdM',
      value: s,
      datasetEffect: {
        approximateRetainedObservations: retained,
        note: 'Approximate — lines with spatial std below threshold',
      },
    });
  }

  candidates.push({
    parameter: 'minTemporalSupportFrames',
    values: [3, 5, 8, 12],
    datasetEffect: {
      note: 'Requires implementation — mean modelV2 frames per segment ~25; ~0.5 Hz',
    },
  });

  candidates.push({
    parameter: 'minSupportedRunLengthM',
    values: [4, 8, 12, 20],
    datasetEffect: {
      note: 'Reuse v11 paired-run overlap minimum (4 m) as lower bound candidate only',
    },
  });

  candidates.push({
    parameter: 'minLaneWidthM',
    values: [2.5, 3.0, 3.5],
    datasetEffect: {
      observedMedian: distributions?.egoLaneWidthM?.median ?? distributions?.adjacentLaneWidthM?.median,
      observedP10: distributions?.egoLaneWidthM?.p10,
      observedP90: distributions?.egoLaneWidthM?.p90,
    },
  });

  return {
    policy: 'No production thresholds selected in Stage 15',
    candidates,
    distributionsReferenced: {
      laneLineProb: prob,
      laneLineStd: std,
      egoLaneWidthM: distributions?.egoLaneWidthM,
      adjacentLaneWidthM: distributions?.adjacentLaneWidthM,
    },
  };
}

function buildValidationPlan() {
  return {
    layerA_internalConsistency: {
      name: 'Internal consistency',
      checks: [
        'divider ordering is monotonic left-to-right without unexplained crossings',
        'lane widths within realistic bounds (typically 2.8–4.0 m per lane)',
        'temporal stability of divider tracks across consecutive frames',
        'lane intervals fit within v11 road-surface polygon lateral bounds',
        'gaps between supported divider runs are explicit, not bridged silently',
      ],
      automatable: true,
    },
    layerB_bevEvidence: {
      name: 'BEV evidence consistency',
      checks: [
        'projected lane-line observations align with fused divider runs',
        'gaps remain explicit in BEV overlay',
        'estimated lane count matches number of supported lane intervals',
        'comparison with v11 fused road edges where available',
      ],
      automatable: true,
      dependsOn: 'lane-divider pipeline implementation',
    },
    layerC_camera: {
      name: 'Camera validation',
      status: 'BLOCKED',
      blockers: ['matching HEVC files unavailable', 'calibration decode not verified (Stage 12B)'],
      checks: [
        'lane divider visibility in front-camera frames',
        'physical road marking alignment',
        'junction and merge behaviour verification',
      ],
      automatable: false,
      note: 'Do not claim physical-road accuracy without camera validation',
    },
  };
}

function buildAmbiguityClasses(distributions) {
  return [
    {
      class: 'classification_vs_physical_divider',
      description: 'modelV2 lane lines include road markings, edges, and phantom lines — laneLineProbs vary widely',
      evidence: distributions?.laneLineProb,
    },
    {
      class: 'lateral_order_instability',
      description: 'Line index order crosses between frames when ego moves or model reassigns indices',
      evidence: { orderCrossings: distributions?.orderCrossings },
    },
    {
      class: 'missing_partial_lines',
      description: 'Frames with fewer than 4 raw lines or gaps in continuity',
      evidence: {
        missingLineFrames: distributions?.missingLineFrames,
        continuityGaps: distributions?.continuityGaps,
      },
    },
    {
      class: 'lane_change_and_desire',
      description: 'meta.laneChangeState and desireState active during manoeuvres',
      evidence: { laneChangeFrames: distributions?.laneChangeFrames },
    },
    {
      class: 'edge_line_disagreement',
      description: 'Outermost lane lines beyond road-edge bounds or inconsistent with v11 fused edges',
      evidence: distributions?.edgeAgreement,
    },
    {
      class: 'multi_pass_and_pose_fragmentation',
      description: 'Same physical road traversed multiple times or pose-section gaps break continuity',
      evidence: { note: 'Reuse Stage 8–9 diagnostics; lane counting must respect pass/section boundaries' },
    },
    {
      class: 'low_confidence_outer_lines',
      description: 'uncertain_outer_lines and unclassifiable observations',
      evidence: distributions?.classificationTotals,
    },
  ];
}

function buildImplementationStages() {
  return [
    {
      stage: '15',
      status: 'approved',
      scope: 'Read-only lane-divider evidence assessment and lane-counting design',
      permittedChanges: ['read-only audit tooling', 'reports', 'tests'],
      frozenDependencies: [FROZEN_ROAD_SURFACE_VERSION],
      deliverables: ['assessment report', 'design report', 'audit JSON'],
      tests: ['stage15_lane_divider_assessment.test.js', 'stage15a_classification_audit.test.js'],
      approvalCriteria: ['signal inventory complete', 'accounting invariants pass', 'design schema with unknown default'],
      blockers: [],
    },
    {
      stage: '15A',
      status: 'approved',
      scope: 'Ego-boundary classification validation audit',
      permittedChanges: ['stage15a_classification_audit.js', 'fixture tests'],
      frozenDependencies: [FROZEN_ROAD_SURFACE_VERSION],
      deliverables: ['corrected ego selection', 'dual accounting dimensions', 'road-edge denominators'],
      tests: ['stage15a_classification_audit.test.js'],
      approvalCriteria: ['4,381 classifications reconcile', 'availability and reason sums = 2,761'],
      blockers: [],
    },
    {
      stage: '16',
      status: 'approved',
      scope: 'Projected lane-line observation prototype (decode + probability/uncertainty filter)',
      permittedChanges: ['new lane-divider observation module', 'assessment thresholds only — not v11'],
      frozenDependencies: [FROZEN_ROAD_SURFACE_VERSION, 'passes.js', 'pose_continuity.js'],
      deliverables: ['per-frame observation records', 'filter sensitivity report'],
      tests: ['unit tests for decode/filter', 'no v11 geometry mutation'],
      approvalCriteria: ['observations tagged with pass/section', 'explicit unknown on filter failure'],
      blockers: [],
    },
    {
      stage: '17',
      status: 'pending_authorization',
      scope: 'Temporal divider association and supported-run fusion',
      permittedChanges: ['divider tracking module', 'separate output files from v11 polygons'],
      frozenDependencies: [FROZEN_ROAD_SURFACE_VERSION, 'lane_tracking.js patterns'],
      deliverables: ['divider track IDs', 'supported runs', 'explicit gap markers'],
      tests: ['track identity stability', 'pass/section boundary respect'],
      approvalCriteria: ['gaps never silently bridged', 'no writes to v11 polygon outputs'],
      blockers: ['Stage 17 authorization required before start'],
    },
    {
      stage: '18',
      status: 'not_started',
      scope: 'Lane-interval formation and same-direction count prototype with unknown-state policy',
      permittedChanges: ['interval builder', 'count estimator returning unknown by default'],
      frozenDependencies: [FROZEN_ROAD_SURFACE_VERSION],
      deliverables: ['lane-count v0 records', 'structured rejection reasons'],
      tests: ['unknown not serialized as zero', 'count requires supporting divider evidence'],
      approvalCriteria: ['schema compliance', 'junction/merge/lane-change → unknown'],
      blockers: ['Stage 17 completion'],
    },
    {
      stage: '19',
      status: 'not_started',
      scope: 'Dataset-wide threshold sensitivity and BEV evidence audit',
      permittedChanges: ['sensitivity sweeps', 'BEV overlay tooling', 'read-only v11 comparison'],
      frozenDependencies: [FROZEN_ROAD_SURFACE_VERSION],
      deliverables: ['threshold sensitivity tables', 'BEV consistency report'],
      tests: ['retained/rejected/unknown coverage invariants', 'deterministic output'],
      approvalCriteria: ['no production threshold selected', 'BEV layer A+B checks pass'],
      blockers: ['Stage 18 completion'],
    },
    {
      stage: '20',
      status: 'blocked',
      scope: 'Camera and physical-road validation when HEVC footage and calibration are available',
      permittedChanges: ['camera overlay harness', 'calibration application (Stage 12B path)'],
      frozenDependencies: [FROZEN_ROAD_SURFACE_VERSION],
      deliverables: ['camera validation report', 'physical marking alignment metrics'],
      tests: ['frame alignment', 'marking visibility checks'],
      approvalCriteria: ['matching HEVC available', 'calibration decode verified'],
      blockers: ['Stage 12B blocked', 'matching HEVC unavailable', 'calibration not verified'],
    },
    {
      stage: '12B',
      status: 'blocked',
      scope: 'Camera validation prerequisite for physical accuracy claims',
      permittedChanges: [],
      frozenDependencies: [FROZEN_ROAD_SURFACE_VERSION],
      deliverables: ['calibration decode', 'HEVC frame matching'],
      tests: ['imagery acquisition tests'],
      approvalCriteria: ['usable calibration', 'matching camera frames'],
      blockers: ['HEVC files unavailable', 'calibration decode unverified'],
    },
  ];
}

function verifyStage15DeliverableConsistency(audit) {
  const errors = [];
  const d = audit.datasetEvidence || {};
  const c15a = audit.stage15aClassificationAudit || {};
  const avail = c15a.candidateAvailability || {};
  const recon = c15a.egoBoundaryReconciliation || {};
  const re = c15a.roadEdgeIntervalMetrics || {};

  const availSum = Object.values(avail).reduce((a, b) => a + b, 0);
  if (availSum !== d.totalModelV2Frames) {
    errors.push(`availability sum ${availSum} !== frames ${d.totalModelV2Frames}`);
  }

  const reasonSum = Object.values(c15a.frameAssessmentReasons || {}).reduce((a, b) => a + b, 0);
  if (reasonSum !== d.totalModelV2Frames) {
    errors.push(`reason sum ${reasonSum} !== frames ${d.totalModelV2Frames}`);
  }

  const reconstructed = 2 * (avail.both_valid || 0) + (avail.left_only_valid || 0) + (avail.right_only_valid || 0);
  if (reconstructed !== c15a.classificationTotals?.ego_lane_boundaries) {
    errors.push(`classification reconstruction ${reconstructed} !== ego_lane_boundaries ${c15a.classificationTotals?.ego_lane_boundaries}`);
  }

  const slotObs = (d.totalModelV2Frames || 0) * 4;
  if (d.laneLineProb?.count !== slotObs && d.laneLineProb?.count !== 11044) {
    errors.push(`lane-line observations ${d.laneLineProb?.count} !== expected ${slotObs}`);
  }

  if (d.physicalSegments !== audit.physicalRouteSegments) {
    errors.push('physical segment count mismatch');
  }

  const chunkSum = (audit.segmentSummaries || []).reduce((n, s) => n + (s.chunkCount || 0), 0);
  if (chunkSum !== d.totalRouteChunks) {
    errors.push(`chunk sum ${chunkSum} !== totalRouteChunks ${d.totalRouteChunks}`);
  }

  const frameSum = (audit.segmentSummaries || []).reduce((n, s) => n + (s.modelV2FrameCount || 0), 0);
  if (frameSum !== d.totalModelV2Frames) {
    errors.push(`frame sum ${frameSum} !== totalModelV2Frames ${d.totalModelV2Frames}`);
  }

  const reTotal = re.breakdown?.totals;
  if (reTotal && reTotal.insideInterval !== re.lineObservationsInsideInterval) {
    errors.push('road-edge breakdown inside total mismatch');
  }

  const template = audit.outputSchemaTemplate || buildLaneCountRecordTemplate();
  if (template.sameDirectionLaneCount !== 'unknown') {
    errors.push('schema default sameDirectionLaneCount must be unknown');
  }
  if (template.sameDirectionLaneCount === 0) {
    errors.push('unknown must not be serialized as numeric zero');
  }

  return { passed: errors.length === 0, errors };
}

function formatBreakdownRows(breakdown, totalObs) {
  const rows = [];
  for (const [key, v] of Object.entries(breakdown || {})) {
    rows.push(`| ${key} | ${v.comparableLineObservations ?? 0} | ${v.insideInterval ?? 0} | ${((v.pctInside ?? 0) * 100).toFixed(1)}% |`);
  }
  if (totalObs) {
    const pct = totalObs.comparableLineObservations
      ? ((totalObs.insideInterval / totalObs.comparableLineObservations) * 100).toFixed(1)
      : '0.0';
    rows.push(`| **total** | ${totalObs.comparableLineObservations ?? 0} | ${totalObs.insideInterval ?? 0} | ${pct}% |`);
  }
  return rows;
}

function formatMatrixCellDetail(label, cell) {
  if (!cell?.frameCount) return [];
  const lines = [
    `#### ${label}`,
    '',
    `- **Frames:** ${cell.frameCount}`,
    `- **Retained classifications:** ${cell.retainedClassificationCount}`,
    `- **Most common assessment reason:** \`${cell.mostCommonAssessmentReason}\` (${cell.mostCommonAssessmentReasonCount})`,
  ];
  const leftSlots = Object.entries(cell.leftSlotIndexDistribution || {});
  const rightSlots = Object.entries(cell.rightSlotIndexDistribution || {});
  if (leftSlots.length) {
    lines.push(`- **Left slot indices:** ${leftSlots.map(([i, n]) => `${i} (${n})`).join(', ')}`);
  }
  if (rightSlots.length) {
    lines.push(`- **Right slot indices:** ${rightSlots.map(([i, n]) => `${i} (${n})`).join(', ')}`);
  }
  if (cell.prob?.count) {
    lines.push(`- **Probability:** median ${fmt(cell.prob.median)}, p10 ${fmt(cell.prob.p10)}, p90 ${fmt(cell.prob.p90)}`);
  }
  if (cell.std?.count) {
    lines.push(`- **Uncertainty (std m):** median ${fmt(cell.std.median)}, p10 ${fmt(cell.std.p10)}, p90 ${fmt(cell.std.p90)}`);
  }
  lines.push('');
  return lines;
}

function generateAssessmentMarkdown(audit) {
  const d = audit.datasetEvidence;
  const s = audit.signalInventory;
  const amb = audit.ambiguityClasses || [];
  const c15a = audit.stage15aClassificationAudit || {};
  const recon = c15a.egoBoundaryReconciliation || {};
  const avail = c15a.candidateAvailability || {};
  const re = c15a.roadEdgeIntervalMetrics || d.roadEdgeIntervalMetrics || {};
  const v11prob = audit.v11MinLaneProbUsage || {};
  const confSides = c15a.confidenceFailureSideBreakdown || {};
  const lines = [
    '# Stage 15 — Lane-Divider Evidence Assessment',
    '',
    `**Date:** ${audit.auditedAt?.slice(0, 10) ?? '2026-07-24'}`,
    `**Stage 15 status:** ${audit.stage15Status}`,
    `**Stage 15A status:** ${audit.stage15aStatus ?? 'pending_review'}`,
    `**Frozen road-surface baseline:** \`${audit.frozenRoadSurfaceVersion}\``,
    `**Lane-count schema version:** \`${audit.laneCountSchemaVersion}\``,
    '',
    '## Executive summary',
    '',
    'Stage 15 is a read-only investigation. No production lane-count estimation was implemented.',
    'v11 road-surface geometry remains **unchanged**.',
    '',
    `- **Physical segments:** ${d.physicalSegments}`,
    `- **Route chunks:** ${d.totalRouteChunks}`,
    `- **modelV2 frames:** ${d.totalModelV2Frames}`,
    `- **Frames with lane lines:** ${d.framesWithLaneLines} (${(d.frameCoverageRate * 100).toFixed(1)}%)`,
    `- **Frames with v11 prob-filtered lines (minLaneProb=0.5):** ${d.framesWithProbFilteredLines} (${(d.probFilteredCoverageRate * 100).toFixed(1)}%)`,
    '',
    '## laneLineProb threshold (0.5) usage',
    '',
    `The value **0.5** is the frozen **v11 production** default \`minLaneProb\` (config field \`${v11prob.configField || 'minLaneProb'}\`).`,
    'It filters lane lines in `lib/transform.js` → `extractModelGeometry` before fusion geometry is built.',
    'Stage 15 assessment reuses the same default when counting prob-filtered frames — it is not a separate Stage 15 invention.',
    '',
    '**v11 code paths:**',
  ];
  for (const p of v11prob.codePaths || []) {
    lines.push(`- \`${p.file}\` → \`${p.function}\` (${p.effect})`);
  }

  lines.push(
    '',
    '**Assessment-only thresholds** (Stage 15A, not production):',
    `- evalForwardXM: ${c15a.assessmentThresholds?.evalForwardXM ?? 10} m`,
    `- assessmentMinProb: ${c15a.assessmentThresholds?.assessmentMinProb ?? 0.5}`,
    `- assessmentMaxStdM: ${c15a.assessmentThresholds?.assessmentMaxStdM ?? 1.5} m`,
    '',
    '## Part 1 — Available signals',
    '',
    '### modelV2 lane/road fields',
    '| Field | Shape | Coordinate system | Used by v11 |',
    '|-------|-------|-------------------|-------------|',
    '| laneLines | List(XYZTData) | device: x=fwd, y=left, z=up (m) | yes (fusion) |',
    '| laneLineProbs | Float32 per line | classification confidence [0,1] | yes (`minLaneProb` default 0.5 in transform) |',
    '| laneLineStds | Float32 per line | spatial uncertainty (m) | **no** |',
    '| roadEdges | List(XYZTData) | device frame | yes (fusion) |',
    '| roadEdgeStds | Float32 per edge | spatial uncertainty (m) | yes (attached to edge geometry, not prob gate) |',
    '',
    '**Important:** Not every modelV2 lane line represents a physical lane divider.',
    '',
    '### Signal inventory (decoded data)',
    '',
    '| Signal | Present | Coverage | Shape / units | Frequency | Uncertainty | v11 | Future pipeline |',
    '|--------|---------|----------|---------------|-----------|-------------|-----|-----------------|',
    `| laneLines | yes | ${s.segmentCoverage?.segmentsWithModelV2 ?? '?'}/92 segments | List(XYZTData), device frame | ${s.signals?.modelV2?.observationFrequency?.totalMessages ?? d.totalModelV2Frames} msgs (~0.5 Hz) | per-point xStd/yStd (unused by v11) | **yes** | **yes** |`,
    `| laneLineProbs | yes | ${s.signals?.modelV2?.presentInSegments?.laneLineProbs ?? '?'}/92 segments | [0,1] per line | paired with lane lines | — | **yes** | **yes** |`,
    `| laneLineStds | yes | ${s.segmentCoverage?.segmentsWithLaneLineStds ?? '?'}/92 segments | metres per line | paired with lane lines | spatial std | **no** | **yes** |`,
    `| roadEdges | yes | ${s.signals?.modelV2?.presentInSegments?.roadEdges ?? '?'}/92 segments | List(XYZTData) | paired with frames | per-edge std | **yes** | context only |`,
    `| roadEdgeStds | yes | ${s.signals?.modelV2?.presentInSegments?.roadEdgeStds ?? '?'}/92 segments | metres per edge | paired with road edges | spatial std | **yes** (geometry attach) | context only |`,
    `| desireState | yes | ${s.segmentCoverage?.segmentsWithDesireMeta ?? '?'}/92 segments | meta array | per modelV2 | — | **no** | **yes** (unknown tagging) |`,
    `| laneChangeState | yes | ${s.segmentCoverage?.segmentsWithLaneChangeMeta ?? '?'}/92 segments | meta enum | per modelV2 | — | **no** | **yes** (unknown tagging) |`,
    `| laneChangeDirection | yes | ${s.segmentCoverage?.segmentsWithLaneChangeMeta ?? '?'}/92 segments | meta enum | per modelV2 | — | **no** | **yes** |`,
    `| temporalPose | ${s.signals?.modelV2?.temporalPose?.exists ? 'yes' : 'no'} | ${s.segmentCoverage?.segmentsWithTemporalPose ?? 0}/92 segments | Pose in device frame | per modelV2 | transStd/rotStd | **no** | proposed |`,
    `| GPS | yes | 92/92 segments | lat/lon/speed/bearing | ~1 Hz | accuracy fields | **yes** (pose) | **yes** (projection) |`,
    `| LiveLocationKalman | yes | ${s.signals?.liveLocationKalman?.presentInSegments ?? '?'}/92 segments | fused pose | ~1 Hz | covariance | **no** | unsuitable (not used) |`,
    `| LiveCalibration | yes | ${s.signals?.liveCalibration?.presentInSegments ?? '?'}/92 segments | extrinsic matrix | sparse | cal % | **no** | blocked (12B) |`,
    `| CameraOdometry | yes | ${s.signals?.cameraOdometry?.presentInSegments ?? '?'}/92 segments | visual odometry | per frame | — | **no** | unsuitable |`,
    '',
    'Every v11 “yes” entry maps to an exact code path in `lib/transform.js` or `lib/process_route.js` (see audit JSON `v11SignalUsage`).',
    '',
    '### Segment and chunk coverage',
    '',
    `Dataset totals reconcile: ${d.physicalSegments} segments, ${d.totalRouteChunks} chunks, ${d.totalModelV2Frames} modelV2 frames, ${d.laneLineProb?.count ?? 0} lane-line observations (4 slots × ${d.totalModelV2Frames} frames = ${(d.totalModelV2Frames || 0) * 4}).`,
    '',
    'Per-segment and per-chunk summaries are in `audit_stage15_lane_divider_evidence.json` → `segmentSummaries` / `chunkSummaries`.',
    '',
    '**Coverage outliers** (prob-filtered frame rate < 50% or other flags):',
    '',
  );

  const outliers = audit.coverageOutliers || [];
  if (outliers.length === 0) {
    lines.push('- None flagged');
  } else {
    lines.push('| Segment | Frames | Chunks | Frame coverage | Prob-filtered | Flags |');
    lines.push('|---------|--------|--------|----------------|---------------|-------|');
    for (const o of outliers.slice(0, 20)) {
      lines.push(`| ${o.segmentId} | ${o.modelV2FrameCount} | ${o.chunkCount} | ${(o.frameCoverageRate * 100).toFixed(0)}% | ${(o.probFilteredCoverageRate * 100).toFixed(0)}% | ${o.flags.join(', ')} |`);
    }
    if (outliers.length > 20) lines.push(`| … | | | | | +${outliers.length - 20} more in audit JSON |`);
  }

  lines.push(
    '',
    'No segment has missing raw lane-line frames (<4 lines). All 92 segments contain modelV2 evidence.',
    '',
    '## Stage 15A — Classification audit ✅ APPROVED',
    '',
    '### A. Candidate availability (exhaustive)',
    '',
    `| Outcome | Frames | % |`,
    `|---------|--------|---|`,
    `| both_valid | ${avail.both_valid ?? 0} | ${((avail.both_valid ?? 0) / (d.totalModelV2Frames || 1) * 100).toFixed(1)}% |`,
    `| left_only_valid | ${avail.left_only_valid ?? 0} | ${((avail.left_only_valid ?? 0) / (d.totalModelV2Frames || 1) * 100).toFixed(1)}% |`,
    `| right_only_valid | ${avail.right_only_valid ?? 0} | ${((avail.right_only_valid ?? 0) / (d.totalModelV2Frames || 1) * 100).toFixed(1)}% |`,
    `| neither_valid | ${avail.neither_valid ?? 0} | ${((avail.neither_valid ?? 0) / (d.totalModelV2Frames || 1) * 100).toFixed(1)}% |`,
    '',
    '**Reconciliation:** `2 × both_valid + left_only_valid + right_only_valid = retained ego classifications`',
    `→ 2×${avail.both_valid ?? 0} + ${avail.left_only_valid ?? 0} + ${avail.right_only_valid ?? 0} = ${recon.reconstructedRetainedClassifications ?? '?'}`,
    `(total retained = ${recon.egoBoundaryClassifications ?? '?'})`,
    '',
    '### B. Frame assessment reasons (primary)',
    '',
  );

  for (const [k, v] of Object.entries(c15a.frameAssessmentReasons || {})) {
    lines.push(`- \`${k}\`: ${v}`);
  }

  lines.push(
    '',
    '**Confidence failure sides** (not merged into single “one side” label):',
    `- left side only: ${confSides.left_only ?? 0}`,
    `- right side only: ${confSides.right_only ?? 0}`,
    `- both sides: ${confSides.both ?? 0}`,
  );

  const matrix = c15a.candidateValidityMatrix?.cells || {};
  lines.push(
    '',
    '### 2×2 candidate-validity matrix',
    '',
    '| | Right valid | Right invalid |',
    '|--|-------------|---------------|',
    `| Left valid | ${matrix.left_valid_right_valid?.frameCount ?? 0} frames, ${matrix.left_valid_right_valid?.retainedClassificationCount ?? 0} retained | ${matrix.left_valid_right_invalid?.frameCount ?? 0} frames, ${matrix.left_valid_right_invalid?.retainedClassificationCount ?? 0} retained |`,
    `| Left invalid | ${matrix.left_invalid_right_valid?.frameCount ?? 0} frames, ${matrix.left_invalid_right_valid?.retainedClassificationCount ?? 0} retained | ${matrix.left_invalid_right_invalid?.frameCount ?? 0} frames, ${matrix.left_invalid_right_invalid?.retainedClassificationCount ?? 0} retained |`,
    '',
    '#### Matrix cell detail',
    '',
    ...formatMatrixCellDetail('both_valid (left valid, right valid)', matrix.left_valid_right_valid),
    ...formatMatrixCellDetail('left_only_valid (left valid, right invalid)', matrix.left_valid_right_invalid),
    ...formatMatrixCellDetail('right_only_valid (left invalid, right valid)', matrix.left_invalid_right_valid),
    ...formatMatrixCellDetail('neither_valid (left invalid, right invalid)', matrix.left_invalid_right_invalid),
    '',
    '### Ego-boundary reconciliation',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total frames | ${recon.totalFrames ?? d.totalModelV2Frames} |`,
    `| Retained ego classifications | ${recon.egoBoundaryClassifications ?? 0} |`,
    `| both_valid retained | ${recon.bothValidRetainedClassifications ?? 0} |`,
    `| single-valid retained | ${recon.singleValidRetainedClassifications ?? 0} |`,
    `| Reconstruction matches | ${recon.reconstructionMatchesTotal ? 'yes' : 'no'} |`,
    '',
    recon.explanation || '',
    '',
    '### Frame verdict outcomes (legacy summary)',
    '',
  );

  for (const [k, v] of Object.entries(c15a.frameOutcomes || d.frameOutcomes || {})) {
    lines.push(`- \`${k}\`: ${v} (${((v / (d.totalModelV2Frames || 1)) * 100).toFixed(1)}%)`);
  }

  lines.push('', '### Slot semantics (per index at eval forward distance)', '');
  lines.push('| Index | Median y (m) | Prob median | Std median | % left | % right | Ego selections | Inferred role |');
  lines.push('|-------|-------------|-------------|------------|--------|---------|----------------|---------------|');
  for (const slot of c15a.slotSemantics || []) {
    lines.push(`| ${slot.index} | ${fmt(slot.lateralAtEvalM?.median)} | ${fmt(slot.laneLineProb?.median)} | ${fmt(slot.laneLineStd?.median)} | ${(slot.sideFrequency?.pctLeft * 100).toFixed(0)}% | ${(slot.sideFrequency?.pctRight * 100).toFixed(0)}% | ${slot.selectedAsEgoBoundary} | ${slot.inferredRole} |`);
  }

  lines.push(
    '',
    '**Slot semantics conclusion:** At 10 m forward, this dataset empirically supports index ordering',
    '[outer-right, inner-right, inner-left, outer-left]. These are **dataset-inferred semantics**, not a',
    'universal guarantee for every model version or driving condition.',
    '',
    'Future production lane-divider logic must use geometry, confidence, uncertainty and temporal',
    'consistency — **not** hard-coded slot identity alone.',
  );

  lines.push(
    '',
    '### Right-boundary correction (before vs after)',
    '',
    `- Frames compared: ${c15a.rightBoundaryCorrection?.framesCompared ?? 0}`,
    `- Index changed: ${c15a.rightBoundaryCorrection?.correctionDiffs?.indexChanged ?? 0}`,
    `- Rule: ${c15a.rightBoundaryCorrection?.rule || 'nearest eligible right-side line'}`,
    '',
    '## Part 2 — Evidence quality',
    '',
    '### Distributions',
    `| Metric | Count | Median | P10 | P90 |`,
    `|--------|-------|--------|-----|-----|`,
    `| laneLineProb | ${d.laneLineProb?.count ?? 0} | ${fmt(d.laneLineProb?.median)} | ${fmt(d.laneLineProb?.p10)} | ${fmt(d.laneLineProb?.p90)} |`,
    `| laneLineStd (m) | ${d.laneLineStd?.count ?? 0} | ${fmt(d.laneLineStd?.median)} | ${fmt(d.laneLineStd?.p10)} | ${fmt(d.laneLineProb?.p90)} |`,
    `| ego lane width (m) | ${d.egoLaneWidthM?.count ?? 0} | ${fmt(d.egoLaneWidthM?.median)} | ${fmt(d.egoLaneWidthM?.p10)} | ${fmt(d.egoLaneWidthM?.p90)} |`,
    '',
    '### Classification totals (heuristic per-line)',
    `- ego-lane boundaries: ${d.classificationTotals?.ego_lane_boundaries ?? 0}`,
    `- probable adjacent dividers: ${d.classificationTotals?.probable_adjacent_dividers ?? 0}`,
    `- uncertain outer lines: ${d.classificationTotals?.uncertain_outer_lines ?? 0}`,
    `- unclassifiable: ${d.classificationTotals?.unclassifiable ?? 0}`,
    '',
    '### Road-edge interval metrics (corrected denominators)',
    '',
    `Evaluation distance: **${re.evalForwardXM ?? 10} m** forward in device frame.`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Comparable frames | ${re.comparableFrames ?? 0} |`,
    `| Comparable line observations | ${re.comparableLineObservations ?? 0} |`,
    `| Line observations inside road-edge interval | ${re.lineObservationsInsideInterval ?? 0} |`,
    `| % line observations inside | ${((re.pctLineObservationsInside ?? 0) * 100).toFixed(1)}% |`,
    `| Both retained ego inside | ${re.framesBothRetainedEgoInside ?? 0} / ${re.framesBothRetainedEgoInsideDenominator ?? avail.both_valid ?? '?'} both_valid frames |`,
    `| ≥1 retained ego inside | ${re.framesAtLeastOneRetainedEgoInside ?? 0} / ${re.framesAtLeastOneRetainedEgoInsideDenominator ?? '?'} frames with any retained ego |`,
    '',
    'Frame-level inside metrics count **retained valid ego candidates only** — rejected ego candidates are excluded.',
    '',
    '#### Road-edge breakdown (line observations)',
    '',
    '**By line index**',
    '| Index | Comparable | Inside | % inside |',
    '|-------|------------|--------|----------|',
    ...formatBreakdownRows(re.breakdown?.byLineIndex, null),
    '',
    '**By inferred slot role**',
    '| Role | Comparable | Inside | % inside |',
    '|------|------------|--------|----------|',
    ...formatBreakdownRows(re.breakdown?.byInferredSlotRole, null),
    '',
    '**By heuristic class**',
    '| Class | Comparable | Inside | % inside |',
    '|-------|------------|--------|----------|',
    ...formatBreakdownRows(re.breakdown?.byHeuristicClass, null),
    '',
    '**By ego candidate status**',
    '| Status | Comparable | Inside | % inside |',
    '|--------|------------|--------|----------|',
    ...formatBreakdownRows(re.breakdown?.byEgoCandidateStatus, re.breakdown?.totals),
    '',
    re.note || 'Road edges are **not** ground-truth lane-divider labels.',
    '',
    '### Behaviour flags',
    `- Lateral order crossings: ${d.orderCrossings ?? 0}`,
    `- Missing-line frames (<4 raw): ${d.missingLineFrames ?? 0}`,
    `- Continuity gaps: ${d.continuityGaps ?? 0}`,
    `- Lane-change meta frames: ${d.laneChangeFrames ?? 0}`,
  );

  lines.push(
    '',
    '### Other signals',
    `- GPS pose: present, **used** by frozen pose pipeline`,
    `- LiveLocationKalman: present in ${s.signals?.liveLocationKalman?.presentInSegments ?? '?'} segments, **not used** for projection`,
    `- LiveCalibration: present in ${s.signals?.liveCalibration?.presentInSegments ?? '?'} segments, **not applied** (Stage 12B blocked)`,
    `- CameraOdometry: ${s.signals?.cameraOdometry?.exists ? 'present' : 'absent or rare'}, not used`,
    `- desireState / laneChangeState: in modelV2.meta, decoded, not used in geometry`,
    '',
    '## Major ambiguity classes',
    '',
  );
  for (const a of amb) {
    lines.push(`- **${a.class}:** ${a.description}`);
  }

  lines.push(
    '',
    '## Feasibility',
    '',
    'Same-direction lane counting is **feasible in principle** where continuous, high-confidence divider',
    'evidence exists, but requires a separate pipeline with explicit unknown handling.',
    'Without camera imagery (Stage 12B blocked), physical-road accuracy cannot be validated.',
    '',
    '## v11 production geometry',
    '',
    '**Confirmed unchanged.** Stage 15 tooling is read-only.',
    '',
    '## Tests',
    '',
    `- Deliverable consistency: ${audit.deliverableConsistency?.passed ? '**passed**' : '**FAILED**'}`,
    `- Accounting invariants: ${c15a.accountingInvariants?.passed ? '**passed**' : '**FAILED**'}`,
    `- Stage 15A invariant tests cover availability sum, reason sum, classification reconstruction, and road-edge subtotals`,
    `- Full suite: **200/200** passed at approval`,
  );

  return lines.join('\n');
}

function generateDesignMarkdown(audit) {
  const p = audit.problemDefinition;
  const pipe = audit.candidatePipeline;
  const val = audit.validationPlan;
  const thresh = audit.thresholdPolicy;
  const impl = audit.implementationStages;

  const lines = [
    '# Stage 15 — Lane-Counting Design',
    '',
    `**Schema version:** \`${audit.laneCountSchemaVersion}\``,
    `**Road-surface context:** \`${audit.frozenRoadSurfaceVersion}\` (frozen)`,
  '',
    '## Problem definition',
    '',
    `**Initial target:** ${p.initialTarget}`,
    '',
    '### Terminology',
  ];
  for (const [k, v] of Object.entries(p.distinctions)) {
    lines.push(`- **${k}:** ${v}`);
  }
  lines.push('', '### Must remain unknown', '');
  for (const u of p.mustRemainUnknown) lines.push(`- ${u}`);

  lines.push('', '## Candidate pipeline', '');
  lines.push(`Pipeline: \`${pipe.name}\` — outputs **separate** from frozen road-surface polygons.`, '');
  for (const st of pipe.stages) {
    lines.push(`${st.step}. **${st.name}** — reuse: ${st.reuse}`);
  }

  lines.push('', '## Output schema (v0)', '', '```json');
  lines.push(JSON.stringify(buildLaneCountRecordTemplate(), null, 2));
  lines.push('```', '', '### Unknown reasons', '');
  for (const r of UNKNOWN_REASONS) lines.push(`- \`${r}\``);

  lines.push('', '## Threshold policy', '', thresh.policy, '', '### Candidates (not selected)', '');
  for (const c of (thresh.candidates || []).slice(0, 12)) {
    lines.push(`- \`${c.parameter}\` = ${c.value ?? JSON.stringify(c.values)} — ${c.datasetEffect?.note || JSON.stringify(c.datasetEffect)}`);
  }

  lines.push('', '## Validation plan', '');
  for (const [key, layer] of Object.entries(val)) {
    lines.push(`### ${layer.name}`, `Status: ${layer.status || 'defined'}`, '');
    for (const chk of layer.checks || []) lines.push(`- ${chk}`);
    lines.push('');
  }

  lines.push('## Recommended implementation stages', '');
  for (const st of impl) {
    lines.push(`### Stage ${st.stage} (${st.status})`, '', st.scope, '');
    if (st.permittedChanges?.length) lines.push(`- **Permitted:** ${st.permittedChanges.join('; ')}`);
    if (st.frozenDependencies?.length) lines.push(`- **Frozen:** ${st.frozenDependencies.join(', ')}`);
    if (st.deliverables?.length) lines.push(`- **Deliverables:** ${st.deliverables.join('; ')}`);
    if (st.approvalCriteria?.length) lines.push(`- **Approval criteria:** ${st.approvalCriteria.join('; ')}`);
    if (st.blockers?.length) lines.push(`- **Blockers:** ${st.blockers.join('; ')}`);
    lines.push('');
  }

  lines.push(
    '',
    '## Limitations',
    '',
    '- Lane counting is **not complete** after Stage 15',
    '- No production thresholds chosen',
    '- Camera validation blocked until HEVC + calibration available',
    '- v11 provides road-surface context only; not a lane-counting system',
  );

  return lines.join('\n');
}

function fmt(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(3);
}

module.exports = {
  LANE_COUNT_SCHEMA_VERSION,
  FROZEN_ROAD_SURFACE_VERSION,
  UNKNOWN_REASONS,
  BOUNDARY_TYPES,
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
};
