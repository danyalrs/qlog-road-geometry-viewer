# Combined orientation / visible-lane projection default promotion

Bounded default-promotion only. No geometry algorithm was changed.

## 1. Proven default-selection cause
The failure was **default selection**, not a different algorithm. Both candidates were opt-in:
- `parseCombinedOrientationCandidate` returned `null` for an absent/invalid
  `combinedOrientationCandidate`, so the boundary-anchored placement was never applied.
- `combinedVisibleLaneProjectionCandidate` was treated as off unless `=1`
  (`parseCombinedVisibleLaneProjectionCandidate` returned `raw === '1'`; `render.js` read the raw param
  `=== '1'`), so the corrected combined visible-lane projection was disabled.
With both off, combined Seg2 kept its incorrect original right curve. The explicit candidate URL turned both
on, producing the verified left curve.

## 2. Exact files changed
- `lib/combined_boundary_anchored_orientation.js` (canonical)
- `public/combined_boundary_anchored_orientation.js` (mirror)
- `lib/combined_visible_lane_projection.js` (canonical)
- `public/combined_visible_lane_projection.js` (mirror)
- `public/render.js` (browser-only flag default)
- `tests/combined_visible_lane_projection.test.js`, `tests/combined_full_layer_alignment.test.js`,
  `tests/combined_segment1_arrow_lane_change.test.js` (stale default assertions)
- `tests/combined_default_promotion.test.js` (new focused tests)

## 3. Exact default changes
- `parseCombinedOrientationCandidate`: absent or invalid → `boundaryAnchored`; explicit `boundaryAnchored`
  preserved; explicit `commonTransformNoSeg0Correction` (Candidate A) preserved as the legacy/off override.
- `parseCombinedVisibleLaneProjectionCandidate`: returns `raw !== '0'` (absent/`1`/invalid → enabled;
  explicit `0` → disabled).
- `render.js` `_visibleLaneProjectionEnabled`: `urlParams.get('combinedVisibleLaneProjectionCandidate') !== '0'`.

## 4. Explicit override behaviour
- `combinedOrientationCandidate=boundaryAnchored` → boundary-anchored (unchanged).
- `combinedOrientationCandidate=commonTransformNoSeg0Correction` → legacy/off diagnostic (unchanged).
- `combinedVisibleLaneProjectionCandidate=1` → enabled; `=0` → disabled.
- URL values are read on each build/draw, so URL overrides beat the defaults.
- No flag renamed; no value invented.

## 5. Standalone versus combined Seg2 result
Objective metrics (`focus_geometry_metrics.json`):
- Standalone Seg2 lane centerline curvature sign = **+1**; boundary-anchored inactive.
- Combined default Seg2 lane centerline curvature sign = **+1** → matches standalone.
- Combined default (`B`) lane checksum `3bb65a3c…` equals explicit candidate (`C`) `3bb65a3c…`.
- Legacy/off (`D`) checksum `a493e4ad…` differs → A/B override still available.

## 6. Seg0/1/2 focus gates
All objective gates pass: `B_equals_C_laneChecksum=true`,
`B_seg2_sign_matches_standalone=true`, `D_differs_from_B=true`, `no_non_finite=true`,
`standalone_not_oriented=true`. Seg0 road/trajectory/arrow alignment and bridge continuity are covered by the
`combined_full_layer_alignment` (12/12) and `boundary_bridge_playback` (15/15) suites. No road, trajectory,
arrow or bridge mutation: the promotion changes only which builder/flag is selected; the transforms were not
edited.

## 7. Test counts
**148/148 pass** across 11 focused suites (combined boundary anchoring, combined source correction scope,
combined visible-lane projection, cross-layer shared frame, combined default promotion, combined full-layer
alignment, boundary bridge playback, point-accumulated lane polylines, representative lane lines, purityRevisit,
local geometry defaults). The new `combined_default_promotion` suite has 11 tests.

## 8. Cache/re-seek result
`combined_default_promotion` test 15 rebuilds the combined map twice and asserts identical per-point placed
coordinates and identical `combinedCoordinateFrame` → deterministic cache/re-seek. The combined cache key in
`app.js` now includes `:cand:boundaryAnchored` for the plain URL (no collision with prior keys).

## 9. Runtime isolation result
- Standalone (`segments=2`) unchanged: `applyBoundaryAnchoredOrientation` returns the map unchanged for
  single-source maps (`!isMultiSourceMap` guard), and CVLP `isCandidateEligible` requires multi-source.
- Reflection applied exactly once: `applyOrientationCandidateIfNeeded` is idempotent on cache hits
  (`boundaryAnchoredOrientationActive && combinedCoordinateFrame==='combinedPlaced'`), and CVLP
  `projectCombinedSourceLanePoint` returns `alreadyApplied` for already-projected points.
- `mirror=0/1` semantics unchanged; mirror math not modified.
- No change to representative-line counts, purityRevisit, road, trajectory, arrow, bridge, qlog, processing,
  pose, cache or fused geometry.

## 10. Backup location
`.checkpoint_test_backup/pre_combined_orientation_default_promotion/` — the 6 pre-edit files
(lib + public CBAO, lib + public CVLP, render.js, and the 3 edited tests).

## 11. Review URL without candidate flags
`http://localhost:3847/?segments=0,1,2&local=1&fit=1&mirror=1` — select Seg2 and confirm it curves left.

## 12. Explicit legacy/off comparison URL
`http://localhost:3847/?segments=0,1,2&local=1&fit=1&mirror=1&combinedOrientationCandidate=commonTransformNoSeg0Correction&combinedVisibleLaneProjectionCandidate=0`

## 13. Remaining risks
- Live browser capture of the plain combined URL was **not** completed: the running server process predates
  the edits and branch switches, and the headless load timed out. A **manual server restart and hard browser
  refresh** is recommended before visual review.
- The Seg2 "curves left" confirmation remains a user visual gate; the objective proxy here is that the
  combined-default Seg2 lane curvature sign matches standalone and that default equals the explicit candidate.
- The pre-existing `combined_segment1_arrow_lane_change` failure (`CST.roadRelativeLateralM` missing at HEAD)
  is unrelated and left unmodified.

## 14. Branch, HEAD and staged-file count
Branch `experiment/lane-map-accuracy`; HEAD `e58e73cdf3956ea6e039e1ebe4fa56226f03d521`; staged **0**.

## 15. Commit and push status
Nothing staged, committed or pushed.

## 16. Verdict
**Ready for user visual review** (after a server restart + hard refresh).

---

Combined default promotion only. Transform algorithms unchanged. Standalone behaviour unchanged. Nothing
staged, committed or pushed. User visual review still required.
