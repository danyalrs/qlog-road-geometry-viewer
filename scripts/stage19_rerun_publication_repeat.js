'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildStage19InputContext } = require('../lib/stage19_stage18_loader');
const { injectStage17Gaps, clearStage17Gaps } = require('../lib/stage19_runtime');
const { buildStage19Bundle } = require('../lib/stage19_bundle_builder');
const { publishProductionBundle } = require('../lib/stage19_publication_production');

const ROOT = path.join(__dirname, '..');
const REPETITIONS = parseInt(process.env.STAGE19_RERUN_REPEAT || '30', 10);

async function buildMinimalBundle(runId) {
  const context = buildStage19InputContext(ROOT);
  injectStage17Gaps(context.gaps);
  try {
    return await buildStage19Bundle(context, { runId });
  } finally {
    clearStage17Gaps();
  }
}

(async () => {
  const results = { repetitions: REPETITIONS, pass: 0, fail: 0, errors: [] };
  for (let i = 0; i < REPETITIONS; i++) {
    const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), `stage19-rerun-${i}-`));
    const runId = 'stage19-overlap-rerun-test';
    try {
      const b1 = await buildMinimalBundle(runId);
      await publishProductionBundle(pubRoot, b1, { allowExistingRunDir: true });
      const manifest1 = fs.readFileSync(path.join(pubRoot, 'runs', runId, 'manifest_v0.json'), 'utf8');
      const b2 = await buildMinimalBundle(runId);
      await publishProductionBundle(pubRoot, b2, { allowExistingRunDir: true });
      const manifest2 = fs.readFileSync(path.join(pubRoot, 'runs', runId, 'manifest_v0.json'), 'utf8');
      if (manifest1 !== manifest2) throw new Error('manifest_mismatch');
      if (fs.existsSync(path.join(pubRoot, '.staging', runId))) throw new Error('staging_residue');
      results.pass += 1;
    } catch (e) {
      results.fail += 1;
      results.errors.push({ iteration: i, error: String(e.message || e) });
    }
  }
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.fail > 0 ? 1 : 0);
})();
