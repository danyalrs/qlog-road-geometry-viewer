'use strict';

/**
 * Audit of the EXPERIMENTAL constructed-fragment layer.
 *
 * The constructed lane-boundary fragments are a display-only diagnostic built
 * from the accumulated point dots. This audit measures how well they behave
 * across a sample of real segments: fragment counts, coverage, residual
 * quality, split reasons, physical-boundary separation, and non-modification
 * of the source points.
 *
 * This is an audit of an experimental output — it is NOT a production gate and
 * does not feed production lane geometry.
 */

const fs = require('fs');
const path = require('path');
const SLM = require('../lib/segment_local_map');
const CF = require('../lib/constructed_fragments');
const { processRoute } = require('../lib/process_route');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEGMENT_SAMPLE = process.argv.slice(2);
const FILES = SEGMENT_SAMPLE.length
  ? SEGMENT_SAMPLE.map((f) => (f.includes('.bz2') ? f : `qlog_f449c_${f}.bz2`))
  : ['qlog_f449c_0.bz2', 'qlog_f449c_7.bz2', 'qlog_f449c_13.bz2', 'qlog_f449c_14.bz2', 'qlog_f449c_22.bz2', 'qlog_f449c_50.bz2'];

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function runSegment(file) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) return { file, error: 'missing' };
  const me = extractModel(full).map((e) => ({ ...e, sourceFile: file }));
  const ge = extractGps(full).map((e) => ({ ...e, sourceFile: file }));
  const r = processRoute(me, ge, { pipelineMode: 'C' });
  const out = SLM.buildPointAccumulatedFragments(
    r.frames,
    r.frames.map((x, i) => ({ index: i, logMonoTime: x.logMonoTime })),
    { east: 0, north: 0, headingDeg: 0 }, 0, 0, r.routeChunks, {},
  );
  const pa = out.pointAccumulated;
  const points = pa.points || [];
  if (!points.length) return { file, error: 'no points' };

  // non-modification check: snapshot source before building fragments
  const before = points.map((p) => `${p.s},${p.d},${p.localEast},${p.localNorth}`).join('|');
  const cf = CF.buildConstructedFragments(points);
  const after = points.map((p) => `${p.s},${p.d},${p.localEast},${p.localNorth}`).join('|');

  const frags = cf.fragments;
  const resid = frags.map((f) => f.medianResidualM).filter((x) => x != null);
  const lens = frags.map((f) => f.lengthM);
  const reasons = {};
  for (const rc of cf.rejectedConnections) reasons[rc.reason] = (reasons[rc.reason] || 0) + 1;
  const perTrack = {};
  for (const f of frags) perTrack[f.groupTrackId] = (perTrack[f.groupTrackId] || 0) + 1;

  return {
    file,
    points: points.length,
    groups: cf.groups,
    fragments: frags.length,
    lanesCovered: Object.keys(perTrack).length,
    fragmentsPerTrack: perTrack,
    medianLengthM: lens.length ? +median(lens).toFixed(1) : null,
    maxLengthM: lens.length ? +Math.max(...lens).toFixed(1) : null,
    medianResidualM: resid.length ? +median(resid).toFixed(3) : null,
    maxResidualM: resid.length ? +Math.max(...resid).toFixed(3) : null,
    splitReasons: reasons,
    sourceUnmodified: before === after,
  };
}

const results = [];
for (const f of FILES) {
  try {
    results.push(runSegment(f));
    console.log(`done ${f}`);
  } catch (e) {
    results.push({ file: f, error: e.message });
  }
}

const valid = results.filter((r) => !r.error);
const allMedianResid = valid.flatMap((r) => r.medianResidualM != null ? [r.medianResidualM] : []);
const allMaxResid = valid.flatMap((r) => r.maxResidualM != null ? [r.maxResidualM] : []);
const allLen = valid.flatMap((r) => r.medianLengthM != null ? [r.medianLengthM] : []);

const totalReasons = {};
for (const r of valid) for (const [k, v] of Object.entries(r.splitReasons)) totalReasons[k] = (totalReasons[k] || 0) + v;

console.log('\n========================================');
console.log('CONSTRUCTED-FRAGMENT AUDIT (EXPERIMENTAL)');
console.log('========================================');
console.table(valid.map((r) => ({
  file: r.file,
  points: r.points,
  groups: r.groups,
  frags: r.fragments,
  lanes: r.lanesCovered,
  medianLen: r.medianLengthM,
  maxLen: r.maxLengthM,
  medResid: r.medianResidualM,
  maxResid: r.maxResidualM,
  srcOk: r.sourceUnmodified,
})));
console.log('\nAggregate (valid segments only):');
console.log(`  segments: ${valid.length}`);
console.log(`  total fragments: ${valid.reduce((a, r) => a + r.fragments, 0)}`);
console.log(`  median fragment length across segments: ${allLen.length ? median(allLen) : '—'} m`);
console.log(`  median fragment residual: ${allMedianResid.length ? median(allMedianResid) : '—'} m`);
console.log(`  max fragment residual (median over segs): ${allMaxResid.length ? median(allMaxResid) : '—'} m`);
console.log(`  source points unmodified in all segments: ${valid.every((r) => r.sourceUnmodified)}`);
console.log(`  split reasons: ${JSON.stringify(totalReasons)}`);
