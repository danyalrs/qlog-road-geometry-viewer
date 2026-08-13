'use strict';

/**
 * Measure stationary-pose drift on qlog_f449c_6 and qlog_f449c_9.
 * Reports per-frame speed, movement state, displacement, heading change,
 * and the pose used to transform lane observations.
 */

const { processRoute } = require('../lib/process_route');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const { interpolateGpsAtTime, enrichGpsHeadings } = require('../lib/alignment');
const { classifyMovementStates } = require('../lib/movement_state');

function latLonToEastNorth(lat, lon, refLat, refLon) {
  const R = 6371000;
  const dLat = (lat - refLat) * Math.PI / 180;
  const dLon = (lon - refLon) * Math.PI / 180;
  const e = dLon * Math.cos(refLat * Math.PI / 180) * R;
  const n = dLat * R;
  return { east: e, north: n };
}

function measure(seg) {
  const file = `qlog_f449c_${seg}.bz2`;
  const me = extractModel(file).map((e) => ({ ...e, sourceFile: file }));
  const ge = extractGps(file).map((e) => ({ ...e, sourceFile: file }));
  const r = processRoute(me, ge, { pipelineMode: 'C' });

  // Build a per-frame GPS pose table (interpolated at model times)
  const enriched = enrichGpsHeadings(ge.map((g) => ({ ...g })));
  const refLat = ge[0].latitude, refLon = ge[0].longitude;
  for (const g of ge) {
    const p = latLonToEastNorth(g.latitude, g.longitude, refLat, refLon);
    g.east = p.east; g.north = p.north;
  }
  const frames = r.frames || [];
  const poseTable = [];
  for (const f of frames) {
    const gps = interpolateGpsAtTime(ge, f.logMonoTime, 2e9);
    poseTable.push({
      logMonoTime: f.logMonoTime,
      frameIndex: f.frameIndex,
      east: gps?.east ?? null,
      north: gps?.north ?? null,
      speed: gps?.speed ?? 0,
      headingDeg: gps?.headingDeg ?? 0,
      bearingAccuracyDeg: gps?.bearingAccuracyDeg ?? null,
      horizontalAccuracy: gps?.horizontalAccuracy ?? null,
    });
  }

  // movement state from GPS displacement + speed
  const pts = poseTable.filter((p) => p.east != null).map((p) => ({
    east: p.east, north: p.north, speed: p.speed, logMonoTime: p.logMonoTime, headingDeg: p.headingDeg,
  }));
  const mov = classifyMovementStates(pts);
  for (let i = 0; i < mov.states.length; i++) {
    poseTable.find((p) => p.east != null).state = undefined; // placeholder
  }
  let stateIdx = 0;
  for (const p of poseTable) {
    if (p.east != null) { p.movementState = mov.states[stateIdx]?.state; stateIdx++; }
    else p.movementState = 'no-gps';
  }

  // drift statistics over the whole segment
  const eastVals = poseTable.filter((p) => p.east != null).map((p) => p.east);
  const northVals = poseTable.filter((p) => p.north != null).map((p) => p.north);
  const minE = Math.min(...eastVals), maxE = Math.max(...eastVals);
  const minN = Math.min(...northVals), maxN = Math.max(...northVals);
  const driftRange = Math.hypot(maxE - minE, maxN - minN);
  // per-step displacement
  const disp = [];
  const headingChange = [];
  let falseTravel = 0;
  for (let i = 1; i < poseTable.length; i++) {
    const a = poseTable[i - 1], b = poseTable[i];
    if (a.east == null || b.east == null) continue;
    const d = Math.hypot(b.east - a.east, b.north - a.north);
    disp.push(d);
    falseTravel += d;
    let hd = Math.abs(b.headingDeg - a.headingDeg);
    if (hd > 180) hd = 360 - hd;
    headingChange.push(hd);
  }
  disp.sort((a, b) => a - b);
  headingChange.sort((a, b) => a - b);
  const pct = (arr, q) => arr[Math.floor(arr.length * q)];

  // movement state change count
  let transitions = 0;
  for (let i = 1; i < poseTable.length; i++) {
    if (poseTable[i].movementState !== poseTable[i - 1].movementState) transitions++;
  }
  // state distribution
  const stateCounts = {};
  for (const p of poseTable) stateCounts[p.movementState] = (stateCounts[p.movementState] || 0) + 1;

  return {
    seg,
    frames: frames.length,
    gpsRecords: ge.length,
    driftRangeM: +driftRange.toFixed(3),
    perStepDisplacementM: {
      median: +pct(disp, 0.5).toFixed(3),
      p95: +pct(disp, 0.95).toFixed(3),
      max: +disp[disp.length - 1].toFixed(3),
    },
    headingChangeDeg: {
      median: +pct(headingChange, 0.5).toFixed(2),
      p95: +pct(headingChange, 0.95).toFixed(2),
      max: +headingChange[headingChange.length - 1].toFixed(2),
    },
    accumulatedFalseTravelM: +falseTravel.toFixed(2),
    firstLastDistanceM: poseTable.filter((p) => p.east != null).length >= 2
      ? +Math.hypot(poseTable[0].east - poseTable[poseTable.length - 1].east, poseTable[0].north - poseTable[poseTable.length - 1].north).toFixed(3)
      : null,
    stateTransitions: transitions,
    stateCounts,
    speeds: {
      min: +Math.min(...poseTable.map((p) => p.speed)).toFixed(3),
      max: +Math.max(...poseTable.map((p) => p.speed)).toFixed(3),
    },
    // first/last frame detail
    firstFrame: poseTable.slice(0, 8).map((p) => ({ fi: p.frameIndex, speed: +p.speed.toFixed(2), state: p.movementState, disp: p.east != null ? +Math.hypot(p.east - poseTable[0].east, p.north - poseTable[0].north).toFixed(2) : null })),
  };
}

for (const seg of ['6', '9']) {
  const m = measure(seg);
  console.log('=== seg', seg, '===');
  console.log(JSON.stringify(m, null, 1));
}
