/**
 * Stage 20 Amendment A — corridor linkage record validation (schema + fixtures only).
 */
const {
  AMENDMENT_A_ERROR_CODES: E,
  CORRIDOR_LINKAGE_SCHEMA_VERSION,
  buildPoseSectionRef,
} = require('./stage20_amendment_a_schema');
const { validationError } = require('./stage20_amendment_a_validation');

function validateEndpoint(endpoint, runById) {
  const required = [
    'parentTrackId', 'dividerRunId', 'segmentId', 'chunkId', 'temporalPassId',
    'poseSectionId', 'trackIndex', 'dividerCorridorId', 'poseSectionRef',
  ];
  for (const field of required) {
    if (endpoint[field] == null) return validationError(E.A_LNK_004, `endpoint missing ${field}`);
  }

  const run = runById.get(endpoint.dividerRunId);
  if (!run) return validationError(E.A_LNK_003, 'endpoint dividerRunId not in supported runs', { dividerRunId: endpoint.dividerRunId });

  const expectedRef = buildPoseSectionRef(endpoint.segmentId, endpoint.chunkId, endpoint.temporalPassId, endpoint.poseSectionId);
  if (endpoint.poseSectionRef !== expectedRef) {
    return validationError(E.A_LNK_004, 'poseSectionRef mismatch', { expected: expectedRef, actual: endpoint.poseSectionRef });
  }

  const fields = ['parentTrackId', 'segmentId', 'chunkId', 'temporalPassId', 'poseSectionId', 'trackIndex', 'dividerCorridorId'];
  for (const field of fields) {
    if (run[field] !== endpoint[field]) {
      return validationError(E.A_LNK_004, `endpoint ${field} does not match supported run`, { field });
    }
  }

  return null;
}

function validateLinkageRecord(record, runById) {
  if (!record.provenance || !record.evidenceSource) {
    return validationError(E.A_LNK_005, 'missing linkage provenance or evidenceSource');
  }
  if (!Array.isArray(record.endpoints) || record.endpoints.length !== 2) {
    return validationError(E.A_LNK_004, 'linkage record requires exactly two endpoints');
  }

  for (const ep of record.endpoints) {
    const err = validateEndpoint(ep, runById);
    if (err) return err;
  }

  const [a, b] = record.endpoints;
  if (a.parentTrackId === b.parentTrackId) {
    return validationError(E.A_LNK_004, 'endpoints must have different parentTrackId');
  }
  if (a.temporalPassId === b.temporalPassId) {
    return validationError(E.A_LNK_004, 'endpoints must have different temporalPassId');
  }

  if (record.linkageType === 'same_segment') {
    if (!Number.isInteger(record.segmentId)) return validationError(E.A_LNK_004, 'same_segment linkage requires segmentId');
    if (a.segmentId !== record.segmentId || b.segmentId !== record.segmentId) {
      return validationError(E.A_LNK_004, 'endpoint segmentId must match linkage segmentId');
    }
  }

  if (record.linkageType === 'cross_segment') {
    if (a.segmentId === b.segmentId) return validationError(E.A_LNK_004, 'cross_segment linkage requires different segmentIds');
    if (record.validationState === 'validated' && !record.crossSegmentAlignment) {
      return validationError(E.A_LNK_006, 'cross_segment validated linkage requires alignment record');
    }
    if (record.crossSegmentAlignment?.validationState === 'validated'
      && record.evidenceInputs?.geometryOnlyValidation === true) {
      return validationError(E.A_LNK_007, 'geometry-only validation claim forbidden');
    }
  }

  if (record.evidenceInputs?.geometryOnlyValidation === true && record.validationState === 'validated') {
    return validationError(E.A_LNK_007, 'geometry-only validation claim forbidden');
  }

  return null;
}

function validateLinkageArtifact(artifact, runById) {
  const errors = [];
  if (artifact.schemaVersion !== CORRIDOR_LINKAGE_SCHEMA_VERSION) {
    errors.push(validationError(E.A_ART_001, 'linkage schemaVersion mismatch'));
  }

  const ids = new Set();
  const endpointPairs = new Map();
  for (const record of artifact.linkageRecords || []) {
    if (ids.has(record.corridorLinkageId)) errors.push(validationError(E.A_LNK_001, 'duplicate corridorLinkageId'));
    ids.add(record.corridorLinkageId);

    const err = validateLinkageRecord(record, runById);
    if (err) errors.push(err);

    const pairKey = [record.endpoints[0].parentTrackId, record.endpoints[1].parentTrackId].sort().join('|');
    const existing = endpointPairs.get(pairKey);
    if (existing && existing.roadCorridorId !== record.roadCorridorId) {
      errors.push(validationError(E.A_LNK_002, 'conflicting roadCorridorId for endpoint pair', { pairKey }));
    }
    endpointPairs.set(pairKey, record);
  }

  return errors;
}

