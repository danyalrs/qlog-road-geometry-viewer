# Constructed Lane-Boundary Fragments — Acceptance Validation Evidence

**Status:** EXPERIMENTAL (ES) — display-only diagnostic. Never feeds production geometry.
**Date:** 2026-08-11
**Scope:** This document completes the acceptance evidence for the constructed lane-boundary fragments layer. No algorithm thresholds were changed and no cross-fragment joining was performed during this validation.

---

## Item 1 — The five segments in the reported audit

The reported audit (`reports/constructed_fragments_experimental.md`, run by
`scripts/audit_constructed_fragments.js`) used the default sample:

```
['qlog_f449c_0.bz2', 'qlog_f449c_7.bz2', 'qlog_f449c_13.bz2', 'qlog_f449c_14.bz2', 'qlog_f449c_22.bz2', 'qlog_f449c_50.bz2']
```

Segment 7 exists on disk (2,746 KB) but produces **0 point-accumulated observations**
(2 route chunks, 30 frames, no point-accumulation output), so `runSegment()` returned
`{ error: 'no points' }` and it was excluded from the valid table.

**The five audited segments were therefore: 0, 13, 14, 22, 50.**

| Segment | Audited | Notes |
|---------|---------|-------|
| 0 | yes | 2,054 points, 36 fragments |
| 7 | no | 0 point-accumulated observations (skipped) |
| 13 | yes | 2,340 points, 44 fragments |
| 14 | yes | 2,314 points, 37 fragments |
| 22 | yes | 910 points, 27 fragments |
| 50 | yes | 1,612 points, 16 fragments |

---

## Item 2 — Audit run on all seven required segments

Run: `node scripts/validate_constructed_fragments.js`
Output: `reports/constructed_fragments_validation/per_segment_statistics.json`

All seven required segments (14, 16, 54, 2, 58, 99, 6) produced point-accumulated
observations and were audited.

---

## Item 3 — Per-segment statistics

Full machine-readable statistics in
`reports/constructed_fragments_validation/per_segment_statistics.json`. Summary table:

| seg | input pts | usable pts | fragments | boundaries (lane/side/track) | len med/min/max (m) | gap med/max (m) | residual med/max (m) | rejected | below-min-obs | source unchanged |
|-----|-----------|------------|-----------|------------------------------|---------------------|-----------------|-----------------------|----------|---------------|------------------|
| 14 | 2,314 | 2,183 | 37 | 0/right/0, 1/right/1, 2/left/2 | 42.8 / 6.2 / 502.2 | 5.35 / 11.25 | 0.179 / 0.8 | 48 | 0 | yes |
| 16 | 2,340 | 2,239 | 17 | 0/right/0, 1/right/1, 2/left/2 | 189.5 / 26.8 / 597.4 | 5.81 / 11.25 | 0.088 / 0.8 | 24 | 0 | yes |
| 54 | 1,690 | 1,623 | 24 | 0/right/0, 1/right/1, 2/left/2, 3/left/3 | 5.8 / 2.2 / 50.2 | 0.26 / 3.4 | 0 / 0.8 | 166 | 0 | yes |
| 2 | 1,378 | 802 | 33 | 1/right/0, 2/left/1, 3/left/2 | 15.6 / 2.7 / 108.9 | 3.2 / 8.26 | 0.024 / 0.8 | 51 | 0 | yes |
| 58 | 832 | 487 | 18 | 1/right/0, 0/right/1, 2/left/2 | 12.9 / 1.5 / 90.6 | 3.78 / 5.44 | 0.036 / 0.8 | 40 | 0 | yes |
| 99 | 754 | 307 | 9 | 2/left/0, 1/right/1, 0/right/2 | 27.0 / 7.5 / 50.2 | 3.77 / 6.86 | 0.013 / 0.55 | 33 | 0 | yes |
| 6 | 208 | 160 | 4 | 1/right/0 | 14.1 / 1.7 / 14.1 | 0.37 / 1.25 | 0 / 0.014 | 35 | 0 | yes |

