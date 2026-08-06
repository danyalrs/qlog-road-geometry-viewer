/**
 * Stage 20 Amendment A — supported-run and artifact validation.
 */
const {
  AMENDMENT_A_ERROR_CODES: E,
  SUPPORTED_RUNS_V1_SCHEMA_VERSION,
  buildDividerCorridorId,
  resolveTrackIndex,
} = require('./stage20_amendment_a_schema');
const { SUPPORTED_RUNS_V1_PROCESSING_VERSION } = require('./stage20_amendment_a_version');
const { contentHashSha256, sortRuns, sortGaps } = require('./stage20_amendment_a_serialization');

function validationError(code, message, details = {}) {
  return { code, message, details };
}

function isV1Run(run) {
  return run?.schemaVersion === SUPPORTED_RUNS_V1_SCHEMA_VERSION;
}

function validateMemberSegmentUniformity(observationIds, obMap) {
  const segmentIds = [];
  for (const id of observationIds) {
    const ob = obMap.get(id);
    if (!ob) return validationError(E.A_MEM_001, 'member observation missing', { observationId: id });
    if (!Number.isInteger(ob.segmentId)) return validationError(E.A_MEM_002, 'member observation missing segmentId', { observationId: id });
    segmentIds.push(ob.segmentId);
  }
  const unique = [...new Set(segmentIds)];
  if (unique.length > 1) return validationError(E.A_MEM_004, 'member segmentId conflict', { segmentIds: unique });
  return { segmentId: unique[0] };
}

function validateMemberBoundaryConsistency(observationIds, track, obMap) {
  for (const id of observationIds) {
    const ob = obMap.get(id);
    if (!ob) continue;
    if (ob.chunkId !== track.chunkId) {
      return validationError(E.A_MEM_003, 'member chunkId differs from parent track', { observationId: id });
    }
    if (ob.temporalPassId !== track.temporalPassId) {
      return validationError(E.A_MEM_003, 'member temporalPassId differs from parent track', { observationId: id });
    }
    if (ob.poseSectionId !== track.poseSectionId) {
      return validationError(E.A_MEM_003, 'member poseSectionId differs from parent track', { observationId: id });
    }
  }
  return null;
}

function validateRunForEmission(run, track, obMap) {
  if (!track) return validationError(E.A_PTR_002, 'parent track not found', { parentTrackId: run.parentTrackId });

  const memberSeg = validateMemberSegmentUniformity(run.observationIds || [], obMap);
  if (memberSeg.code) return memberSeg;

  const memberBoundary = validateMemberBoundaryConsistency(run.observationIds || [], track, obMap);
  if (memberBoundary) return memberBoundary;

  if (run.temporalPassId !== track.temporalPassId) {
    return validationError(E.A_PTR_001, 'run temporalPassId differs from parent track');
  }
  if (run.parentTrackId !== track.trackId) {
    return validationError(E.A_PTR_001, 'run parentTrackId differs from parent track');
  }
  if (!track.segmentIds?.includes(memberSeg.segmentId)) {
    return validationError(E.A_PTR_003, 'run segmentId not in parent track segmentIds', { segmentId: memberSeg.segmentId });
  }

  const trackIndex = resolveTrackIndex(track);
  if (!Number.isInteger(trackIndex) || trackIndex < 0) {
    return validationError(E.A_BND_002, 'missing trackIndex on parent track');
  }
  const corridorId = buildDividerCorridorId(track);
  if (!corridorId) return validationError(E.A_BND_002, 'missing dividerCorridorId components');

  const required = ['segmentId', 'chunkId', 'temporalPassId', 'poseSectionId', 'trackIndex', 'dividerCorridorId'];
  for (const field of required) {
    if (run[field] == null) return validationError(E.A_BND_002, `missing required field ${field}`);
  }

  if (run.chunkId !== track.chunkId || run.poseSectionId !== track.poseSectionId || run.trackIndex !== trackIndex) {
    return validationError(E.A_PTR_001, 'propagated boundary fields do not match parent track');
  }
  if (run.dividerCorridorId !== corridorId) {
    return validationError(E.A_BND_002, 'dividerCorridorId does not match authoritative derivation');
  }
  if (!run.boundaryProvenance || run.boundaryProvenance.comparisonKeyScope !== 'within_segment') {
    return validationError(E.A_BND_002, 'missing or invalid boundaryProvenance');
  }

  return null;
}

