/**
 * Stage 19 — assemble publication bundle, validate semantics, publish artifacts.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { jcsUtf8Bytes } = require('./stage19_spec/jcs');
const { validateStage19Semantics } = require('./stage19_spec/semantic');
const { config } = require('./stage19_spec/config');
const { STAGE19_PROCESSING_VERSION } = require('./stage19_version');
const { verifyNormativeBindingsAgainstPackage } = require('./stage19_normative_verify');
const {
  buildMatchRecords,
  buildCatalogMembers,
  attachBranchIdsToMatches,
  runProductionMatchPartition,
} = require('./stage19_match_builder');
const {
  buildCrossPassCandidates,
  buildCrossPassRecords,
  buildHeadingForCandidates,
  detectProductionConflicts,
} = require('./stage19_cross_pass_production');
const { loadStage18BevArtifacts, buildStage19BevRecord } = require('./stage19_bev_production');
const { assessIntervalProduction } = require('./stage19_interval_evidence');
const { validateProductionQualityGates } = require('./stage19_quality_gates');
const { runStage19SensitivitySweep } = require('./stage19_sensitivity_production');
const { publishProductionBundle, deterministicManifest } = require('./stage19_publication_production');
const { validatePublishedBundleDocs } = require('./stage19_schema_validate');
const { buildBevProductionAudit, buildP3ProductionAudit } = require('./stage19_production_audit');

function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function buildExclusions(runId, gaps) {
  return {
    schemaVersion: 'stage19_exclusions_v0',
    runId,
    excluded: (gaps || []).map((g) => ({ gapId: g.gapId, reason: g.reason || 'gap' })),
  };
}

function buildUnassociated(runId, observationIds, catalogMemberIds, failedObservations) {
  const memberSet = new Set(catalogMemberIds);
  const unassociated = observationIds
    .filter((oid) => !memberSet.has(oid) || failedObservations?.has(oid))
    .map((oid) => ({ matchId: oid }));
  return {
    schemaVersion: 'stage19_unassociated_v0',
    runId,
    unassociated,
  };
}

function buildBevAnchorPairs(bevArtifactLoad) {
  const anchors = [];
  const seen = new Set();
  for (const entry of bevArtifactLoad.entries.filter((e) => e.layerValidation?.pass)) {
    const fp = entry.featurePairId;
    if (seen.has(fp)) continue;
    seen.add(fp);
    anchors.push({
      featurePairId: fp,
      evidenceUnitKey: entry.provenance?.sourceArtifact || fp,
      overlapM: 0,
      headingDiffDeg: 0,
      _bevAnchor: true,
    });
  }
  return anchors;
}

function buildPromotionRecord(runId, assessments) {
  return {
    schemaVersion: 'stage19_promotion_v0',
    runId,
    decisions: assessments.map((a) => ({
      intervalId: a.intervalId,
      status: a.status,
      promotion: a.promotion,
    })),
  };
}

function buildSchemaCompliantHeadingRecord(runId, headingResults) {
  return {
    schemaVersion: 'stage19_heading_v0',
    runId,
    results: (headingResults || []).map((r) => ({
      featurePairId: r.featurePairId,
      estimates: (r.estimates || []).map((e) => ({
        mean: e.mean,
        meanResultant: e.meanResultant,
        evidenceUnitKey: e.evidenceUnitKey,
        featurePairId: e.featurePairId,
      })),
      qualifying: r.qualifying || [],
    })),
  };
}

function mergePromotionEvidenceForSemantics(promotion, assessments) {
  return {
    ...promotion,
    decisions: (promotion.decisions || []).map((d) => {
      const assessment = (assessments || []).find((a) => a.intervalId === d.intervalId);
      return assessment ? { ...d, ...assessment } : d;
    }),
  };
}

function buildCommitRecord(runId, manifestSha256) {
  return {
    schemaVersion: 'stage19_commit_v0',
    runId,
    manifestSha256,
    publishedAt: new Date().toISOString(),
  };
}

async function buildStage19Bundle(inputContext, options = {}) {
  const normative = verifyNormativeBindingsAgainstPackage();
  if (!normative.ok) {
    throw new Error(`normativeBindingMismatch: ${JSON.stringify({ missing: normative.missing, extra: normative.extra, mismatched: normative.mismatched?.length })}`);
  }

  const runId = options.runId || `stage19-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  let { matches, observationIds } = buildMatchRecords(inputContext);
  if (options.fixtureMatches?.length) {
    matches = options.fixtureMatches;
    observationIds = matches.map((m) => m.observationId).sort();
  }
  if (!options.fixtureMode && observationIds.length !== config.N_obs) {
    throw new Error(`observationCountMismatch: expected ${config.N_obs}, got ${observationIds.length}`);
  }

  const partitionDeps = options.partitionDeps || {};
  if (options.fixturePartitionConfigOverlay) {
    partitionDeps.partitionConfigOverlay = options.fixturePartitionConfigOverlay;
  }
  const partitionOutcome = runProductionMatchPartition(matches, partitionDeps);
  const { members, partitionResults, partitionStats, branchByObs, failedObservations } =
    buildCatalogMembers(matches, observationIds, partitionOutcome);
  attachBranchIdsToMatches(matches, branchByObs, failedObservations);

  if (members.length + failedObservations.size !== observationIds.length) {
    throw new Error('catalogCoverageMismatch');
  }

  const catalog = {
    schemaVersion: 'stage19_catalog_v0',
    runId,
    members,
  };

  const crossPassCandidateResult = options.crossPassInject
    || buildCrossPassCandidates(inputContext, matches);

  const { results: headingResultsAll, headingByPairId } =
    buildHeadingForCandidates(crossPassCandidateResult.candidates, matches);
  const { conflicts, insufficient: conflictInsufficient } =
    detectProductionConflicts(crossPassCandidateResult.candidates, headingByPairId);

  const invalidCrossPassReasons = new Set(['same_pass_rejected', 'repeated_evidence_unit']);
  const rejectedCrossPassIds = new Set(
    conflictInsufficient
      .filter((i) => invalidCrossPassReasons.has(i.reason))
      .map((i) => i.featurePairId),
  );
  const genuineCrossPassCandidates = crossPassCandidateResult.candidates.filter(
    (c) => !rejectedCrossPassIds.has(c.featurePairId),
  );
  const headingResults = headingResultsAll.filter((r) => !rejectedCrossPassIds.has(r.featurePairId));
  const filteredCrossPassResult = {
    candidates: genuineCrossPassCandidates,
    insufficient: [...crossPassCandidateResult.insufficient, ...conflictInsufficient],
  };

  const crossPassPairsRaw = buildCrossPassRecords(genuineCrossPassCandidates)
    .map(({ _meta, ...rest }) => rest);
  const bevArtifactLoad = options.bevArtifactLoad || await loadStage18BevArtifacts(options.bevOptions || {});
  const bevAnchors = buildBevAnchorPairs(bevArtifactLoad);
  const crossPassPairs = [...crossPassPairsRaw];
  for (const anchor of bevAnchors) {
    if (!crossPassPairs.some((p) => p.featurePairId === anchor.featurePairId)) {
      crossPassPairs.push(anchor);
    }
  }

  const crossPass = {
    schemaVersion: 'stage19_cross_pass_v0',
    runId,
    pairs: crossPassPairs.map(({ _bevAnchor, _meta, ...rest }) => rest),
  };
  const heading = buildSchemaCompliantHeadingRecord(runId, headingResults);

  const intervalEvidence = {
    context: inputContext,
    partitionResults,
    failedObservations,
    crossPass: filteredCrossPassResult,
    conflicts,
    insufficientCrossPass: filteredCrossPassResult.insufficient,
    bevArtifacts: bevArtifactLoad,
  };

  const assessments = (options.fixtureMode && options.fixtureAssessments)
    ? options.fixtureAssessments
    : (inputContext.acceptedIntervals || []).map((iv) =>
      assessIntervalProduction(iv, intervalEvidence, runId),
    );

  const exclusions = buildExclusions(runId, inputContext.gaps);
  const unassociated = buildUnassociated(
    runId,
    observationIds,
    members.map((m) => m.memberMatchId),
    failedObservations,
  );
  const bev = buildStage19BevRecord(runId, bevArtifactLoad);
  const promotion = buildPromotionRecord(runId, assessments);

  const assessmentStatusCounts = assessments.reduce((acc, a) => {
    acc[a.status] = (acc[a.status] || 0) + 1;
    return acc;
  }, {});

  const baselineBundle = {
    runId,
    crossPassCount: crossPassCandidateResult.candidates.length,
    conflicts,
    insufficientCrossPassCount: intervalEvidence.insufficientCrossPass.length,
    assessmentStatusCounts,
    partitionStats,
  };
  const sensitivityTable = runStage19SensitivitySweep(inputContext, baselineBundle, { bevArtifactLoad });

  const terminalBranchIds = [...new Set(members.map((m) => m.branchId))];
  const spanPositions = matches.map((m) => ({
    id: m.observationId,
    sLo: m.sLoUm / 1e6,
    sHi: m.sHiUm / 1e6,
  }));

  const payloadHashes = {};
  const fileEntries = [];
  const serialized = {};
  const payloadFiles = { ...(bevArtifactLoad.payloads || {}) };

  for (const [rel, bytes] of Object.entries(payloadFiles)) {
    payloadHashes[rel] = sha256Bytes(bytes);
    fileEntries.push({ path: rel, sha256: payloadHashes[rel], bytes: bytes.length });
  }

  const staticDocs = {
    'catalog_v0.json': catalog,
    'cross_pass_v0.json': crossPass,
    'heading_v0.json': heading,
    'bev_v0.json': bev,
    'exclusions_v0.json': exclusions,
    'unassociated_v0.json': unassociated,
    'promotion_v0.json': promotion,
    'sensitivity_v0.json': sensitivityTable,
  };

  for (const [name, doc] of Object.entries(staticDocs)) {
    const bytes = jcsUtf8Bytes(doc);
    serialized[name] = bytes;
    const sha = sha256Bytes(bytes);
    payloadHashes[name] = sha;
    fileEntries.push({ path: name, sha256: sha, bytes: bytes.length });
  }

  for (const a of assessments) {
    const fname = `assessment_${a.intervalId.replace(/[^a-zA-Z0-9._-]+/g, '_')}.json`;
    const bytes = jcsUtf8Bytes(a);
    serialized[fname] = bytes;
    const sha = sha256Bytes(bytes);
    payloadHashes[fname] = sha;
    fileEntries.push({ path: fname, sha256: sha, bytes: bytes.length });
  }

  const manifest = deterministicManifest(runId, fileEntries, STAGE19_PROCESSING_VERSION);
  const manifestBytes = jcsUtf8Bytes(manifest);
  const manifestSha256 = sha256Bytes(manifestBytes);
  const commit = buildCommitRecord(runId, manifestSha256);

  const semanticBundle = {
    catalog,
    crossPass,
    heading,
    bev,
    manifest,
    assessments,
    promotion: mergePromotionEvidenceForSemantics(promotion, assessments),
    payloadHashes,
    observationIds: members.map((m) => m.memberMatchId),
    terminalBranchIds,
    spanPositions,
    conflictCandidates: crossPassPairsRaw,
  };
  const semantics = validateStage19Semantics(semanticBundle);

  const schemaValidation = validatePublishedBundleDocs({
    catalog,
    crossPass,
    heading,
    bev,
    exclusions,
    unassociated,
    promotion,
    manifest,
    commit,
    assessments,
  });

  const insufficientEvidenceIntervalCount = assessmentStatusCounts.insufficient_evidence || 0;

  const qualityGates = validateProductionQualityGates({
    catalog,
    crossPass,
    bev,
    partitionResults,
    failedObservations,
    crossPassCandidates: crossPassCandidateResult,
    crossPassCandidateCount: crossPassCandidateResult.candidates.length,
    crossPassBundleCount: crossPassPairs.length,
    bevArtifactLoad,
    assessments,
    sensitivityTable,
    partitionStats,
    bevAnchorCount: bevAnchors.length,
    conflicts,
    payloadFiles,
    expectedInsufficientIntervalCount: options.fixtureMode
      ? (options.expectedInsufficientIntervalCount ?? assessments.filter((a) => a.status === 'insufficient_evidence').length)
      : (inputContext.acceptedIntervals?.length || 5),
  }, payloadFiles);

  if (!semantics.ok) throw new Error(`semanticValidationFailed:${JSON.stringify(semantics.errors?.slice(0, 3))}`);
  if (!schemaValidation.ok) throw new Error(`schemaValidationFailed:${JSON.stringify(schemaValidation.errors?.slice(0, 3))}`);
  if (!qualityGates.ok) throw new Error(`qualityGatesFailed:${JSON.stringify(qualityGates.errors?.slice(0, 5))}`);

  const branchCounts = {};
  for (const m of members) branchCounts[m.branchId] = (branchCounts[m.branchId] || 0) + 1;

  const productionAudit = {
    bev: buildBevProductionAudit(runId, bevArtifactLoad),
    p3: buildP3ProductionAudit(runId, partitionResults),
  };

  return {
    runId,
    bundleDocs: { ...staticDocs, assessments, promotion },
    serialized,
    payloadFiles,
    manifest,
    manifestBytes,
    manifestSha256,
    commit,
    semantics,
    schemaValidation,
    qualityGates,
    normative,
    partitionResults,
    partitionStats,
    failedObservations,
    crossPassCandidates: crossPassCandidateResult,
    crossPassCandidateCount: crossPassCandidateResult.candidates.length,
    conflicts,
    conflictInsufficient,
    insufficientCrossPassCount: intervalEvidence.insufficientCrossPass.length,
    insufficientEvidenceIntervalCount,
    conflictEvidenceAvailable: crossPassCandidateResult.candidates.length >= config.minCorroboratingEvidenceUnits,
    headingResults,
    bevArtifactLoad,
    sensitivityTable,
    productionAudit,
    p3Stats: {
      eligible: partitionStats.p3Eligible || 0,
      executed: partitionStats.p3Executed || 0,
      selected: partitionStats.p3Selected || 0,
      failed: partitionStats.p3Failed || 0,
    },
    observationCount: observationIds.length,
    catalogMemberCount: members.length,
    crossPassCount: crossPassPairsRaw.length,
    crossPassBundleCount: crossPassPairs.length,
    assessmentCount: assessments.length,
    assessmentStatusCounts,
    gapCount: exclusions.excluded.length,
    unassociatedCount: unassociated.unassociated.length,
    branchCounts,
    bevImageCount: bev.images.length,
    bevAnchorCount: bevAnchors.length,
  };
}

async function writeStage19Bundle(bundle, publicationRoot, options = {}) {
  return publishProductionBundle(publicationRoot, bundle, options);
}

module.exports = {
  buildStage19Bundle,
  writeStage19Bundle,
  buildExclusions,
  buildUnassociated,
  buildBevAnchorPairs,
  sha256Bytes,
};
