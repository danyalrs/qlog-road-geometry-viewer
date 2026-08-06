/**
 * Stage 19 orchestrator — dataset-wide lane-interval sensitivity & BEV evidence audit.
 */
const path = require('path');
const fs = require('fs');
const { PROCESSING_VERSION } = require('./version');
const { FROZEN_ROAD_SURFACE_VERSION } = require('./stage15_lane_counting_design');
const { STAGE18_PROCESSING_VERSION } = require('./stage18_lane_interval_schema');
const { STAGE19_PROCESSING_VERSION, STAGE19_IMPLEMENTATION_CHECKPOINT } = require('./stage19_version');
const { buildStage19InputContext } = require('./stage19_stage18_loader');
const { injectStage17Gaps, clearStage17Gaps, validateStage19RuntimeConfig } = require('./stage19_runtime');
const { buildStage19Bundle, writeStage19Bundle } = require('./stage19_bundle_builder');
const { verifyNormativeBindingsAgainstPackage } = require('./stage19_normative_verify');
const { summarizePartitionStatsBySegment } = require('./stage19_partition_production');
const { config } = require('./stage19_spec/config');

const EXPECTED_OBS_COUNT = config.N_obs;
const EXPECTED_GAP_COUNT = 136;
const EXPECTED_INTERVAL_COUNT = 5;

async function buildStage19DatasetSensitivityAudit(root, options = {}) {
  validateStage19RuntimeConfig();
  const normative = verifyNormativeBindingsAgainstPackage();
  if (!normative.ok) {
    throw new Error(`normativeBindingMismatch: ${JSON.stringify(normative)}`);
  }

  const context = buildStage19InputContext(root, options);
  injectStage17Gaps(context.gaps);

  try {
    if (context.gapCount !== EXPECTED_GAP_COUNT) {
      throw new Error(`gapCountMismatch: expected ${EXPECTED_GAP_COUNT}, got ${context.gapCount}`);
    }
    if (context.observationById.size !== EXPECTED_OBS_COUNT) {
      throw new Error(`observationCountMismatch: expected ${EXPECTED_OBS_COUNT}, got ${context.observationById.size}`);
    }

    const bundle = await buildStage19Bundle(context, { runId: options.runId });

    const intervals = context.acceptedIntervals || [];
    if (intervals.length !== EXPECTED_INTERVAL_COUNT) {
      throw new Error(`intervalCountMismatch: expected ${EXPECTED_INTERVAL_COUNT}, got ${intervals.length}`);
    }

    const promotionCounts = bundle.bundleDocs.promotion.decisions.reduce((acc, d) => {
      acc[d.promotion] = (acc[d.promotion] || 0) + 1;
      return acc;
    }, {});

    const partitionBySegment = summarizePartitionStatsBySegment(bundle.partitionResults);
    const fallbackPct = bundle.observationCount > 0
      ? (bundle.failedObservations.size / bundle.observationCount) * 100
      : 0;

    return {
      auditedAt: new Date().toISOString(),
      stage19Status: 'implementation_pending_validation',
      stage19ImplementationCheckpoint: STAGE19_IMPLEMENTATION_CHECKPOINT,
      stagePurpose: 'dataset_wide_lane_interval_sensitivity_and_bev_evidence_audit',
      productionLaneCountImplemented: false,
      physicalRoadValidationComplete: false,
      hdMapSystemComplete: false,
      v11GeometryModified: false,
      stage15Through18Modified: false,
      frozenRoadSurfaceVersion: FROZEN_ROAD_SURFACE_VERSION,
      frozenV11ProcessingVersion: PROCESSING_VERSION,
      stage19ProcessingVersion: STAGE19_PROCESSING_VERSION,
      stage18ProcessingVersion: STAGE18_PROCESSING_VERSION,
      stage17InputVersion: context.stage17RunsEnvelope?.schemaVersion,
      stage17ProcessingVersion: context.stage17RunsEnvelope?.processingVersion,
      stage16InputChecksum: context.stage16Checksum,
      datasetBounds: {
        N_obs: EXPECTED_OBS_COUNT,
        N_gap: EXPECTED_GAP_COUNT,
        P_cp_max: config.P_cp,
        N_interval: EXPECTED_INTERVAL_COUNT,
      },
      normativeVerification: normative,
      schemaValidation: bundle.schemaValidation,
      runId: bundle.runId,
      manifestSha256: bundle.manifestSha256,
      semanticValidation: bundle.semantics,
      productionQualityGates: bundle.qualityGates,
      productionAudit: bundle.productionAudit,
      observationCount: bundle.observationCount,
      catalogMemberCount: bundle.catalogMemberCount,
      genuineCrossPassCandidateCount: bundle.crossPassCandidateCount,
      crossPassBundleCount: bundle.crossPassBundleCount,
      gapExclusionCount: bundle.gapCount,
      unassociatedCount: bundle.unassociatedCount,
      acceptedIntervalCount: intervals.length,
      assessmentCount: bundle.assessmentCount,
      assessmentStatusCounts: bundle.assessmentStatusCounts,
      promotionCounts,
      crossPassConflictCount: bundle.conflicts.length,
      conflictEvidenceAvailable: bundle.conflictEvidenceAvailable,
      insufficientEvidenceIntervalCount: bundle.insufficientEvidenceIntervalCount,
      insufficientCrossPassCandidateCount: bundle.insufficientCrossPassCount,
      partitionStats: bundle.partitionStats,
      partitionBySegment,
      partitionFailureCount: bundle.partitionStats.failedPartitions,
      partitionOverflowCount: bundle.partitionStats.overflowPartitions,
      nonTrivialPartitionCount: bundle.partitionStats.multiObservationChains,
      singletonChainCount: bundle.partitionStats.singleObservationChains,
      failedObservationCount: bundle.failedObservations.size,
      fallbackOrFailurePct: fallbackPct,
      branchCounts: bundle.branchCounts,
      p3Stats: bundle.p3Stats,
      bevImageCount: bundle.bevImageCount,
      bevArtifacts: (bundle.productionAudit?.bev?.entries || []).map((e) => ({
        imageId: e.imageId,
        category: e.category,
        laneIntervalId: e.laneIntervalId,
        sourceArtifact: e.sourceArtifact,
        sourceSvgSha256: e.sourceSvgSha256,
        pngSha256: e.pngSha256,
        mime: e.mime,
        bytes: e.bytes,
        widthPx: e.widthPx,
        heightPx: e.heightPx,
        layerValidation: e.layerValidation,
        provenance: e.provenance,
      })),
      sensitivitySummary: {
        rowCount: bundle.sensitivityTable.rowCount,
        baseline: bundle.sensitivityTable.baseline,
        authorityNote: bundle.sensitivityTable.authorityNote,
        empiricalLimitation: bundle.sensitivityTable.empiricalLimitation,
      },
      publicationState: 'pending_write',
      bundle,
      context,
    };
  } finally {
    clearStage17Gaps();
  }
}

