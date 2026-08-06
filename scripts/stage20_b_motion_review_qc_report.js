#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadManifest } = require('../lib/stage20_b_motion_manifest_validate');
const { loadReviewsArtifact } = require('../lib/stage20_b_motion_review_store');
const {
  DEFAULT_SOURCE_REVIEWS_PATH,
  DEFAULT_QC_REVIEWS_PATH,
  buildQcChangeReport,
  buildQcProgressReport,
  verifyQcArtifact,
} = require('../lib/stage20_b_motion_review_qc');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'deliverables', 'stage20-b-motion-evidence-review-manifest.json');
const SOURCE_PATH = path.join(ROOT, DEFAULT_SOURCE_REVIEWS_PATH);
const QC_PATH = path.join(ROOT, DEFAULT_QC_REVIEWS_PATH);

function main() {
  const manifest = loadManifest(MANIFEST_PATH);
  const manifestRel = path.relative(ROOT, MANIFEST_PATH);

  if (!fs.existsSync(QC_PATH)) {
    console.error(`QC artifact not found: ${path.relative(ROOT, QC_PATH)}`);
    process.exit(1);
  }

  const baseline = loadReviewsArtifact(SOURCE_PATH, manifest, manifestRel);
  const qcArtifact = loadReviewsArtifact(QC_PATH, manifest, manifestRel);
  const verification = verifyQcArtifact(qcArtifact);
  const progress = buildQcProgressReport(qcArtifact);
  const changes = buildQcChangeReport(qcArtifact, baseline);

  const report = {
    generatedAt: new Date().toISOString(),
    qcArtifact: path.relative(ROOT, QC_PATH),
    sourceArtifact: path.relative(ROOT, SOURCE_PATH),
    verification,
    progress,
    changes,
  };

  const outPath = path.join(ROOT, 'deliverables', 'stage20-b-motion-qc-report.json');
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log('B-MOTION QC report');
  console.log(`  reviews: ${verification.reviewCount} (unique pair IDs: ${verification.uniquePairIds})`);
  console.log(`  integrity: ${verification.ok ? 'OK' : 'FAILED'}`);
  console.log(`  QC progress: ${progress.qcReviewed} / ${progress.qcTargetCount} (remaining ${progress.qcRemaining})`);
  console.log(`  changed labels/notes: ${changes.changedRecordCount}`);
  console.log(`  QC reviewed: ${changes.qcReviewedCount}`);
  console.log('  final label counts:', changes.finalLabelCounts);
  if (changes.changes.length) {
    console.log('  changed records:');
    for (const c of changes.changes) {
      if (!c.labelChanged && !c.noteChanged && !c.evidenceChanged) continue;
      console.log(`    [${c.recordIndex}] ${c.reviewPairId}: ${c.previousReviewerLabel} -> ${c.reviewerLabel}`);
    }
  }
  console.log(`Report written: ${path.relative(ROOT, outPath)}`);

  if (!verification.ok) process.exit(1);
}

if (require.main === module) main();

module.exports = { main };
