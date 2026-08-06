'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PROCESSING_VERSION } = require('../lib/version');
const {
  buildStage19DatasetSensitivityAudit,
  EXPECTED_OBS_COUNT,
  EXPECTED_GAP_COUNT,
  EXPECTED_INTERVAL_COUNT,
} = require('../lib/stage19_dataset_sensitivity_audit');
const { STAGE19_PROCESSING_VERSION, STAGE19_IMPLEMENTATION_CHECKPOINT } = require('../lib/stage19_version');

const ROOT = path.join(__dirname, '..');

describe('Stage 19 dataset sensitivity audit v2', () => {
  it('uses v2 implementation checkpoint', () => {
    assert.equal(STAGE19_IMPLEMENTATION_CHECKPOINT, '2026-07-27-stage19-v5');
    assert.notEqual(STAGE19_PROCESSING_VERSION, PROCESSING_VERSION);
  });

  it('builds audit with PNG BEV and corrected counters', async () => {
    const audit = await buildStage19DatasetSensitivityAudit(ROOT);
    assert.equal(audit.observationCount, EXPECTED_OBS_COUNT);
    assert.equal(audit.gapExclusionCount, EXPECTED_GAP_COUNT);
    assert.equal(audit.acceptedIntervalCount, EXPECTED_INTERVAL_COUNT);
    assert.equal(audit.genuineCrossPassCandidateCount, 0);
    assert.equal(audit.insufficientEvidenceIntervalCount, 5);
    assert.equal(audit.crossPassConflictCount, 0);
    assert.equal(audit.conflictEvidenceAvailable, false);
    assert.equal(audit.schemaValidation.ok, true);
    assert.equal(audit.productionQualityGates.ok, true);
    assert.ok(audit.bevImageCount >= 1);
    assert.ok(audit.bevArtifacts.every((a) => a.mime === 'image/png'));
    assert.equal(audit.singletonChainCount, 5809);
    assert.equal(audit.nonTrivialPartitionCount, 0);
    assert.equal(audit.p3Stats.executed, 0);
  });

  it('does not modify v11 version constant', () => {
    const versionText = fs.readFileSync(path.join(ROOT, 'lib/version.js'), 'utf8');
    assert.match(versionText, /2026-07-24-fusion-v12/);
  });
});
