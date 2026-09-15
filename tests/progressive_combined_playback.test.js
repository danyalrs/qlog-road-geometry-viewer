'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PCP = require('../lib/progressive_combined_playback');
const VMB = require('../lib/viewer_map_build');
const SLM = require('../lib/segment_local_map');
const CBAO = require('../lib/combined_boundary_anchored_orientation');
const MVT = require('../lib/multisegment_video_timeline');
const SVT = require('../lib/segment_video');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

const SEG0 = 'qlog_f449c_0.bz2';
const SEG1 = 'qlog_f449c_1.bz2';
const SEG2 = 'qlog_f449c_2.bz2';
const SEG3 = 'qlog_f449c_3.bz2';

function processPrefix(files) {
  const loaded = require('../lib/qlog_data').loadSegmentsData(ROOT, files, VMB.VIEWER_DEFAULT_PROCESS_OPTIONS);
  const { processRoute, buildTimeline } = require('../lib/process_route');
  const { qualifySegments } = require('../lib/segment_qualify');
  const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
  const sq = qualifySegments(loaded.audits);
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
    ...VMB.VIEWER_DEFAULT_PROCESS_OPTIONS,
    segmentQualifications: sq,
    fileAudits: loaded.audits,
  });
  return {
    ...result,
    timeline: enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath),
    fileAudits: loaded.audits,
  };
}

function buildBaseMap(pd) {
  return SLM.buildSegmentLocalMap(pd, {
    geometrySource: 'pointAccumulated',
    timelineIndex: 0,
    fitEnabled: true,
  });
}

function buildAllAtOnceCombined(pd) {
  return CBAO.applyBoundaryAnchoredOrientation(buildBaseMap(pd), pd, { mirrorChecked: true });
}

function buildFullCombinedMap(files) {
  const pd = processPrefix(files);
  return buildAllAtOnceCombined(pd);
}

function simulateProgressiveLookaheadState(visiblePrefix, availableOrdered) {
  const visible = PCP.orderPrefixFiles(visiblePrefix, availableOrdered);
  const hidden = PCP.resolveNextAvailableSegment(availableOrdered, visible);
  const processList = hidden ? [...visible, hidden] : visible;
  const pd = processPrefix(processList);
  const fullMap = buildAllAtOnceCombined(pd);
  const initial = PCP.buildInitialLookaheadDisplay(fullMap, pd, visible, hidden);
  return {
    availableOrdered,
    visiblePrefix: visible,
    hiddenLookahead: hidden,
    processPrefix: processList,
    fullMap: initial.fullMap,
    displayMap: initial.displayMap,
    fullProcessData: pd,
    displayProcessData: initial.displayProcessData,
    stateSnapshots: new Map(),
  };
}

function revealLookahead(state, { continuePlayback = false } = {}) {
  const reveal = PCP.revealPreparedLookahead(state, { continuePlayback });
  assert.equal(reveal.ok, true, reveal.reason || 'reveal failed');
  const newState = {
    ...state,
    visiblePrefix: reveal.visiblePrefix,
    hiddenLookahead: null,
    displayMap: reveal.displayMap,
    displayProcessData: reveal.displayProcessData,
  };
  newState.stateSnapshots.set(PCP.prefixSnapshotKey(state.visiblePrefix), {
    visiblePrefix: [...state.visiblePrefix],
    hiddenLookahead: state.hiddenLookahead,
    displayMap: PCP.snapshotFrozenMap(state.displayMap),
    displayProcessData: state.displayProcessData,
  });
  return { reveal, state: newState };
}

function prepareNextLookahead(state, hiddenSource) {
  const visible = state.visiblePrefix;
  const processList = [...visible, hiddenSource];
  const pd = processPrefix(processList);
  const freshBase = buildBaseMap(pd);
  const prepared = PCP.prepareNextHiddenLookahead(state, hiddenSource, freshBase, pd, { mirrorChecked: true });
  assert.equal(prepared.ok, true, prepared.reason || 'prepare failed');
  return {
    ...state,
    hiddenLookahead: prepared.hiddenLookahead,
    fullMap: prepared.fullMap,
    fullProcessData: prepared.fullProcessData,
    processPrefix: prepared.processPrefix,
    displayMap: state.displayMap,
    displayProcessData: state.displayProcessData,
  };
}

