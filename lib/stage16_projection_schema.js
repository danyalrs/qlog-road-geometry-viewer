/**
 * Stage 16 — projected lane-line observation schema (separate from v11 / lane-count).
 */
const { FROZEN_ROAD_SURFACE_VERSION } = require('./stage15_lane_counting_design');
const { PROCESSING_VERSION } = require('./version');

const PROJECTION_SCHEMA_VERSION = '2026-07-24-lane-projection-v0';
const STAGE16_PROCESSING_VERSION = '2026-07-24-lane-projection-v0';

const PROJECTION_STATUSES = {
  PROJECTED: 'projected',
  REJECTED_INVALID_GEOMETRY: 'rejected_invalid_geometry',
  REJECTED_LOW_ASSESSMENT_CONFIDENCE: 'rejected_low_assessment_confidence',
  REJECTED_EXCESSIVE_ASSESSMENT_UNCERTAINTY: 'rejected_excessive_assessment_uncertainty',
  REJECTED_MISSING_POSE: 'rejected_missing_pose',
  REJECTED_POSE_GAP: 'rejected_pose_gap',
  REJECTED_PASS_BOUNDARY: 'rejected_pass_boundary',
  REJECTED_POSE_SECTION_BOUNDARY: 'rejected_pose_section_boundary',
  REJECTED_NONFINITE_OUTPUT: 'rejected_nonfinite_output',
  REJECTED_FRAGMENT_POLICY: 'rejected_fragment_policy',
  REJECTED_OTHER: 'rejected_other',
};

/** Exhaustive point-level outcomes for reconciliation. */
const POINT_OUTCOMES = {
  RAW_NONFINITE: 'raw_nonfinite',
  REJECTED_X_WINDOW: 'rejected_x_window',
  IN_OBSERVATION_REJECTED: 'in_observation_rejected',
  REJECTED_PERP_DIST: 'rejected_perp_dist',
  REJECTED_POSE_UNAVAILABLE: 'rejected_pose_unavailable',
  REJECTED_FORWARD_WINDOW: 'rejected_forward_window',
  REJECTED_NONFINITE_OUTPUT: 'rejected_nonfinite_output',
  REJECTED_FRAGMENT_DISCARDED: 'rejected_fragment_discarded',
  PROJECTED: 'projected',
};

/** Prototype fragment assessment — not production thresholds. */
const DEFAULT_FRAGMENT_ASSESSMENT = {
  minProjectedPoints: 2,
  minRetainedPointFraction: 0.05,
  minProjectedRouteSpanM: 2.0,
  maxInternalSourceIndexGap: 1,
  requireMonotonicRouteS: true,
  maxProjectionDistM: 25,
  maxForwardM: 120,
  minForwardM: -5,
  backwardToleranceM: 5,
  temporalWindowSegments: 4,
  maxProjectionTimeDeltaNs: 4e9,
};

const PERPENDICULAR_DISTANCE_SEMANTICS = {
  definition: 'Perpendicular distance from the projected global (east, north) point to the nearest trajectory line segment within the temporal search window',
  units: 'metres',
  assessmentLimitM: DEFAULT_FRAGMENT_ASSESSMENT.maxProjectionDistM,
  trajectoryScope: 'Section-scoped vehicle path for matching (temporalPassId, poseSectionId)',
  temporalSearchWindow: '±temporalWindowSegments (default 4) around nearest path index to observation time',
  tieResolution: 'Minimum perpendicular distance among valid candidates within temporal window; ambiguous if two candidates within 1 m perp dist and >10 m s separation',
  pointLevelFilterRationale: 'Long lane-line polylines extend beyond reliable trajectory association; distant points often exceed perp limit while near-field points remain valid. Point-level filtering retains valid near-field geometry instead of rejecting the entire observation.',
  curvedRoadBehaviour: 'On curves, perp distance is measured to the local chord segment in the temporal window, not the global arc; points remain valid when within limit relative to nearby path segment',
  poseSectionEndBehaviour: 'Near section ends the temporal window may shrink; points projecting outside the window are rejected as pose_unavailable, not silently interpolated across boundaries',
};

const BEV_REQUIRED_CATEGORIES = [
  'straight_road',
  'curved_road',
  'low_confidence',
  'single_valid_side',
  'both_invalid',
  'pose_section_boundary',
  'sparse_segment',
  'stage15_outlier',
  'apparent_lane_change_geometry',
];

const TRANSFORM_CONVENTIONS = {
  deviceFrame: { x: 'forward (m)', y: 'left (m)', z: 'up (m)' },
  globalFrame: { east: 'metres east of first GPS fix', north: 'metres north of first GPS fix' },
  heading: 'clockwise from north (degrees)',
  routeS: 'cumulative arc length along section-scoped vehicle path from s=0 at first path point',
  routeD: 'signed lateral offset from nearest trajectory segment; positive = left of travel direction',
  poseOrigin: 'first valid GPS fix in segment (equirectangular local projection)',
  poseInterpolation: 'interpolateGpsAtTime — linear east/north/speed, circular heading; maxModelGpsDeltaNs default 2s',
  rotation: 'modelToGlobal: east = vehicleEast + x*sin(θ) - y*cos(θ); north = vehicleNorth + x*cos(θ) + y*sin(θ)',
  projectionMethod: 'projectPointTemporal — temporal window around nearest path index',
  boundaryPolicy: 'trajectory scoped to single temporal pass and pose section; no cross-boundary projection',
  perpendicularDistance: PERPENDICULAR_DISTANCE_SEMANTICS,
  fragmentPolicy: 'Projected points must form contiguous source-index runs; disconnected runs split into fragments; primary fragment selected by longest route-s span',
};

function buildProjectedObservationTemplate() {
  return {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    processingVersion: STAGE16_PROCESSING_VERSION,
    frozenBaselineVersion: FROZEN_ROAD_SURFACE_VERSION,
    frozenV11ProcessingVersion: PROCESSING_VERSION,
    segmentId: null,
    chunkId: null,
    sourceFile: null,
    sourceEventIndex: null,
    sourceFrameId: null,
    logMonoTime: null,
    temporalPassId: null,
    poseSectionId: null,
    sourceSlotIndex: null,
    inferredSlotRole: null,
    laneLineProb: null,
    laneLineStd: null,
    assessmentValidity: {
      eligibleGeometry: false,
      passesAssessmentConfidence: false,
      passesAssessmentUncertainty: false,
      assessmentThresholdsLabel: 'Stage15A assessment-only (not production)',
    },
    projectionStatus: null,
    rejectionReasons: [],
    pointAudit: null,
    projectionFragments: [],
    deviceFramePoints: [],
    projectedRoutePoints: [],
    poseRecord: null,
    transformMetadata: { ...TRANSFORM_CONVENTIONS },
    provenance: {
      pipelineStage: 'stage16_lane_line_projection',
      createdAt: null,
      notes: null,
    },
  };
}

module.exports = {
  PROJECTION_SCHEMA_VERSION,
  STAGE16_PROCESSING_VERSION,
  PROJECTION_STATUSES,
  POINT_OUTCOMES,
  DEFAULT_FRAGMENT_ASSESSMENT,
  PERPENDICULAR_DISTANCE_SEMANTICS,
  BEV_REQUIRED_CATEGORIES,
  TRANSFORM_CONVENTIONS,
  buildProjectedObservationTemplate,
};