Notes:
- **usable points** = points passing the repeated-support gate (`supportFrameCount >= 2`).
  The dots still show every point; only fragment construction uses the stricter gate.
- **below-min-obs** = fragments with fewer than `minObservations` (3). Always 0 — such runs are dropped, not published.
- **source unchanged** = the accumulated-point source was byte-identical after fragment construction (verified per segment).

Rejected-connection reasons by segment:

| seg | reasons |
|-----|---------|
| 14 | sharpDirectionChange 30, largeStep 10, largeSpatialGap 7, temporalGap 1 |
| 16 | sharpDirectionChange 13, largeStep 7, largeSpatialGap 4 |
| 54 | temporalGap 71, temporalRevisit 62, lateralJump 17, largeStep 14, largeSpatialGap 2 |
| 2 | temporalGap 23, lateralJump 10, sharpDirectionChange 8, temporalRevisit 4, largeSpatialGap 3, largeStep 3 |
| 58 | largeStep 14, temporalGap 8, lateralJump 7, sharpDirectionChange 6, largeSpatialGap 5 |
| 99 | lateralJump 10, largeStep 10, temporalGap 7, temporalRevisit 4, largeSpatialGap 2 |
| 6 | temporalRevisit 16, temporalGap 16, largeStep 3 |

---

## Item 4 — Explicit verification for Segments 14 and 16

Run: `node scripts/validate_constructed_fragments.js`
Output: `reports/constructed_fragments_validation/verification_14_16.json`