function simulateAppProcessAndAppend(visiblePrefix, availableOrdered) {
  let state = simulateProgressiveLookaheadState(visiblePrefix, availableOrdered);
  const initialSeg0 = PCP.perSourcePlacedChecksums(state.displayMap, [visiblePrefix[0]])[visiblePrefix[0]];
  const hiddenChecksum = state.hiddenLookahead
    ? PCP.perSourcePlacedChecksums(state.fullMap, [state.hiddenLookahead])[state.hiddenLookahead]
    : null;
  const { reveal, state: afterReveal } = revealLookahead(state);
  const afterSeg0 = PCP.perSourcePlacedChecksums(afterReveal.displayMap, [visiblePrefix[0]])[visiblePrefix[0]];
  const revealedHidden = reveal.revealedChecksum;
  return {
    initialSeg0,
    afterSeg0,
    hiddenChecksum,
    revealedHidden,
    reveal,
    state: afterReveal,
  };
}

test('1. progressive candidate defaults off', () => {
  assert.equal(PCP.parseProgressiveCombinedPlaybackCandidate(''), false);
  assert.equal(PCP.isCandidateEnabled(''), false);
});

test('2. hidden next-source selection respects numeric gaps', () => {
  const available = ['qlog_f449c_0.bz2', 'qlog_f449c_2.bz2', 'qlog_f449c_5.bz2'];
  assert.equal(PCP.resolveNextAvailableSegment(available, []), 'qlog_f449c_0.bz2');
  assert.equal(PCP.resolveNextAvailableSegment(available, ['qlog_f449c_0.bz2']), 'qlog_f449c_2.bz2');
  assert.equal(PCP.buildLookaheadProcessList(['qlog_f449c_0.bz2'], available).length, 2);
});

test('3. initial visible Seg0 equals normal combined Seg0+1 Seg0 placement', () => {
  const available = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));
  const state = simulateProgressiveLookaheadState([SEG0], available);
  const combined = buildFullCombinedMap([SEG0, SEG1]);
  const progressiveSeg0 = PCP.perSourcePlacedChecksums(state.displayMap, [SEG0])[SEG0];
  const combinedSeg0 = PCP.perSourcePlacedChecksums(combined, [SEG0])[SEG0];
  assert.equal(progressiveSeg0, combinedSeg0);
});

test('4. hidden Seg1 absent from every visible draw collection', () => {
  const available = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));
  const state = simulateProgressiveLookaheadState([SEG0], available);
  const leaks = PCP.findHiddenGeometryLeaks(state.displayMap, [SEG0], SEG1);
  assert.deepEqual(leaks, []);
  assert.equal(state.displayMap.trajectory.some((p) => p.sourceFile === SEG1), false);
  assert.equal(state.displayMap.laneFragments?.some((f) => f.sourceFile === SEG1), false);
});

test('5. hidden Seg1 excluded from timeline and video', () => {
  const available = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));
  const state = simulateProgressiveLookaheadState([SEG0], available);
  const visibleTimeline = state.displayProcessData.timeline;
  assert.equal(visibleTimeline.some((t) => t.sourceFile === SEG1), false);
  const last = visibleTimeline[visibleTimeline.length - 1];
  assert.equal(last.sourceFile, SEG0);
  const entries = MVT.buildSegmentVideoTimeline(visibleTimeline, state.visiblePrefix);
  assert.equal(entries.some((e) => e.sourceQlogName === SEG1), false);
});

test('6. first append performs reveal without full-prefix re-solve', () => {
  const available = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));
  const state = simulateProgressiveLookaheadState([SEG0], available);
  const beforeCs = PCP.perSourcePlacedChecksums(state.fullMap, state.processPrefix);
  const { reveal, state: after } = revealLookahead(state);
  const afterCs = PCP.perSourcePlacedChecksums(after.fullMap, state.processPrefix);
  assert.deepEqual(afterCs, beforeCs);
  assert.equal(reveal.visibleStable.ok, true);
});

test('7. Seg0 checksum and transform unchanged after first append', () => {
  const available = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));
  const result = simulateAppProcessAndAppend([SEG0], available);
  assert.equal(result.afterSeg0, result.initialSeg0);
});

test('8. revealed Seg1 checksum equals its hidden checksum', () => {
  const available = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));
  const result = simulateAppProcessAndAppend([SEG0], available);
  assert.equal(result.revealedHidden, result.hiddenChecksum);
});