function validateV1RunRecord(run, trackById, obMap) {
  const track = trackById.get(run.parentTrackId);
  return validateRunForEmission(run, track, obMap);
}

function validateArtifactEnvelope(artifact) {
  const errors = [];
  if (artifact.schemaVersion !== SUPPORTED_RUNS_V1_SCHEMA_VERSION) {
    errors.push(validationError(E.A_ART_001, 'schemaVersion mismatch'));
  }
  if (artifact.processingVersion && artifact.processingVersion !== SUPPORTED_RUNS_V1_PROCESSING_VERSION) {
    errors.push(validationError(E.A_ART_005, 'processingVersion mismatch'));
  }
  if (artifact.supportedRunCount !== (artifact.supportedRuns || []).length) {
    errors.push(validationError(E.A_ART_002, 'supportedRunCount mismatch'));
  }
  if (artifact.gapCount !== (artifact.gaps || []).length) {
    errors.push(validationError(E.A_ART_002, 'gapCount mismatch'));
  }

  const runIds = new Set();
  for (const run of artifact.supportedRuns || []) {
    if (runIds.has(run.dividerRunId)) errors.push(validationError(E.A_ART_003, 'duplicate dividerRunId', { dividerRunId: run.dividerRunId }));
    runIds.add(run.dividerRunId);
  }

  const sortedRuns = sortRuns(artifact.supportedRuns || []);
  for (let i = 0; i < sortedRuns.length; i++) {
    if (sortedRuns[i].dividerRunId !== (artifact.supportedRuns || [])[i]?.dividerRunId) {
      errors.push(validationError(E.A_ART_006, 'supportedRuns not sorted'));
      break;
    }
  }

  const sortedGaps = sortGaps(artifact.gaps || []);
  for (let i = 0; i < sortedGaps.length; i++) {
    if (sortedGaps[i].gapId !== (artifact.gaps || [])[i]?.gapId) {
      errors.push(validationError(E.A_ART_006, 'gaps not sorted'));
      break;
    }
  }

  const expectedHash = contentHashSha256({ supportedRuns: artifact.supportedRuns || [], gaps: artifact.gaps || [] });
  if (artifact.contentHashSha256 && artifact.contentHashSha256 !== expectedHash) {
    errors.push(validationError(E.A_ART_004, 'contentHashSha256 mismatch'));
  }

  return errors;
}

function detectParentTrackIdConflicts(runs) {
  const byParent = new Map();
  const conflicts = [];
  for (const run of runs) {
    if (!byParent.has(run.parentTrackId)) byParent.set(run.parentTrackId, run.temporalPassId);
    else if (byParent.get(run.parentTrackId) !== run.temporalPassId) {
      conflicts.push(validationError(E.A_PTR_001, 'same parentTrackId with different temporalPassId', { parentTrackId: run.parentTrackId }));
    }
  }
  return conflicts;
}

function isLegacyV0Artifact(artifact) {
  return artifact?.schemaVersion === '2026-07-24-lane-divider-tracking-v0'
    || !artifact?.supportedRuns?.[0]?.dividerCorridorId;
}

function legacyV0Unavailable() {
  return { available: false, code: E.A_LEG_001, state: 'unavailable' };
}

module.exports = {
  validationError,
  isV1Run,
  validateMemberSegmentUniformity,
  validateMemberBoundaryConsistency,
  validateRunForEmission,
  validateV1RunRecord,
  validateArtifactEnvelope,
  detectParentTrackIdConflicts,
  isLegacyV0Artifact,
  legacyV0Unavailable,
};
