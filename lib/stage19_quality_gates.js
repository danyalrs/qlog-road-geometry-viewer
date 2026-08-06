'use strict';

const { isPngSignature } = require('./stage19_bev_png');
const { validateAgainstSchema } = require('./stage19_schema_validate');

function validateProductionQualityGates(bundleContext, payloadBytesByPath = {}) {
  const errors = [];
  const err = (code, detail) => errors.push({ code, detail });

  const {
    catalog,
    crossPass,
    bev,
    partitionResults,
    failedObservations,
    crossPassCandidates,
    bevArtifactLoad,
    assessments,
    payloadFiles,
  } = bundleContext;

  if (!bev?.images?.length) err('bev_empty', 'required representative BEV evidence missing');
  if (bevArtifactLoad && bevArtifactLoad.entries.every((e) => !e.layerValidation?.pass)) {
    err('bev_layer_validation_failed', 'no BEV entry passed layer A+B checks');
  }

  for (const img of bev?.images || []) {
    const bytes = payloadBytesByPath[img.payloadPath] || payloadFiles?.[img.payloadPath];
    if (!bytes) {
      err('bev_payload_missing', img.payloadPath);
      continue;
    }
    if (img.mime === 'image/png' && !isPngSignature(bytes)) err('bev_mime_png_bytes_mismatch', img.payloadPath);
    if (img.sha256 && require('crypto').createHash('sha256').update(bytes).digest('hex') !== img.sha256) {
      err('bev_payload_hash_mismatch', img.payloadPath);
    }
    if (!img.provenance && bevArtifactLoad) {
      const entry = bevArtifactLoad.entries.find((e) => e.payloadPath === img.payloadPath);
      if (entry && !entry.provenance?.conversionTool) err('bev_conversion_provenance_missing', img.imageId);
    }
  }

  const bevSchema = validateAgainstSchema(bev, 'bev_v0.json');
  if (bev && !bevSchema.ok) err('bev_schema_invalid', bevSchema.errors);

  const candidateCount = crossPassCandidates?.candidates?.length ?? bundleContext.crossPassCandidateCount ?? 0;
  const pairCount = crossPass?.pairs?.length ?? bundleContext.crossPassBundleCount ?? 0;
  const bevAnchorCount = bundleContext.bevAnchorCount ?? 0;
  if (candidateCount === 0 && pairCount > bevAnchorCount) {
    err('fabricated_cross_pass_pairs', 'non-anchor pairs present without candidates');
  }

  for (const c of crossPassCandidates?.candidates || []) {
    if (c.temporalPassIdLo && c.temporalPassIdHi && c.temporalPassIdLo === c.temporalPassIdHi) {
      err('cross_pass_self_pair', c.featurePairId);
    }
    if (c.evidenceUnitKeyLo && c.evidenceUnitKeyHi && c.evidenceUnitKeyLo === c.evidenceUnitKeyHi) {
      err('cross_pass_same_evidence_unit', c.featurePairId);
    }
  }

  for (const pr of partitionResults || []) {
    if (!pr.ok && pr.branchByObs) err('silent_partition_fallback', pr.unitKey);
    if (pr.p3Executed && pr.p3Eligible && !pr.branchSelection) {
      err('missing_apply_branch_selection', pr.unitKey);
    }
    if (pr.p3Executed && pr.p3Eligible && pr.branchSelection && !pr.branchSelection.ok && pr.ok) {
      err('p3_branch_selection_failed', pr.unitKey);
    }
  }

  if (failedObservations?.size > 0) {
    for (const oid of failedObservations) {
      const member = catalog?.members?.find((m) => m.memberMatchId === oid);
      if (member) err('failed_observation_in_catalog', oid);
    }
  }

  const insufficientIntervalCount = (assessments || []).filter((a) => a.status === 'insufficient_evidence').length;
  if (bundleContext.expectedInsufficientIntervalCount != null
    && insufficientIntervalCount !== bundleContext.expectedInsufficientIntervalCount) {
    err('interval_insufficient_count_mismatch', { expected: bundleContext.expectedInsufficientIntervalCount, actual: insufficientIntervalCount });
  }

  if (candidateCount === 0 && (bundleContext.conflicts?.length || 0) > 0) {
    err('conflict_without_candidates', null);
  }

  for (const a of assessments || []) {
    if (a.status === 'accepted' && (a.caveats?.length || 0) > 0) {
      err('accepted_with_caveats_mismatch', a.intervalId);
    }
  }

  if (!bundleContext.sensitivityTable) err('sensitivity_table_missing', null);
  if (!bundleContext.sensitivityTable?.authorityNote) err('sensitivity_authority_missing', null);

  const successfulMultiObs = (partitionResults || []).filter((p) => p.ok && (p.chainLength || 0) > 1);
  if (successfulMultiObs.length > 0 && !successfulMultiObs.some((p) => p.p3Executed)) {
    err('p3_not_invoked', null);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

module.exports = { validateProductionQualityGates };
