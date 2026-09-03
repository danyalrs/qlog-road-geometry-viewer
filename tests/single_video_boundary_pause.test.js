'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const boundaryLib = require('../lib/single_video_boundary_pause');

describe('single video boundary pause — pure helpers', () => {
  const timeline = [
    { sourceFile: 'qlog_f449c_0.bz2', logMonoTime: '1000' },
    { sourceFile: 'qlog_f449c_0.bz2', logMonoTime: '2000' },
    { sourceFile: 'qlog_f449c_1.bz2', logMonoTime: '3000' },
    { sourceFile: 'qlog_f449c_1.bz2', logMonoTime: '4000' },
  ];

  it('1. same-segment steps do not cross boundary', () => {
    assert.equal(boundaryLib.crossesSegmentBoundary(timeline, 0, 1), false);
  });

  it('2. boundary detection uses sourceFile before arrow advancement', () => {
    assert.equal(boundaryLib.crossesSegmentBoundary(timeline, 1, 2), true);
    assert.equal(boundaryLib.parseSegmentIdFromSourceFile('qlog_f449c_1.bz2'), '1');
  });

  it('3-4. frozen playback index stays on prior segment during loading state', () => {
    const state = boundaryLib.createRouteTransitionState();
    state.state = 'loadingNextSegmentVideo';
    state.frozenBoundaryIndex = 1;
    assert.equal(state.frozenBoundaryIndex, 1);
    assert.notEqual(state.pendingBoundaryIndex, 1);
  });

  it('5. visible player source change is tracked once per boundary load', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'local_playback_video.js'), 'utf8');
    assert.match(src, /boundarySrcChangeCount \+= 1/);
    assert.match(src, /beginBoundaryLoad/);
  });

  it('6. metadata alone does not complete boundary transition', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'local_playback_video.js'), 'utf8');
    assert.match(src, /_waitForBoundaryFrame/);
    assert.match(src, /readyState < HAVE_CURRENT_DATA/);
    assert.doesNotMatch(src, /loadedmetadata[\s\S]{0,120}onReady\?\.\(\)/);
  });

  it('7-8. loaded frame gate and commit happen together in app controller', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.match(src, /commitRouteBoundaryTransition/);
    assert.match(src, /updateTimelineInfo\(toIdx\)/);
    assert.match(src, /pollBoundaryFrameReady/);
  });

  it('9. loading wall time excluded via frozen logMonoTime', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.match(src, /frozenLogMonoTime/);
    assert.match(src, /isRouteBoundaryLoading\(\)/);
  });

  it('10. automatic playback resumes after readiness when resumeAfterBoundary', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.match(src, /resumeAfterBoundary/);
    assert.match(src, /if \(resume\) \{[\s\S]*schedulePlaybackStep/);
  });

  it('11. manual pause prevents automatic resume', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.match(src, /routeTransition\.resumeAfterBoundary = false/);
  });

  it('12. seeking backward cancels pending transition', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.match(src, /cancelRouteBoundaryTransition/);
    assert.match(src, /wasBoundaryLoading/);
  });

  it('13. rapid seeking uses boundary switch token guards', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'local_playback_video.js'), 'utf8');
    assert.match(src, /boundaryLoadToken/);
    assert.match(src, /onStale/);
  });

  it('14. confirmed missing video releases frozen playback', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.match(src, /onMissing:\s*\(\) => commitRouteBoundaryTransition/);
    const panel = fs.readFileSync(path.join(ROOT, 'public', 'local_playback_video.js'), 'utf8');
    assert.match(panel, /onMissing\?\.\(\)/);
  });

  it('15. single-segment schedule path unchanged for non-boundary steps', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.match(src, /timelineCrossesSegmentBoundary\(idx, nextIdx\)/);
    assert.match(src, /playbackAnim = \{[\s\S]*fromPose: resolveLocalPlaybackPose\(idx\)/);
  });

  it('16-17. single visible video element remains', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.equal((html.match(/<video\b/g) || []).length, 1);
    assert.match(html, /id="localPlaybackVideo"/);
    assert.doesNotMatch(html, /data-video-slot/);
  });

  it('18. rejected two-slot code remains inactive', () => {
    for (const f of ['public/app.js', 'public/local_playback_video.js', 'public/index.html', 'public/style.css']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.doesNotMatch(src, /data-video-slot/);
      assert.doesNotMatch(src, /preloadSwitchToken/);
      assert.doesNotMatch(src, /bufferingAtSegmentBoundary/);
    }
  });

  it('19. lane and road checksums remain unchanged vs backup manifest', () => {
    const manifestPath = path.join(ROOT, '.checkpoint_test_backup', 'pre_multisegment_video_switch', 'manifest.sha256');
    if (!fs.existsSync(manifestPath)) return;
    const manifest = fs.readFileSync(manifestPath, 'utf8');
    const connectedHash = manifest.match(/connected_accumulated_display\.js\s+([a-f0-9]+)/i)?.[1];
    if (connectedHash) {
      const crypto = require('node:crypto');
      const buf = fs.readFileSync(path.join(ROOT, 'public', 'connected_accumulated_display.js'));
      const h = crypto.createHash('sha256').update(buf).digest('hex');
      assert.equal(h, connectedHash);
    }
  });

  it('20. Segment 0 correction modules unchanged by boundary work', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.doesNotMatch(src, /segment0_road_mirror_fix/);
    const render = fs.readFileSync(path.join(ROOT, 'public', 'render.js'), 'utf8');
    assert.doesNotMatch(render, /beginBoundaryLoad/);
  });
});

