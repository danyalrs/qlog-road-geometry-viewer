'use strict';

const { config } = require('./config');
const { sha256 } = require('./crypto_util');

const DECLARED_SEMANTIC_RULES = [
  'duplicate_member',
  'branch_out_of_range',
  'observation_not_covered',
  'catalog_extra_member',
  'coverage_disjointness',
  'terminal_branch_foreign_key',
  'missing_feature_pair_id',
  'missing_evidence_unit_key',
  'duplicate_feature_pair_id',
  'heading_audit_foreign_key',
  'heading_fk_mismatch',
  'bev_feature_pair_foreign_key',
  'conflict_candidate_foreign_key',
  'duplicate_bev_image_id',
  'duplicate_bev_feature_pair_id',
  'bev_payload_missing',
  'bev_image_hash_mismatch',
  'manifest_payload_missing',
  'manifest_hash_mismatch',
  'payload_not_in_manifest',
  'span_positional_inversion',
  'span_positional_nonfinite',
  'status_promotion_mismatch',
  'status_evidence_shape_mismatch',
  'failed_missing_evidence',
  'conflict_missing_evidence',
  'insufficient_missing_evidence',
  'caveats_missing',
  'promotion_table_mismatch',
  'promotion_evidence_mismatch',
];

function promotionDecision(status, evidence) {
  const table = {
    failed: 'reject',
    conflict: 'reject',
    insufficient_evidence: 'hold',
    accepted_with_caveats: 'promote_with_caveats',
    accepted: 'promote',
  };
  const d = table[status];
  if (!d) throw new Error('invalidStatus');
  if (status === 'failed' && !evidence.failureReason) throw new Error('statusEvidenceMismatch');
  if (status === 'conflict' && !evidence.crossPassConflict) throw new Error('statusEvidenceMismatch');
  return d;
}

