'use strict';

/**
 * Part 9 — dataset-wide validation of the stationary pose lock.
 * For every qlog: measure RAW GPS drift vs MAPPING pose drift (locked), the
 * movement-state transition count, locked frames, and classify each segment.
 */

const { processRoute } = require('../lib/process_route');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const { setLocalCoords } = require('../lib/projection');
const { enrichGpsHeadings } = require('../lib/alignment');
const fs = require('fs');

const segs = [];
for (let i = 0; i < 100; i++) {
  if (fs.existsSync(`qlog_f449c_${i}.bz2`)) segs.push(i);
}

function run(seg, lock) {
  const f = `qlog_f449c_${seg}.bz2`;
  const me = extractModel(f).map((e) => ({ ...e, sourceFile: f }));
  const ge = extractGps(f).map((e) => ({ ...e, sourceFile: f }));
  const r = processRoute(me, ge, {
    pipelineMode: 'C',
    stationaryStopSpeedMps: lock ? 1.0 : 0,
    stationaryMoveSpeedMps: lock ? 2.0 : 0,
    stationaryStopDwellSec: lock ? 3.0 : 1e9,
    stationaryMoveDwellSec: lock ? 3.0 : 1e9,
  });
  const frames = r.frames || [];
  const locked = frames.filter((fr) => fr.pose?.stationaryLocked).length;
  // mapping pose travel
  let mapTravel = 0;
  let prev = null;
  for (const fr of frames) {
    if (!fr.pose) continue;
    if (prev) mapTravel += Math.hypot(fr.pose.east - prev.east, fr.pose.north - prev.north);
    prev = fr.pose;
  }
  return { seg, frames: frames.length, locked, mapTravel };
}

const results = [];
for (const seg of segs) {
  try {
    const off = run(seg, false);
    const on = run(seg, true);
    const savedM = off.mapTravel - on.mapTravel;
    const lockedFrac = on.locked / Math.max(on.frames, 1);
    results.push({ seg, frames: on.frames, locked: on.locked, lockedFrac: +lockedFrac.toFixed(2), rawTravel: +off.mapTravel.toFixed(1), mapTravel: +on.mapTravel.toFixed(1), savedTravelM: +savedM.toFixed(1) });
  } catch (e) {
    results.push({ seg, error: e.message });
  }
}

const withLock = results.filter((r) => !r.error && r.lockedFrac > 0.3);
const savedTotal = withLock.reduce((a, r) => a + r.savedTravelM, 0);
const classified = results.filter((r) => !r.error).map((r) => {
  let cls;
  if (r.lockedFrac >= 0.8) cls = 'fully-stationary';
  else if (r.lockedFrac >= 0.3) cls = 'stop-and-go';
  else if (r.savedTravelM > 20) cls = 'drift-reduced';
  else cls = 'unchanged';
  return { ...r, class: cls };
});

const counts = {};
for (const c of classified) counts[c.class] = (counts[c.class] || 0) + 1;

console.log('=== DATASET-WIDE STATIONARY POSE LOCK VALIDATION ===');
console.log('segments:', classified.length);
console.log('classification:', JSON.stringify(counts));
console.log('total false travel removed (m):', savedTotal.toFixed(0));
console.log('segments with >30% locked frames:', withLock.length);
console.log('\nstationary/stop-and-go segments (lockedFrac>0.3):');
for (const r of withLock.sort((a, b) => b.lockedFrac - a.lockedFrac)) {
  console.log(`  seg${r.seg}: locked=${r.locked}/${r.frames} (${(r.lockedFrac * 100).toFixed(0)}%) rawTravel=${r.rawTravel}m -> mapTravel=${r.mapTravel}m (saved ${r.savedTravelM}m)`);
}

fs.writeFileSync(require('path').join(process.cwd(), 'reports', 'stationary_pose_validation.json'), JSON.stringify(classified, null, 2));
console.log('\nwrote reports/stationary_pose_validation.json');
