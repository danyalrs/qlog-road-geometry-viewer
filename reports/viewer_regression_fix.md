# Lane-Viewer Rendering Regression — Diagnosis & Fix Report

**Status:** FIXED.
**Date:** 2026-08-12
**Scope:** Repair the viewer regression introduced after the joined-fragment singleton and
shared `boundaryColor(groupTrackId)` changes. No lane-processing thresholds, fragment
construction, endpoint-extension gates, connector acceptance, tracking identities,
chunk/pass generation, mirror mathematics or accumulated source observations were
changed. No commit/merge/push.

---

## 1. Root cause of the regression (retained first-segment look / missing arrow / missing joined lines)

**Root cause: `ReferenceError: drawn is not defined`, thrown on every fragment draw in
`_drawConstructedFragments`.**

While applying the shared-boundary-colour fix, the old hard-coded `laneColors` const
and the adjacent `let drawn = 0` declaration were both removed from
`_drawConstructedFragments`. The method still referenced `drawn` (in `drawn++` and in
the fragment-count label text). Every fragment draw therefore threw, aborting the
whole point-accumulated canvas function. Because the canvas function aborted after the
first fragment:

- only the first (blue, groupTrackId 0) boundary's first fragment drew;
- the joined solid polylines (drawn after fragments) never drew;
- the moving vehicle arrow (drawn later in the same canvas function) never drew;
- because the exception fired identically regardless of which segment was processed,
  the viewer appeared to "retain" the first processed segment's geometry.

**The first point where identities appeared to diverge** was in rendering only: the
server processed, responded and installed each new segment correctly (verified:
fragment counts 37/17/95/80/4 and joined counts 18/4/62/59/4 for segments
14/16/19/20/6; arrow screen y changed per segment). The selected/requested/processed/
received/active identities all matched — the divergence was purely that the renderer
threw before drawing anything beyond the first blue fragment.

Browser-console errors before the fix (captured during reproduction):
`[pageerror] drawn is not defined` (repeated on every draw).

Server-terminal: no errors; each request was a fresh processed run with the correct
per-file cache key including the qlog filename and sha256 (e.g.
`qlog_f449c_6.bz2:e7eb0444...`).

## 2. Exact fix

Restored `let drawn = 0;` at the start of the fragment loop in
`_drawConstructedFragments` (`public/render.js`). One line. The rest of the earlier
valid fixes (singletons, shared `boundaryColor`, mirror, endpoint extension) are
untouched.

## 3. Missing vehicle arrow (Part D)

The arrow was not drawn because `_drawConstructedFragments` threw before the arrow draw
code (later in the canvas function) ran. No canvas-state leak, clipping, alpha,
transform or unbalanced save/restore was involved. After the fix, the arrow renders and
moves with playback (arrow screen y changed 363→367→370→645 across segments 14/16/20/6).
The road-geometry mirror does not move the arrow (verified: arrow shift 0.00 px on
toggle; it uses `worldToScreen`, not the road mirror).

## 4. Only the blue dashed boundary rendering (Part E)

Caused by the same exception: after the first fragment (blue) drew, the loop threw at
`drawn++`, so red/green/orange fragments never drew. `boundaryColor(groupTrackId)` itself
is correct and never filters geometry — it only selects stroke colour. Verified:
groupTrackId 0/1/2/3 resolve to blue/red/green/orange; numeric and string forms resolve
identically; missing identity returns an explicit diagnostic (`#f97316`) and continues.

## 5. Missing joined solid polylines (Part F)

Joined polylines were present in the server result and in frontend state (counts
18/4/62/59/4) but never drew because `_drawConstructedFragments` threw first (joined
draws after fragments in the same canvas function). After the fix, joined solid lines
render for every segment.

## 6. Browser-console errors before/after

| Error | Before | After |
|-------|--------|-------|
| `ReferenceError: drawn is not defined` | yes (every draw) | **gone** |
| 404 resource (pre-existing, unrelated) | present | present (unrelated to this fix) |

## 7. Server-terminal errors

None. Each segment produced a fresh, correctly-keyed processed run.

## 8. Request/response segment identities

For every tested segment, selected = requested = server-processed = response = active =
rendered identity. Verified via per-segment fragment/joined counts and arrow position
(Part H fingerprints).

## 9. Geometry fingerprints (Part H)