function validateStage19Semantics(bundle, options = {}) {
  const errors = [];
  const fixtureMode = options.fixtureMode === true;
  const err = (code, detail) => {
    errors.push({ code, detail: detail ?? null });
    if (fixtureMode) throw new Error('fixtureStop');
  };

  try {
    const {
      catalog, crossPass, heading, bev, manifest, assessments, promotion,
      payloadHashes, observationIds, terminalBranchIds, spanPositions, conflictCandidates,
    } = bundle;

    if (catalog) {
      const ids = new Set();
      const branches = new Set();
      const rawMembers = catalog.members || [];
      for (const m of rawMembers) {
        if (ids.has(m.memberMatchId)) err('duplicate_member', m.memberMatchId);
        ids.add(m.memberMatchId);
        if (m.branchId < 0 || m.branchId >= config.O_max) err('branch_out_of_range', m.memberMatchId);
        branches.add(m.branchId);
      }
      if (observationIds) {
        for (const oid of observationIds) {
          if (!ids.has(oid)) err('observation_not_covered', oid);
        }
        for (const mid of ids) {
          if (!observationIds.includes(mid)) err('catalog_extra_member', mid);
        }
        if (rawMembers.length !== observationIds.length || ids.size !== observationIds.length) {
          err('coverage_disjointness');
        }
      }
      if (terminalBranchIds) {
        for (const bid of terminalBranchIds) {
          if (!branches.has(bid)) err('terminal_branch_foreign_key', bid);
        }
      }
    }

    if (crossPass) {
      const pairIds = new Set();
      for (const p of crossPass.pairs || []) {
        if (!p.featurePairId) err('missing_feature_pair_id');
        if (!p.evidenceUnitKey) err('missing_evidence_unit_key');
        if (p.featurePairId && pairIds.has(p.featurePairId)) err('duplicate_feature_pair_id', p.featurePairId);
        if (p.featurePairId) pairIds.add(p.featurePairId);
      }
      if (heading) {
        for (const r of heading.results || []) {
          if (!pairIds.has(r.featurePairId)) err('heading_audit_foreign_key', r.featurePairId);
        }
      }
      if (bev) {
        for (const img of bev.images || []) {
          if (img.featurePairId && !pairIds.has(img.featurePairId)) err('bev_feature_pair_foreign_key', img.featurePairId);
        }
      }
      if (conflictCandidates) {
        for (const c of conflictCandidates) {
          if (!pairIds.has(c.featurePairId)) err('conflict_candidate_foreign_key', c.featurePairId);
        }
      }
    }

    if (heading) {
      for (const r of heading.results || []) {
        for (const e of r.estimates || []) {
          if (e.featurePairId !== r.featurePairId) err('heading_fk_mismatch', r.featurePairId);
          if (!e.evidenceUnitKey) err('missing_evidence_unit_key');
        }
      }
    }

    if (bev) {
      const imageIds = new Set();
      const bevPairIds = new Set();
      for (const img of bev.images || []) {
        if (imageIds.has(img.imageId)) err('duplicate_bev_image_id', img.imageId);
        imageIds.add(img.imageId);
        if (img.featurePairId) {
          if (bevPairIds.has(img.featurePairId)) err('duplicate_bev_feature_pair_id', img.featurePairId);
          bevPairIds.add(img.featurePairId);
        }
        if (payloadHashes && img.payloadPath) {
          const expected = payloadHashes[img.payloadPath];
          if (!expected) err('bev_payload_missing', img.payloadPath);
          else if (expected !== img.sha256) err('bev_image_hash_mismatch', img.imageId);
        }
      }
    }

    if (manifest && payloadHashes) {
      for (const f of manifest.files || []) {
        if (!payloadHashes[f.path] && !f.path.endsWith('.json')) err('manifest_payload_missing', f.path);
        if (payloadHashes[f.path] && payloadHashes[f.path] !== f.sha256) err('manifest_hash_mismatch', f.path);
      }
      for (const p of Object.keys(payloadHashes)) {
        if (!(manifest.files || []).some((f) => f.path === p)) err('payload_not_in_manifest', p);
      }
    }

    if (spanPositions) {
      for (const sp of spanPositions) {
        if (sp.sLo > sp.sHi) err('span_positional_inversion', sp.id);
        if (!Number.isFinite(sp.sLo) || !Number.isFinite(sp.sHi)) err('span_positional_nonfinite', sp.id);
      }
    }

    for (const doc of assessments || []) {
      if (doc.status === 'failed' && (!doc.failureReason || !doc.failureDetail)) err('failed_missing_evidence', doc.intervalId);
      if (doc.status === 'conflict' && !doc.crossPassConflict) err('conflict_missing_evidence', doc.intervalId);
      if (doc.status === 'insufficient_evidence' && !doc.insufficientEvidence) err('insufficient_missing_evidence', doc.intervalId);
      if (doc.status === 'accepted_with_caveats' && !(doc.caveats && doc.caveats.length > 0)) err('caveats_missing', doc.intervalId);
      try {
        const promo = promotionDecision(doc.status, doc);
        if (doc.promotion !== promo) err('status_promotion_mismatch', doc.intervalId);
      } catch (e) {
        if (e.message === 'fixtureStop') throw e;
        err('status_evidence_shape_mismatch', doc.intervalId);
      }
    }

    if (promotion) {
      for (const d of promotion.decisions || []) {
        try {
          const expected = promotionDecision(d.status, d);
          if (d.promotion !== expected) err('promotion_table_mismatch', d.intervalId);
        } catch (e) {
          if (e.message === 'fixtureStop') throw e;
          err('promotion_evidence_mismatch', d.intervalId);
        }
      }
    }
  } catch (e) {
    if (e.message !== 'fixtureStop') throw e;
  }

  if (!fixtureMode) {
    errors.sort((a, b) => a.code.localeCompare(b.code) || String(a.detail).localeCompare(String(b.detail)));
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function buildValidSemanticBundle() {
  const hash = sha256('png');
  return {
    catalog: {
      schemaVersion: 'stage19_catalog_v0', runId: 'run-1',
      members: [
        { memberMatchId: 'm-0000', branchId: 0 },
        { memberMatchId: 'm-0001', branchId: 1 },
      ],
    },
    observationIds: ['m-0000', 'm-0001'],
    terminalBranchIds: [0, 1],
    crossPass: {
      schemaVersion: 'stage19_cross_pass_v0', runId: 'run-1',
      pairs: [{ featurePairId: 'fp-0', evidenceUnitKey: 'eu-0', overlapM: 6, headingDiffDeg: 2 }],
    },
    heading: {
      schemaVersion: 'stage19_heading_v0', runId: 'run-1',
      results: [{
        featurePairId: 'fp-0',
        estimates: [{ mean: 5, meanResultant: 2, evidenceUnitKey: 'eu-0', featurePairId: 'fp-0' }],
        qualifying: [],
      }],
    },
    bev: {
      schemaVersion: 'stage19_bev_v0', runId: 'run-1',
      images: [{
        imageId: 'img-0', featurePairId: 'fp-0', widthPx: 64, heightPx: 64, mime: 'image/png',
        sha256: hash, bytes: 4, payloadPath: 'payloads/img-0.png',
      }],
    },
    manifest: {
      schemaVersion: 'stage19_manifest_v0', runId: 'run-1',
      createdAt: '2026-07-24T00:00:00.000Z', processingVersion: config.processingVersion,
      files: [{ path: 'payloads/img-0.png', sha256: hash, bytes: 4 }],
    },
    payloadHashes: { 'payloads/img-0.png': hash },
    spanPositions: [{ id: 'sp-0', sLo: 0, sHi: 10 }],
    conflictCandidates: [{ featurePairId: 'fp-0' }],
    assessments: [{
      schemaVersion: 'stage19_assessment_v0', runId: 'run-1', intervalId: 'iv-0',
      status: 'accepted', promotion: 'promote', partition: { numPaths: 2, totalExtensionCost: 0.5 },
    }],
    promotion: {
      schemaVersion: 'stage19_promotion_v0', runId: 'run-1',
      decisions: [{ intervalId: 'iv-0', status: 'accepted', promotion: 'promote' }],
    },
  };
}

function baselineForRule(code) {
  const hash = sha256('png');
  const catalog = {
    schemaVersion: 'stage19_catalog_v0', runId: 'run-1',
    members: [
      { memberMatchId: 'm-0000', branchId: 0 },
      { memberMatchId: 'm-0001', branchId: 1 },
    ],
  };
  const crossPass = {
    schemaVersion: 'stage19_cross_pass_v0', runId: 'run-1',
    pairs: [{ featurePairId: 'fp-0', evidenceUnitKey: 'eu-0', overlapM: 6, headingDiffDeg: 2 }],
  };
  const heading = {
    schemaVersion: 'stage19_heading_v0', runId: 'run-1',
    results: [{
      featurePairId: 'fp-0',
      estimates: [{ mean: 5, meanResultant: 2, evidenceUnitKey: 'eu-0', featurePairId: 'fp-0' }],
      qualifying: [],
    }],
  };
  const bev = {
    schemaVersion: 'stage19_bev_v0', runId: 'run-1',
    images: [{
      imageId: 'img-0', featurePairId: 'fp-0', widthPx: 64, heightPx: 64, mime: 'image/png',
      sha256: hash, bytes: 4, payloadPath: 'payloads/img-0.png',
    }],
  };
  const manifest = {
    schemaVersion: 'stage19_manifest_v0', runId: 'run-1',
    createdAt: '2026-07-24T00:00:00.000Z', processingVersion: config.processingVersion,
    files: [{ path: 'payloads/img-0.png', sha256: hash, bytes: 4 }],
  };
  const assessment = {
    schemaVersion: 'stage19_assessment_v0', runId: 'run-1', intervalId: 'iv-0',
    status: 'accepted', promotion: 'promote', partition: { numPaths: 2, totalExtensionCost: 0.5 },
  };
  const map = {
    duplicate_member: { catalog },
    branch_out_of_range: { catalog },
    observation_not_covered: { catalog, observationIds: ['m-0000', 'm-0001'] },
    catalog_extra_member: { catalog, observationIds: ['m-0000', 'm-0001'] },
    coverage_disjointness: { catalog, observationIds: ['m-0000', 'm-0001'] },
    terminal_branch_foreign_key: { catalog, terminalBranchIds: [0, 1] },
    missing_feature_pair_id: { crossPass },
    missing_evidence_unit_key: { crossPass },
    duplicate_feature_pair_id: { crossPass },
    heading_audit_foreign_key: { crossPass, heading },
    heading_fk_mismatch: { crossPass, heading },
    bev_feature_pair_foreign_key: { crossPass, bev },
    conflict_candidate_foreign_key: { crossPass, conflictCandidates: [{ featurePairId: 'fp-0' }] },
    duplicate_bev_image_id: { crossPass, bev, payloadHashes: { 'payloads/img-0.png': hash } },
    duplicate_bev_feature_pair_id: { crossPass, bev, payloadHashes: { 'payloads/img-0.png': hash } },
    bev_payload_missing: { crossPass, bev, payloadHashes: { 'payloads/img-0.png': hash } },
    bev_image_hash_mismatch: { crossPass, bev, payloadHashes: { 'payloads/img-0.png': hash } },
    manifest_payload_missing: { manifest, payloadHashes: { 'payloads/img-0.png': hash } },
    manifest_hash_mismatch: { manifest, payloadHashes: { 'payloads/img-0.png': hash } },
    payload_not_in_manifest: { manifest, payloadHashes: { 'payloads/img-0.png': hash } },
    span_positional_inversion: { spanPositions: [{ id: 'sp-0', sLo: 0, sHi: 10 }] },
    span_positional_nonfinite: { spanPositions: [{ id: 'sp-0', sLo: 0, sHi: 10 }] },
    status_promotion_mismatch: { assessments: [assessment], promotion: { schemaVersion: 'stage19_promotion_v0', runId: 'run-1', decisions: [] } },
    status_evidence_shape_mismatch: { assessments: [assessment] },
    failed_missing_evidence: { assessments: [{ ...assessment, status: 'failed', promotion: 'reject', failureReason: 'r', failureDetail: {} }] },
    conflict_missing_evidence: { assessments: [{ ...assessment, status: 'conflict', promotion: 'reject', crossPassConflict: true }] },
    insufficient_missing_evidence: { assessments: [{ ...assessment, status: 'insufficient_evidence', promotion: 'hold', insufficientEvidence: {} }] },
    caveats_missing: { assessments: [{ ...assessment, status: 'accepted_with_caveats', promotion: 'promote_with_caveats', caveats: ['note'] }] },
    promotion_table_mismatch: { promotion: { schemaVersion: 'stage19_promotion_v0', runId: 'run-1', decisions: [{ intervalId: 'iv-0', status: 'accepted', promotion: 'promote' }] }, assessments: [] },
    promotion_evidence_mismatch: { promotion: { schemaVersion: 'stage19_promotion_v0', runId: 'run-1', decisions: [{ intervalId: 'iv-0', status: 'accepted', promotion: 'promote' }] }, assessments: [] },
  };
  return JSON.parse(JSON.stringify(map[code]));
}

function buildSemanticRuleFixtures() {
  const mutators = {
    duplicate_member: (b) => { b.catalog.members.push({ memberMatchId: 'm-0000', branchId: 0 }); },
    branch_out_of_range: (b) => { b.catalog.members[0].branchId = 99; },
    observation_not_covered: (b) => { b.observationIds.push('m-missing'); },
    catalog_extra_member: (b) => { b.observationIds = ['m-0000']; },
    coverage_disjointness: (b) => { b.observationIds.push('m-0000'); },
    terminal_branch_foreign_key: (b) => { b.terminalBranchIds = [7]; },
    missing_feature_pair_id: (b) => { delete b.crossPass.pairs[0].featurePairId; },
    missing_evidence_unit_key: (b) => { delete b.crossPass.pairs[0].evidenceUnitKey; },
    duplicate_feature_pair_id: (b) => { b.crossPass.pairs.push({ ...b.crossPass.pairs[0] }); },
    heading_audit_foreign_key: (b) => { b.heading.results[0].featurePairId = 'fp-missing'; },
    heading_fk_mismatch: (b) => { b.heading.results[0].estimates[0].featurePairId = 'fp-other'; },
    bev_feature_pair_foreign_key: (b) => { b.bev.images[0].featurePairId = 'fp-missing'; },
    conflict_candidate_foreign_key: (b) => { b.conflictCandidates[0].featurePairId = 'fp-missing'; },
    duplicate_bev_image_id: (b) => { b.bev.images.push({ ...b.bev.images[0] }); },
    duplicate_bev_feature_pair_id: (b) => { b.bev.images.push({ ...b.bev.images[0], imageId: 'img-1' }); },
    bev_payload_missing: (b) => { delete b.payloadHashes['payloads/img-0.png']; },
    bev_image_hash_mismatch: (b) => { b.bev.images[0].sha256 = 'd'.repeat(64); },
    manifest_payload_missing: (b) => { b.manifest.files.push({ path: 'payloads/missing.png', sha256: 'e'.repeat(64), bytes: 1 }); },
    manifest_hash_mismatch: (b) => { b.manifest.files[0].sha256 = 'f'.repeat(64); },
    payload_not_in_manifest: (b) => { b.payloadHashes['payloads/extra.png'] = 'g'.repeat(64); },
    span_positional_inversion: (b) => { b.spanPositions[0].sLo = 20; },
    span_positional_nonfinite: (b) => { b.spanPositions[0].sHi = NaN; },
    status_promotion_mismatch: (b) => { b.assessments[0].promotion = 'reject'; },
    status_evidence_shape_mismatch: (b) => { b.assessments[0].status = 'not_a_status'; },
    failed_missing_evidence: (b) => { delete b.assessments[0].failureDetail; },
    conflict_missing_evidence: (b) => { delete b.assessments[0].crossPassConflict; },
    insufficient_missing_evidence: (b) => { delete b.assessments[0].insufficientEvidence; },
    caveats_missing: (b) => { delete b.assessments[0].caveats; },
    promotion_table_mismatch: (b) => { b.promotion.decisions[0].promotion = 'reject'; },
    promotion_evidence_mismatch: (b) => { b.promotion.decisions[0].status = 'failed'; },
  };
  const fixtures = DECLARED_SEMANTIC_RULES.map((code) => {
    const validBase = baselineForRule(code);
    const invalidBase = baselineForRule(code);
    mutators[code](invalidBase);
    const valid = validateStage19Semantics(validBase);
    const invalid = validateStage19Semantics(invalidBase, { fixtureMode: true });
    const codes = invalid.errors.map((e) => e.code);
    return {
      code,
      valid,
      invalid,
      isolated: invalid.errors.length === 1 && invalid.errors[0].code === code,
      unrelatedErrors: codes.filter((c) => c !== code),
    };
  });
  return fixtures;
}

function buildSemanticIntegrationFixture() {
  const b = buildValidSemanticBundle();
  b.catalog.members.push({ memberMatchId: 'm-0000', branchId: 0 });
  b.observationIds.push('m-missing');
  b.assessments[0].status = 'failed';
  b.assessments[0].promotion = 'reject';
  return validateStage19Semantics(b);
}

function runSemanticFixtures() {
  const fixtures = buildSemanticRuleFixtures();
  const integration = buildSemanticIntegrationFixture();
  const results = fixtures.map((f) => ({
    code: f.code,
    validPass: f.valid.ok === true,
    invalidPass: f.invalid.ok === false && f.invalid.errors.some((e) => e.code === f.code),
    isolatedPass: f.isolated,
    unrelatedErrors: f.unrelatedErrors,
    pass: f.valid.ok === true && f.invalid.ok === false && f.isolated,
  }));
  const declared = new Set(DECLARED_SEMANTIC_RULES);
  const covered = new Set(results.filter((r) => r.pass).map((r) => r.code));
  const missing = [...declared].filter((c) => !covered.has(c));
  return {
    allPass: results.every((r) => r.pass) && missing.length === 0 && integration.ok === false,
    integrationMultiError: integration.errors?.length > 1,
    results,
    missingRules: missing,
    declaredRuleCount: declared.size,
    coveredRuleCount: covered.size,
  };
}

module.exports = {
  DECLARED_SEMANTIC_RULES,
  promotionDecision,
  validateStage19Semantics,
  buildValidSemanticBundle,
  baselineForRule,
  buildSemanticRuleFixtures,
  buildSemanticIntegrationFixture,
  runSemanticFixtures,
};