function generateStage19Markdown(audit) {
  const lines = [
    '# Stage 19 — Dataset-Wide Lane-Interval Sensitivity & BEV Evidence Audit',
    '',
    `**Date:** ${audit.auditedAt?.slice(0, 10)}`,
    `**Status:** ${audit.stage19Status}`,
    `**Implementation checkpoint:** \`${audit.stage19ImplementationCheckpoint}\``,
    `**Processing version:** \`${audit.stage19ProcessingVersion}\``,
    `**Frozen v11 baseline:** \`${audit.frozenV11ProcessingVersion}\``,
    '',
    '## Results',
    '',
    `- Run ID: \`${audit.runId}\``,
    `- Genuine cross-pass candidates: ${audit.genuineCrossPassCandidateCount}`,
    `- Measured conflicts: ${audit.crossPassConflictCount} (evidence available: ${audit.conflictEvidenceAvailable})`,
    `- Insufficient-evidence intervals: ${audit.insufficientEvidenceIntervalCount}`,
    `- Singleton chains: ${audit.singletonChainCount}`,
    `- BEV PNG images: ${audit.bevImageCount}`,
    '',
  ];
  return lines.join('\n');
}

async function runAndWriteStage19Audit(root, options = {}) {
  const audit = await buildStage19DatasetSensitivityAudit(root, options);
  const publicationRoot = path.join(root, options.bundleDir || 'stage19_bundle');
  const pub = await writeStage19Bundle(audit.bundle, publicationRoot, {
    allowExistingRunDir: true,
    ...(options.publicationOptions || {}),
  });

  const reportDir = path.join(root, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });

  const auditPath = path.join(root, options.auditOut || 'audit_stage19_dataset_sensitivity.json');
  const auditOut = { ...audit, publicationState: 'published', publicationRoot, runDir: pub.runDir };
  delete auditOut.bundle;
  delete auditOut.context;
  fs.writeFileSync(auditPath, JSON.stringify(auditOut, null, 2));
  fs.writeFileSync(path.join(reportDir, 'stage19_bev_production_audit.json'), JSON.stringify(audit.productionAudit?.bev || {}, null, 2));
  fs.writeFileSync(path.join(reportDir, 'stage19_p3_production_audit.json'), JSON.stringify(audit.productionAudit?.p3 || {}, null, 2));
  fs.writeFileSync(path.join(reportDir, 'stage19_dataset_sensitivity.md'), generateStage19Markdown(auditOut));

  return { audit: auditOut, bundleDir: pub.runDir, auditPath, publication: pub };
}

module.exports = {
  EXPECTED_OBS_COUNT,
  EXPECTED_GAP_COUNT,
  EXPECTED_INTERVAL_COUNT,
  buildStage19DatasetSensitivityAudit,
  generateStage19Markdown,
  runAndWriteStage19Audit,
};
