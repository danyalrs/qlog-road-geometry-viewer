# Default test reconciliation report

## 1. Repository state
- Root `C:\Kommu AI Project`; branch `experiment/candidate-layer-display`; HEAD `488c61b`; staged-file count 0.
- Port 3847 was **listening** during this task (PID 20268) and was not stopped or restarted.
- Two test files edited (test-only). No production source, no `server.js`, no thresholds changed.

## 2. Eight-failure classification table
| # | File | Test | Assertion (expected → actual) | Category | Before default edit? | HEAD same? | Decision |
|---|---|---|---|---|---|---|---|
| 1 | local_playback_geometry_modes | 6 | `DEFAULT_MODE`/normalize/HTML selected `fused` → `pointAccumulated` | UI-default | yes | yes | update |
| 2 | local_playback_geometry_modes | 21 | fallback `fused` → `pointAccumulated` | UI-default | yes | yes | update |
| 3 | local_playback_geometry_modes | 22 | `map.laneFragments.length>0` → `0` (pointAccumulated) | UI-default downstream | yes | yes | update (non-weakening) |
| 4 | local_playback_geometry_modes | 16 | source-order `movementIdx>arrowIdx` → false | arrow harness | yes | yes (passes at HEAD) | retain |
| 5 | local_playback_geometry_modes | 28 | API checksums via localhost:3847 → now pass | API/environmental | yes | yes | retain |
| 6 | local_playback_geometry_modes | browser parity | regex `…DEFAULT_MODE.*fused` → no match | UI-default | yes | yes | update |
| 7 | local_playback_stationary | 13 | HTML `fused selected` → `pointAccumulated selected` | UI-default | yes | yes | update |
| 8 | local_playback_stationary | 14 | HTML `fused selected` + constant `fused` → `pointAccumulated` | UI-default | yes | yes | update |

"Before default edit" = the failure predates the latest representative-method edit; it stems from the earlier
accepted local-geometry default change (`fused` → `pointAccumulated`, uncommitted). `git show HEAD` confirms
the committed production default was `fused` and the committed tests asserted `fused`.

## 3. Which fused assertions were genuinely stale
Six assertions that explicitly encoded the **old initial UI default** `fused`:
- geometry_modes test 6 (`LOCAL_GEOMETRY_DEFAULT_MODE`, `normalizeLocalGeometrySelection`, HTML `selected`),
  test 21 (fallback), test 22 (downstream geometry-collection assumption), browser-parity regex;
- stationary test 13 (selected dropdown option), test 14 (HTML `selected` + `LOCAL_GEOMETRY_DEFAULT_MODE`).
Accepted requirement: visualization `local`, local geometry `pointAccumulated`, all-per-frame on,
representative opt-in, method `purityRevisit`, fused still manually selectable.

## 4. Which fused assertions remain valid (unchanged)
- geometry_modes test 4 "Fused lane lines is present and enabled".
- geometry_modes test 7 "raw/fused/pointAccumulated remain separate modes".
- Layer-separation tests 7/8 (raw vs fused data-model geometry) and all `buildModeMap(data,'fused')` checksum tests.
- stationary fused-geometry/reference-frame tests.
No valid fused data-model assertion was weakened or removed.

## 5. Exact test edits
`tests/local_playback_geometry_modes.test.js`:
- test 6: expected default → `pointAccumulated` (constant, 3 normalize cases, HTML `selected`).
- test 21: fallback → `pointAccumulated`.
- test 22: replaced `map.laneFragments.length > 0` with a mode-aware non-empty geometry check
  (`laneFragments` OR `pointAccumulated.points`) — still a non-empty assertion, not weakened.
- browser-parity regex → `LOCAL_GEOMETRY_DEFAULT_MODE.*pointAccumulated`.
`tests/local_playback_stationary.test.js`:
- test 13: HTML selected option → `pointAccumulated` (fused retained as present but not selected); title updated.
- test 14: HTML `selected` + constant → `pointAccumulated`; fused/observations asserted not selected; title updated.
Each updated test carries a one-line comment noting the accepted default change (2026-09-10). No fixtures renamed,
no suite restructured, no other assertions touched.

## 6. API-test result
`28. API produces same pre-Stage-7/8 geometry checksums` **passes** with the running server. It targets
`localhost:3847`, does not start its own server, and does not assume an ephemeral port. Classification:
environmental; no edit. (It failed in the earlier consolidation only because the port was down.)

## 7. Arrow-test result
`16. arrow renders above geometry and vehicle path` **retained unchanged and still failing**.
- Exact assertion: source-order `movementIdx > arrowIdx` within a fixed 20000-char slice of `render.js`.
- Owning path: `_drawStationaryLocalMap` draw-order source scan (not a transform value).
- Predates the consolidation: it passes against HEAD `render.js`; it fails in the working tree because accepted
  display code growth pushes `_drawVehicleMovementIndicator` beyond the fixed window, and the test's
  `methodStart` resolves to a call site rather than the definition.
- No evidence that the expected value is a pre-fix incorrect transform, so it was not edited (Stage 4 rule).

## 8. Final focused-test counts
- `tests/local_playback_geometry_modes.test.js`: 41 tests, **40 pass, 1 fail** (retained arrow test).
- `tests/local_playback_stationary.test.js`: 19 tests, **19 pass, 0 fail**.
- Accepted-path suites: **60/60 pass** (combined projection 13, point-accumulated 11, cross-layer 4,
  representative 8, purity 11, purityRevisit 13).
- purityRevisit focused suite: **13/13 pass** (including `revisit-13` default/override selection).

## 9. Files edited
- `tests/local_playback_geometry_modes.test.js`
- `tests/local_playback_stationary.test.js`
(Test files only. No production source, no `server.js`, no thresholds.)

## 10. Backup location
`.checkpoint_test_backup/pre_default_test_reconciliation/` (exact pre-edit files):
- `local_playback_geometry_modes.test.js` SHA1 `143ABC86E35470E4CA4BB5192D49BB4F3E53DC0C`
- `local_playback_stationary.test.js` SHA1 `10A81FC450B3DF11EF2F24ED50553CE0FCB56675`

## 11. Staging recommendation
Both reconciled files are safe for **whole-file staging**: before this task they were tracked and unmodified, so
their working-tree diff is exactly the reconciled default assertions. The prior patch-level recommendation for
these two files is superseded. Full details: `reconciled_test_manifest.json`.

## 12. Remaining failures
One: the retained arrow source-order test (`16`). It is unrelated to the accepted default change, passes at HEAD,
and is a test-harness window limitation. No other failures remain in the focused set.

## 13. Branch, HEAD and staged count
Branch `experiment/candidate-layer-display`; HEAD `488c61b`; staged-file count **0**.

## 14. Confirmation of no production changes
No production source, `server.js`, config, or generated data was modified. Only the two test files and the new
evidence directory were written.

## 15. Commit and push status
No commit, no push, no staging. No `git reset`/`checkout`/`clean`/`restore`/`undo` used.

## 16. Verdict
**Ready for staging review.** Six stale UI-default assertions were reconciled without weakening any valid fused
data-model or geometry assertion; the API failure is environmental and passes with the server; the single
remaining arrow failure is a retained, non-transform test-harness limitation documented for separate handling.

---

Test reconciliation only. Production behaviour unchanged. No valid fused data-model assertion weakened.
Nothing staged, committed or pushed.
