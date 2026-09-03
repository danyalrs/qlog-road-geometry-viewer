'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const {
  buildSegmentVideoTimeline,
  resolveTimelineEntryForIndex,
  resolvePlaybackProvenance,
  computeSegmentLocalTimeS,
  resolveExpectedVideoTime,
} = require('../lib/multisegment_video_timeline');
const { computeLocalElapsedSeconds } = require('../lib/segment_video');

const NS = 1_000_000_000n;

function makeTimeline(segments) {
  const timeline = [];
  let base = 1_000_000_000n;
  for (const seg of segments) {
    for (let i = 0; i < seg.frames; i++) {
      timeline.push({
        sourceFile: seg.file,
        logMonoTime: String(base),
        frameId: `${seg.file}-${i}`,
      });
      base += BigInt(Math.round((seg.frameGapS ?? 0.5) * Number(NS)));
    }
  }
  return timeline;
}

describe('multisegment video timeline', () => {
  it('1. two selected segments produce two timeline entries', () => {
    const timeline = makeTimeline([
      { file: 'qlog_f449c_2.bz2', frames: 4, frameGapS: 1 },
      { file: 'qlog_f449c_6.bz2', frames: 3, frameGapS: 2 },
    ]);
    const entries = buildSegmentVideoTimeline(timeline, ['qlog_f449c_2.bz2', 'qlog_f449c_6.bz2']);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].sourceSegmentId, '2');
    assert.equal(entries[1].sourceSegmentId, '6');
  });

  it('2. playback order follows combined timeline, selection index preserved separately', () => {
    const timeline = makeTimeline([
      { file: 'qlog_f449c_6.bz2', frames: 2 },
      { file: 'qlog_f449c_2.bz2', frames: 2 },
    ]);
    const selected = ['qlog_f449c_2.bz2', 'qlog_f449c_6.bz2'];
    const entries = buildSegmentVideoTimeline(timeline, selected);
    assert.equal(entries[0].sourceSegmentId, '6');
    assert.equal(entries[1].sourceSegmentId, '2');
    assert.equal(entries[0].sourceSelectionIndex, 1);
    assert.equal(entries[1].sourceSelectionIndex, 0);
    assert.equal(entries[0].timelineStartIdx, 0);
    assert.equal(entries[1].timelineStartIdx, 2);
  });

  it('3. active arrow pose resolves the correct video segment', () => {
    const timeline = makeTimeline([
      { file: 'qlog_f449c_2.bz2', frames: 5, frameGapS: 1 },
      { file: 'qlog_f449c_6.bz2', frames: 4, frameGapS: 1.5 },
    ]);
    const entries = buildSegmentVideoTimeline(timeline, ['qlog_f449c_2.bz2', 'qlog_f449c_6.bz2']);
    const provA = resolvePlaybackProvenance(timeline, 4, ['qlog_f449c_2.bz2', 'qlog_f449c_6.bz2'], timeline[4].logMonoTime, entries);
    const provB = resolvePlaybackProvenance(timeline, 5, ['qlog_f449c_2.bz2', 'qlog_f449c_6.bz2'], timeline[5].logMonoTime, entries);
    assert.equal(provA.sourceSegmentId, '2');
    assert.equal(provB.sourceSegmentId, '6');
  });

  it('6. local video time resets at the second segment start', () => {
    const timeline = makeTimeline([
      { file: 'qlog_f449c_2.bz2', frames: 3, frameGapS: 10 },
      { file: 'qlog_f449c_6.bz2', frames: 3, frameGapS: 7 },
    ]);
    const entries = buildSegmentVideoTimeline(timeline, ['qlog_f449c_2.bz2', 'qlog_f449c_6.bz2']);
    const boundaryIdx = entries[1].timelineStartIdx;
    const prov = resolvePlaybackProvenance(
      timeline,
      boundaryIdx,
      ['qlog_f449c_2.bz2', 'qlog_f449c_6.bz2'],
      timeline[boundaryIdx].logMonoTime,
      entries,
    );
    assert.equal(prov.sourceLocalTimeS, 0);
  });

  it('7. segment durations are not assumed to be 60 seconds', () => {
    const timeline = makeTimeline([
      { file: 'qlog_f449c_2.bz2', frames: 2, frameGapS: 17.3 },
      { file: 'qlog_f449c_99.bz2', frames: 2, frameGapS: 41.7 },
    ]);
    const entries = buildSegmentVideoTimeline(timeline, ['qlog_f449c_2.bz2', 'qlog_f449c_99.bz2']);
    assert.ok(Math.abs(entries[0].localEndTimeS - 17.3) < 0.01);
    assert.ok(Math.abs(entries[1].localEndTimeS - 41.7) < 0.01);
    assert.notEqual(entries[0].localEndTimeS, 60);
  });

  it('8. backward seeking resolves earlier segment video', () => {
    const timeline = makeTimeline([
      { file: 'qlog_f449c_2.bz2', frames: 4, frameGapS: 1 },
      { file: 'qlog_f449c_6.bz2', frames: 4, frameGapS: 1 },
    ]);
    const entries = buildSegmentVideoTimeline(timeline, ['qlog_f449c_2.bz2', 'qlog_f449c_6.bz2']);
    const back = resolvePlaybackProvenance(timeline, 2, ['qlog_f449c_2.bz2', 'qlog_f449c_6.bz2'], timeline[2].logMonoTime, entries);
    assert.equal(back.sourceSegmentId, '2');
    assert.ok(back.sourceLocalTimeS > 0);
  });

  it('14. arrow segment id equals provenance segment id throughout indices', () => {
    const timeline = makeTimeline([
      { file: 'qlog_f449c_2.bz2', frames: 3, frameGapS: 2 },
      { file: 'qlog_f449c_6.bz2', frames: 3, frameGapS: 3 },
      { file: 'qlog_f449c_99.bz2', frames: 2, frameGapS: 4 },
    ]);
    const entries = buildSegmentVideoTimeline(timeline, ['qlog_f449c_2.bz2', 'qlog_f449c_6.bz2', 'qlog_f449c_99.bz2']);
    for (let i = 0; i < timeline.length; i++) {
      const prov = resolvePlaybackProvenance(timeline, i, ['qlog_f449c_2.bz2', 'qlog_f449c_6.bz2', 'qlog_f449c_99.bz2'], timeline[i].logMonoTime, entries);
      const entry = resolveTimelineEntryForIndex(entries, i);
      assert.equal(prov.sourceSegmentId, entry.sourceSegmentId);
      assert.equal(prov.sourceQlogName, timeline[i].sourceFile);
    }
  });

  it('expected video time uses per-segment local elapsed plus offset', () => {
    const prov = { sourceLocalTimeS: 12.4 };
    assert.equal(resolveExpectedVideoTime(prov, 1.25), 13.65);
  });
});

