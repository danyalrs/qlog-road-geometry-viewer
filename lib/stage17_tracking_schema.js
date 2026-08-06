/**
 * Stage 17 — lane-divider track and supported-run schema (separate from v11 / Stage 16).
 */
const { FROZEN_ROAD_SURFACE_VERSION } = require('./stage15_lane_counting_design');
const { PROCESSING_VERSION } = require('./version');
const { PROJECTION_SCHEMA_VERSION, STAGE16_PROCESSING_VERSION } = require('./stage16_projection_schema');

const TRACKING_SCHEMA_VERSION = '2026-07-24-lane-divider-tracking-v0';
const STAGE17_PROCESSING_VERSION = '2026-07-24-lane-divider-tracking-v0';

const ASSOCIATION_OUTCOMES = {
  ASSOCIATED: 'associated',
  NEW_TRACK: 'new_track',
  REJECTED_NO_CANDIDATE: 'rejected_no_candidate',
  REJECTED_AMBIGUOUS: 'rejected_ambiguous',
  REJECTED_GEOMETRY_MISMATCH: 'rejected_geometry_mismatch',
  REJECTED_TEMPORAL_GAP: 'rejected_temporal_gap',
  REJECTED_BOUNDARY: 'rejected_boundary',
  REJECTED_CROSSING: 'rejected_crossing',
  REJECTED_OTHER: 'rejected_other',
};

const GAP_REASONS = {
  MISSING_MODEL_EVIDENCE: 'missing_model_evidence',
  REJECTED_STAGE16: 'rejected_stage16_observation',
  MISSING_POSE: 'missing_pose',
  PASS_OR_SECTION_BOUNDARY: 'pass_or_section_boundary',
  TEMPORAL_GAP: 'temporal_gap',
  GEOMETRIC_MISMATCH: 'geometric_mismatch',
  AMBIGUOUS_ASSOCIATION: 'ambiguous_association',
  DATASET_BOUNDARY: 'dataset_boundary',
  UNSUPPORTED_SEGMENT_BOUNDARY: 'unsupported_segment_boundary',
  DISCONNECTED_SUPPORT: 'disconnected_support',
};

/** Prototype assessment settings — not validated production thresholds. */
const DEFAULT_ASSOCIATION_ASSESSMENT = {
  maxAssociationCost: 12,
  ambiguousCostRatio: 1.15,
  maxTimeGapSec: 4.0,
  maxRouteSGapM: 35,
  minRouteSOverlapM: 2,
  maxLateralJumpM: 1.8,
  maxHeadingDiffDeg: 25,
  maxUncertaintyM: 1.5,
  minConfidence: 0.5,
  maxTrackGapFrames: 3,
  maxMissedFrames: 2,
  lateralCostWeight: 2.0,
  shapeCostWeight: 1.5,
  timeCostWeight: 0.15,
  headingCostWeight: 0.08,
  uncertaintyCostWeight: 0.5,
  roleMismatchPenalty: 0.3,
  crossingLateralOrderThreshold: 2,
  sampleSStepM: 5,
  maxChunkBoundaryLateralJumpM: 1.0,
  minChunkBoundaryOverlapM: 5,
  maxChunkBoundaryShapeRmseM: 1.5,
  maxShapeRmseM: 2.5,
};

const DEFAULT_FUSION_ASSESSMENT = {
  maxSupportedGapM: 15,
  runSplitTimeGapSec: 3.5,
  minRunSupportDensity: 0.02,
  minRunObservationCount: 1,
  minRunSpanM: 2,
  dMergeToleranceM: 0.8,
  interpolationPermitted: false,
};

