#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { injectStage17Gaps, clearStage17Gaps } = require('../lib/stage19_runtime');
const { buildStage19InputContext } = require('../lib/stage19_stage18_loader');
const { validateManifest, loadManifest, isQlogInWorkspace } = require('../lib/stage20_b_motion_manifest_validate');

const ROOT = path.join(__dirname, '..');
const DEFAULT_MANIFEST = path.join(ROOT, 'deliverables', 'stage20-b-motion-evidence-review-manifest.json');
const DEFAULT_REPORT = path.join(ROOT, 'deliverables', 'stage20-b-motion-manifest-validation-report.json');

function main() {
  const manifestPath = process.argv[2] || DEFAULT_MANIFEST;
  const reportPath = process.argv[3] || DEFAULT_REPORT;
  const manifest = loadManifest(manifestPath);

  injectStage17Gaps();
  let observationById;
  try {
    const context = buildStage19InputContext(ROOT);
    observationById = context.observationById;
  } catch (err) {
    console.error(`FK context load failed: ${err.message}`);
    observationById = null;
  } finally {
    clearStage17Gaps();
  }

  const qlogAvailability = {};
  for (const pair of manifest.reviewPairs || []) {
    if (pair.qlogReference) {
      qlogAvailability[pair.qlogReference] = isQlogInWorkspace(ROOT, pair.qlogReference);
    }
  }

  const result = validateManifest(manifest, { root: ROOT, observationById });
  const report = {
    generatedAt: new Date().toISOString(),
    manifestPath: path.relative(ROOT, manifestPath),
    ok: result.ok,
    issueCount: result.issueCount,
    warningCount: result.warningCount,
    pairCount: result.pairCount,
    uniquePairIds: result.uniquePairIds,
    codesPresent: result.codesPresent,
    fkResolutionEnabled: observationById != null,
    observationCount: observationById?.size ?? null,
    qlogAvailabilitySummary: {
      referenced: Object.keys(qlogAvailability).length,
      availableInWorkspace: Object.values(qlogAvailability).filter(Boolean).length,
      missing: Object.entries(qlogAvailability).filter(([, v]) => !v).map(([k]) => k),
    },
    warnings: result.warnings,
    issues: result.issues,
    note: 'No records were repaired — validation is read-only',
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: report.ok,
    issueCount: report.issueCount,
    pairCount: report.pairCount,
    reportPath: path.relative(ROOT, reportPath),
  }, null, 2));

  if (!report.ok) process.exit(1);
}

main();
