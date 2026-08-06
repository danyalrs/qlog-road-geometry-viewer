#!/usr/bin/env node
/**
 * CLI: verify qlog file identity — size, SHA-256, message counts, timestamps.
 * Usage: node verify_file_identity.js [qlog_f449c_6.bz2 ...]
 */
const path = require('path');
const { auditQlogFile } = require('./lib/qlog_audit');
const fs = require('fs');

const KNOWN = {
  'qlog_f449c_5.bz2': {
    size: 2788736,
    sha256: 'daeee538824df59b343efbc84fe58c2f96b138c8ad9ca040f4969a57ba739419',
    modelV2: 30,
    gps: 60,
    kalman: 240,
  },
  'qlog_f449c_6.bz2': {
    size: 143360,
    sha256: 'cd5ddf28b7426399254ecd8af2ab2151e31562c5ad9a8994c475264114f99d86',
    modelV2: 1,
    gps: 2,
    kalman: 8,
  },
  'qlog_f449c_7.bz2': {
    size: 409600,
    sha256: 'e5359114de851f49240af81090d82ec3e40e275b3772c2bd5d55a92be701c773',
    modelV2: 4,
    gps: 8,
    kalman: 32,
  },
};

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['qlog_f449c_5.bz2', 'qlog_f449c_6.bz2', 'qlog_f449c_7.bz2'];

for (const f of files) {
  const p = path.resolve(f);
  if (!fs.existsSync(p)) {
    console.error('Missing:', p);
    continue;
  }
  const a = auditQlogFile(p);
  const known = KNOWN[a.filename];
  const match = known
    ? a.fileSizeBytes === known.size
      && a.sha256 === known.sha256
      && a.modelV2Count === known.modelV2
    : null;

  console.log('\n===', a.filename, '===');
  console.log('  path:    ', a.absolutePath);
  console.log('  size:    ', a.fileSizeBytes, known ? `(expected ${known.size})` : '');
  console.log('  sha256:  ', a.sha256);
  if (known && a.sha256 !== known.sha256) console.log('  EXPECTED:', known.sha256, '*** MISMATCH ***');
  console.log('  raw msgs:', a.rawMessageCount);
  console.log('  modelV2: ', a.modelV2Count, known ? `(expected ${known.modelV2})` : '');
  console.log('  GPS:     ', a.gpsCount);
  console.log('  Kalman:  ', a.liveLocationKalmanCount);
  console.log('  duration:', JSON.stringify(a.durationSec));
  console.log('  frameIds:', a.modelV2FrameIds.join(', '));
  console.log('  first:   ', JSON.stringify(a.firstTimestamp));
  console.log('  last:    ', JSON.stringify(a.lastTimestamp));
  console.log('  kalman gpsOK=false:', a.kalmanGpsOkFalse, 'positionInvalid:', a.kalmanPositionInvalid);
  console.log('  classification:', a.classification);
  if (known) console.log('  matches user reference:', match ? 'YES' : 'NO');
}
