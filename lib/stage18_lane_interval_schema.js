/**
 * Stage 18 — lane-interval and prototype lane-count assessment schema.
 */
const { FROZEN_ROAD_SURFACE_VERSION } = require('./stage15_lane_counting_design');
const { PROCESSING_VERSION } = require('./version');
const {
  TRACKING_SCHEMA_VERSION,
  STAGE17_PROCESSING_VERSION,
} = require('./stage17_tracking_schema');

const INTERVAL_SCHEMA_VERSION = '2026-07-24-lane-interval-assessment-v0';
const STAGE18_PROCESSING_VERSION = '2026-07-24-lane-interval-assessment-v0';

const RUN_USAGE_OUTCOMES = {
  USED_AS_INTERVAL_BOUNDARY: 'used_as_interval_boundary',
  UNPAIRED_OUTER_BOUNDARY: 'unpaired_outer_boundary',
  UNPAIRED_ISOLATED: 'unpaired_isolated',
  EXCLUDED_INELIGIBLE: 'excluded_ineligible',
};

const PAIRING_OUTCOMES = {
  ACCEPTED: 'accepted',
  REJECTED_NO_OVERLAP: 'rejected_no_overlap',
  REJECTED_INSUFFICIENT_SUPPORT: 'rejected_insufficient_support',
  REJECTED_NON_ADJACENT: 'rejected_non_adjacent',
  REJECTED_INTERVENING_DIVIDER: 'rejected_intervening_divider',
  REJECTED_ORDER_FAILURE: 'rejected_order_failure',
  REJECTED_CROSSING: 'rejected_crossing',
  REJECTED_NON_POSITIVE_WIDTH: 'rejected_non_positive_width',
  REJECTED_WIDTH_OUTLIER: 'rejected_width_outlier',
  REJECTED_UNSTABLE_WIDTH: 'rejected_unstable_width',
  REJECTED_BOUNDARY: 'rejected_boundary',
  REJECTED_CONFIDENCE: 'rejected_confidence',
  REJECTED_UNCERTAINTY: 'rejected_uncertainty',
  REJECTED_AMBIGUOUS: 'rejected_ambiguous',
  REJECTED_OTHER: 'rejected_other',
};

const INTERVAL_ASSESSMENT_STATUS = {
  PLAUSIBLE_PROTOTYPE: 'plausible_prototype_interval',
  NARROW_WIDTH_OUTLIER: 'narrow_width_outlier',
  WIDE_WIDTH_OUTLIER: 'wide_width_outlier',
  UNSTABLE_WIDTH: 'unstable_width_interval',
  INSUFFICIENT_SUPPORT: 'insufficient_support_interval',
  CROSSING_OR_INVALID_ORDER: 'crossing_or_invalid_order_interval',
  AMBIGUOUS: 'ambiguous_interval',
  INCOMPLETE_BOUNDARY: 'incomplete_boundary_interval',
};

const COUNT_ASSESSMENT_STATUS = {
  ASSESSED: 'assessed',
  INSUFFICIENT_BOUNDARY_EVIDENCE: 'insufficient_boundary_evidence',
  INCOMPLETE_OUTER_BOUNDARY: 'incomplete_outer_boundary',
  AMBIGUOUS_PAIRING: 'ambiguous_pairing',
  INCONSISTENT_WIDTH: 'inconsistent_width',
  DIVIDER_CROSSING_OR_ORDER_FAILURE: 'divider_crossing_or_order_failure',
  UNSUPPORTED_GAP: 'unsupported_gap',
  CONFLICTING_TEMPORAL_EVIDENCE: 'conflicting_temporal_evidence',
  REJECTED_OTHER: 'rejected_other',
};

