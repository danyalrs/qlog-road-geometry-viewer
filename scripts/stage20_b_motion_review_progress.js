#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadManifest } = require('../lib/stage20_b_motion_manifest_validate');
const { loadReviewsArtifact, DEFAULT_REVIEWS_PATH } = require('../lib/stage20_b_motion_review_store');
const { buildProgressReport } = require('../lib/stage20_b_motion_review_progress');
const { assignCalibrationValidationSplit } = require('../lib/stage20_b_motion_review_split');

const ROOT = path.join(__dirname, '..');
const DEFAULT_MANIFEST = path.join(ROOT, 'deliverables', 'stage20-b-motion-evidence-review-manifest.json');

function main() {
  const manifestPath = process.argv[2] || DEFAULT_MANIFEST;
  const reviewsPath = process.argv[3] || path.join(ROOT, DEFAULT_REVIEWS_PATH);
  const manifest = loadManifest(manifestPath);
  const reviews = loadReviewsArtifact(reviewsPath, manifest, path.relative(ROOT, manifestPath));
  const progress = buildProgressReport(manifest, reviews, { root: ROOT });
  const split = assignCalibrationValidationSplit(manifest.reviewPairs || []);

  const report = {
    ...progress,
    split: {
      seed: split.seed,
      calibrationPairCount: split.calibrationPairCount,
      validationPairCount: split.validationPairCount,
      coverage: split.coverage,
    },
  };

  const outPath = path.join(ROOT, 'deliverables', 'stage20-b-motion-review-progress.json');
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main();
