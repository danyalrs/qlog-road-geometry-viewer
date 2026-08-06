#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadManifest } = require('../lib/stage20_b_motion_manifest_validate');
const { buildReviewBatches } = require('../lib/stage20_b_motion_review_batches');
const { isQlogInWorkspace } = require('../lib/stage20_b_motion_manifest_validate');

const ROOT = path.join(__dirname, '..');
const DEFAULT_MANIFEST = path.join(ROOT, 'deliverables', 'stage20-b-motion-evidence-review-manifest.json');

function main() {
  const manifestPath = process.argv[2] || DEFAULT_MANIFEST;
  const manifest = loadManifest(manifestPath);
  const pairs = (manifest.reviewPairs || []).map((p) => ({
    ...p,
    videoAvailableInWorkspace: p.qlogReference ? isQlogInWorkspace(ROOT, p.qlogReference) : false,
  }));
  const batches = buildReviewBatches(pairs);

  const report = {
    generatedAt: new Date().toISOString(),
    manifestPath: path.relative(ROOT, manifestPath),
    totalPairs: pairs.length,
    batchCount: batches.length,
    batchSizeRange: { min: 20, max: 30, target: 25 },
    batches,
    note: 'ruleDerivedPositiveContinuations in coverage are not manual positives',
  };

  const outPath = path.join(ROOT, 'deliverables', 'stage20-b-motion-review-batches.json');
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    batchCount: batches.length,
    totalPairs: pairs.length,
    outPath: path.relative(ROOT, outPath),
  }, null, 2));
}

main();
