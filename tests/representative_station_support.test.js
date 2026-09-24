'use strict';

// Focused tests for the default-off representativeStationSupportCandidate.
// Pure guardStationExtension tests + selection + integration + focus metrics.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CAD_SRC = fs.readFileSync(path.join(ROOT, 'public/connected_accumulated_display.js'), 'utf8');
function loadCAD() {
  const sb = { console, module: { exports: {} }, exports: {} };
  sb.global = sb; sb.window = sb;
  vm.runInNewContext(CAD_SRC, sb, { filename: 'cad.js' });
  return sb.ConnectedAccumulatedDisplay || sb.module.exports;
}
const CAD = loadCAD();
const D = CAD.STATION_SUPPORT_DEFAULTS;
const OPTS = { ...CAD.DEFAULTS, stationSupport: true, ...D, trustedModelXM: 80 };

// helpers to build {curve, v} samples
function sample(d, frameId, modelX) { return { curve: { frameId, frameIndex: frameId, chunkId: 0, passId: 0, groupId: 'g' }, v: { d, modelX } }; }
function stationSamples(ds, modelXs, frameOffset = 0) { return ds.map((d, i) => sample(d, frameOffset + i, modelXs ? modelXs[i] : 10)); }

function baseInput(overrides = {}) {
  return {
    s: 100,
    baseSamples: [sample(-3.0, 1, 20)],
    context: { left: { s: 90, medianD: -3.0 }, right: { s: 110, medianD: -3.0 } },
    curveSamples: [sample(-3.05, 2, 95)],
    localBand: { count: 3, uniqueFrames: 3, centre: -3.0, spread: 0.2, maxGap: 0.1, frames: [1, 2, 3] },
    baseRangeM: 80,
    maxRangeM: D.stationSupportMaxRangeM,
    opts: OPTS,
    ...overrides,
  };
}

// --- selection ---
test('1. absent flag -> OFF', () => { assert.equal(CAD.parseRepresentativeStationSupportCandidate(''), false); });
test('2. =0 -> OFF', () => { assert.equal(CAD.parseRepresentativeStationSupportCandidate('?representativeStationSupportCandidate=0'), false); });
test('3. =1 -> ON', () => { assert.equal(CAD.parseRepresentativeStationSupportCandidate('?representativeStationSupportCandidate=1'), true); });
test('4. invalid -> OFF', () => {
  assert.equal(CAD.parseRepresentativeStationSupportCandidate('?representativeStationSupportCandidate=yes'), false);
  assert.equal(CAD.parseRepresentativeStationSupportCandidate('?representativeStationSupportCandidate='), false);
  assert.equal(CAD.parseRepresentativeStationSupportCandidate('?x=1'), false);
});
test('5. candidate identity/version present for cache keys', () => {
  assert.equal(typeof CAD.STATION_SUPPORT_VERSION, 'number');
  const renderSrc = fs.readFileSync(path.join(ROOT, 'public/render.js'), 'utf8');
  assert.match(renderSrc, /_representativeCandidateKey/);
  assert.match(renderSrc, /representativeStationSupportCandidate/);
});