| Segment | constructed frags | joined polylines | first fragment (east,north) | gt ids present |
|---------|-------------------|------------------|------------------------------|----------------|
| 14 | 37 | 18 | (0, −4.17) | 0,1,2 |
| 16 | 17 | 4 | (0, −4.17) | 0,1,2 |
| 19 | 95 | 62 | — | 0,1,2,3 |
| 20 | 80 | 59 | (0, −4.17) | 0,1,2,3 |
| 6 | 4 | 4 | (75.24, 40.43) | 0 |

Order-independence: processing 14→16→19→20→6 and then 20→14→6→19 both replace
geometry correctly; no segment retains a previous segment's data (verified the arrow
moves to each segment's pose and counts change per segment).

## 10. Evidence that groupTrackId 0/1/2/3 pass through the renderer

| Segment | blue px | red px | green px | orange px | gt ids |
|---------|---------|--------|----------|-----------|--------|
| 14 | 515 | 496 | 662 | 0 | 0,1,2 |
| 16 | 553 | 211 | 789 | 0 | 0,1,2 |
| 19 | 891 | 438 | 250 | 1037 | 0,1,2,3 |
| 20 | 824 | 649 | 432 | 1005 | 0,1,2,3 |
| 6 | 732 | 107 | 0 | 0 | 0 |

## 11. Legitimate orange boundary (gt3) intact

Orange = `trackColor(3)` = `#ca8a04`, the intermittent outer-left 4th boundary,
preserved with its own identity and observations (segments 19, 20; also 40 segments
across the dataset). Not a colour bug.

## 12. Segment replacement evidence

Each new segment replaces all previous segment-specific state: constructed-fragment
arrays, joined-polyline arrays, playback frames, map bounds, and frame index. Verified
by per-segment counts and arrow pose changing on every selection, and by the absence of
any first-segment retention.

## 13. Late responses

The processing path is request-scoped: `process()` awaits the fetch and installs the
result synchronously; `clearProcessState()` clears prior state and the stationary-map
cache before each request; the server cache key includes the qlog filename + sha256, so
different files never share a result. No late-response overwrite was observed.

## 14. Mirror-alignment and arrow-stability

- Mirror toggle moves road geometry together (fragments + joined, 4.3 px each); arrow
  shift 0.00 px; fragment-vs-joined screen distance 0.0 px.
- Corrected default mirror restored on refresh.

## 15. Screenshots (Part J)

`screenshots/viewer_regression_fix/` — 33 PNGs: for each of Segments 14, 16, 19, 20, 6
(1 constructed only, 2 joined only, 3 fragments+joined, 4 arrow, 5 mirror on, 6 mirror
off) plus a 14→16→20 state-transition sequence.

## 16. Test baseline

| Suite | Before | After |
|-------|--------|-------|
| Full suite | 1,546 tests, 1,519-1,520 pass / 26-27 fail | **1,558 tests, 1,531 pass / 26-27 fail** |
| New `tests/viewer_state_regression.test.js` | — | **12/12 pass** |

The failing set is identical to the pre-change baseline (same leaf failures; the
aggregate count flip is the known-flaky Stage 19 concurrent-publication test). **No new
failure added.**

## 17. Remaining failing tests

Identical to baseline: test-21 (experimental boundaries), D12 partial-tail/rendering,
road-surface Stage 1/2, path-filter/trajectory 15 m threshold, stage13A/14/16/17/18
baselines, flaky Stage 19 concurrent-publication, stage20 T-A-051. Each existed before
this fix.

## 18. Files changed

- `public/render.js` — restored `let drawn = 0` in `_drawConstructedFragments`.
- `tests/viewer_state_regression.test.js` — new (12 tests).
- `docs/DEVELOPMENT_LOG.md`, `docs/CURRENT_STATUS.md` — updated.
- `screenshots/viewer_regression_fix/*.png` — evidence.

## 19. Known limitations

- The unrelated pre-existing 404 resource warning in the console remains (not part of
  this fix).
- The full-suite aggregate failure count varies 26↔27 between runs solely due to the
  flaky Stage 19 concurrent-publication test.

## 20. Unchanged (per constraints)

Lane-processing thresholds, constructed-fragment generation, endpoint-extension gates,
connector acceptance, tracking identities, chunk/pass generation, mirror mathematics
and accumulated source observations were NOT modified. The singleton-fragment fix and
the shared `boundaryColor` resolver were NOT reverted.