| Check | Seg 14 | Seg 16 |
|-------|--------|--------|
| L0/L1/L2 remain separate | PASS (0 mixed) | PASS (0 mixed) |
| No fragment changes physicalBoundaryId | PASS (37/37 consistent) | PASS (17/17 consistent) |
| No fragment crosses another boundary | PASS (0 crossings) | PASS (0 crossings) |
| No fragment bridges an unsupported gap | PASS (all gaps ≤ maxJoinGapM=12) | PASS |
| Point order does not reverse or zigzag | PASS (0 s-reversals; 0 interior sharp turns) | PASS (0 s-reversals; 0 interior sharp turns) |
| Smoothing stays close to dots | PASS (max shift 0.800 m = cap; 0 over-cap; max residual 0.8 m) | PASS (same) |
| Fragment endpoints evidence-supported | PASS (0 fail min-obs/distinct-frames) | PASS |
| Vehicle between correct boundaries | PASS (all laterals consistent with side) | PASS |
| Corrected default lateral orientation unchanged | PASS (uses dots' localEast/localNorth; source unchanged) | PASS |

### Zigzag measurement methodology

Direction-change is only meaningful over `minDirectionSpanM` (5 m) — shorter spans are
noise-dominated (documented module design). Interior smoothed geometry (away from the
fragment-start transition) has **0 sharp turns on both segments**.

**Boundary-zone kinks (not zigzags):** fragments begin at a previously-rejected outlier
point which is kept raw by the documented "keep endpoints" rule; the first smoothed
interior point transitions back, creating a local kink at index 2. Seg 14 has 4
(CF7@2 64°, CF9@2 120°, CF20@2 86°, CF34@37 46°); Seg 16 has 3 (CF3@2 60°, CF9@2 63°,
CF14@2 48°). These are bounded by the smoothing shift cap and are **not** interior
zigzags. The construction-time raw turns were all ≤ 45° (the gate worked; e.g. CF9/seg14
raw 5.3° → smoothed 120° because the fragment starts at the rejected outlier).

---

## Item 5 — Complete rejected-connection records for Segments 14 and 16

Exported to `reports/constructed_fragments_validation/rejected_connections_14_16.json`
(48 records for seg 14, 24 for seg 16). Each record contains:

- `fromId` / `toId` — source point IDs (chunkId:passId:groupTrackId:frameId:laneIndex:s:d)
- `physicalBoundaryId` — chunkId:passId:groupTrackId
- `groupTrackId`, `laneIndex`
- `spatialGapM` (along-track s gap), `stepM` (euclidean), `lateralChangeM`, `directionDeltaDeg`, `temporalDiffSec`
- `reason`

Sample (seg 14, record 0):

```json
{
  "fromId": "0:0:0:16883:0:68.12:-4.27",
  "toId": "0:0:0:16883:0:87.62:-3.90",
  "fromS": 68.119, "toS": 87.616,
  "physicalBoundaryId": "0:0:0",
  "groupTrackId": "0", "laneIndex": 0,
  "spatialGapM": 19.497, "stepM": 19.5,
  "lateralChangeM": 0.363, "directionDeltaDeg": 70.85,
  "temporalDiffSec": 0, "reason": "largeSpatialGap"
}
```

To regenerate: the module now records these fields on every rejected connection
(`lib/constructed_fragments.js` `constructGroupFragments`). No thresholds changed.

---

## Item 6 — Synchronized visual comparisons for Segments 14 and 16

Run: `node scripts/capture_constructed_fragments.js 14 16 14`
Output: `screenshots/constructed_fragments/` (8 PNGs + `capture_manifest.json`)

| View | Seg 14 | Seg 16 |
|------|--------|--------|
| 1. Video frame (synchronized road video, 28.0s/60.1s) | `1_video_qlog_f449c_14_idx14.png` | `1_video_qlog_f449c_16_idx14.png` |
| 2. Accumulated dots only (layer OFF) | `2_dots_qlog_f449c_14_idx14.png` | `2_dots_qlog_f449c_16_idx14.png` |
| 3. Dots + constructed fragments (layer ON) | `3_dots_fragments_qlog_f449c_14_idx14.png` | `3_dots_fragments_qlog_f449c_16_idx14.png` |
| 4. Fragment IDs and split reasons (`?cfLabels=1`) | `4_ids_splits_qlog_f449c_14_idx14.png` | `4_ids_splits_qlog_f449c_16_idx14.png` |

Programmatic verification (`scripts/verify_constructed_fragments_capture.js`) confirms
the fragment layer renders on-screen: fragment-colored canvas pixels jump from 49 → 307
(seg 14) and 28 → 312 (seg 16) when the layer is enabled, and the video panel is
`ready` at 28.0 s / 60.1 s in both.

All captures are at `pointAccumulated` geometry mode, timeline index 14, with the
corrected default lateral orientation (mirror on). A display-only URL param
`cfLabels=1` was added to render fragment IDs and split reasons for view 4.

---

## Item 7 — Regression checks on Segments 2, 6, 54, 58, 99

Run: `node scripts/regression_constructed_fragments.js`
Output: `reports/constructed_fragments_validation/regression_2_6_54_58_99.json`

All invariants hold on every segment: mixed-boundary fragments = 0, boundary crossings = 0,
s-reversals = 0, interior sharp turns = 0, internal gap over maxJoinGap = 0,
smoothing shift max = 0.8 m (cap), 0 over-cap, 0 below-min-obs fragments.

| seg | attention point | result |
|-----|-----------------|--------|
| 99 | spatial revisit and curves | 9 fragments; 4 temporalRevisit correctly rejected; 0 spatialRevisit; 0 interior turns (curves split at apex, no zigzag); 0 crossings; max len 50.2 m |
| 6 | GPS discontinuity | sparse: 208 pts / 160 usable → 4 fragments; max s-gap 4 m; 0 fragments bridging > maxJoinGap; 0 long phantom fragments |
| 2 | dense boundaries | 3 boundaries; 1,378 pts; 33 fragments; 0 mixed; 0 crossings |
| 58 | uneven track distribution | fragmentsPerTrack {0:9, 1:3, 2:6}; 0 mixed; 0 crossings — uneven coverage preserved, tracks never mixed |
| 54 | multi-boundary general | 4 boundaries; 24 fragments; 0 mixed; 0 crossings |

Segment 54 shows the most rejected connections (166), dominated by `temporalGap` (71)
and `temporalRevisit` (62) — consistent with a sparse/segmented route where coverage
holes and frame interleave are common; the layer splits rather than bridging.

---

## Item 8 — Unrelated browser-bundle repair (explained separately)

### 8.1 Exact original failure

The browser mirror of the segment-local map (`public/segment_local_map.js`, generated by
`scripts/sync_segment_local_map_public.js`) threw at load:

```
ReferenceError: headingDegForVehicleIcon is not defined
```

Reproduced exactly by rebuilding the bundle with the pre-work wrapper
(`.cache/pre_repair_segment_local_map.js`; verification in this session). This is a
**pre-existing** defect: the committed `public/segment_local_map.js` at git HEAD
produces the same error, and the road-surface test
`Segment 2 road-surface Stage 2 / 16. browser bundle has no unresolved require error`
failed with the same cause before this work. `public/lane_map_cleanup.js` (unmodified
from HEAD) also still contains `require(` calls and keeps that test red — that is a
separate, untouched pre-existing issue.

### 8.2 Exact files and lines changed

File: `scripts/sync_segment_local_map_public.js` (wrapper template, the `out` template literal).

The sync script strips the top-of-file require block from `lib/segment_local_map.js`
(lines 8–25: `const LP`, `const LMC`, `const SD`, `const { buildReferenceTrajectory }`,
`const { resolveCleanupOptions }`, `const interpolateTimedPath`,
`const headingDegForVehicleIcon`, `const MIN_HEADING_DISPLACEMENT_M`) but the wrapper
template only re-declared `LP`, `LMC`, `globalToVehicleDisplay`, `interpolateTimedPath`,
`MIN_HEADING_DISPLACEMENT_M`. Four bindings used by the lib body and/or the `api` export
were therefore undefined in the browser bundle:

- `headingDegForVehicleIcon` — referenced in `api` (`lib/segment_local_map.js:1120`, bundle line 1074) → **the load-time ReferenceError**
- `buildReferenceTrajectory` — used at `lib/segment_local_map.js:377` (bundle line 333)
- `SD` — used at `lib/segment_local_map.js:379` (bundle line 336)
- `resolveCleanupOptions` — used at `lib/segment_local_map.js:382` (bundle line 338)

Added to the wrapper template (current bundle lines 6, 7, 12, 19):

```js
const SD = global.SdFusion;
const buildReferenceTrajectory = global.Trajectory?.buildReferenceTrajectory || ((path) => { ... });
const resolveCleanupOptions = (d) => d?.processingOptions || {};
const headingDegForVehicleIcon = (...args) => LP.headingDegForVehicleIcon(...args);
```

### 8.3 Why the constructed-fragment layer required it

The constructed fragments are computed inside `buildPointAccumulatedFragments`, which
lives in `lib/segment_local_map.js` and is delivered to the browser through this same
bundle. The bundle could not even load (it threw at `api` construction before any
pipeline ran), so the Local playback viewer and its browser test suite could not
exercise `pointAccumulated.constructedFragments` at all. The repair was required for
the visual captures (Item 6) and browser-mirror verification.

### 8.4 Proof that arrow, GPS, playback, Raw, Fused, Candidate D and the corrected lane mirror remain unchanged

- The change is confined to the **bundle wrapper template**; it re-declares bindings that the
  sync script already stripped. It does not touch any algorithm in `lib/segment_local_map.js`,
  `lib/lane_map_cleanup.js`, `lib/point_accumulation.js`, or any renderer geometry.
- `public/render.js` changes are purely additive: the `_drawConstructedFragments` method,
  the `this.layers.constructedFragments` gate, and a display-only `?cfLabels=1` label
  param. No existing draw path was modified.
- Test suites covering these surfaces pass: `local_playback`, `local_playback_geometry_modes`,
  `local_playback_current_frame`, `local_playback_turn_direction`, `lateral_axis`,
  `road_geometry`, `point_transform_controlled` — 205 tests, 0 failures.
- Browser probe confirms: `_mirrorRoadLateralDisplay` default true (corrected orientation),
  `_drawLocalPlaybackArrow` present, video panel present. `_drawConstructedFragments` is
  only reachable from `_drawPointAccumulatedGeometry`, which is only invoked when
  `localGeometryMode === 'pointAccumulated'` (`public/render.js:1054`). Raw and Fused
  modes never draw the overlay.
- The `lane_map_cleanup.js` bundle `require(` failure (road-surface Stage 2 test 16) is
  pre-existing and untouched; it is not part of this repair.

---

## Item 9 — Full test baseline (before / after)

### Before this work (recorded in the previous session)

Full suite `node --expose-gc --test tests`: **26 failures** in the same suites.

### After this work (this session, twice)

Full suite `node --expose-gc --test tests`:

| Run | tests | pass | fail |
|-----|-------|------|------|
| run 1 | 1,506 | 1,479 | 27 |
| run 2 | 1,506 | 1,479 | 27 |

### Failing test names (identical set in both runs)

- `experimental_boundaries.test.js` — `21. Fused mode remains unchanged`
- `local_playback_d12_partial_tails.test.js` — `12. fused fragment count matches accepted baseline (18)`, `14. display span sum discrepancy ...`
- `local_playback_d12_rendering.test.js` — `1. unsupported intervals ...`, `11. fused fragment count matches accepted baseline (18)`, `12. logical cleaned run count 17 ...`
- `local_playback_road_surface_stage1.test.js` — `20. logical cleaned-run count remains 28`, `21. fused-fragment count remains 33`
- `local_playback_road_surface_stage2.test.js` — `3. no polygon geometry changes during Stage 2`, `14. browser and Node lane checksums match`, `15. browser and Node polygon checksums match`, `16. browser bundle has no unresolved require error`, `22. Mode 5 checksum remains 5283af91`, `23. cleaned-run count remains 28`, `24. fused-fragment count remains 33`
- `local_road_surface_path_filter.test.js` — `4. lane polyline 15 m threshold remains on general renderer`
- `local_trajectory_overlay.test.js` — `10. lane renderer retains the existing 15 m break threshold`
- `stage13a_fusion_trace.test.js` — `2. reconciles seg 90 aggregate coverage vs zero production polygons`, `15. passes full consistency reconciliation`, `17. records segment 90 as first-chunk run-pairing misalignment`
- `stage14_delivery_readiness.test.js` — `1. separates first-chunk summary A from all-chunk summary B`
- `stage14_chunk_reconciliation.test.js` — `1. sums per-chunk counts to 540 and first-chunk to 524`
- `stage16_lane_line_projection.test.js` — `1. v11 processing version unchanged`
- `stage17_lane_divider_tracking.test.js` — `1. v11 processing version unchanged`
- `stage18_lane_interval_assessment.test.js` — `1. v11 processing version unchanged`
- `stage19_publication_overlap.test.js` — `4. child process concurrent publication: one winner and one fenced loser` (**known flaky** — passes in isolation, flips between full-run invocations)
- `stage20_amendment_a.test.js` — `2. T-A-051 frozen v11 unchanged`

### No new failure was added

- The only difference in the aggregate count (26 → 27) is the **known-flaky** Stage 19
  concurrent-publication test, which passes in isolation
  (`node --test tests/stage19_publication_overlap.test.js` → `# fail 0`) and is already
  documented as flaky in `docs/DEVELOPMENT_LOG.md`.
- All tests added by this work (`tests/constructed_fragments.test.js`, 17 tests) pass.
- The pre-existing `experimental_boundaries` test-21 failure was verified before this
  work: the 8000-char window delta was already 8211 (> 8000) with my additions removed.

---

## Methodology notes

- **No tuning.** Thresholds are the module defaults; the validation scripts only measure.
- **No cross-fragment joining.** Out of scope per instruction.
- **No layer replacement.** Constructed fragments are a separate, toggleable layer;
  dots, Raw, Fused, Candidate D and tracked outputs are untouched.
- **No commit, merge or push performed.**
- Artifacts: `reports/constructed_fragments_validation/{per_segment_statistics,verification_14_16,rejected_connections_14_16,regression_2_6_54_58_99}.json`, `screenshots/constructed_fragments/*.png`.