function buildCorridorLinkageId(roadCorridorId, parentA, parentB) {
  const sorted = [parentA, parentB].sort();
  return `link:${roadCorridorId}:${sorted[0]}:${sorted[1]}`;
}

function buildValidatedSameSegmentLinkage(runA, runB, options = {}) {
  const roadCorridorId = options.roadCorridorId || `corridor:${runA.segmentId}:${runA.dividerCorridorId}`;
  const endpoints = [runA, runB].map((run) => ({
    parentTrackId: run.parentTrackId,
    dividerRunId: run.dividerRunId,
    segmentId: run.segmentId,
    chunkId: run.chunkId,
    temporalPassId: run.temporalPassId,
    poseSectionId: run.poseSectionId,
    trackIndex: run.trackIndex,
    dividerCorridorId: run.dividerCorridorId,
    poseSectionRef: buildPoseSectionRef(run.segmentId, run.chunkId, run.temporalPassId, run.poseSectionId),
  }));

  return {
    corridorLinkageId: buildCorridorLinkageId(roadCorridorId, runA.parentTrackId, runB.parentTrackId),
    roadCorridorId,
    linkageType: 'same_segment',
    segmentId: runA.segmentId,
    endpoints,
    evidenceSource: options.evidenceSource || 'stage20_corridor_linkage_validator_fixture',
    evidenceInputs: {
      routeSOverlapM: options.routeSOverlapM ?? null,
      passDetectionRefs: options.passDetectionRefs || [],
      geometryOnlyValidation: false,
    },
    provenance: {
      createdAt: options.createdAt || '2026-07-28T00:00:00.000Z',
      validatorVersion: options.validatorVersion || 'fixture-v1',
      inputChecksums: options.inputChecksums || [],
    },
    confidence: options.confidence ?? 1.0,
    validationState: 'validated',
    validationReason: null,
  };
}

function buildValidatedCrossSegmentLinkage(runA, runB, options = {}) {
  const roadCorridorId = options.roadCorridorId || `corridor:cross:${runA.dividerCorridorId}`;
  const endpoints = [runA, runB].map((run) => ({
    parentTrackId: run.parentTrackId,
    dividerRunId: run.dividerRunId,
    segmentId: run.segmentId,
    chunkId: run.chunkId,
    temporalPassId: run.temporalPassId,
    poseSectionId: run.poseSectionId,
    trackIndex: run.trackIndex,
    dividerCorridorId: run.dividerCorridorId,
    poseSectionRef: buildPoseSectionRef(run.segmentId, run.chunkId, run.temporalPassId, run.poseSectionId),
  }));

  const segmentIds = [runA.segmentId, runB.segmentId].sort((a, b) => a - b);
  const alignmentId = options.alignmentId || `align:${segmentIds.join(':')}:${roadCorridorId}`;

  return {
    corridorLinkageId: buildCorridorLinkageId(roadCorridorId, runA.parentTrackId, runB.parentTrackId),
    roadCorridorId,
    linkageType: 'cross_segment',
    endpoints,
    crossSegmentAlignment: {
      alignmentId,
      segmentIds,
      routeSCorridorMapping: options.routeSCorridorMapping || { method: 'fixture_linear', scale: 1.0 },
      validationState: 'validated',
      provenance: {
        createdAt: options.createdAt || '2026-07-28T00:00:00.000Z',
        validatorVersion: options.validatorVersion || 'fixture-v1',
      },
    },
    evidenceSource: options.evidenceSource || 'stage20_corridor_linkage_validator_fixture',
    evidenceInputs: {
      routeSOverlapM: options.routeSOverlapM ?? null,
      geometryOnlyValidation: false,
    },
    provenance: {
      createdAt: options.createdAt || '2026-07-28T00:00:00.000Z',
      validatorVersion: options.validatorVersion || 'fixture-v1',
      inputChecksums: options.inputChecksums || [],
    },
    confidence: options.confidence ?? 1.0,
    validationState: 'validated',
    validationReason: null,
  };
}

function sortLinkageRecordsDeterministic(records) {
  return [...records].sort((a, b) => a.corridorLinkageId.localeCompare(b.corridorLinkageId));
}

function detectDuplicateFeaturePair(pairKeys) {
  const seen = new Set();
  const duplicates = [];
  for (const key of pairKeys) {
    if (seen.has(key)) duplicates.push({ pairKey: key, code: E.A_DUP_003 });
    seen.add(key);
  }
  return duplicates;
}

module.exports = {
  validateEndpoint,
  validateLinkageRecord,
  validateLinkageArtifact,
  buildCorridorLinkageId,
  buildValidatedSameSegmentLinkage,
  buildValidatedCrossSegmentLinkage,
  sortLinkageRecordsDeterministic,
  detectDuplicateFeaturePair,
};
