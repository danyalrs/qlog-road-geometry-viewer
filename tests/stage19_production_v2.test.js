'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { verifyNormativeBindingsAgainstPackage } = require('../lib/stage19_normative_verify');
const { buildStage19InputContext } = require('../lib/stage19_stage18_loader');
const { injectStage17Gaps, clearStage17Gaps } = require('../lib/stage19_runtime');
const { buildStage19Bundle } = require('../lib/stage19_bundle_builder');
const { isPngSignature } = require('../lib/stage19_bev_png');
const { STAGE19_IMPLEMENTATION_CHECKPOINT } = require('../lib/stage19_version');

const ROOT = path.join(__dirname, '..');

describe('Stage 19 v3 production integration', () => {
  it('uses v3 checkpoint and preserves normative bindings', () => {
    assert.equal(STAGE19_IMPLEMENTATION_CHECKPOINT, '2026-07-27-stage19-v5');
    const v = verifyNormativeBindingsAgainstPackage();
    assert.equal(v.ok, true);
  });

  it('builds full bundle with PNG payloads and schema-valid bev', async () => {
    const context = buildStage19InputContext(ROOT);
    injectStage17Gaps(context.gaps);
    try {
      const bundle = await buildStage19Bundle(context, { runId: 'stage19-v2-integration-test' });
      assert.equal(bundle.genuineCrossPassCandidateCount ?? bundle.crossPassCandidateCount, 0);
      assert.equal(bundle.insufficientEvidenceIntervalCount, 5);
      assert.equal(bundle.schemaValidation.ok, true);
      assert.equal(bundle.qualityGates.ok, true);
      for (const [rel, bytes] of Object.entries(bundle.payloadFiles)) {
        if (rel.endsWith('.png')) assert.equal(isPngSignature(bytes), true);
      }
      assert.equal(Object.prototype.hasOwnProperty.call(bundle.bundleDocs['bev_v0.json'] || {}, '_productionMeta'), false);
    } finally {
      clearStage17Gaps();
    }
  });

  it('preserves v1 rollback checkpoint file', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'checkpoints/stage19-implementation-pre-v1.json')));
    assert.ok(fs.existsSync(path.join(ROOT, 'checkpoints/stage19-implementation-pre-v2.json')));
  });
});
