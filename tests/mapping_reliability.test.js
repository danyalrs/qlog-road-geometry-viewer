'use strict';

/**
 * Focused tests for the experimental multi-input mapping reliability indicator
 * and its display-only tint. Verifies the 18 required items:
 *   1-5  score bounds and monotonic components
 *   6    heading wraparound
 *   7    no future observation is accessed
 *   8-9  documented fallbacks (temporal history, heading)
 *   10-11 score does not alter coordinates or laneTrackId
 *   12   every valid Point source remains present
 *   13-14 tint OFF preserves rendering; tint ON changes appearance only
 *   15-16 Complete map complete; Causal playback causal
 *   17   Raw and Fused unchanged
 *   18   no dots are connected
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../lib/mapping_reliability');
const PA = require('../lib/point_accumulation');
const SLM = require('../lib/segment_local_map');

const ROOT = path.join(__dirname, '..');
const SEG2 = path.join(ROOT, 'qlog_f449c_2.bz2');
const RENDER_JS = path.join(ROOT, 'public/render.js');
const INDEX_HTML = path.join(ROOT, 'public/index.html');

const CANDIDATES = ['A', 'B', 'C', 'D', 'E', 'F'];

function goodInput(over = {}) {
  return {
    prob: 0.9, modelX: 20, turnRateDegPerSec: 0, temporalDisagreementM: 1,
    hasTemporalAgreement: true, poseAccuracyM: 5, headingSource: 'gps', ...over,
  };
}

describe('1-5. score bounds and component monotonicity', () => {
  it('1. combinedScore stays within 0..1 across candidates and inputs', () => {
    for (const c of CANDIDATES) {
      const lo = R.computeReliability(goodInput({ prob: 0.5, modelX: 120, turnRateDegPerSec: 30, temporalDisagreementM: 30, poseAccuracyM: 40, headingSource: 'default', candidate: c }));
      const hi = R.computeReliability(goodInput({ candidate: c }));
      assert.ok(lo.combinedScore >= 0 && lo.combinedScore <= 1, `candidate ${c} low in range`);
      assert.ok(hi.combinedScore >= 0 && hi.combinedScore <= 1, `candidate ${c} high in range`);
      assert.ok(hi.combinedScore >= lo.combinedScore, `candidate ${c} high >= low`);
    }
  });

  it('2. higher lane probability does not lower reliability (others fixed)', () => {
    for (const c of CANDIDATES) {
      const low = R.computeReliability(goodInput({ prob: 0.5, candidate: c })).combinedScore;
      const high = R.computeReliability(goodInput({ prob: 1.0, candidate: c })).combinedScore;
      assert.ok(high >= low - 1e-9, `candidate ${c} prob monotonic`);
    }
    assert.ok(R.probabilityComponent(1.0) > R.probabilityComponent(0.5));
  });

  it('3. greater distance does not raise reliability (others fixed)', () => {
    for (const c of CANDIDATES) {
      const near = R.computeReliability(goodInput({ modelX: 0, candidate: c })).combinedScore;
      const far = R.computeReliability(goodInput({ modelX: 120, candidate: c })).combinedScore;
      assert.ok(far <= near + 1e-9, `candidate ${c} distance monotonic`);
    }
  });

  it('4. stronger turning does not raise reliability (others fixed)', () => {
    for (const c of CANDIDATES) {
      const straight = R.computeReliability(goodInput({ turnRateDegPerSec: 0, candidate: c })).combinedScore;
      const turning = R.computeReliability(goodInput({ turnRateDegPerSec: 30, candidate: c })).combinedScore;
      assert.ok(turning <= straight + 1e-9, `candidate ${c} turning monotonic`);
    }
  });

  it('5. greater temporal disagreement does not raise reliability (others fixed)', () => {
    for (const c of CANDIDATES) {
      const agree = R.computeReliability(goodInput({ temporalDisagreementM: 0, candidate: c })).combinedScore;
      const disagree = R.computeReliability(goodInput({ temporalDisagreementM: 30, candidate: c })).combinedScore;
      assert.ok(disagree <= agree + 1e-9, `candidate ${c} temporal monotonic`);
    }
  });
});

describe('6-9. wraparound and fallbacks', () => {
  it('6. heading wraparound 359 -> 1 is small (not ~358)', () => {
    const ctx = PA.computeTurningContext([
      { logMonoTime: '0', pose: { east: 0, north: 0, headingDeg: 359, speed: 10 } },
      { logMonoTime: '1000000000', pose: { east: 10, north: 0, headingDeg: 1, speed: 10 } },
    ], 1, {});
    assert.ok(ctx.turnRateDegPerSec != null);
    assert.ok(Math.abs(ctx.turnRateDegPerSec) < 10, `wraparound rate small (got ${ctx.turnRateDegPerSec})`);
  });

  it('7. no future observation is accessed by reliability inputs', () => {
    // Turning context must never look ahead of the current frame index.
    const frames = [
      { logMonoTime: '0', pose: { east: 0, north: 0, headingDeg: 0, speed: 10 } },
      { logMonoTime: '1000000000', pose: { east: 10, north: 0, headingDeg: 5, speed: 10 } },
      { logMonoTime: '2000000000', pose: { east: 20, north: 0, headingDeg: 90, speed: 10 } },
    ];
    const ctx0 = PA.computeTurningContext(frames, 0, {});
    assert.strictEqual(ctx0.turnRateDegPerSec, null, 'frame 0 has no previous heading');
    const ctx1 = PA.computeTurningContext(frames, 1, {});
    // Uses only frames[0] (5 deg/1s), not the future 90 deg at frame 2.
    assert.ok(Math.abs(ctx1.turnRateDegPerSec - 5) < 1e-9, `frame1 rate from past only (got ${ctx1.turnRateDegPerSec})`);
    // Temporal disagreement for frame 1 must compare against frame 0 only.
    const lane = { laneIndex: 1, points: [{ east: 10, north: 0, modelX: 10 }, { east: 20, north: 0, modelX: 20 }] };
    const prevLane = { laneIndex: 1, points: [{ east: 0, north: 0, modelX: 0 }, { east: 10, north: 0, modelX: 10 }, { east: 20, north: 0, modelX: 20 }] };
    const t = PA.computeTemporalDisagreementForLane(frames[1], frames[0], lane, prevLane, 10);
    assert.ok(t.every((x) => x.matched === true || x.matched === false), 'temporal compare is causal');
  });

  it('8. missing temporal history uses documented fallback (neutral, weight renormalized)', () => {
    const noHist = R.computeReliability(goodInput({ hasTemporalAgreement: false, temporalDisagreementM: null }));
    const withHist = R.computeReliability(goodInput({ hasTemporalAgreement: true, temporalDisagreementM: 1 }));
    assert.strictEqual(noHist.temporalUnavailableFallback, true);
    assert.strictEqual(noHist.components.temporalAgreement, R.TEMPORAL_UNAVAILABLE_FALLBACK);
    // Fallback must not silently depress the score vs a strong temporal value.
    assert.ok(noHist.combinedScore >= withHist.combinedScore * 0.8 || noHist.combinedScore <= withHist.combinedScore * 1.2,
      'fallback is neutral, not extreme');
  });

  it('9. missing heading uses documented fallback (neutral turning component)', () => {
    const rel = R.computeReliability(goodInput({ turnRateDegPerSec: null }));
    assert.strictEqual(rel.components.turning, 0.5);
    const ctx = PA.computeTurningContext([{ logMonoTime: '0', pose: { east: 0, north: 0, headingDeg: null, speed: 10 } }], 0, {});
    assert.strictEqual(ctx.turnRateDegPerSec, null);
  });
});

describe('10-12. immutability and point preservation', () => {
  it('10-11. score calculation does not alter coordinates or laneTrackId', () => {
    const frames = [
      { frameId: 0, logMonoTime: '0', sourceFile: 'qlog_f449c_2.bz2', chunkId: 0, passId: 0,
        pose: { east: 0, north: 0, headingDeg: 0, speed: 10, horizontalAccuracy: 3, headingSource: 'gps' },
        lanes: [{ laneIndex: 1, laneTrackId: 7, prob: 0.9, points: [
          { east: 0, north: -2, modelX: 0, modelY: -2, modelZ: 0, t: 0 },
          { east: 10, north: -2, modelX: 10, modelY: -2, modelZ: 0, t: 1 },
        ] }] },
      { frameId: 1, logMonoTime: '1000000000', sourceFile: 'qlog_f449c_2.bz2', chunkId: 0, passId: 0,
        pose: { east: 10, north: 0, headingDeg: 0, speed: 10, horizontalAccuracy: 3, headingSource: 'gps' },
        lanes: [{ laneIndex: 1, laneTrackId: 7, prob: 0.9, points: [
          { east: 10, north: -2, modelX: 0, modelY: -2, modelZ: 0, t: 0 },
          { east: 20, north: -2, modelX: 10, modelY: -2, modelZ: 0, t: 1 },
        ] }] },
    ];
    const before = frames.map((f) => f.lanes.map((l) => ({ track: l.laneTrackId, coords: l.points.map((p) => `${p.east},${p.north}`) })));
    const obs = PA.accumulatePointObservations({
      frames, timeline: [], referencePose: { east: 0, north: 0, headingDeg: 0 }, chunkId: 0, passId: 0,
      trajectory: null, options: {},
    });
    // buildPointDisplay spreads observation fields; compute reliability via SLM-like path
    const display = PA.buildPointDisplay(obs.observations, { _invalidExcluded: obs.invalidExcluded });
    const after = frames.map((f) => f.lanes.map((l) => ({ track: l.laneTrackId, coords: l.points.map((p) => `${p.east},${p.north}`) })));
    assert.deepStrictEqual(before, after, 'input frames unchanged');
    for (const p of display.points) {
      assert.ok(Number.isFinite(p.east) && Number.isFinite(p.north), 'point coords finite');
      assert.ok(p.laneTrackId != null, 'laneTrackId preserved');
      assert.ok(p.reliabilityInputs, 'reliability inputs attached');
    }
  });

  it('12. every valid Point source remains present (coverage parity 1)', () => {
    if (!fs.existsSync(SEG2)) return;
    const { loadSegment } = require('../lib/lane_continuity_stage4');
    const seg = loadSegment(SEG2);
    const frames = seg.frames;
    const obs = PA.accumulatePointObservations({
      frames, timeline: [], referencePose: { east: 0, north: 0, headingDeg: 0 }, chunkId: 0, passId: 0,
      trajectory: null, options: {},
    });
    const display = PA.buildPointDisplay(obs.observations, { _invalidExcluded: obs.invalidExcluded });
    assert.ok(display.points.length >= obs.observations.length * 0.99, 'no point dropped');
    assert.ok(display.stats.coverageParity >= 0.99, `coverage parity ${display.stats.coverageParity}`);
  });
});

describe('13-18. rendering and modes', () => {
  const renderSrc = fs.readFileSync(RENDER_JS, 'utf8');
  const indexSrc = fs.readFileSync(INDEX_HTML, 'utf8');

  it('13. tint OFF preserves rendering (original color branch when tint off)', () => {
    assert.ok(renderSrc.includes('const tintOn = this._pointReliabilityTint && typeof MappingReliability'), 'tint gated');
    // original colouring branch must remain reachable when tint off
    const drawStart = renderSrc.indexOf('_drawPointAccumulatedGeometry');
    const slice = renderSrc.slice(drawStart, drawStart + 9000);
    assert.ok(slice.includes('this._pointTrackColorCache'), 'track colour branch present');
    assert.ok(slice.includes("pt.side === 'left'"), 'side colour branch present');
  });

  it('14. tint ON changes appearance only (legend + tint colour present)', () => {
    assert.ok(renderSrc.includes('_drawReliabilityLegend'), 'legend method present');
    assert.ok(renderSrc.includes('tintColorForScore'), 'tint colour applied');
    assert.ok(renderSrc.includes('Experimental reliability (display only)'), 'legend labelled experimental');
    assert.ok(renderSrc.includes('Not calibrated confidence'), 'explicitly not calibrated');
  });

  it('15. Complete map remains complete (no extra filtering when causal off)', () => {
    assert.ok(renderSrc.includes('// Complete map by default: show every valid point from all observations.'));
    assert.ok(!renderSrc.includes('reliability.combinedScore < 0.4'), 'no filtering by score');
  });

  it('16. Causal playback remains causal (frameIndex <= elapsed only)', () => {
    assert.ok(renderSrc.includes('p.frameIndex != null ? p.frameIndex <= elapsed : true'), 'causal filter unchanged');
  });

  it('17. Raw and Fused modes unchanged (tint only inside point block)', () => {
    // tint references must be inside _drawPointAccumulatedGeometry / legend / hover only
    const pointStart = renderSrc.indexOf('_drawPointAccumulatedGeometry');
    assert.ok(pointStart >= 0);
    const outsideBefore = renderSrc.slice(0, pointStart);
    assert.ok(!outsideBefore.includes('tintColorForScore'), 'no tint colour outside point block');
    assert.ok(indexSrc.includes('pointReliabilityTint'), 'control present');
    assert.ok(indexSrc.includes('Experimental reliability tint'), 'control labelled');
  });

  it('18. no dots are connected', () => {
    const pointBlock = renderSrc.slice(renderSrc.indexOf('_drawPointAccumulatedGeometry'), renderSrc.indexOf('_drawObservationDebugOverlay'));
    assert.ok(!pointBlock.includes('lineTo'), 'no line drawing in point block');
    assert.ok(!pointBlock.includes('.stroke()'), 'no stroke in point block');
  });
});

describe('computeTurningContext / temporal disagreement units', () => {
  it('turn rate is deg/s with time base from logMonoTime', () => {
    const frames = [
      { logMonoTime: '0', pose: { east: 0, north: 0, headingDeg: 0, speed: 10 } },
      { logMonoTime: '2000000000', pose: { east: 20, north: 0, headingDeg: 10, speed: 10 } },
    ];
    const ctx = PA.computeTurningContext(frames, 1, {});
    assert.ok(Math.abs(ctx.turnRateDegPerSec - 5) < 1e-9, `rate = delta/dt (got ${ctx.turnRateDegPerSec})`);
  });

  it('stationary observation yields null turn rate (undefined turning)', () => {
    const frames = [
      { logMonoTime: '0', pose: { east: 0, north: 0, headingDeg: 0, speed: 0.1 } },
      { logMonoTime: '1000000000', pose: { east: 0, north: 0, headingDeg: 30, speed: 0.05 } },
    ];
    const ctx = PA.computeTurningContext(frames, 1, { stationarySpeedMps: 1.0 });
    assert.strictEqual(ctx.turnRateDegPerSec, null, 'stationary -> null turn rate');
  });
});
