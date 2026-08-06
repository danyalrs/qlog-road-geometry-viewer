'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const vm = require('vm');
const { processRoute } = require('../lib/process_route');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const {
  normalizeProgress,
  formatPairTitle,
  analyzeFrameGeometry,
  serializePlaybackFrame,
  buildDrawPlan,
  canSubmitReviewLabel,
  navigationFrameIndex,
  finitePoints,
  buildBrowserPlaybackScript,
} = require('../lib/stage20_b_motion_review_playback');

function loadBrowserPlaybackApi() {
  const script = buildBrowserPlaybackScript();
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(script, context);
  return context.window.BMotionPlayback;
}

function loadRealSegmentFrames() {
  const qlog = 'qlog_f449c_0.bz2';
  const modelEvents = extractModel(qlog).map((e) => ({ ...e, sourceFile: qlog }));
  const gpsEvents = extractGps(qlog).map((e) => ({ ...e, sourceFile: qlog }));
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  return result.frames;
}

describe('B-MOTION playback field mapping', () => {
  it('serializePlaybackFrame maps lanes/edges to laneLines/roadEdges', () => {
    const frames = loadRealSegmentFrames();
    assert.ok(frames.length > 0);
    const raw = frames[0];
    assert.ok((raw.lanes || []).length > 0);
    const serialized = serializePlaybackFrame(raw, 0);
    assert.ok(serialized.laneLines.length > 0);
    assert.ok(serialized.roadEdges.length >= 0);
    assert.ok(finitePoints(serialized.laneLines[0].points).length >= 2);
  });

  it('normalizeProgress maps pair/next subset and full progress', () => {
    const subset = normalizeProgress({ completed: 3, total: 220, pending: 217 });
    assert.equal(subset.totalPairs, 220);
    assert.equal(subset.completed, 3);
    assert.equal(subset.pending, 217);
    assert.equal(subset.positive, 0);

    const full = normalizeProgress({
      totalPairs: 220, completed: 5, pending: 215, positive: 1, negative: 2, unresolved: 2,
    });
    assert.equal(full.totalPairs, 220);
    assert.equal(full.positive, 1);
  });

  it('formatPairTitle renders segment, pair id and slot indices', () => {
    const title = formatPairTitle({
      segmentId: 0,
      reviewPairId: '0:0:100:0|0:0:200:0',
      observationIdA: '0:0:100:0',
      observationIdB: '0:0:200:0',
    });
    assert.match(title, /Segment 0/);
    assert.match(title, /slot 0 → 0/);
    assert.match(title, /0:0:100:0\|0:0:200:0/);
  });
});

describe('B-MOTION playback geometry rendering input', () => {
  it('real frame has finite coordinates and non-empty draw plan', () => {
    const frames = loadRealSegmentFrames();
    const serialized = serializePlaybackFrame(frames[0], 0);
    const stats = analyzeFrameGeometry(serialized);
    assert.ok(stats.pointCount > 0);
    assert.ok(stats.hasDrawable);
    const plan = buildDrawPlan(serialized, 960, 540);
    assert.equal(plan.hasDrawable, true);
    assert.ok(plan.paths.length > 0);
    for (const p of plan.paths) {
      assert.ok(p.points.length >= 2);
      for (const pt of p.points) {
        assert.ok(Number.isFinite(pt.x));
        assert.ok(Number.isFinite(pt.y));
      }
    }
  });

  it('empty frame reports no drawable geometry status', () => {
    const empty = { laneLines: [], roadEdges: [] };
    const plan = buildDrawPlan(empty, 640, 360);
    assert.equal(plan.hasDrawable, false);
    assert.match(plan.message, /No drawable/);
  });
});

describe('B-MOTION playback review gating and navigation', () => {
  it('blocks positive/negative until drawable evidence rendered', () => {
    assert.equal(canSubmitReviewLabel({
      evidenceLoaded: false, hasDrawable: false, label: 'positive_continuation', evidenceMode: 'qlog_playback',
    }), false);
    assert.equal(canSubmitReviewLabel({
      evidenceLoaded: true, hasDrawable: true, targetMapped: true, label: 'negative_non_continuation', evidenceMode: 'qlog_playback',
    }), true);
    assert.equal(canSubmitReviewLabel({
      evidenceLoaded: true, hasDrawable: false, label: 'positive_continuation', evidenceMode: 'qlog_playback',
    }), false);
  });

  it('allows unresolved with insufficient evidence or after load', () => {
    assert.equal(canSubmitReviewLabel({
      evidenceLoaded: false, hasDrawable: false, label: 'unresolved', evidenceMode: 'insufficient',
    }), true);
    assert.equal(canSubmitReviewLabel({
      evidenceLoaded: true, hasDrawable: false, label: 'unresolved', evidenceMode: 'qlog_playback',
    }), true);
  });

  it('navigationFrameIndex handles prev, next, frameA and frameB', () => {
    const payload = {
      frames: [{}, {}, {}, {}],
      suggestedFrameIndexA: 1,
      suggestedFrameIndexB: 3,
    };
    assert.equal(navigationFrameIndex('frameA', 0, payload), 1);
    assert.equal(navigationFrameIndex('frameB', 0, payload), 3);
    assert.equal(navigationFrameIndex('next', 1, payload), 2);
    assert.equal(navigationFrameIndex('prev', 1, payload), 0);
  });
});

