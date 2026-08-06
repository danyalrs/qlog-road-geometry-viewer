'use strict';

const fs = require('fs');
const path = require('path');
const {
  MANIFEST_SCHEMA_VERSION,
  OBSERVATION_ID_RE,
  MANIFEST_VALIDATION_CODES: C,
} = require('./stage20_b_motion_review_constants');
const { expectedReviewPairId, reversedReviewPairId } = require('./stage20_b_motion_review_fingerprint');

function parseObservationId(observationId) {
  if (!OBSERVATION_ID_RE.test(observationId)) return null;
  const [segmentId, chunkId, logMonoTime, sourceSlotIndex] = observationId.split(':');
  return {
    segmentId: Number(segmentId),
    chunkId: Number(chunkId),
    logMonoTime,
    sourceSlotIndex: Number(sourceSlotIndex),
  };
}

function isQlogInWorkspace(root, qlogReference) {
  if (!qlogReference) return false;
  return fs.existsSync(path.join(root, qlogReference));
}

function validateManifestPair(pair, index, ctx) {
  const issues = [];
  const add = (code, message, field = null) => {
    issues.push({ code, message, field, reviewPairId: pair.reviewPairId ?? null, index });
  };

  if (!pair.reviewPairId) {
    add(C.B_MR_001, 'missing reviewPairId');
    return issues;
  }

  if (pair.observationIdA === pair.observationIdB) {
    add(C.B_MR_003, 'self-pair: observationIdA equals observationIdB');
  }

  const expectedId = expectedReviewPairId(pair);
  if (pair.reviewPairId !== expectedId) {
    add(C.B_MR_006, `reviewPairId mismatch: expected ${expectedId}`, 'reviewPairId');
  }

  for (const field of ['observationIdA', 'observationIdB']) {
    const oid = pair[field];
    if (!oid || typeof oid !== 'string') {
      add(C.B_MR_004, `missing or invalid ${field}`, field);
      continue;
    }
    if (!OBSERVATION_ID_RE.test(oid)) {
      add(C.B_MR_004, `invalid observation ID format for ${field}: ${oid}`, field);
      continue;
    }
    if (ctx.observationById && !ctx.observationById.has(oid)) {
      add(C.B_MR_005, `observation FK not found for ${field}: ${oid}`, field);
    }
  }

  if (pair.qlogReference == null || pair.qlogReference === '') {
    add(C.B_MR_007, 'missing qlogReference', 'qlogReference');
  } else if (ctx.root && !isQlogInWorkspace(ctx.root, pair.qlogReference)) {
    add(C.B_MR_008, `qlog file not in workspace: ${pair.qlogReference}`, 'qlogReference');
  } else if (ctx.root && pair.videoAvailableInWorkspace === false && isQlogInWorkspace(ctx.root, pair.qlogReference)) {
    if (!ctx.warnings) ctx.warnings = [];
    ctx.warnings.push({
      code: 'B-MR-W001',
      message: 'videoAvailableInWorkspace is false but qlog file exists in workspace',
      reviewPairId: pair.reviewPairId,
      field: 'videoAvailableInWorkspace',
    });
  }

  if (pair.videoReference == null || pair.videoReference === '') {
    add(C.B_MR_009, 'missing videoReference', 'videoReference');
  }

  const numericFields = [
    'segmentId', 'deltaTimeS', 'spatialM', 'speedMps', 'headingDiffDeg',
    'routeSGapM', 'lateralDeltaM',
  ];
  for (const field of numericFields) {
    if (pair[field] != null && typeof pair[field] !== 'number') {
      add(C.B_MR_014, `${field} must be a number`, field);
    }
  }

  if (pair.reviewerLabel != null) {
    add(C.B_MR_010, 'reviewerLabel must be null before manual review', 'reviewerLabel');
  }
  if (pair.reviewerNotes != null) {
    add(C.B_MR_010, 'reviewerNotes must be null before manual review', 'reviewerNotes');
  }
  if (pair.reviewStatus && pair.reviewStatus !== 'pending') {
    add(C.B_MR_011, `reviewStatus must be pending before manual review, got ${pair.reviewStatus}`, 'reviewStatus');
  }

  if (!pair.evidenceProvenance?.source) {
    add(C.B_MR_013, 'missing evidenceProvenance.source', 'evidenceProvenance');
  }

  if (ctx.observationById) {
    const parsedA = parseObservationId(pair.observationIdA);
    const parsedB = parseObservationId(pair.observationIdB);
    const obA = ctx.observationById.get(pair.observationIdA);
    const obB = ctx.observationById.get(pair.observationIdB);
    if (parsedA && obA) {
      if (pair.segmentId != null && obA.segmentId !== pair.segmentId) {
        add(C.B_MR_015, 'segmentId inconsistent with observationIdA FK', 'segmentId');
      }
      if (pair.chunkIdA != null && obA.chunkId !== pair.chunkIdA) {
        add(C.B_MR_015, 'chunkIdA inconsistent with observationIdA FK', 'chunkIdA');
      }
      if (pair.logMonoTimeA != null && String(obA.logMonoTime) !== String(pair.logMonoTimeA)) {
        add(C.B_MR_015, 'logMonoTimeA inconsistent with observationIdA FK', 'logMonoTimeA');
      }
    }
    if (parsedB && obB && pair.logMonoTimeB != null && String(obB.logMonoTime) !== String(pair.logMonoTimeB)) {
      add(C.B_MR_015, 'logMonoTimeB inconsistent with observationIdB FK', 'logMonoTimeB');
    }
  }

  return issues;
}

