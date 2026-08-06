#!/usr/bin/env node
/**
 * Stage 20 Amendment A — build lane_divider_supported_runs_v1.json
 */
const path = require('path');
const { writeV1Artifact } = require('./lib/stage20_amendment_a_emit');
const { evaluateCrossPassFromArtifacts, discoverCrossSegmentKeyCollisions } = require('./lib/stage20_amendment_a_cross_pass');

const ROOT = __dirname;

function main() {
  const out = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : 'lane_divider_supported_runs_v1.json';

  const result = writeV1Artifact(ROOT, out, {
    createdAt: process.env.AMENDMENT_A_FIXED_TIMESTAMP || new Date().toISOString(),
  });

  const crossPass = evaluateCrossPassFromArtifacts(result.artifact, null);
  const keyCollisions = discoverCrossSegmentKeyCollisions(result.artifact.supportedRuns);

  console.log('Stage 20 Amendment A — supported runs v1');
  console.log(`  Checkpoint: ${result.artifact.implementationCheckpoint}`);
  console.log(`  Schema: ${result.artifact.schemaVersion}`);
  console.log(`  Supported runs: ${result.artifact.supportedRunCount}`);
  console.log(`  Rejected at emission: ${result.artifact.rejectedRunCount}`);
  console.log(`  Content hash: ${result.artifact.contentHashSha256}`);
  console.log(`  Validation valid: ${result.validation.valid}`);
  console.log(`  Cross-segment key collisions: ${keyCollisions.length}`);
  console.log(`  Structural candidates: ${crossPass.counts?.structural ?? 0}`);
  console.log(`  Genuine evidence: ${crossPass.counts?.genuine ?? 0}`);
  console.log(`  Wrote ${result.outPath}`);
}

if (require.main === module) main();

module.exports = { main };
