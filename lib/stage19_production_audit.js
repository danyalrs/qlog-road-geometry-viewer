'use strict';

/**
 * Production-only audit metadata — not published in schema-bound bundle artifacts.
 */
function buildBevProductionAudit(runId, bevArtifactLoad) {
  return {
    schemaVersion: 'stage19_bev_production_audit_v0',
    runId,
    generatedAt: new Date().toISOString(),
    entries: (bevArtifactLoad.entries || []).map((e) => ({
      imageId: e.imageId,
      category: e.category,
      laneIntervalId: e.laneIntervalId,
      countAssessmentId: e.countAssessmentId,
      sourceArtifact: e.sourceArtifact,
      sourceSvgPath: e.sourcePath,
      sourceSvgSha256: e.sourceSvgSha256,
      pngPayloadPath: e.payloadPath,
      pngSha256: e.sha256,
      widthPx: e.widthPx,
      heightPx: e.heightPx,
      bytes: e.bytes,
      mime: e.mime,
      layerValidation: e.layerValidation,
      provenance: e.provenance,
    })),
  };
}

function buildP3ProductionAudit(runId, partitionResults) {
  const chains = partitionResults || [];
  return {
    schemaVersion: 'stage19_p3_production_audit_v0',
    runId,
    eligible: chains.filter((c) => c.p3Eligible).length,
    executed: chains.filter((c) => c.p3Executed).length,
    selected: chains.filter((c) => c.branchSelection?.ok).length,
    failed: chains.filter((c) => c.p3Executed && !c.branchSelection?.ok).length,
    singletonSkipped: chains.filter((c) => c.chainLength === 1).length,
    records: chains.filter((c) => c.p3Executed).map((c) => ({
      unitKey: c.unitKey,
      chainLength: c.chainLength,
      p3Ok: c.p3Result?.ok,
      branchSelectionOk: c.branchSelection?.ok,
      branchSelectionValue: c.branchSelection?.value,
      branchSelectionReason: c.branchSelection?.reason,
    })),
  };
}

module.exports = {
  buildBevProductionAudit,
  buildP3ProductionAudit,
};