/** Birth reasons for new_track outcomes — not hidden association failures. */
const TRACK_BIRTH_REASONS = {
  FIRST_OBSERVATION_IN_GROUP: 'first_observation_in_group',
  NO_ACTIVE_TRACK_AT_FRAME: 'no_active_track_at_frame',
  HUNGARIAN_UNMATCHED_COMPETITION: 'hungarian_unmatched_competition',
  LATERAL_GATE_FAILED: 'lateral_gate_failed',
  HEADING_GATE_FAILED: 'heading_gate_failed',
  TEMPORAL_GATE_FAILED: 'temporal_gate_failed',
  INSUFFICIENT_ROUTE_S_OVERLAP: 'insufficient_route_s_overlap',
  ALL_CANDIDATES_EXCEEDED_TOTAL_COST: 'all_candidates_exceeded_total_cost',
  ALL_CANDIDATES_GATE_FAILED_NEW_HYPOTHESIS: 'all_candidates_gate_failed_new_hypothesis',
  PREVIOUS_TRACK_TERMINATED_RESTART: 'previous_track_terminated_restart',
  CHUNK_BOUNDARY_RESTART: 'chunk_boundary_restart',
  BOUNDARY_RESTART: 'boundary_restart',
};

const OUTCOME_SEMANTICS = {
  associated: 'Hungarian-assigned continuation of an existing track with valid cost below threshold',
  new_track: 'New divider-track hypothesis created; birthReason records why (not a hidden association failure)',
  rejected_ambiguous: 'Two or more active tracks have valid local costs within ambiguousCostRatio for this observation',
  rejected_no_candidate: 'No active tracks at assignment time and observation failed eligibility for new hypothesis',
  rejected_geometry_mismatch: 'All active track candidates failed lateral, route-s, or shape gates',
  rejected_temporal_gap: 'All active track candidates failed temporal gap gate',
  rejected_boundary: 'Pass, section, or unsupported chunk boundary gate failed for all candidates',
  rejected_crossing: 'Reserved for explicit crossing rejection policy (not used in current prototype)',
  rejected_other: 'Cost above threshold, confidence, uncertainty, or other gate failure on all candidates',
  newTrackVsRejection: 'Unmatched after Hungarian: if every candidate fails the same gate family → rejection; if mixed or competition → new_track with birthReason',
};

const AMBIGUITY_SEMANTICS = {
  definition: 'second_lowest_local_observation_to_track_cost',
  description: 'Among all active tracks in the frame, the second-lowest valid per-observation cost divided by the lowest valid cost. This is NOT an alternative global Hungarian assignment.',
  notGlobal: 'A locally ambiguous cost ratio does not imply multiple global optima; global assignment is always Hungarian minimum total cost',
  tieBreaking: 'Hungarian algorithm with deterministic active-track ordering by trackId',
};

const ASSOCIATION_MODEL_DOCS = {
  candidateGeneration: 'Within each (chunkId, temporalPassId, poseSectionId) group, observations sorted by logMonoTime then segmentId then sourceSlotIndex; active tracks matched via Hungarian assignment per time step. Cross-chunk association is intentionally forbidden — chunkId is part of the grouping key.',
  costTerms: {
    lateralRouteD: { units: 'metres', weight: 'lateralCostWeight', description: 'Mean |Δd| on overlapping route-s samples' },
    shapeMismatch: { units: 'metres', weight: 'shapeCostWeight', description: 'RMSE of d profile on overlapping s' },
    timeGap: { units: 'seconds', weight: 'timeCostWeight', description: 'Elapsed time since last track observation' },
    headingDiff: { units: 'degrees', weight: 'headingCostWeight', description: 'Pose heading delta' },
    uncertainty: { units: 'metres', weight: 'uncertaintyCostWeight', description: 'laneLineStd sum penalty' },
    roleMismatch: { units: 'dimensionless', weight: 'roleMismatchPenalty', description: 'Weak penalty when inferredSlotRole differs' },
  },
  normalization: 'Each term scaled by assessment weight; invalid gates return Infinity cost',
  gating: 'Reject when time gap, lateral jump, heading, confidence, uncertainty, or s-overlap gates fail before cost evaluation',
  tieBreaking: 'Hungarian minimum total cost; ambiguous when second-best cost within ambiguousCostRatio of best valid cost',
  trackBirth: 'Unmatched observation after assignment becomes new_track unless rejected by gates',
  trackContinuation: 'Hungarian match with cost below maxAssociationCost',
  trackTermination: 'Track removed from active set after maxMissedFrames without match',
  maxSupportedObservationGap: 'maxTrackGapFrames frames or maxTimeGapSec between consecutive associations',
};