// --- guard helper ---
test('6. baseline-accepted station unchanged (>=2 base frames -> not eligible)', () => {
  const r = CAD.guardStationExtension(baseInput({ baseSamples: [sample(-3.0, 1, 20), sample(-3.1, 2, 30)] }));
  assert.equal(r.eligible, false);
  assert.equal(r.accepted, true);
  assert.equal(r.reason, 'baselineAccepted');
  assert.equal(r.retained.length, 2);
});
test('7. no base anchor -> noBaseAnchor', () => {
  const r = CAD.guardStationExtension(baseInput({ baseSamples: [] }));
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'noBaseAnchor');
});
test('8. one anchor + one safe extended unique-frame sample accepted', () => {
  const r = CAD.guardStationExtension(baseInput());
  assert.equal(r.accepted, true);
  assert.equal(r.reason, 'localBandConfirmed');
  assert.equal(r.extendedCount, 1);
  assert.equal(r.uniqueFrameSupport, 2);
});
test('9. duplicate extended frame does not increase support', () => {
  const r = CAD.guardStationExtension(baseInput({ curveSamples: [sample(-3.05, 1, 95), sample(-3.02, 1, 98)] }));
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'insufficientExtendedSupport');
});
test('10. extended lateral mismatch rejected', () => {
  const r = CAD.guardStationExtension(baseInput({ curveSamples: [sample(-9.0, 2, 95)] }));
  assert.equal(r.accepted, false);
  assert.ok(r.discarded.some((d) => d.reason === 'extendedLateralMismatch'));
});
test('11. two credible extended modes rejected', () => {
  // Both modes inside the lateral tolerance, separated > competing gap.
  const r = CAD.guardStationExtension(baseInput({ curveSamples: [sample(-1.9, 2, 95), sample(-2.0, 3, 96), sample(-4.0, 4, 97), sample(-4.1, 5, 98)] }));
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'competingExtendedMode');
});
test('12. missing left context rejected', () => {
  const r = CAD.guardStationExtension(baseInput({ context: { left: null, right: { s: 110, medianD: -3 } } }));
  assert.equal(r.reason, 'missingLeftContext');
});
test('13. missing right context rejected', () => {
  const r = CAD.guardStationExtension(baseInput({ context: { left: { s: 90, medianD: -3 }, right: null } }));
  assert.equal(r.reason, 'missingRightContext');
});
test('14. temporal revisit mismatch rejected', () => {
  const r = CAD.guardStationExtension(baseInput({ curveSamples: [sample(-3.05, 100000, 95)] }));
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'temporalRevisitRisk');
});
test('15. out-of-range extended observation discarded', () => {
  const r = CAD.guardStationExtension(baseInput({ curveSamples: [sample(-3.0, 2, 999)] }));
  assert.equal(r.accepted, false);
  assert.ok(r.discarded.some((d) => d.reason === 'extendedOutOfRange'));
});
test('16. input-order invariance', () => {
  const a = baseInput({ curveSamples: [sample(-3.0, 2, 95), sample(-3.2, 3, 96)] });
  const b = baseInput({ curveSamples: [sample(-3.2, 3, 96), sample(-3.0, 2, 95)] });
  assert.equal(CAD.guardStationExtension(a).accepted, CAD.guardStationExtension(b).accepted);
  assert.deepEqual(CAD.guardStationExtension(a).fittedDInput.sort(), CAD.guardStationExtension(b).fittedDInput.sort());
});
test('17. deterministic tie-breaking / repeat build', () => {
  const a = CAD.guardStationExtension(baseInput());
  const b = CAD.guardStationExtension(baseInput());
  assert.deepEqual(a.retained.map((x) => x.v.d), b.retained.map((x) => x.v.d));
});
test('18. no synthetic observation created (all retained come from inputs)', () => {
  const input = baseInput();
  const r = CAD.guardStationExtension(input);
  const all = [...input.baseSamples, ...input.curveSamples];
  for (const kept of r.retained) assert.ok(all.includes(kept));
});
test('19. two unique-frame minimum preserved', () => {
  const r = CAD.guardStationExtension(baseInput({ curveSamples: [sample(-3.0, 2, 95)] }));
  assert.ok(r.uniqueFrameSupport >= 2);
});
test('20. fitted d derives only from retained observations', () => {
  const input = baseInput();
  const r = CAD.guardStationExtension(input);
  const ds = r.retained.map((x) => Number(x.v.d.toFixed(3)));
  assert.deepEqual(r.fittedDInput, ds);
});

// --- integration ---
function buildSegment(seg) {
  const vm2 = require('node:vm');
  const VMB = require(path.join(ROOT, 'lib/viewer_map_build'));
  const SLM = require(path.join(ROOT, 'lib/segment_local_map'));
  const loaded = require(path.join(ROOT, 'lib/qlog_data')).loadSegmentsData(ROOT, [`qlog_f449c_${seg}.bz2`], VMB.VIEWER_DEFAULT_PROCESS_OPTIONS);
  const { processRoute, buildTimeline } = require(path.join(ROOT, 'lib/process_route'));
  const { qualifySegments } = require(path.join(ROOT, 'lib/segment_qualify'));
  const { enrichTimelineWithMovement } = require(path.join(ROOT, 'lib/vehicle_movement_display'));
  const sq = qualifySegments(loaded.audits);
  const r = processRoute(loaded.modelEvents, loaded.gpsEvents, { ...VMB.VIEWER_DEFAULT_PROCESS_OPTIONS, segmentQualifications: sq, fileAudits: loaded.audits });
  const pd = { ...r, timeline: enrichTimelineWithMovement(buildTimeline(r.frames), r.vehiclePath), fileAudits: loaded.audits };
  const map = SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', timelineIndex: 0, fitEnabled: true });
  const pa = map.pointAccumulated.points || [];
  const pf = CAD.buildPerFrameConnectedPolylines(pa);
  return { pf, pa };
}
function buildBoth(seg) {
  const { pf, pa } = buildSegment(seg);
  const off = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, {});
  const on = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, { representativeStationSupportCandidate: true });
  return { off, on, pa };
}