describe('multisegment video panel wiring', () => {
  it('4. app.js resolves provenance and syncs video on timeline scrub and playback tick', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.match(src, /resolveActivePlaybackProvenance/);
    assert.match(src, /syncVideoToActivePose/);
    assert.match(src, /MultisegmentVideoTimeline/);
    assert.match(src, /localPlaybackVideo\?\.tickSync\(resolveActivePlaybackProvenance/);
    assert.match(src, /localPlaybackVideo\?\.onTimelineScrub\(resolveActivePlaybackProvenance/);
  });

  it('5. same-segment sync does not reload video source when segment unchanged', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'local_playback_video.js'), 'utf8');
    assert.match(src, /segmentChanged/);
    assert.match(src, /if \(segmentChanged\)/);
    assert.match(src, /syncToLocalTime/);
  });

  it('9. paused scrub path forces seek without requiring play state', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'local_playback_video.js'), 'utf8');
    assert.match(src, /onTimelineScrub/);
    assert.match(src, /this\.pause\(\)/);
    assert.match(src, /forceSeek: true/);
  });

  it('10. rapid switching uses videoSwitchToken and ignores stale metadata', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'local_playback_video.js'), 'utf8');
    assert.match(src, /videoSwitchToken/);
    assert.match(src, /staleSwitchIgnoredCount/);
    assert.match(src, /token !== this\.videoSwitchToken/);
    assert.match(src, /\{ once: true \}/);
  });

  it('11. missing video clears previous footage display', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'local_playback_video.js'), 'utf8');
    assert.match(src, /_clearVideoDisplay/);
    assert.match(src, /removeAttribute\('src'\)/);
    assert.match(src, /video unavailable/);
  });

  it('12. later available segment can load after missing segment', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'local_playback_video.js'), 'utf8');
    assert.match(src, /async _switchToSegment/);
    assert.match(src, /hasVideo/);
  });

  it('13. single-segment playback retains tickSync and drift correction', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'local_playback_video.js'), 'utf8');
    assert.match(src, /computeSyncAction/);
    assert.match(src, /tickSync/);
    assert.doesNotMatch(src, /setInterval\(/);
  });
});

