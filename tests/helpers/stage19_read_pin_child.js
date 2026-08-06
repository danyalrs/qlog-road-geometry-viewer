'use strict';

const fs = require('fs');
const path = require('path');
const { acquireReaderPin } = require('../../lib/stage19_spec/recovery');

const pubRoot = process.argv[2];

(async () => {
  const pin = acquireReaderPin();
  try {
    const currentPath = path.join(pubRoot, 'current.json');
    const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
    const manifestPath = path.join(pubRoot, 'runs', current.runId, 'manifest_v0.json');
    const bytesBefore = fs.readFileSync(manifestPath);
    process.send?.({ phase: 'pinned', runId: current.runId, sha256: require('crypto').createHash('sha256').update(bytesBefore).digest('hex') });
    await new Promise((r) => {
      process.on('message', (msg) => { if (msg === 'release-check') r(); });
    });
    const bytesAfter = fs.readFileSync(manifestPath);
    const shaAfter = require('crypto').createHash('sha256').update(bytesAfter).digest('hex');
    process.send?.({ phase: 'verified', sha256: shaAfter, unchanged: shaAfter === require('crypto').createHash('sha256').update(bytesBefore).digest('hex') });
  } finally {
    pin.release();
    process.send?.({ phase: 'released' });
  }
  process.exit(0);
})();