test('9. preparing Seg2 leaves Seg0+Seg1 unchanged', () => {
  const available = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));
  const { state: afterReveal } = simulateAppProcessAndAppend([SEG0], available);
  const before = PCP.perSourcePlacedChecksums(afterReveal.displayMap, [SEG0, SEG1]);
  const withHidden2 = prepareNextLookahead(afterReveal, SEG2);
  const after = PCP.perSourcePlacedChecksums(withHidden2.displayMap, [SEG0, SEG1]);
  assert.equal(before[SEG0], after[SEG0]);
  assert.equal(before[SEG1], after[SEG1]);
});

test('10. Seg2 reveal leaves full prior prefix unchanged', () => {
  const available = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));
  const { state: afterReveal } = simulateAppProcessAndAppend([SEG0], available);
  const withHidden2 = prepareNextLookahead(afterReveal, SEG2);
  const before = PCP.perSourcePlacedChecksums(withHidden2.displayMap, [SEG0, SEG1]);
  const { state: afterSeg2 } = revealLookahead(withHidden2);
  const after = PCP.perSourcePlacedChecksums(afterSeg2.displayMap, [SEG0, SEG1]);
  assert.equal(before[SEG0], after[SEG0]);
  assert.equal(before[SEG1], after[SEG1]);
});

test('11. append-and-continue enters new source timeline index', () => {
  const pd = processPrefix([SEG0, SEG1, SEG2]);
  const continueIdx = PCP.resolveProgressiveTimelineIndex(pd.timeline, {
    continuePlayback: true,
    enterSourceFile: SEG2,
  });
  assert.equal(pd.timeline[continueIdx].sourceFile, SEG2);
});

test('12. remove-last restores prior snapshot checksum', () => {
  const available = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));
  const { state: afterReveal } = simulateAppProcessAndAppend([SEG0], available);
  const key0 = PCP.prefixSnapshotKey([SEG0]);
  const snap = afterReveal.stateSnapshots.get(key0);
  assert.ok(snap);
  assert.equal(snap.hiddenLookahead, SEG1);
  const restoredCs = PCP.perSourcePlacedChecksums(snap.displayMap, [SEG0])[SEG0];
  const currentCs = PCP.perSourcePlacedChecksums(afterReveal.displayMap, [SEG0])[SEG0];
  assert.equal(restoredCs, currentCs);
  assert.equal(snap.displayMap.trajectory.some((p) => p.sourceFile === SEG1), false);
  assert.equal(afterReveal.displayMap.trajectory.some((p) => p.sourceFile === SEG1), true);
});

test('13. failed preparation reports and retains visible prefix', () => {
  const available = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));
  const state = simulateProgressiveLookaheadState([SEG0, SEG1], available);
  const before = PCP.perSourcePlacedChecksums(state.displayMap, [SEG0, SEG1]);
  const tampered = PCP.snapshotFrozenMap(state.fullMap);
  tampered.trajectory = tampered.trajectory.map((p, i) => (
    i === 0 ? { ...p, placedEast: (p.placedEast ?? p.east) + 50 } : p
  ));
  const badState = { ...state, fullMap: tampered };
  const pd = processPrefix([SEG0, SEG1, SEG2]);
  const prepared = PCP.prepareNextHiddenLookahead(
    badState,
    SEG2,
    buildBaseMap(pd),
    pd,
    { mirrorChecked: true },
  );
  assert.equal(prepared.ok, false);
  const after = PCP.perSourcePlacedChecksums(state.displayMap, [SEG0, SEG1]);
  assert.deepEqual(before, after);
});

test('14. no-next-source behaviour', () => {
  const available = [SEG0];
  const hidden = PCP.resolveNextAvailableSegment(available, [SEG0]);
  assert.equal(hidden, null);
  assert.equal(PCP.formatProgressiveStatusLabel([SEG0], null).includes('Next prepared'), false);
});

test('15. multiple initially selected sources use lookahead frame', () => {
  const available = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));
  const state = simulateProgressiveLookaheadState([SEG0, SEG1], available);
  const combined = buildFullCombinedMap([SEG0, SEG1, SEG2]);
  const progCs = PCP.perSourcePlacedChecksums(state.displayMap, [SEG0, SEG1]);
  const allCs = PCP.perSourcePlacedChecksums(combined, [SEG0, SEG1]);
  assert.equal(progCs[SEG0], allCs[SEG0]);
  assert.equal(progCs[SEG1], allCs[SEG1]);
  assert.equal(state.hiddenLookahead, SEG2);
});