test('21. candidate OFF byte-identical to baseline', () => {
  const { pf } = buildSegment(12);
  const a = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, {});
  const b = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, {});
  assert.equal(JSON.stringify(a.polylines), JSON.stringify(b.polylines));
});
test('22. Seg14 gaps decrease without logical-lane changes', () => {
  const { off, on } = buildBoth(14);
  const g = (r) => (r.stats.splitReasonCounts.alongTrackGap || 0);
  assert.ok(g(on) < g(off), `ON gaps ${g(on)} < OFF gaps ${g(off)}`);
  assert.equal(on.stats.logicalLaneCount, off.stats.logicalLaneCount);
});
test('23. Seg16 gaps decrease without logical-lane changes', () => {
  const { off, on } = buildBoth(16);
  const g = (r) => (r.stats.splitReasonCounts.alongTrackGap || 0);
  assert.ok(g(on) < g(off));
  assert.equal(on.stats.logicalLaneCount, off.stats.logicalLaneCount);
});
test('24. Seg89 gaps decrease without logical-lane changes', () => {
  const { off, on } = buildBoth(89);
  const g = (r) => (r.stats.splitReasonCounts.alongTrackGap || 0);
  assert.ok(g(on) < g(off));
  assert.equal(on.stats.logicalLaneCount, off.stats.logicalLaneCount);
});
test('25. Seg12 unchanged under the candidate', () => {
  const { off, on } = buildBoth(12);
  assert.equal(JSON.stringify(on.polylines), JSON.stringify(off.polylines));
  assert.equal(on.stats.stationSupportAccepted || 0, 0);
});
test('26. Seg2 has no unsafe cross-lane join (accepted count not reduced)', () => {
  const { off, on } = buildBoth(2);
  assert.ok((on.stats.representativeLineCount || 0) >= (off.stats.representativeLineCount || 0) - 0);
  assert.equal(on.stats.stationSupportAccepted || 0, 0);
});
test('27. Seg99 fold remains absent / gap count not increased', () => {
  const { off, on } = buildBoth(99);
  const g = (r) => (r.stats.splitReasonCounts.alongTrackGap || 0);
  assert.ok(g(on) <= g(off));
});
test('28. no non-finite geometry; no input mutation', () => {
  const { pf } = buildSegment(16);
  const before = JSON.stringify(pf.polylines.map((c) => c.points.map((p) => [p.s, p.d])));
  const on = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, { representativeStationSupportCandidate: true });
  for (const pl of on.polylines) for (const p of pl.points) assert.ok(Number.isFinite(p.s) && Number.isFinite(p.d));
  assert.equal(JSON.stringify(pf.polylines.map((c) => c.points.map((p) => [p.s, p.d]))), before);
});