const COUNT_TRANSITION_LABELS = {
  STABLE_NUMERIC_SUPPORTED_COUNT: 'stable_numeric_supported_count',
  STABLE_INCOMPLETE_BOUNDARY_EVIDENCE: 'stable_incomplete_boundary_evidence',
  STABLE_UNSUPPORTED_EVIDENCE: 'stable_unsupported_evidence',
  APPARENT_COUNT_TRANSITION: 'apparent_count_transition',
  SUPPORT_CHANGE_ONLY: 'support_change_only',
  METADATA_ASSOCIATED: 'metadata_associated',
  INSUFFICIENT_EVIDENCE: 'insufficient_evidence',
  CONFLICTING_PASS_EVIDENCE: 'conflicting_pass_evidence',
  UNCLASSIFIED: 'unclassified',
};

/** Prototype assessment settings — not validated Malaysian road-design limits. */
const DEFAULT_INTERVAL_ASSESSMENT = {
  minSharedRouteSM: 5,
  sampleSStepM: 2,
  minPrototypeWidthM: 2.0,
  maxPrototypeWidthM: 5.5,
  narrowWidthThresholdM: 2.0,
  wideWidthThresholdM: 5.5,
  maxWidthVariationM: 1.2,
  maxWidthStdM: 0.8,
  maxTangentDiffDeg: 25,
  minConfidence: 0.5,
  maxUncertaintyM: 1.5,
  requireTemporalOverlap: true,
  intervalContinuationGapM: 3,
  minCountRunSpanM: 10,
  minCountStabilitySpanM: 15,
  lateralOrderToleranceM: 0.15,
};

const WIDTH_ASSESSMENT_BANDS = [
  { label: 'narrow_below_2_0m', min: 0, max: 2.0 },
  { label: 'prototype_2_0_to_3_5m', min: 2.0, max: 3.5 },
  { label: 'prototype_3_5_to_5_5m', min: 3.5, max: 5.5 },
  { label: 'wide_above_5_5m', min: 5.5, max: Infinity },
];

const PAIRING_MODEL_DOCS = {
  candidateGeneration: 'Within each (chunkId, temporalPassId, poseSectionId) group, eligible supported runs ranked by mean route-d (left-to-right). Adjacent run pairs in lateral order are pairing candidates when route-s ranges overlap.',
  metrics: {
    routeSOverlapM: { units: 'metres', description: 'Shared route-s span between left and right divider runs' },
    laneWidthM: { units: 'metres', description: 'Left d minus right d at sampled s (positive when left divider has higher d)' },
    widthStdM: { units: 'metres', description: 'Standard deviation of width samples along overlap' },
    meanConfidence: { units: 'dimensionless', description: 'Mean lane-line probability of supporting observations' },
    meanUncertaintyM: { units: 'metres', description: 'Mean lane-line std of supporting observations' },
  },
  gating: 'Reject when overlap too short, intervening divider present, non-positive width, width outlier, unstable width, boundary mismatch, low confidence, high uncertainty, or ambiguous observation geometry',
  tieBreaking: 'Deterministic ordering by dividerRunId when mean d values tie within lateralOrderToleranceM',
  adjacency: 'Only immediately adjacent runs in lateral ranking may form an interval; local route-s sampling verifies adjacency across the shared span',
  signedWidthConvention: 'widthM = leftRouteD - rightRouteD where left is the higher mean route-d boundary',
  widthTolerance: 'See WIDTH_TOLERANCE_DOCS in stage18_width_tolerance.js',
};

const COUNTING_SEMANTICS = {
  observedDividerRuns: 'Stage 17 supported runs with finite route-d geometry',
  evidenceSupportedLaneIntervals: 'Drivable lateral space between two adjacent compatible divider runs with overlapping route-s support',
  assessedSameDirectionLanes: 'Supported same-direction interval count derived only from adjacent accepted intervals in an assessed route-s span; not total physical road lanes',
  unknownOrUnsupportedNeighbouringSpace: 'Missing outer boundary or Stage 17 gap — not counted as zero lanes',
  totalPhysicalRoadLanes: 'Not inferred by Stage 18',
  oppositeDirectionLanes: 'Not assessed',
  shouldersAndNonDriving: 'Not classified without explicit divider evidence',
};