test('16. Seg2 still curves left after progressive reveal chain', () => {
  const available = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));
  const { state: afterReveal } = simulateAppProcessAndAppend([SEG0], available);
  const withHidden2 = prepareNextLookahead(afterReveal, SEG2);
  const { state: afterSeg2 } = revealLookahead(withHidden2);
  const seg2 = afterSeg2.displayMap.trajectory.filter((p) => p.sourceFile === SEG2);
  assert.equal(CBAO.dominantTurnSign(CBAO.signedTurnSequence(seg2)), 'left');
});

test('17. hidden geometry does not affect visible fit bounds', () => {
  const available = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));
  const state = simulateProgressiveLookaheadState([SEG0], available);
  const visibleOnly = PCP.computeVisibleFitBounds(state.fullMap, [SEG0]);
  const displayBounds = state.displayMap.fitBounds;
  assert.equal(displayBounds.minE, visibleOnly.minE);
  assert.equal(displayBounds.maxE, visibleOnly.maxE);
});

test('18. deterministic repeated progressive sequence', () => {
  const available = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));
  const a = simulateAppProcessAndAppend([SEG0], available);
  const b = simulateAppProcessAndAppend([SEG0], available);
  assert.equal(a.afterSeg0, b.afterSeg0);
  assert.equal(a.revealedHidden, b.revealedHidden);
});

test('19. legacy standalone append rotates Seg0; lookahead path does not', () => {
  const available = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));
  const standaloneCs = PCP.perSourcePlacedChecksums(buildBaseMap(processPrefix([SEG0])), [SEG0])[SEG0];
  const combinedCs = PCP.perSourcePlacedChecksums(buildFullCombinedMap([SEG0, SEG1]), [SEG0])[SEG0];
  assert.notEqual(standaloneCs, combinedCs);
  const lookahead = simulateProgressiveLookaheadState([SEG0], available);
  assert.equal(
    PCP.perSourcePlacedChecksums(lookahead.displayMap, [SEG0])[SEG0],
    combinedCs,
  );
  assert.ok(APP_SRC.includes('bootstrapProgressiveDisplay'));
  assert.ok(APP_SRC.includes('progressiveRevealPrepared'));
});