describe('B-MOTION target observation highlighting', () => {
  const {
    parseObservationEndpoint,
    formatPairIdentity,
    findLaneBySourceSlot,
    resolvePairTargetMapping,
    resolveActiveTarget,
    TARGET_LANE_COLOR,
    NON_TARGET_LANE_COLOR,
  } = require('../lib/stage20_b_motion_review_playback');

  function playbackForTimes(frames, logMonoTimeA, logMonoTimeB) {
    const serialized = frames.map((f, i) => serializePlaybackFrame(f, i));
    const findIdx = (t) => {
      const target = BigInt(t);
      let best = 0;
      let bestDiff = null;
      for (let i = 0; i < serialized.length; i++) {
        const cur = BigInt(serialized[i].logMonoTime);
        const diff = cur > target ? cur - target : target - cur;
        if (bestDiff == null || diff < bestDiff) {
          bestDiff = diff;
          best = i;
        }
      }
      return best;
    };
    return {
      frames: serialized,
      suggestedFrameIndexA: findIdx(logMonoTimeA),
      suggestedFrameIndexB: findIdx(logMonoTimeB),
    };
  }

  it('observation ID maps sourceSlotIndex to laneIndex, not array order alone', () => {
    const parsed = parseObservationEndpoint('0:0:73700718671:2');
    assert.equal(parsed.sourceSlotIndex, 2);
    assert.equal(parsed.logMonoTime, '73700718671');
    const frames = loadRealSegmentFrames();
    const payload = playbackForTimes(frames, '73700718671', '75701987372');
    const frameA = payload.frames[payload.suggestedFrameIndexA];
    const lane = findLaneBySourceSlot(frameA, 2);
    assert.ok(lane);
    assert.equal(lane.laneIndex, 2);
  });

  it('different candidate pairs on same frames highlight different target dividers', () => {
    const frames = loadRealSegmentFrames();
    const payload = playbackForTimes(frames, '73700718671', '75701987372');
    const pair0 = {
      reviewPairId: '0:0:73700718671:0|0:0:75701987372:0',
      observationIdA: '0:0:73700718671:0',
      observationIdB: '0:0:75701987372:0',
      segmentId: 0,
      logMonoTimeA: '73700718671',
      logMonoTimeB: '75701987372',
    };
    const pair1 = {
      reviewPairId: '0:0:73700718671:1|0:0:75701987372:1',
      observationIdA: '0:0:73700718671:1',
      observationIdB: '0:0:75701987372:1',
      segmentId: 0,
      logMonoTimeA: '73700718671',
      logMonoTimeB: '75701987372',
    };
    const map0 = resolvePairTargetMapping(pair0, payload);
    const map1 = resolvePairTargetMapping(pair1, payload);
    assert.equal(map0.ok, true);
    assert.equal(map1.ok, true);
    assert.equal(map0.targetLaneIndexA, 0);
    assert.equal(map1.targetLaneIndexA, 1);
    assert.notEqual(map0.targetLaneIndexA, map1.targetLaneIndexA);

    const frameA = payload.frames[payload.suggestedFrameIndexA];
    const plan0 = buildDrawPlan(frameA, 960, 540, { targetLaneIndex: map0.targetLaneIndexA });
    const plan1 = buildDrawPlan(frameA, 960, 540, { targetLaneIndex: map1.targetLaneIndexA });
    const target0 = plan0.paths.find((p) => p.role === 'target');
    const target1 = plan1.paths.find((p) => p.role === 'target');
    assert.equal(target0.laneIndex, 0);
    assert.equal(target1.laneIndex, 1);
    assert.equal(target0.color, TARGET_LANE_COLOR);
    assert.equal(target1.color, TARGET_LANE_COLOR);
  });

  it('Observation A maps to Frame A geometry and Observation B to Frame B', () => {
    const frames = loadRealSegmentFrames();
    const payload = playbackForTimes(frames, '73700718671', '75701987372');
    const pair = {
      reviewPairId: '0:0:73700718671:3|0:0:75701987372:3',
      observationIdA: '0:0:73700718671:3',
      observationIdB: '0:0:75701987372:3',
      segmentId: 0,
      logMonoTimeA: '73700718671',
      logMonoTimeB: '75701987372',
    };
    const activeA = resolveActiveTarget(pair, payload, payload.suggestedFrameIndexA);
    const activeB = resolveActiveTarget(pair, payload, payload.suggestedFrameIndexB);
    assert.equal(activeA.ok, true);
    assert.equal(activeA.endpoint, 'A');
    assert.equal(activeA.sourceSlotIndex, 3);
    assert.equal(activeB.ok, true);
    assert.equal(activeB.endpoint, 'B');
    assert.equal(activeB.sourceSlotIndex, 3);

    const planA = buildDrawPlan(payload.frames[payload.suggestedFrameIndexA], 800, 450, {
      targetLaneIndex: activeA.sourceSlotIndex,
    });
    const planB = buildDrawPlan(payload.frames[payload.suggestedFrameIndexB], 800, 450, {
      targetLaneIndex: activeB.sourceSlotIndex,
    });
    assert.equal(planA.targetFound, true);
    assert.equal(planB.targetFound, true);
    assert.equal(planA.paths.find((p) => p.role === 'target').laneIndex, 3);
    assert.equal(planB.paths.find((p) => p.role === 'target').laneIndex, 3);
  });

  it('unrelated dividers remain visible but muted', () => {
    const frames = loadRealSegmentFrames();
    const payload = playbackForTimes(frames, '73700718671', '75701987372');
    const frameA = payload.frames[payload.suggestedFrameIndexA];
    const plan = buildDrawPlan(frameA, 960, 540, { targetLaneIndex: 1 });
    const muted = plan.paths.filter((p) => p.role === 'non_target');
    const target = plan.paths.filter((p) => p.role === 'target');
    assert.ok(muted.length >= 1);
    assert.equal(target.length, 1);
    for (const m of muted) {
      assert.equal(m.muted, true);
      assert.equal(m.color, NON_TARGET_LANE_COLOR);
      assert.ok(m.width < target[0].width);
    }
  });

  it('submission is blocked when target mapping fails', () => {
    assert.equal(canSubmitReviewLabel({
      evidenceLoaded: true,
      hasDrawable: true,
      targetMapped: false,
      label: 'positive_continuation',
      evidenceMode: 'qlog_playback',
    }), false);
    assert.equal(canSubmitReviewLabel({
      evidenceLoaded: true,
      hasDrawable: true,
      targetMapped: false,
      label: 'negative_non_continuation',
      evidenceMode: 'qlog_playback',
    }), false);
    assert.equal(canSubmitReviewLabel({
      evidenceLoaded: true,
      hasDrawable: true,
      targetMapped: true,
      label: 'positive_continuation',
      evidenceMode: 'qlog_playback',
    }), true);
  });

  it('pair identity displays correct IDs and indices', () => {
    const identity = formatPairIdentity({
      reviewPairId: '0:0:73700718671:1|0:0:75701987372:1',
      observationIdA: '0:0:73700718671:1',
      observationIdB: '0:0:75701987372:1',
    });
    assert.equal(identity.reviewPairId, '0:0:73700718671:1|0:0:75701987372:1');
    assert.equal(identity.observationIdA, '0:0:73700718671:1');
    assert.equal(identity.observationIdB, '0:0:75701987372:1');
    assert.equal(identity.sourceSlotIndexA, 1);
    assert.equal(identity.sourceSlotIndexB, 1);
  });

  it('resolvePairTargetMapping fails explicitly for missing target slot', () => {
    const frames = loadRealSegmentFrames();
    const payload = playbackForTimes(frames, '73700718671', '75701987372');
    const bad = resolvePairTargetMapping({
      reviewPairId: 'x',
      observationIdA: '0:0:73700718671:99',
      observationIdB: '0:0:75701987372:0',
      logMonoTimeA: '73700718671',
      logMonoTimeB: '75701987372',
    }, payload);
    assert.equal(bad.ok, false);
    assert.ok(bad.issues.some((i) => i.endpoint === 'A' && i.error === 'target_lane_not_found_in_frame'));
  });
});

