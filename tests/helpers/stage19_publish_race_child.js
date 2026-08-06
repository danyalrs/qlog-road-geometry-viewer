'use strict';

const path = require('path');
const { buildStage19InputContext } = require('../../lib/stage19_stage18_loader');
const { injectStage17Gaps, clearStage17Gaps } = require('../../lib/stage19_runtime');
const { buildStage19Bundle } = require('../../lib/stage19_bundle_builder');
const { publishProductionBundle } = require('../../lib/stage19_publication_production');

const ROOT = path.join(__dirname, '..', '..');
const pubRoot = process.argv[2];
const runId = process.argv[3];
const slot = process.argv[4] || '0';

(async () => {
  try {
    if (slot === 'wait') {
      await new Promise((r) => {
        process.on('message', (msg) => { if (msg === 'go') r(); });
      });
    }
    const context = buildStage19InputContext(ROOT);
    injectStage17Gaps(context.gaps);
    const bundle = await buildStage19Bundle(context, { runId });
    clearStage17Gaps();
    const pub = await publishProductionBundle(pubRoot, bundle, {
      allowExistingRunDir: true,
      hostId: `race-child-${slot}`,
    });
    process.send?.({ ok: true, slot, runId: pub.runDir });
  } catch (e) {
    process.send?.({ ok: false, slot, error: String(e.message || e) });
  }
  process.exit(0);
})();