function validateManifestOrdering(pairs) {
  const issues = [];
  for (let i = 1; i < pairs.length; i++) {
    const prev = pairs[i - 1];
    const curr = pairs[i];
    const cmp = prev.segmentId - curr.segmentId || prev.spatialM - curr.spatialM;
    if (cmp > 0) {
      issues.push({
        code: C.B_MR_012,
        message: `ordering violation at index ${i}: expected segmentId/spatialM ascending`,
        index: i,
        reviewPairId: curr.reviewPairId,
      });
    }
  }
  return issues;
}

function validateManifest(manifest, ctx = {}) {
  const issues = [];
  const pairIds = new Set();
  const reversedKeys = new Set();

  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    issues.push({
      code: C.B_MR_016,
      message: `schemaVersion mismatch: expected ${MANIFEST_SCHEMA_VERSION}`,
      field: 'schemaVersion',
    });
  }

  const pairs = manifest.reviewPairs || [];
  if (!Array.isArray(pairs)) {
    issues.push({ code: C.B_MR_016, message: 'reviewPairs must be an array', field: 'reviewPairs' });
    return { ok: false, issueCount: issues.length, issues, pairCount: 0 };
  }

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (pairIds.has(pair.reviewPairId)) {
      issues.push({
        code: C.B_MR_001,
        message: `duplicate reviewPairId: ${pair.reviewPairId}`,
        reviewPairId: pair.reviewPairId,
        index: i,
      });
    } else {
      pairIds.add(pair.reviewPairId);
    }

    const rev = reversedReviewPairId(pair);
    if (reversedKeys.has(rev) || pairIds.has(rev)) {
      issues.push({
        code: C.B_MR_002,
        message: `reversed-duplicate pair: ${pair.reviewPairId}`,
        reviewPairId: pair.reviewPairId,
        index: i,
      });
    }
    reversedKeys.add(pair.reviewPairId);

    issues.push(...validateManifestPair(pair, i, ctx));
  }

  issues.push(...validateManifestOrdering(pairs));

  if (manifest.reviewPairCount != null && manifest.reviewPairCount !== pairs.length) {
    issues.push({
      code: C.B_MR_016,
      message: `reviewPairCount ${manifest.reviewPairCount} does not match reviewPairs.length ${pairs.length}`,
      field: 'reviewPairCount',
    });
  }

  const errorCodes = new Set(issues.map((i) => i.code));
  return {
    ok: issues.length === 0,
    issueCount: issues.length,
    issues,
    warnings: ctx.warnings || [],
    warningCount: (ctx.warnings || []).length,
    pairCount: pairs.length,
    uniquePairIds: pairIds.size,
    codesPresent: [...errorCodes].sort(),
  };
}

function loadManifest(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

module.exports = {
  validateManifest,
  validateManifestPair,
  validateManifestOrdering,
  loadManifest,
  parseObservationId,
  isQlogInWorkspace,
};
