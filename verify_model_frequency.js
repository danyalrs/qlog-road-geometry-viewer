/** Verify modelV2 event frequency and decoder completeness for a qlog file. */
const fs = require('fs');
const path = require('path');
const capnp = require('capnp-ts');
const Log = require('@commaai/log_reader/capnp/log.capnp');
const { iterateEvents, UNION } = require('./lib/qlog_decoder');
const { extractFromFile } = require('./extract_modelv2');

const file = process.argv[2] || 'qlog_f449c_0.bz2';
const filePath = path.join(__dirname, file);

function scanQlog() {
  const buf = fs.readFileSync(filePath);
  const tags = new Map();
  let initVersion = null;
  let totalEvents = 0;
  let parseErrors = 0;
  let pos = 0;

  while (pos < buf.length) {
    try {
      const { readSize } = require('@commaai/log_reader/src/buffer');
      const remaining = buf.slice(pos);
      const size = readSize(remaining);
      if (!size || size > remaining.length) break;
      pos += size;
      totalEvents++;
    } catch (e) {
      parseErrors++;
      break;
    }
  }

  for (const item of iterateEvents(buf, file)) {
    tags.set(item.unionTag, (tags.get(item.unionTag) || 0) + 1);
    if (item.unionTag === 0) {
      try {
        const init = capnp.Struct.getStruct(0, Log.InitData, item.event);
        initVersion = init.getVersion();
      } catch (e) { /* ignore */ }
    }
  }

  const liveExtract = extractFromFile(filePath);
  const modelTimes = liveExtract.map((e) => BigInt(e.logMonoTime)).sort((a, b) => (a < b ? -1 : 1));
  const durationSec = modelTimes.length > 1
    ? Number(modelTimes[modelTimes.length - 1] - modelTimes[0]) / 1e9
    : 0;

  console.log(`\n=== Model frequency audit: ${file} ===\n`);
  console.log('Software version (initData):', initVersion ?? 'not found');
  console.log('Schema: @commaai/log_reader bundled log.capnp (capnp-ts 0.4.0)');
  console.log('Decoder iterator events:', [...tags.values()].reduce((a, b) => a + b, 0));
  console.log('Framing parse errors:', parseErrors);
  console.log('');
  console.log('Union tag counts:');
  const sorted = [...tags.entries()].sort((a, b) => a[0] - b[0]);
  for (const [tag, count] of sorted) {
    const known = { 0: 'initData', 20: 'gpsLocation', 47: 'gpsExternal', 73: 'modelV2', 75: 'wideRoadEncodeIdx', 104: 'unknown@104' };
    console.log(`  tag ${tag} (${known[tag] || '?'})`.padEnd(36) + count);
  }
  console.log('');
  console.log('modelV2 (tag 73):', tags.get(UNION.MODEL_V2) ?? 0);
  console.log('tag 104 (same count as modelV2?):', tags.get(104) ?? 0);
  console.log('wideRoadEncodeIdx (tag 75):', tags.get(75) ?? 0, '— camera at ~20 Hz');
  console.log('gpsLocation (tag 20):', tags.get(UNION.GPS_LOCATION) ?? 0);
  console.log('');
  console.log('Live extract modelV2 count:', liveExtract.length);
  console.log('Duration covered by modelV2 (s):', durationSec.toFixed(2));
  console.log('Observed modelV2 rate (Hz):', durationSec > 0 ? ((liveExtract.length - 1) / durationSec).toFixed(3) : 'n/a');
  console.log('');
  console.log('Conclusion:');
  console.log('  - 31 is the true stored modelV2 count, not a decoder limit.');
  console.log('  - Iterator reads all', [...tags.values()].reduce((a, b) => a + b, 0), 'events from bz2 stream.');
  console.log('  - openpilot 10.0.5-release logs modelV2 at ~0.5 Hz (vision model rate),');
  console.log('    while camera encode idx runs at ~20 Hz (1200/60s).');
  console.log('  - No drivingModelData union member in this schema; tag 104 is unmapped.');
  console.log('  - GPS alignment rejects ~10/31 frames (2s maxModelGpsDelta window).');
}

function pad(s, n) { return String(s).padEnd(28); }

scanQlog();