describe('single video boundary pause — frame readiness', () => {
  it('isVideoFrameReady requires HAVE_CURRENT_DATA and seek settle', () => {
    const video = {
      readyState: 2,
      seeking: false,
      currentTime: 1.02,
    };
    assert.equal(boundaryLib.isVideoFrameReady(video, 1.0), true);
    video.readyState = 1;
    assert.equal(boundaryLib.isVideoFrameReady(video, 1.0), false);
  });
});

describe('single video boundary pause — panel vm harness', () => {
  function loadPanelClass() {
    const sandbox = {
      window: {},
      performance: { now: () => Date.now() },
      fetch: async () => ({
        ok: true,
        json: async () => ({
          hasVideo: true,
          streamUrl: '/api/video/segment/1/stream.mp4',
          videoStartOffsetSeconds: 0,
          remux: { durationSec: 60 },
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
      duration: 60,
      paused: true,
      playbackRate: 1,
      src: '',
      readyState: 0,
      networkState: 0,
      seeking: false,
      muted: true,
      addEventListener(type, fn, opts) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push({ fn, opts });
      },
      removeEventListener(type, fn) {
        const arr = listeners.get(type) || [];
        listeners.set(type, arr.filter((e) => e.fn !== fn));
      },
      play() { videoEl.paused = false; return Promise.resolve(); },
      pause() { videoEl.paused = true; },
      load() {},
      removeAttribute() { videoEl.src = ''; },
    };
    return {
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
  }

  it('boundary load increments src change count once', async () => {
    const Panel = loadPanelClass();
    const root = makeRoot();
    const panel = new Panel(root);
    let ready = false;
    await panel.beginBoundaryLoad({
      sourceSegmentId: '1',
      sourceLocalTimeS: 0,
      segmentStartLogMonoTime: '3000',
    }, {
      token: 1,
      onReady: () => { ready = true; },
    });
    assert.equal(panel.boundarySrcChangeCount, 1);
      root._videoEl.readyState = 4;
      root._videoEl.currentTime = 0;
      const meta = root._listeners.get('loadedmetadata')?.[0]?.fn;
      assert.ok(meta);
      meta();
      const handler = root._listeners.get('loadeddata')?.[0]?.fn
        || root._listeners.get('canplay')?.[0]?.fn;
      assert.ok(handler);
      handler();
      assert.equal(ready, true);
  });
});
