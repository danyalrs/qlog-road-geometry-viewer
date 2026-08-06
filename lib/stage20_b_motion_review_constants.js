'use strict';

const MANIFEST_SCHEMA_VERSION = 'stage20-b-motion-evidence-review-manifest-v1';
const REVIEWS_SCHEMA_VERSION = 'stage20-b-motion-manual-reviews-v1';
const REVIEW_SPEC_VERSION = 'stage20-b-motion-evidence-review-spec-v1';
const SPLIT_SEED = 'stage20-b-motion-calibration-validation-v1';
const SPLIT_CALIBRATION_MAX_FRACTION = 0.6;
const SPLIT_VALIDATION_MIN_FRACTION = 0.4;

const APPROVED_REVIEWER_LABELS = Object.freeze([
  'positive_continuation',
  'negative_non_continuation',
  'unresolved',
]);

const APPROVED_EVIDENCE_MODES = Object.freeze([
  'video',
  'qlog_playback',
  'combined',
  'insufficient',
]);

const OBSERVATION_ID_RE = /^\d+:\d+:\d+:\d+$/;

const MANIFEST_VALIDATION_CODES = Object.freeze({
  B_MR_001: 'B-MR-001',
  B_MR_002: 'B-MR-002',
  B_MR_003: 'B-MR-003',
  B_MR_004: 'B-MR-004',
  B_MR_005: 'B-MR-005',
  B_MR_006: 'B-MR-006',
  B_MR_007: 'B-MR-007',
  B_MR_008: 'B-MR-008',
  B_MR_009: 'B-MR-009',
  B_MR_010: 'B-MR-010',
  B_MR_011: 'B-MR-011',
  B_MR_012: 'B-MR-012',
  B_MR_013: 'B-MR-013',
  B_MR_014: 'B-MR-014',
  B_MR_015: 'B-MR-015',
  B_MR_016: 'B-MR-016',
});

const REVIEW_VALIDATION_CODES = Object.freeze({
  B_MR_R001: 'B-MR-R001',
  B_MR_R002: 'B-MR-R002',
  B_MR_R003: 'B-MR-R003',
  B_MR_R004: 'B-MR-R004',
  B_MR_R005: 'B-MR-R005',
  B_MR_R006: 'B-MR-R006',
  B_MR_R007: 'B-MR-R007',
  B_MR_R008: 'B-MR-R008',
  B_MR_R009: 'B-MR-R009',
  B_MR_R010: 'B-MR-R010',
});

const THRESHOLD_APPROVAL_GATES = Object.freeze({
  minReviewedPairs: 200,
  minPositive: 30,
  minNegative: 80,
  maxUnresolvedFraction: 0.2,
});

const MEASUREMENT_FINGERPRINT_FIELDS = Object.freeze([
  'observationIdA',
  'observationIdB',
  'segmentId',
  'spatialM',
  'deltaTimeS',
  'speedMps',
  'headingDiffDeg',
  'logMonoTimeA',
  'logMonoTimeB',
  'chunkIdA',
  'chunkIdB',
  'temporalPassIdA',
  'temporalPassIdB',
  'poseSectionIdA',
  'poseSectionIdB',
]);

module.exports = {
  MANIFEST_SCHEMA_VERSION,
  REVIEWS_SCHEMA_VERSION,
  REVIEW_SPEC_VERSION,
  SPLIT_SEED,
  SPLIT_CALIBRATION_MAX_FRACTION,
  SPLIT_VALIDATION_MIN_FRACTION,
  APPROVED_REVIEWER_LABELS,
  APPROVED_EVIDENCE_MODES,
  OBSERVATION_ID_RE,
  MANIFEST_VALIDATION_CODES,
  REVIEW_VALIDATION_CODES,
  THRESHOLD_APPROVAL_GATES,
  MEASUREMENT_FINGERPRINT_FIELDS,
};
