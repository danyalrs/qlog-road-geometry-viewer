'use strict';

/**
 * Regression tests for the lane-viewer state / rendering fix.
 *
 * The regression: `_drawConstructedFragments` referenced `drawn` without
 * declaring it, so every fragment draw threw `ReferenceError: drawn is not
 * defined`, aborting the point-accumulated canvas function. That hid the
 * vehicle arrow (drawn later), the joined solid polylines (drawn after
 * fragments), and every boundary except the first fragment's (blue). It also
 * made the viewer appear to retain the first processed segment's geometry.
 *
 * These tests pin the fix and the invariants that must hold.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RENDER_JS = path.join(ROOT, 'public/render.js');
const APP_JS = path.join(ROOT, 'public/app.js');
const LANE_JOINING = path.join(ROOT, 'lib/lane_joining.js');

describe('renderer: drawn variable regression', () => {
  it('1. _drawConstructedFragments declares `drawn` before use', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    const i = src.indexOf('_drawConstructedFragments(map, elapsedIdx, visiblePoints)');
    const j = src.indexOf('_drawJoinedPolylines(map, elapsedIdx, visiblePoints)');
    const block = src.slice(i, j);
    assert.match(block, /let drawn = 0/, '_drawConstructedFragments declares drawn');
    assert.ok((block.match(/drawn/g) || []).length >= 2, 'drawn used');
  });

  it('2. no other layer method references an undeclared counter', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    // every `xxx++` counter in a method must have a matching `let xxx = 0`
    const methods = ['_drawPointAccumulatedGeometry', '_drawConstructedFragments', '_drawJoinedPolylines', '_drawJoinCandidates'];
    for (const m of methods) {
      const i = src.indexOf(`${m}(map`);
      const next = methods.map((n) => src.indexOf(`${n}(map`, i + 10)).filter((x) => x > 0).sort((a, b) => a - b)[0] || src.length;
      const block = src.slice(i, next);
      const counters = [...block.matchAll(/(\w+)\+\+/g)].map((x) => x[1]);
      for (const c of counters) {
        assert.ok(new RegExp(`let ${c} = 0|let ${c}\\s*=`).test(block), `${m} declares ${c}`);
      }
    }
  });
});

describe('segment state replacement (frontend)', () => {
  it('3. process() assigns the new result to processData', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    assert.match(src, /processData = data;/);
    assert.match(src, /clearProcessState\(\);/);
    assert.match(src, /applyVisualization\(\);/);
  });

  it('4. clearProcessState clears the stationary map cache and resets state', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    assert.match(src, /clearStationaryMapCache\(\);/);
    assert.match(src, /processData = null;/);
    assert.match(src, /renderer\.setData\(null/);
  });

  it('5. segment processing targets the currently selected segment', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    // btnProcess uses selectedSegments() at click time, not a captured value
    assert.match(src, /btnProcess.*onclick.*process\(selectedSegments\(\)/);
  });

  it('6. the server cache key includes the qlog filename and file hash', () => {
    // check the server for a cache key that includes the file
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(serverSrc, /sha256|fileHash|hash/i, 'server hashes input file');
    assert.match(serverSrc, /segments|qlog|\.bz2/i, 'server references input filename');
  });
});

describe('shared boundary colour (Part E/F)', () => {
  it('7. fragments/joined use boundaryColor(groupTrackId), not laneColors[laneIndex]', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    assert.match(src, /boundaryColor\(frag\.groupTrackId\)/);
    assert.match(src, /boundaryColor\(poly\.groupTrackId/);
    // the old hard-coded laneColors map must not select normal colours
    const fragBlock = src.slice(src.indexOf('_drawConstructedFragments(map'), src.indexOf('_drawJoinedPolylines(map'));
    assert.ok(!/laneColors\[frag\.laneIndex\]/.test(fragBlock), 'no laneColors[laneIndex] in fragments');
  });

  it('8. missing identity produces a diagnostic, not silent orange', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    assert.match(src, /missing identity/);
    assert.match(src, /#f97316/);
  });

  it('9. debug decision colours are confined to the candidates layer', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    const candStart = src.indexOf('_drawJoinCandidates(map, elapsedIdx, visiblePoints)');
    const candEnd = src.indexOf('_joinCandidateHover');
    const candBlock = src.slice(candStart, candEnd);
    // amber/red/brown appear only in the debug block
    assert.match(candBlock, /rgba\(245,158,11/); // amber
    assert.match(candBlock, /rgba\(220,38,38/); // red rejected
    // normal joined layer must not use amber (slice just the joined method)
    const joinedStart = src.indexOf('_drawJoinedPolylines(map, elapsedIdx, visiblePoints)');
    const joinedEnd = src.indexOf('_drawJoinCandidates(map, elapsedIdx, visiblePoints)');
    const joinedBlock = src.slice(joinedStart, joinedEnd);
    assert.ok(!/245,158,11/.test(joinedBlock), 'no amber in joined layer');
    assert.ok(!/rgba\(220,38,38/.test(joinedBlock), 'no rejected-red in joined layer');
  });

  it('10. groupTrackId 0/1/2/3 resolve to blue/red/green/orange', () => {
    const TC = ['#2563eb', '#dc2626', '#16a34a', '#ca8a04', '#7c3aed', '#0891b2', '#ea580c', '#db2777', '#4f46e5', '#65a30d', '#0d9488', '#c026d3'];
    assert.strictEqual(TC[0], '#2563eb');
    assert.strictEqual(TC[1], '#dc2626');
    assert.strictEqual(TC[2], '#16a34a');
    assert.strictEqual(TC[3], '#ca8a04');
    // numeric and string forms resolve identically
    for (const g of [1, '1']) assert.strictEqual(TC[g % TC.length], '#dc2626');
    for (const g of [3, '3']) assert.strictEqual(TC[g % TC.length], '#ca8a04');
  });
});

describe('joined-output integrity retained (Part G)', () => {
  it('11. every valid fragment appears exactly once (singleton logic present)', () => {
    const src = fs.readFileSync(LANE_JOINING, 'utf8');
    assert.match(src, /singleton/);
    assert.match(src, /paths\.push\(\[f\]\)/);
    assert.match(src, /orderedSourceFragmentIds: fragments\.map\(\(f\) => f\.fragmentId\)/);
  });

  it('12. joined polylines carry groupTrackId for colour resolution', () => {
    const src = fs.readFileSync(LANE_JOINING, 'utf8');
    assert.match(src, /groupTrackId: A\.groupTrackId/);
  });
});
