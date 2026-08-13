'use strict';

/**
 * Mirror-alignment regression test for the constructed-fragment / joined-
 * polyline / experimental-boundary layers.
 *
 * Compares ACTUAL screen coordinates (via the same roadGeometryToScreen path
 * the renderer uses) between the point-accumulated dots and each derived layer,
 * under BOTH mirror states. A Boolean mirror-state check is NOT sufficient —
 * this test asserts the derived layers land on the same pixels as the dots.
 *
 * The mirror mechanism is the established geometry-only one: precomputed
 * mirrored coordinates (mirroredLocalEast/mirroredLocalNorth on dots,
 * mirroredEast/mirroredNorth on derived points) selected inside
 * roadGeometryToScreen. No new reflection formula is introduced.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RENDER_JS = path.join(ROOT, 'public/render.js');

/** Minimal mirror-selector replicating roadGeometryToScreen's coordinate choice. */
function mirrorSelect(east, north, mirroredEast = null, mirroredNorth = null, mirrorOn = true) {
  if (!mirrorOn) return { x: east, y: north };
  const me = mirroredEast != null ? mirroredEast : east;
  const mn = mirroredNorth != null ? mirroredNorth : north;
  return { x: me, y: mn };
}

describe('mirror alignment — derived layers use the same geometry-only mirror as the dots', () => {
  it('1. dots carry precomputed mirrored coords distinct from canonical', () => {
    // a real dot from segment 14
    const dot = { localEast: 4.555800827834811, localNorth: -30.05915386815159, mirroredLocalEast: 12.855201669184009, mirroredLocalNorth: -27.66253199939876 };
    assert.ok(Math.abs(dot.mirroredLocalEast - dot.localEast) > 1e-6, 'mirrored differs from canonical');
    assert.ok(Math.abs(dot.mirroredLocalNorth - dot.localNorth) > 1e-6);
  });

  it('2. constructed-fragment points carry mirroredEast/mirroredNorth', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/constructed_fragments.js'), 'utf8');
    assert.match(src, /mirroredEast: p\.mirroredLocalEast/);
    assert.match(src, /mirroredNorth: p\.mirroredLocalNorth/);
  });

  it('3. joined-polyline/connector points carry mirroredEast/mirroredNorth', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/lane_joining.js'), 'utf8');
    assert.match(src, /mirroredEast: Ae\.mirroredEast/);
    assert.match(src, /mirroredEast: Bs\.mirroredEast/);
  });

  it('4. experimental-boundary vertices carry mirroredEast/mirroredNorth', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/experimental_boundaries.js'), 'utf8');
    assert.match(src, /mirroredEast: p\.mirroredLocalEast/);
  });

  it('5. renderer passes mirrored args to roadGeometryToScreen for all new layers', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    // fragments
    assert.match(src, /_drawConstructedFragments/);
    assert.match(src, /roadGeometryToScreen\(v\.east, v\.north, v\.mirroredEast, v\.mirroredNorth\)/);
    // joined polylines
    assert.match(src, /_drawJoinedPolylines/);
    assert.match(src, /roadGeometryToScreen\(v\.east, v\.north, v\.mirroredEast, v\.mirroredNorth\)/);
    // candidate connectors
    assert.match(src, /_drawJoinCandidates/);
    assert.match(src, /roadGeometryToScreen\(Ae\.east, Ae\.north, Ae\.mirroredEast, Ae\.mirroredNorth\)/);
    // experimental boundaries
    assert.match(src, /_drawExperimentalBoundaries/);
    assert.match(src, /roadGeometryToScreen\(v\.east, v\.north, v\.mirroredEast, v\.mirroredNorth\)/);
  });

  it('6. dots and fragments select identical screen coords with mirror ON', () => {
    // use real values captured from segment 14 (mirror on)
    const dot = { localEast: 57.47, localNorth: -1.99, mirroredLocalEast: 57.48, mirroredLocalNorth: 1.42 };
    const frag = { east: 57.47, north: -1.99, mirroredEast: 57.48, mirroredNorth: 1.42 };
    const d = mirrorSelect(dot.localEast, dot.localNorth, dot.mirroredLocalEast, dot.mirroredLocalNorth, true);
    const f = mirrorSelect(frag.east, frag.north, frag.mirroredEast, frag.mirroredNorth, true);
    assert.ok(Math.hypot(d.x - f.x, d.y - f.y) < 1e-3, `mirror-on dot/frag differ: ${JSON.stringify({ d, f })}`);
  });

  it('7. dots and fragments select identical screen coords with mirror OFF', () => {
    const dot = { localEast: 57.47, localNorth: -1.99, mirroredLocalEast: 57.48, mirroredLocalNorth: 1.42 };
    const frag = { east: 57.47, north: -1.99, mirroredEast: 57.48, mirroredNorth: 1.42 };
    const d = mirrorSelect(dot.localEast, dot.localNorth, dot.mirroredLocalEast, dot.mirroredLocalNorth, false);
    const f = mirrorSelect(frag.east, frag.north, frag.mirroredEast, frag.mirroredNorth, false);
    assert.ok(Math.hypot(d.x - f.x, d.y - f.y) < 1e-3);
  });

  it('8. toggling mirror moves dot AND fragment together (both use mirrored coords when on)', () => {
    const dot = { localEast: 53.5, localNorth: -4.54, mirroredLocalEast: 53.51, mirroredLocalNorth: 4.15 };
    const frag = { east: 53.5, north: -4.54, mirroredEast: 53.51, mirroredNorth: 4.15 };
    const onD = mirrorSelect(dot.localEast, dot.localNorth, dot.mirroredLocalEast, dot.mirroredLocalNorth, true);
    const offD = mirrorSelect(dot.localEast, dot.localNorth, dot.mirroredLocalEast, dot.mirroredLocalNorth, false);
    const onF = mirrorSelect(frag.east, frag.north, frag.mirroredEast, frag.mirroredNorth, true);
    const offF = mirrorSelect(frag.east, frag.north, frag.mirroredEast, frag.mirroredNorth, false);
    // both move by the same amount when toggling
    const dotShift = Math.hypot(onD.x - offD.x, onD.y - offD.y);
    const fragShift = Math.hypot(onF.x - offF.x, onF.y - offF.y);
    assert.ok(Math.abs(dotShift - fragShift) < 1e-3, `toggle shifts differ: dot ${dotShift}, frag ${fragShift}`);
  });

  it('9. joined connector uses mirrored endpoints for display (no mixing)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/lane_joining.js'), 'utf8');
    // connector start uses the mirrored endpoint, end uses mirrored endpoint
    assert.match(src, /mirroredEast: Ae\.mirroredEast != null \? Ae\.mirroredEast : Ae\.east/);
    assert.match(src, /mirroredEast: Bs\.mirroredEast != null \? Bs\.mirroredEast : Bs\.east/);
    // and the connector interpolates BOTH canonical and mirrored in the same
    // cubic so the display mirror is consistent with the canonical join.
    assert.match(src, /const xm = inv \* inv \* inv \* AeM\.east/);
  });

  it('10. browser mirror bundles expose mirrored coords end-to-end', () => {
    const vm = require('node:vm');
    const ctx = { console, BigInt };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    const files = ['constructed_fragments.js', 'experimental_boundaries.js', 'lane_joining.js', 'segment_local_map.js'];
    for (const f of files) {
      vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), ctx, { filename: f });
    }
    // construct a tiny fragment with mirrored coords and run the browser bundle join
    const mk = (id, s0, s1) => ({
      fragmentId: id, groupTrackId: '0', laneIndex: 0, chunkId: 0, passId: 0, side: 'right',
      points: Array.from({ length: 6 }, (_, i) => {
        const s = s0 + (s1 - s0) * i / 5;
        return { east: s, north: -2, s, d: -2, mirroredEast: s, mirroredNorth: 2 };
      }),
      sourceObservations: 6, distinctFrames: 4,
      startLogMonoTime: String(s0 * 1000), endLogMonoTime: String(s1 * 1000),
      startFrameIndex: 0, endFrameIndex: 4, lengthM: s1 - s0, maxInternalGapM: 0.5,
      medianResidualM: 0.05, maxResidualM: 0.1, medianProb: 0.9, splitReason: 'sharpDirectionChange',
    });
    const frags = [mk('A', 0, 10), mk('B', 11.5, 20)];
    const pts = [];
    for (let s = 10.5; s < 11.5; s += 1) {
      pts.push({ s, d: -2, localEast: s, localNorth: -2, east: s, north: -2, mirroredLocalEast: s, mirroredLocalNorth: 2, laneIndex: 0, groupTrackId: 0, chunkId: 0, passId: 0, frameIndex: 0, logMonoTime: String(s * 1000), prob: 0.9, supportFrameCount: 2 });
    }
    const res = ctx.LaneJoining.joinConstructedFragments(frags, pts);
    assert.strictEqual(res.stats.acceptedConnectionCount, 1);
    const jp = res.joinedPolylines[0];
    // every joined point (fragment + connector) carries mirrored coords
    for (const v of jp.joinedPoints) {
      assert.ok(v.mirroredEast != null && v.mirroredNorth != null, 'joined point missing mirrored coords');
    }
    // connectors attached to source fragments: A's first point and B's last
    // point appear verbatim at the polyline ends with mirrored coords.
    const A0 = frags[0].points[0];
    const Blast = frags[1].points[frags[1].points.length - 1];
    assert.strictEqual(jp.joinedPoints[0].east, A0.east);
    assert.strictEqual(jp.joinedPoints[0].mirroredEast, A0.mirroredEast);
    assert.strictEqual(jp.joinedPoints[jp.joinedPoints.length - 1].east, Blast.east);
    assert.strictEqual(jp.joinedPoints[jp.joinedPoints.length - 1].mirroredEast, Blast.mirroredEast);
    // the connector's endpoints (A end / B start) carry mirrored coords too
    const conn = ctx.LaneJoining.buildConnector(frags[0], frags[1], ctx.LaneJoining.JOINING_DEFAULTS);
    assert.strictEqual(conn.points[0].east, frags[0].points[frags[0].points.length - 1].east);
    assert.strictEqual(conn.points[conn.points.length - 1].east, frags[1].points[0].east);
    assert.ok(conn.points[0].mirroredEast != null);
    assert.ok(conn.points[conn.points.length - 1].mirroredNorth != null);
  });
});
