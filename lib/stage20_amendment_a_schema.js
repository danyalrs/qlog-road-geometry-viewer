/**
 * Stage 20 Amendment A — schema constants, error codes, templates.
 */
const { FROZEN_ROAD_SURFACE_VERSION } = require('./stage15_lane_counting_design');
const {
  SUPPORTED_RUNS_V1_SCHEMA_VERSION,
  SUPPORTED_RUNS_V1_PROCESSING_VERSION,
  CORRIDOR_LINKAGE_SCHEMA_VERSION,
} = require('./stage20_amendment_a_version');

const AMENDMENT_A_ERROR_CODES = {
  A_BND_002: 'A-BND-002',
  A_PTR_001: 'A-PTR-001',
  A_PTR_002: 'A-PTR-002',
  A_PTR_003: 'A-PTR-003',
  A_MEM_001: 'A-MEM-001',
  A_MEM_002: 'A-MEM-002',
  A_MEM_003: 'A-MEM-003',
  A_MEM_004: 'A-MEM-004',
  A_LEG_001: 'A-LEG-001',
  A_LEG_003: 'A-LEG-003',
  A_XPS_001: 'A-XPS-001',
  A_XPS_002: 'A-XPS-002',
  A_XPS_003: 'A-XPS-003',
  A_XPS_004: 'A-XPS-004',
  A_XPS_007: 'A-XPS-007',
  A_XPS_008: 'A-XPS-008',
  A_XPS_009: 'A-XPS-009',
  A_XPS_010: 'A-XPS-010',
  A_XPS_011: 'A-XPS-011',
  A_XPS_012: 'A-XPS-012',
  A_XPS_013: 'A-XPS-013',
  A_DUP_003: 'A-DUP-003',
  A_ART_001: 'A-ART-001',
  A_ART_002: 'A-ART-002',
  A_ART_003: 'A-ART-003',
  A_ART_004: 'A-ART-004',
  A_ART_005: 'A-ART-005',
  A_ART_006: 'A-ART-006',
  A_LNK_001: 'A-LNK-001',
  A_LNK_002: 'A-LNK-002',
  A_LNK_003: 'A-LNK-003',
  A_LNK_004: 'A-LNK-004',
  A_LNK_005: 'A-LNK-005',
  A_LNK_006: 'A-LNK-006',
  A_LNK_007: 'A-LNK-007',
};

const CROSS_PASS_STATES = {
  UNAVAILABLE: 'unavailable',
  COMPARISON_KEY_MATCH: 'comparison_key_match',
  LINKAGE_HYPOTHESIS: 'linkage_hypothesis',
  CORRIDOR_LINKED: 'corridor_linked',
  STRUCTURAL_CANDIDATE: 'structural_cross_pass_candidate',
  PROVISIONAL: 'provisional_cross_pass_candidate',
  GENUINE: 'genuine_cross_pass_evidence',
};

const MIN_STRUCTURAL_ROUTE_S_OVERLAP_M = 5.0;

function buildV1SupportedRunTemplate() {
  return {
    schemaVersion: SUPPORTED_RUNS_V1_SCHEMA_VERSION,
    dividerRunId: null,
    parentTrackId: null,
    segmentId: null,
    chunkId: null,
    temporalPassId: null,
    poseSectionId: null,
    trackIndex: null,
    dividerCorridorId: null,
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
    boundaryProvenance: null,
    provenance: { pipelineStage: 'stage17_supported_run_fusion', createdAt: null },
  };
}

function buildBoundaryProvenance(track, memberSegmentId, copiedAt) {
  return {
    source: 'parent_track',
    parentTrackId: track.trackId,
    trackChunkId: track.chunkId,
    trackTemporalPassId: track.temporalPassId,
    trackPoseSectionId: track.poseSectionId,
    trackIndex: resolveTrackIndex(track),
    dividerCorridorId: buildDividerCorridorId(track),
    trackSegmentIds: [...(track.segmentIds || [])],
    memberSegmentId,
    comparisonKeyScope: 'within_segment',
    copiedAt: copiedAt || null,
    propagationPoint: 'flushRun',
  };
}

function resolveTrackIndex(track) {
  if (Number.isInteger(track.trackIndex) && track.trackIndex >= 0) return track.trackIndex;
  const parts = String(track.trackId || '').split(':');
  const idx = parseInt(parts[parts.length - 1], 10);
  return Number.isFinite(idx) ? idx : null;
}

function buildDividerCorridorId(track) {
  const trackIndex = resolveTrackIndex(track);
  if (!Number.isInteger(track.chunkId) || !Number.isInteger(track.poseSectionId) || !Number.isInteger(trackIndex)) {
    return null;
  }
  return `${track.chunkId}:${track.poseSectionId}:${trackIndex}`;
}

function buildPoseSectionRef(segmentId, chunkId, temporalPassId, poseSectionId) {
  return `${segmentId}:${chunkId}:${temporalPassId}:${poseSectionId}`;
}

module.exports = {
  SUPPORTED_RUNS_V1_SCHEMA_VERSION,
  SUPPORTED_RUNS_V1_PROCESSING_VERSION,
  CORRIDOR_LINKAGE_SCHEMA_VERSION,
  FROZEN_ROAD_SURFACE_VERSION,
  AMENDMENT_A_ERROR_CODES,
  CROSS_PASS_STATES,
  MIN_STRUCTURAL_ROUTE_S_OVERLAP_M,
  buildV1SupportedRunTemplate,
  buildBoundaryProvenance,
  buildDividerCorridorId,
  buildPoseSectionRef,
  resolveTrackIndex,
};