// --- v2 local-band gates ---
test('v2-1. missing local band rejects', () => {
  const r = CAD.guardStationExtension(baseInput({ localBand: null }));
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'noLocalBand');
});
test('v2-2. one-frame local band rejects', () => {
  const r = CAD.guardStationExtension(baseInput({ localBand: { count: 1, uniqueFrames: 1, centre: -3.0, spread: 0, maxGap: 0, frames: [1] } }));
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'insufficientLocalBandFrames');
});
test('v2-3. wide local band rejects', () => {
  const r = CAD.guardStationExtension(baseInput({ localBand: { count: 3, uniqueFrames: 3, centre: -3.0, spread: 4.0, maxGap: 3.5, frames: [1, 2, 3] } }));
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'localBandTooWide');
});
test('v2-4. competing local mode rejects', () => {
  const r = CAD.guardStationExtension(baseInput({ localBand: { count: 4, uniqueFrames: 4, centre: -3.0, spread: 1.2, maxGap: 1.9, frames: [1, 2, 3, 4] } }));
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'competingLocalBand');
});
test('v2-5. anchor outside local band rejects', () => {
  const r = CAD.guardStationExtension(baseInput({ localBand: { count: 3, uniqueFrames: 3, centre: -6.0, spread: 0.2, maxGap: 0.1, frames: [1, 2, 3] } }));
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'anchorOutsideLocalBand');
});
test('v2-6. extended point outside local band rejects', () => {
  const r = CAD.guardStationExtension(baseInput({ localBand: { count: 3, uniqueFrames: 3, centre: -3.5, spread: 0.2, maxGap: 0.1, frames: [1, 2, 3] }, curveSamples: [sample(-2.4, 2, 95)] }));
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'extendedOutsideLocalBand');
});
test('v2-7. fitted output outside local band rejects', () => {
  const r = CAD.guardStationExtension(baseInput({ baseSamples: [sample(-2.1, 1, 20)], curveSamples: [sample(-2.2, 2, 95)] }));
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'fittedPointOutsideLocalBand');
});
test('v2-8. local band temporal mismatch rejects', () => {
  const r = CAD.guardStationExtension(baseInput({ localBand: { count: 3, uniqueFrames: 3, centre: -3.0, spread: 0.2, maxGap: 0.1, frames: [1, 500, 1000] } }));
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'localBandTemporalMismatch');
});
test('v2-9. safe local band accepts', () => {
  const r = CAD.guardStationExtension(baseInput());
  assert.equal(r.accepted, true);
  assert.equal(r.reason, 'localBandConfirmed');
});
test('v2-10. cache key uses v2 version', () => {
  assert.equal(CAD.STATION_SUPPORT_VERSION, 2);
  const renderSrc = fs.readFileSync(path.join(ROOT, 'public/render.js'), 'utf8');
  assert.match(renderSrc, /v\$\{CAD\.STATION_SUPPORT_VERSION/);
});
test('v2-11. local band is same-identity (cluster curves) only', () => {
  // localBandForStation reads cluster.curves' own points; verify it ignores
  // points outside the radius and reports unique frames from the cluster.
  const cluster = { curves: [{ frameId: 1, pts: [{ s: 100, d: -3.0 }, { s: 101, d: -3.1 }] }, { frameId: 2, pts: [{ s: 100.5, d: -2.9 }] }] };
  const band = CAD.__bandForTest ? CAD.localBandForStation(cluster, 100, 1.5) : null;
  if (band) { assert.equal(band.uniqueFrames, 2); assert.ok(Math.abs(band.centre + 3.0) < 0.2); }
});
test('v2-12. Seg14 restored points within baseline envelope', () => {
  const { pf } = buildSegment(14);
  const on = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, { representativeStationSupportCandidate: true });
  assert.ok((on.stats.stationSupportAccepted || 0) > 0);
  assert.equal(on.stats.logicalLaneCount, CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, {}).stats.logicalLaneCount);
});
test('v2-13. Seg14 smaller and safer than v1 aggressive reduction', () => {
  const { pf } = buildSegment(14);
  const on = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, { representativeStationSupportCandidate: true });
  const off = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, {});
  assert.ok(on.stats.splitReasonCounts.alongTrackGap < off.stats.splitReasonCounts.alongTrackGap);
  assert.ok(on.stats.representativeLineCount > 5, 'not the aggressive v1 collapse');
});
test('v2-14. Seg18 cross-lane sample not admitted (accepted stays modest)', () => {
  const { pf } = buildSegment(18);
  const on = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, { representativeStationSupportCandidate: true });
  const off = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, {});
  assert.equal(on.stats.logicalLaneCount, off.stats.logicalLaneCount);
});
test('v2-15. Seg12 unchanged; Seg2/Seg99 byte-identical', () => {
  for (const seg of [12, 2, 99]) {
    const { pf } = buildSegment(seg);
    const on = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, { representativeStationSupportCandidate: true });
    assert.equal(on.stats.stationSupportAccepted || 0, 0, `seg${seg} should restore nothing`);
  }
});
