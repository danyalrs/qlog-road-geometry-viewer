'use strict';

const path = require('path');
const { buildStage19InputContext } = require('../../lib/stage19_stage18_loader');
const { injectStage17Gaps, clearStage17Gaps } = require('../../lib/stage19_runtime');
const { buildStage19Bundle } = require('../../lib/stage19_bundle_builder');
const { publishProductionBundle } = require('../../lib/stage19_publication_production');

const ROOT = path.join(__dirname, '..', '..');
const pubRoot = process.argv[2];
const runId = process.argv[3];

(async () => {
  try {
    const context = buildStage19InputContext(ROOT);
    injectStage17Gaps(context.gaps);
    const bundle = await buildStage19Bundle(context, { runId });
    clearStage17Gaps();
    await publishProductionBundle(pubRoot, bundle, { allowExistingRunDir: true });
    process.send?.({ ok: true });
  } catch (e) {
    process.send?.({ ok: false, error: String(e.message || e) });
  }
  process.exit(0);
})();