const BEV_REQUIRED_CATEGORIES = [
  'stable_straight_divider',
  'curved_divider',
  'sparse_support',
  'explicit_observation_gap',
  'ambiguous_association',
  'crossing_lateral_order',
  'lane_change_metadata',
  'chunk_boundary_continuation',
  'boundary_separation',
  'pose_section_boundary',
  'stage16_coverage_outlier',
];

function buildDividerTrackTemplate() {
  return {
    schemaVersion: TRACKING_SCHEMA_VERSION,
    processingVersion: STAGE17_PROCESSING_VERSION,
    frozenBaselineVersion: FROZEN_ROAD_SURFACE_VERSION,
    frozenV11ProcessingVersion: PROCESSING_VERSION,
    stage16InputVersion: PROJECTION_SCHEMA_VERSION,
    stage16ProcessingVersion: STAGE16_PROCESSING_VERSION,
    dividerTrackId: null,
    chunkId: null,
    temporalPassId: null,
    poseSectionId: null,
    segmentIdRange: null,
    observationIds: [],
    sourceFrameCount: 0,
    observationCount: 0,
    routeSStart: null,
    routeSEnd: null,
    routeSpanM: null,
    lateralRouteDSamples: [],
    slotRoleHistory: [],
    confidenceSummary: null,
    uncertaintySummary: null,
    associationDecisions: [],
    supportedRunIds: [],
    gapIds: [],
    provenance: { pipelineStage: 'stage17_lane_divider_tracking', createdAt: null },
  };
}

function buildSupportedRunTemplate() {
  return {
    schemaVersion: TRACKING_SCHEMA_VERSION,
    dividerRunId: null,
    parentTrackId: null,
    routeSStart: null,
    routeSEnd: null,
    routeSpanM: null,
    representativeRouteD: [],
    observationIds: [],
    observationCount: 0,
    sourceFrameCount: 0,
    supportDensity: null,
    confidenceSummary: null,
    uncertaintySummary: null,
    precedingGapId: null,
    followingGapId: null,
    interpolationMetadata: { permitted: false, method: null },
    provenance: { pipelineStage: 'stage17_supported_run_fusion', createdAt: null },
  };
}

function buildGapTemplate() {
  return {
    schemaVersion: TRACKING_SCHEMA_VERSION,
    gapId: null,
    parentTrackId: null,
    routeSStart: null,
    routeSEnd: null,
    gapLengthM: null,
    timeSpanNs: null,
    lastSupportingObservationId: null,
    nextSupportingObservationId: null,
    reason: null,
    interpolationPermitted: false,
    provenance: { pipelineStage: 'stage17_gap_policy', createdAt: null },
  };
}

module.exports = {
  TRACKING_SCHEMA_VERSION,
  STAGE17_PROCESSING_VERSION,
  ASSOCIATION_OUTCOMES,
  GAP_REASONS,
  DEFAULT_ASSOCIATION_ASSESSMENT,
  DEFAULT_FUSION_ASSESSMENT,
  TRACK_BIRTH_REASONS,
  OUTCOME_SEMANTICS,
  AMBIGUITY_SEMANTICS,
  ASSOCIATION_MODEL_DOCS,
  BEV_REQUIRED_CATEGORIES,
  buildDividerTrackTemplate,
  buildSupportedRunTemplate,
  buildGapTemplate,
};