describe('B-MOTION browser playback bundle', () => {
  it('analyzeFrameGeometry does not throw when browser bundle is evaluated', () => {
    const api = loadBrowserPlaybackApi();
    const frames = loadRealSegmentFrames();
    const serialized = serializePlaybackFrame(frames[0], 0);
    assert.doesNotThrow(() => api.analyzeFrameGeometry(serialized));
    const stats = api.analyzeFrameGeometry(serialized);
    assert.ok(stats.hasDrawable);
  });

  it('filters non-finite coordinates in browser bundle', () => {
    const api = loadBrowserPlaybackApi();
    const frame = {
      laneLines: [{
        points: [
          { east: 1, north: 2 },
          { east: NaN, north: 3 },
          { east: 4, north: Infinity },
          { east: 5, north: 6 },
        ],
      }],
      roadEdges: [],
    };
    const stats = api.analyzeFrameGeometry(frame);
    assert.equal(stats.pointCount, 2);
    assert.equal(stats.laneLineCount, 1);
  });

  it('buildDrawPlan works with real playback frame data in browser bundle', () => {
    const api = loadBrowserPlaybackApi();
    const frames = loadRealSegmentFrames();
    const serialized = serializePlaybackFrame(frames[0], 0);
    const plan = api.buildDrawPlan(serialized, 960, 540);
    assert.equal(plan.hasDrawable, true);
    assert.ok(plan.paths.length > 0);
    for (const line of plan.paths) {
      for (const pt of line.points) {
        assert.ok(Number.isFinite(pt.x));
        assert.ok(Number.isFinite(pt.y));
      }
    }
  });

  it('empty or all-nonfinite geometry returns explicit no-drawable state in browser bundle', () => {
    const api = loadBrowserPlaybackApi();
    const emptyPlan = api.buildDrawPlan({ laneLines: [], roadEdges: [] }, 640, 360);
    assert.equal(emptyPlan.hasDrawable, false);
    assert.match(emptyPlan.message, /No drawable/);

    const nonFinitePlan = api.buildDrawPlan({
      laneLines: [{ points: [{ east: NaN, north: 1 }, { east: 2, north: NaN }] }],
      roadEdges: [],
    }, 640, 360);
    assert.equal(nonFinitePlan.hasDrawable, false);
    assert.ok(nonFinitePlan.message);
  });

  it('playback-helpers.js HTTP endpoint serves a runnable bundle', async () => {
    const http = require('http');
    process.env.B_MOTION_REVIEWS_PATH = path.join(require('os').tmpdir(), `bmotion-bundle-${Date.now()}.json`);
    const serverModulePath = require.resolve('../scripts/stage20_b_motion_review_server');
    delete require.cache[serverModulePath];
    const app = require('../scripts/stage20_b_motion_review_server');
    const server = await new Promise((resolve) => {
      const srv = app.listen(0, () => resolve(srv));
    });
    const port = server.address().port;

    const script = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/playback-helpers.js`, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve(buf));
      }).on('error', reject);
    });

    const context = { window: {} };
    vm.createContext(context);
    assert.doesNotThrow(() => vm.runInContext(script, context));
    const api = context.window.BMotionPlayback;
    const frames = loadRealSegmentFrames();
    const serialized = serializePlaybackFrame(frames[0], 0);
    assert.doesNotThrow(() => api.buildDrawPlan(serialized, 800, 450));

    await new Promise((resolve) => server.close(resolve));
    delete require.cache[serverModulePath];
  });
});

describe('B-MOTION qlog API playback payload', () => {
  it('returns non-empty laneLines for batch-01 first pair segment', async () => {
    const http = require('http');
    process.env.B_MOTION_REVIEWS_PATH = path.join(require('os').tmpdir(), `bmotion-playback-api-${Date.now()}.json`);
    const serverModulePath = require.resolve('../scripts/stage20_b_motion_review_server');
    delete require.cache[serverModulePath];
    const app = require('../scripts/stage20_b_motion_review_server');
    const server = await new Promise((resolve) => {
      const srv = app.listen(0, () => resolve(srv));
    });
    const port = server.address().port;

    const post = (body) => new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/qlog/process', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve(JSON.parse(buf)));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });

    const manifest = require('../lib/stage20_b_motion_manifest_validate').loadManifest(
      path.join(__dirname, '..', 'deliverables', 'stage20-b-motion-evidence-review-manifest.json'),
    );
    const pair = manifest.reviewPairs[0];
    const payload = await post({
      qlogReference: pair.qlogReference,
      logMonoTimeA: pair.logMonoTimeA,
      logMonoTimeB: pair.logMonoTimeB,
    });
    assert.ok(payload.frames.length > 0);
    const stats = analyzeFrameGeometry(payload.frames[0]);
    assert.ok(stats.laneLineCount > 0, `expected lane lines, got ${JSON.stringify(stats)}`);
    assert.ok(stats.hasDrawable);

    await new Promise((resolve) => server.close(resolve));
    delete require.cache[serverModulePath];
  });
});
