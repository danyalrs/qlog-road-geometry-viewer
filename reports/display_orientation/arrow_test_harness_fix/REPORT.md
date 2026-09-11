# Arrow source-order test harness fix

## 1. Repository state
- Root `C:\Kommu AI Project`; branch `experiment/candidate-layer-display`; HEAD `488c61b`; staged-file count 0.
- One test file edited. No production source, `render.js`, `app.js`, `index.html`, `server.js` or `lib/` file changed.

## 2. Exact original failure
`tests/local_playback_geometry_modes.test.js` → `16. arrow renders above geometry and vehicle path`:
`assert.ok(movementIdx > arrowIdx, 'movement indicator should follow arrow')` failed. The check searched a
fixed `renderSrc.slice(methodStart, methodStart + 20000)` window.

## 3. Why the 20 000-character window failed
`methodStart = renderSrc.indexOf('_drawStationaryLocalMap(d, elapsedIdx)')` resolves to a **call site**
(line 1348), not the method definition (line 1408). The method body is ~19 445 chars and, after accepted
display code growth, the arrow draw (line 1791) and the movement indicator (line 1803) sit at offsets
~18 204 and ~18 782 from that call site. The movement indicator fell just outside the fixed 20 000-char
window, so `movementIdx` became `-1` and the ordering assertion failed. Against HEAD `render.js` (more compact)
the same test passed — confirming this is a harness boundary issue, not an arrow rendering regression.

## 4. Exact test-only change
Added a brace-aware extractor next to the existing `extractFunctionBody`:
```js
function extractMethodBody(src, header) {
  const start = src.indexOf(header);
  if (start < 0) return '';
  const braceStart = start + header.length - 1; // header ends with '{'
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  return src.slice(start);
}
```
Rewrote test 16 to extract the complete `_drawStationaryLocalMap(d, elapsedIdx) {` body and run the same
markers/order check inside that body (trajectory `this._drawLocalVehiclePathOverlay(map);`, arrow
`this._drawLocalPlaybackArrow(null, this.playbackPose)`, movement indicator, diagnostic overlays), with
explicit presence assertions for the trajectory and arrow markers. No other assertion changed in this test.

## 5. Why the new assertion is not weaker
- It verifies the **same** relative ordering (trajectory → arrow → movement indicator → diagnostics) with the
  same operators.
- It now scopes to the exact containing method, so it cannot accidentally match markers elsewhere in the file
  (the previous fixed slice was both too small and not function-scoped).
- It adds two explicit `>= 0` presence checks (`pathIdx`, `arrowIdx`), so a missing trajectory/arrow marker now
  fails with a clear message instead of passing vacuously.
- It still fails if the arrow/trajectory order is genuinely reversed.
- It is independent of total file length and does not use an arbitrary larger character limit.

## 6. Verification results
| Group | Suite / command | Result |
|---|---|---|
| 1 | `tests/local_playback_geometry_modes.test.js` | **41/41 pass** |
| 2 | `tests/local_playback_stationary.test.js` | **19/19 pass** |
| 3 | accepted-path focused (6 suites) | **60/60 pass** |
| 4 | `tests/representative_lane_lines_purity_revisit.test.js` | **13/13 pass** |

Confirmations: the six reconciled Point-accumulated default tests still pass; valid fused tests are unchanged;
the API test (`28`) still passes (server running on 3847); the arrow test now passes via stable source scoping;
no production file changed.

## 7. Files edited
- `tests/local_playback_geometry_modes.test.js` (test-only).

## 8. Backup location
`.checkpoint_test_backup/pre_arrow_test_harness_fix/local_playback_geometry_modes.test.js`
(SHA1 `16B611ACEE206A26EE98B987004696A3C6584226`).

## 9. Staging recommendation
Whole-file staging of `tests/local_playback_geometry_modes.test.js` remains **safe**. The working-tree diff
contains only:
1. `extractMethodBody` helper (arrow harness).
2. Arrow test 16 rewritten to brace-aware method scoping.
3. Test 6 default → `pointAccumulated` (constant + normalize cases + HTML selected).
4. Test 21 fallback → `pointAccumulated`.
5. Test 22 non-empty geometry made mode-aware (`laneFragments` OR `pointAccumulated.points`).
6. Browser-parity regex → `pointAccumulated`.
No unrelated diff exists (confirmed by `git diff`).

## 10. Remaining failures
None in the four verification groups. The previously retained arrow test now passes; the API test passes with
the server running.

## 11. Branch, HEAD and staged count
Branch `experiment/candidate-layer-display`; HEAD `488c61b`; staged-file count **0**.

## 12. Confirmation that production code is unchanged
No production source, `render.js`, `app.js`, `index.html`, `server.js` or `lib/` file was modified. Only the test
file and the new evidence directory were written.

## 13. Commit and push status
No commit, no push, no staging. No `git reset`/`checkout`/`clean`/`restore`/`undo` used.

## 14. Verdict
**Ready for exact staging review.** The arrow source-order test is fixed by stable function-body scoping, all
four verification groups pass, and the change is confined to the test harness.

---

Test-harness fix only. Arrow rendering unchanged. Production behaviour unchanged. Nothing staged, committed or pushed.