describe('progressive visible playback timeline', () => {
  const available = () => fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));

  test('playback-1. fresh progressive visible session starts at index 0', () => {
    const state = simulateProgressiveLookaheadState([SEG0], available());
    const idx = PCP.initialVisibleTimelineIndex(state.displayProcessData.timeline, [SEG0]);
    assert.equal(idx, 0);
    assert.equal(state.displayProcessData.timeline[idx].sourceFile, SEG0);
    assert.ok(state.fullProcessData.timeline.length > state.displayProcessData.timeline.length);
  });

  test('playback-2. initial video timeline entry is Seg0 at 0.0 s', () => {
    const state = simulateProgressiveLookaheadState([SEG0], available());
    const timeline = state.displayProcessData.timeline;
    const entries = MVT.buildSegmentVideoTimeline(timeline, [SEG0]);
    const elapsed = SVT.computeLocalElapsedSeconds(timeline[0].logMonoTime, timeline[0].logMonoTime);
    assert.equal(elapsed, 0);
    assert.equal(MVT.resolveTimelineEntryForIndex(entries, 0).sourceQlogName, SEG0);
  });

  test('playback-3. initial arrow uses first valid Seg0 pose', () => {
    const state = simulateProgressiveLookaheadState([SEG0], available());
    const pose = SLM.resolveArrowOnSegmentMap(
      state.displayMap,
      state.displayProcessData.timeline,
      0,
      {},
    );
    assert.ok(Number.isFinite(pose.east) && Number.isFinite(pose.north));
    assert.equal(pose.timelineIndex, 0);
  });

  test('playback-4. playing through Seg0 uses visible timeline frames only', () => {
    const state = simulateProgressiveLookaheadState([SEG0], available());
    const timeline = state.displayProcessData.timeline;
    for (let i = 0; i < Math.min(5, timeline.length); i++) {
      assert.equal(timeline[i].sourceFile, SEG0);
      const pose = SLM.resolveArrowOnSegmentMap(state.displayMap, timeline, i, {});
      assert.ok(Number.isFinite(pose.east) && Number.isFinite(pose.north));
    }
  });

  test('playback-5. hidden Seg1 frames never enter visible playback', () => {
    const state = simulateProgressiveLookaheadState([SEG0], available());
    assert.equal(state.displayProcessData.timeline.some((t) => t.sourceFile === SEG1), false);
    const entries = MVT.buildSegmentVideoTimeline(state.displayProcessData.timeline, [SEG0]);
    assert.equal(entries.some((e) => e.sourceQlogName === SEG1), false);
  });

  test('playback-6. ordinary append preserves current Seg0 frame and pauses', () => {
    const state = simulateProgressiveLookaheadState([SEG0], available());
    const priorIndex = Math.min(5, state.displayProcessData.timeline.length - 1);
    const priorTimeline = state.displayProcessData.timeline;
    const reveal = PCP.revealPreparedLookahead(state, { continuePlayback: false });
    assert.equal(reveal.ok, true);
    const mapped = PCP.mapPreservedTimelineIndex(
      reveal.displayProcessData.timeline,
      priorTimeline,
      priorIndex,
    );
    assert.equal(mapped, priorIndex);
    assert.equal(reveal.displayProcessData.timeline[mapped].sourceFile, SEG0);
    assert.equal(reveal.timelineIndex, null);
  });

  test('playback-7. ordinary append does not seek into Seg1', () => {
    const state = simulateProgressiveLookaheadState([SEG0], available());
    const priorIndex = Math.min(5, state.displayProcessData.timeline.length - 1);
    const reveal = PCP.revealPreparedLookahead(state, { continuePlayback: false });
    const mapped = PCP.mapPreservedTimelineIndex(
      reveal.displayProcessData.timeline,
      state.displayProcessData.timeline,
      priorIndex,
    );
    assert.notEqual(reveal.displayProcessData.timeline[mapped].sourceFile, SEG1);
    const seg1Last = PCP.findLastTimelineIndexForSource(reveal.displayProcessData.timeline, SEG1);
    assert.notEqual(mapped, seg1Last);
  });

  test('playback-8. append-and-continue selects first valid Seg1 frame', () => {
    const state = simulateProgressiveLookaheadState([SEG0], available());
    const reveal = PCP.revealPreparedLookahead(state, { continuePlayback: true });
    assert.equal(reveal.timelineIndex, PCP.findFirstTimelineIndexForSource(reveal.displayProcessData.timeline, SEG1));
    assert.equal(reveal.displayProcessData.timeline[reveal.timelineIndex].sourceFile, SEG1);
  });

  test('playback-9. renderer arrow and video refer to same active source', () => {
    const state = simulateProgressiveLookaheadState([SEG0], available());
    const idx = 0;
    const timeline = state.displayProcessData.timeline;
    const entries = MVT.buildSegmentVideoTimeline(timeline, [SEG0]);
    const entry = MVT.resolveTimelineEntryForIndex(entries, idx);
    const pose = SLM.resolveArrowOnSegmentMap(state.displayMap, timeline, idx, {});
    assert.equal(timeline[idx].sourceFile, entry.sourceQlogName);
    assert.equal(timeline[idx].sourceFile, SEG0);
    assert.ok(Number.isFinite(pose.east));
  });

  test('playback-10. remove-last snapshot restores prior visible frame', () => {
    const { state: afterReveal } = simulateAppProcessAndAppend([SEG0], available());
    const key0 = PCP.prefixSnapshotKey([SEG0]);
    const snap = afterReveal.stateSnapshots.get(key0);
    assert.ok(snap);
    const restoredIdx = PCP.initialVisibleTimelineIndex(snap.displayProcessData.timeline, [SEG0]);
    assert.equal(restoredIdx, 0);
    assert.equal(snap.displayProcessData.timeline[restoredIdx].sourceFile, SEG0);
  });

  test('playback-11. candidate-off playback wiring unchanged', () => {
    assert.equal(PCP.isCandidateEnabled(''), false);
    assert.ok(!APP_SRC.includes('findLastTimelineIndexForSource(reveal.displayProcessData.timeline, prepared)'));
    assert.ok(APP_SRC.includes('applyProgressiveRendererPlaybackData'));
    assert.ok(APP_SRC.includes('mapPreservedTimelineIndex'));
  });
});

test('candidate-off wiring unchanged', () => {
  assert.equal(PCP.isCandidateEnabled(''), false);
  assert.ok(INDEX_SRC.includes('progressiveCombinedPanel'));
  assert.ok(APP_SRC.includes('bootstrapProgressiveDisplay'));
  assert.ok(APP_SRC.includes('revealPreparedLookahead'));
  const pd = processPrefix([SEG2]);
  const standalone = buildBaseMap(pd);
  assert.equal(standalone.boundaryAnchoredOrientationActive, undefined);
});
