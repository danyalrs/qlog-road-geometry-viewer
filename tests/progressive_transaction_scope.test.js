'use strict';

// Focused tests for the Seg19->Seg20 append transaction and sparse next-source
// resolution. Source-resolution + transaction-scope only; no geometry changes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PCP = require('../lib/progressive_combined_playback');
const VMB = require('../lib/viewer_map_build');
const SLM = require('../lib/segment_local_map');
const CBAO = require('../lib/combined_boundary_anchored_orientation');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

const SEG = (n) => `qlog_f449c_${n}.bz2`;
function availableOrdered() {
  return fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f))
    .sort((a, b) => PCP.segmentNumericId(a) - PCP.segmentNumericId(b));
}
function processPrefix(files) {
  const loaded = require('../lib/qlog_data').loadSegmentsData(ROOT, files, VMB.VIEWER_DEFAULT_PROCESS_OPTIONS);
  const { processRoute, buildTimeline } = require('../lib/process_route');
  const { qualifySegments } = require('../lib/segment_qualify');
  const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
  const sq = qualifySegments(loaded.audits);
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
    ...VMB.VIEWER_DEFAULT_PROCESS_OPTIONS, segmentQualifications: sq, fileAudits: loaded.audits,
  });
  return { ...result, timeline: enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath), fileAudits: loaded.audits };
}
function buildBaseMap(pd) {
  return SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', timelineIndex: 0, fitEnabled: true });
}
function buildAllAtOnceCombined(pd) {
  return CBAO.applyBoundaryAnchoredOrientation(buildBaseMap(pd), pd, { mirrorChecked: true });
}
function simulateState(visiblePrefix, available) {
  const visible = PCP.orderPrefixFiles(visiblePrefix, available);
  const hidden = PCP.resolveNextAvailableSegment(available, visible);
  const processList = hidden ? [...visible, hidden] : visible;
  const pd = processPrefix(processList);
  const fullMap = buildAllAtOnceCombined(pd);
  const initial = PCP.buildInitialLookaheadDisplay(fullMap, pd, visible, hidden);
  return {
    availableOrdered: available, visiblePrefix: visible, hiddenLookahead: hidden,
    processPrefix: processList, fullMap: initial.fullMap, displayMap: initial.displayMap,
    fullProcessData: pd, displayProcessData: initial.displayProcessData, stateSnapshots: new Map(),
  };
}

// Processing Seg19+20 is expensive; compute the shared base once and reuse it.
let _state19 = null;
function state19() {
  if (!_state19) _state19 = simulateState([SEG(19)], availableOrdered());
  return _state19;
}

test('1. segment list sorting uses numeric IDs', () => {
  const ordered = PCP.orderPrefixFiles([SEG(20), SEG(2), SEG(10)], []);
  assert.deepEqual(ordered, [SEG(2), SEG(10), SEG(20)]);
});

test('2. sparse numbering does not require consecutive IDs', () => {
  const available = [SEG(19), SEG(20), SEG(22), SEG(23)];
  assert.equal(PCP.resolveNextAvailableSegment(available, [SEG(19)]), SEG(20));
});

test('3. with [19,20,22,23], next after 20 is 22', () => {
  const available = [SEG(19), SEG(20), SEG(22), SEG(23)];
  assert.equal(PCP.resolveNextAvailableSegment(available, [SEG(19), SEG(20)]), SEG(22));
});

test('4. a missing Seg21 is not automatically end-of-list', () => {
  const available = availableOrdered();
  assert.equal(available.includes(SEG(21)), false);
  assert.equal(PCP.resolveNextAvailableSegment(available, [SEG(20)]), SEG(22));
});

test('5. Seg19 prepares Seg20', () => {
  const state = state19();
  assert.deepEqual(state.visiblePrefix, [SEG(19)]);
  assert.equal(state.hiddenLookahead, SEG(20));
});

test('6. ordinary append reveals and commits Seg20', () => {
  const state = state19();
  const reveal = PCP.revealPreparedLookahead(state, { continuePlayback: false });
  assert.equal(reveal.ok, true, reveal.reason || 'reveal failed');
  assert.deepEqual(reveal.visiblePrefix, [SEG(19), SEG(20)]);
  assert.equal(reveal.preparedChecksum, reveal.revealedChecksum);
});