const BEV_REQUIRED_CATEGORIES = [
  'stable_one_lane_interval',
  'stable_two_lane_assessment',
  'highest_supported_lane_count',
  'curved_road_intervals',
  'narrow_width_outlier',
  'wide_width_outlier',
  'unstable_width_interval',
  'missing_outer_boundary',
  'explicit_stage17_gap',
  'ambiguous_divider_pairing',
  'apparent_count_transition',
  'lane_change_metadata_section',
  'repeated_pass_conflict_or_agreement',
  'pose_section_boundary',
  'stage16_stage17_coverage_outlier',
];

function buildLaneIntervalTemplate() {
  return {
    schemaVersion: INTERVAL_SCHEMA_VERSION,
    processingVersion: STAGE18_PROCESSING_VERSION,
    laneIntervalId: null,
    leftDividerRunId: null,
    rightDividerRunId: null,
    leftParentTrackId: null,
    rightParentTrackId: null,
    temporalPassId: null,
    poseSectionId: null,
    chunkId: null,
    routeSStart: null,
    routeSEnd: null,
    routeSpanM: null,
    leftRouteD: [],
    rightRouteD: [],
    widthSamples: [],
    widthStats: null,
    overlappingSupportLengthM: null,
    supportingObservationIds: [],
    supportingFrameCount: 0,
    confidenceSummary: null,
    uncertaintySummary: null,
    boundaryContinuityState: null,
    sourceSegmentIds: [],
    sourceChunkIds: [],
    assessmentStatus: null,
    assessmentReasons: [],
    provenance: { pipelineStage: 'stage18_lane_interval_construction', createdAt: null },
  };
}

function buildCountAssessmentTemplate() {
  return {
    schemaVersion: INTERVAL_SCHEMA_VERSION,
    processingVersion: STAGE18_PROCESSING_VERSION,
    countAssessmentId: null,
    temporalPassId: null,
    poseSectionId: null,
    chunkId: null,
    routeSStart: null,
    routeSEnd: null,
    routeSpanM: null,
    supportingLaneIntervalIds: [],
    supportingDividerRunIds: [],
    supportingTrackIds: [],
    orderedBoundaryRunIds: [],
    intervalWidthsM: [],
    laneCountCandidate: null,
    supportedSameDirectionIntervalCount: null,
    evidenceCompleteness: null,
    confidenceSummary: null,
    uncertaintySummary: null,
    sourceTimestampStart: null,
    sourceTimestampEnd: null,
    ambiguityFlags: [],
    unsupportedNeighbouringRegions: [],
    status: null,
    structuredReasons: [],
    provenance: { pipelineStage: 'stage18_lane_count_assessment', createdAt: null },
  };
}

function buildUnsupportedRegionTemplate() {
  return {
    schemaVersion: INTERVAL_SCHEMA_VERSION,
    routeSStart: null,
    routeSEnd: null,
    lengthM: null,
    affectedBoundaryOrIntervalId: null,
    sourceGapIds: [],
    reason: null,
    interpolationPermitted: false,
  };
}

module.exports = {
  INTERVAL_SCHEMA_VERSION,
  STAGE18_PROCESSING_VERSION,
  TRACKING_SCHEMA_VERSION,
  STAGE17_PROCESSING_VERSION,
  FROZEN_ROAD_SURFACE_VERSION,
  PROCESSING_VERSION,
  RUN_USAGE_OUTCOMES,
  PAIRING_OUTCOMES,
  INTERVAL_ASSESSMENT_STATUS,
  COUNT_ASSESSMENT_STATUS,
  COUNT_TRANSITION_LABELS,
  DEFAULT_INTERVAL_ASSESSMENT,
  WIDTH_ASSESSMENT_BANDS,
  PAIRING_MODEL_DOCS,
  COUNTING_SEMANTICS,
  BEV_REQUIRED_CATEGORIES,
  buildLaneIntervalTemplate,
  buildCountAssessmentTemplate,
  buildUnsupportedRegionTemplate,
};
