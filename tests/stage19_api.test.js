'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadStage19Summary } = require('../server');
const { STAGE19_IMPLEMENTATION_CHECKPOINT, STAGE19_CHECKPOINT_PRESERVATION } = require('../lib/stage19_version');

const ROOT = path.join(__dirname, '..');

describe('Stage 19 API summary v3', () => {
  it('reports v3 checkpoint and truthful preservation', () => {
    assert.equal(STAGE19_IMPLEMENTATION_CHECKPOINT, '2026-07-27-stage19-v5');
    assert.equal(STAGE19_CHECKPOINT_PRESERVATION.v0.preservation, 'checkpoint-only');
    const data = loadStage19Summary();
    assert.equal(data.implementationCheckpoint, '2026-07-27-stage19-v5');
    assert.equal(data.checkpointPreservation?.v0?.preservation, 'checkpoint-only');
    assert.equal(data.checkpointPreservation?.v1?.preservation, 'immutable-run');
    if (data.available) {
      assert.equal(typeof data.insufficientEvidenceIntervalCount, 'number');
    }
  });

  it('handles missing audit gracefully', () => {
    const auditPath = path.join(ROOT, 'audit_stage19_dataset_sensitivity.json');
    const backup = auditPath + '.bak';
    let restored = false;
    if (fs.existsSync(auditPath)) {
      fs.renameSync(auditPath, backup);
      restored = true;
    }
    try {
      assert.equal(loadStage19Summary().available, false);
    } finally {
      if (restored) fs.renameSync(backup, auditPath);
    }
  });
});