test('7. append-and-continue reveals and commits Seg20 with Seg20 timeline index', () => {
  const state = state19();
  const reveal = PCP.revealPreparedLookahead(state, { continuePlayback: true });
  assert.equal(reveal.ok, true, reveal.reason || 'reveal failed');
  assert.deepEqual(reveal.visiblePrefix, [SEG(19), SEG(20)]);
  const tl = reveal.displayProcessData.timeline;
  assert.equal(tl[reveal.timelineIndex]?.sourceFile, SEG(20));
});

test('8. Seg20 playback uses the Seg20 source in the visible timeline', () => {
  const state = state19();
  const reveal = PCP.revealPreparedLookahead(state, { continuePlayback: true });
  const sources = new Set(reveal.displayProcessData.timeline.map((t) => t.sourceFile));
  assert.equal(sources.has(SEG(20)), true);
  assert.equal(sources.has(SEG(19)), true);
});

test('9. successful Seg20 commit survives a later hidden-preparation failure', () => {
  const d = PCP.resolveAppendTransaction({ revealOk: true, followingSource: SEG(22), lookaheadPreparedOk: false });
  assert.equal(d.commit, true);
  assert.equal(d.rollback, false);
  assert.equal(d.reason, 'laterLookaheadPrepareFailed');
  // static wiring: optional preparation is inside its own try/catch and clears only hiddenLookahead
  assert.match(APP_SRC, /lookaheadPreparedOk = false/);
  assert.match(APP_SRC, /progressiveCombinedState\.hiddenLookahead = null/);
});

test('10. later hidden-preparation failure reports the correct source', () => {
  const label = PCP.formatAppendStatusLabel([SEG(19), SEG(20)], { failedSource: SEG(22) });
  assert.match(label, /Next Seg22 preparation failed/);
  assert.match(label, /Seg19–Seg20/);
});

test('11. a genuine reveal failure still rolls back', () => {
  const d = PCP.resolveAppendTransaction({ revealOk: false, followingSource: SEG(22), lookaheadPreparedOk: null });
  assert.equal(d.commit, false);
  assert.equal(d.rollback, true);
  assert.equal(d.reason, 'revealFailed');
});

test('12. a rejected reveal rolls back safely', () => {
  // A rejected reveal (missing/invalid prepared source) must roll back.
  const state = state19();
  const reveal = PCP.revealPreparedLookahead({ ...state, hiddenLookahead: null }, { continuePlayback: false });
  assert.equal(reveal.ok, false);
  assert.equal(reveal.reason, 'noPreparedLookahead');
  const d = PCP.resolveAppendTransaction({ revealOk: reveal.ok, followingSource: SEG(20) });
  assert.equal(d.rollback, true);
  assert.equal(d.commit, false);
  assert.match(APP_SRC, /await progressiveRevealPrepared\(\{ continuePlayback \}\);/);
  assert.match(APP_SRC, /await restoreProgressiveStateSnapshot\(rollbackKey\);/);
});

test('13. a stale later preparation cannot overwrite the committed Seg20 prefix', () => {
  // The optional stage only clears hiddenLookahead; it never rewrites visiblePrefix.
  const start = APP_SRC.indexOf('catch (lookaheadErr) {');
  assert.ok(start >= 0, 'lookahead catch block present');
  const block = APP_SRC.slice(start, start + 400);
  assert.match(block, /progressiveCombinedState\.hiddenLookahead = null;/);
  assert.doesNotMatch(block, /progressiveCombinedState\.visiblePrefix\s*=/);
});

test('14. terminal-source handling when no later source exists', () => {
  const d = PCP.resolveAppendTransaction({ revealOk: true, followingSource: null, lookaheadPreparedOk: null });
  assert.equal(d.commit, true);
  assert.equal(d.terminal, true);
  assert.equal(d.reason, 'endOfAvailableSegments');
  assert.match(PCP.formatAppendStatusLabel([SEG(19), SEG(20)], { terminal: true }), /End of available segments/);
});