describe('multisegment video panel vm harness', () => {
  function loadPanelClass() {
    const sandbox = {
      window: {},
      performance: { now: () => Date.now() },
      fetch: async () => ({
        ok: true,
        json: async () => ({
          hasVideo: true,
          streamUrl: '/api/video/segment/6/stream.mp4',
          videoStartOffsetSeconds: 0,
          remux: { durationSec: 59.8 },
        }),
      }),
      console,
    };
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'segment_video_timing.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'local_playback_video.js'), 'utf8'), context);
    return sandbox.LocalPlaybackVideoPanel;
  }

  function makeRoot() {
    const listeners = new Map();
    const videoEl = {
      currentTime: 0,
      duration: 59.8,
      paused: true,
      playbackRate: 1,
      src: '',
      muted: true,
      addEventListener(type, fn, opts) {
        if (opts?.once) {
          const wrapped = (...args) => { fn(...args); videoEl.removeEventListener(type, wrapped); };
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(wrapped);
          return;
        }
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const arr = listeners.get(type) || [];
        listeners.set(type, arr.filter((f) => f !== fn));
      },
      play() { videoEl.paused = false; return Promise.resolve(); },
      pause() { videoEl.paused = true; },
      load() {},
      removeAttribute() { videoEl.src = ''; },
    };
    const root = {
      querySelector(sel) {
        if (sel === 'video') return videoEl;
        const map = {
          '[data-video-status]': { textContent: '' },
          '[data-video-time]': { textContent: '' },
          '[data-video-segment]': { textContent: '' },
          '[data-video-sync]': { textContent: '', dataset: {} },
          '[data-video-message]': { textContent: '', classList: { add() {}, remove() {} } },
          '[data-video-body]': { classList: { add() {}, remove() {} } },
          '[data-video-collapse]': { textContent: '▾', addEventListener() {} },
        };
        return map[sel] || { textContent: '', classList: { add() {}, remove() {}, toggle() {} } };
      },
      classList: { toggle() {}, contains: () => false },
      _videoEl: videoEl,
      _listeners: listeners,
    };
    return root;
  }

  it('4b. crossing segment boundary increments sourceSwitchCount once per switch', async () => {
    const Panel = loadPanelClass();
    const root = makeRoot();
    const panel = new Panel(root);
    panel.setSegmentTimeline([
      { sourceSegmentId: '2', segmentStartLogMonoTime: '1000000000' },
      { sourceSegmentId: '6', segmentStartLogMonoTime: '5000000000' },
    ]);

    await panel.syncToActivePose({
      sourceSegmentId: '2',
      sourceLocalTimeS: 5,
      segmentStartLogMonoTime: '1000000000',
    }, { isPlaying: false, forceSeek: true });
    panel.activeVideoSegmentId = '2';
    panel.state = 'ready';

    await panel.syncToActivePose({
      sourceSegmentId: '6',
      sourceLocalTimeS: 0,
      segmentStartLogMonoTime: '5000000000',
    }, { isPlaying: false, forceSeek: true });
    for (const fn of root._listeners.get('loadedmetadata') || []) fn();
    assert.equal(panel.activeVideoSegmentId, '6');
    assert.equal(panel.sourceSwitchCount, 1);
  });

  it('10b. stale loadedmetadata callback is ignored after newer switch', async () => {
    const Panel = loadPanelClass();
    const root = makeRoot();
    const panel = new Panel(root);
    const staleHandlers = [];
    const origAdd = root._videoEl.addEventListener.bind(root._videoEl);
    root._videoEl.addEventListener = (type, fn, opts) => {
      if (type === 'loadedmetadata' && opts?.once) staleHandlers.push(fn);
      else origAdd(type, fn, opts);
    };

    await panel.syncToActivePose({
      sourceSegmentId: '2',
      sourceLocalTimeS: 1,
      segmentStartLogMonoTime: '1000000000',
    }, { isPlaying: false });
    const stale = staleHandlers[0];
    await panel.syncToActivePose({
      sourceSegmentId: '6',
      sourceLocalTimeS: 0,
      segmentStartLogMonoTime: '5000000000',
    }, { isPlaying: false });
    stale?.();
    for (const fn of root._listeners.get('loadedmetadata') || []) fn();
    assert.equal(panel.activeVideoSegmentId, '6');
    assert.ok(panel.staleSwitchIgnoredCount >= 1);
  });
});

describe('mapping isolation', () => {
  it('15. lane-map processing modules unchanged by video switch work', () => {
    for (const f of ['lib/process_route.js', 'lib/segment_local_map.js', 'public/connected_accumulated_display.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.doesNotMatch(src, /videoSwitchToken|MultisegmentVideoTimeline/);
    }
  });

  it('16. checksum of connected_accumulated_display.js stable vs backup manifest', () => {
    const current = crypto.createHash('sha256').update(
      fs.readFileSync(path.join(ROOT, 'public', 'connected_accumulated_display.js')),
    ).digest('hex');
    const manifest = fs.readFileSync(
      path.join(ROOT, 'reports', 'connected_accumulated', 'runtime', 'm051_visible_chain_repair', 'authoritative_runtime.json'),
      'utf8',
    );
    const match = manifest.match(/"public\/connected_accumulated_display\.js": "([a-f0-9]+)"/);
    if (match) assert.equal(current, match[1]);
  });
});