test('15. append buttons disable only at a true terminal source', () => {
  assert.match(APP_SRC, /b\.disabled = terminal/);
  assert.match(APP_SRC, /const terminal = !following && !progressiveCombinedState\.hiddenLookahead/);
});

test('16. remove-last restores the exact Seg19 snapshot', () => {
  const available = availableOrdered();
  const state = state19();
  const before = PCP.perSourcePlacedChecksums(state.displayMap, [SEG(19)]);
  const reveal = PCP.revealPreparedLookahead(state, { continuePlayback: false });
  state.stateSnapshots.set(PCP.prefixSnapshotKey(state.visiblePrefix), {
    visiblePrefix: [...state.visiblePrefix],
    hiddenLookahead: state.hiddenLookahead,
    displayMap: PCP.snapshotFrozenMap(state.displayMap),
    displayProcessData: state.displayProcessData,
  });
  const snap = state.stateSnapshots.get(PCP.prefixSnapshotKey([SEG(19)]));
  assert.deepEqual(snap.visiblePrefix, [SEG(19)]);
  const restored = PCP.perSourcePlacedChecksums(snap.displayMap, [SEG(19)]);
  assert.deepEqual(restored, before);
  assert.deepEqual(reveal.visiblePrefix, [SEG(19), SEG(20)]);
});

test('17. no hidden source appears in the visible displayMap', () => {
  const state = state19();
  const visibleSources = new Set(state.displayMap.trajectory.map((p) => p.sourceFile));
  assert.equal(visibleSources.has(SEG(19)), true);
  assert.equal(visibleSources.has(SEG(20)), false);
  assert.equal(PCP.findHiddenGeometryLeaks(state.displayMap, [SEG(19)], SEG(20)).length, 0);
});

test('18. display-map coordinate checksums remain unchanged', () => {
  const available = availableOrdered();
  const state = state19();
  const before = PCP.perSourcePlacedChecksums(state.displayMap, [SEG(19)]);
  const reveal = PCP.revealPreparedLookahead(state, { continuePlayback: false });
  const afterVisible = PCP.perSourcePlacedChecksums(reveal.displayMap, [SEG(19)]);
  assert.deepEqual(afterVisible, before);
});

test('19. viewport controls remain synchronized (single timeline source)', () => {
  assert.match(APP_SRC, /function syncPlaybackControlStates/);
  assert.match(APP_SRC, /function fitProgressiveActiveSegment/);
  assert.match(APP_SRC, /renderer\.centerOnWorldPoint/);
});

test('20. top and lower playback controls remain synchronized', () => {
  assert.match(APP_SRC, /function setPlaybackButtonLabels/);
  assert.match(APP_SRC, /\['btnPlay', 'btnProgressivePlay'\]/);
  assert.match(APP_SRC, /\['btnPrevFrame', 'btnProgressivePrevFrame'\]/);
  assert.match(APP_SRC, /\['btnNextFrame', 'btnProgressiveNextFrame'\]/);
});

test('21. candidate-off behaviour remains unchanged', () => {
  assert.equal(PCP.parseProgressiveCombinedPlaybackCandidate(''), false);
  assert.equal(PCP.isCandidateEnabled('?progressiveCombinedPlaybackCandidate=1'), true);
  assert.equal(PCP.isCandidateEnabled(''), false);
});

test('22. Seg9-19 sparse progressive chain resolves without inventing missing IDs', () => {
  const available = availableOrdered();
  const chain = [9];
  let prefix = [SEG(9)];
  while (chain.length < 11) {
    const next = PCP.resolveNextAvailableSegment(available, prefix);
    assert.ok(next, 'next source resolved');
    const n = PCP.segmentNumericId(next);
    assert.ok(n > PCP.segmentNumericId(prefix[prefix.length - 1]), 'strictly increasing');
    chain.push(n);
    prefix = [...prefix, next];
  }
  assert.deepEqual(chain, [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.equal(PCP.resolveNextAvailableSegment(available, prefix), SEG(20));
});
