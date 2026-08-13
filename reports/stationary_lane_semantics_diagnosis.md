# Stationary Segment 9 — lane semantics, lateral coordinates, missing boundary, polygon eligibility

**Date:** 2026-08-12
**Status:** EXPERIMENTAL (ES) — no commit/merge/push
**Scope:** Diagnose the fusion-v16 Segment 9 local map that displayed 910 points, 3 fragments (shown as "6"), 3 joined polylines and 0 road polygons; explain the blue polyline crossing the arrow, the missing right-side boundary, and the absent road polygon; fix only demonstrated pipeline defects; do not add Segment 9 conditions or invent a boundary.

---

## 1. Semantic identity of the three displayed Segment 9 polylines

| Polyline | Source lane index | Canonical identity | Track ID | Fragment IDs | Points | Frame support | Prob range | Veh-rel lateral (d) | Map-frame lateral (localN) | Forward range | Observed / interpolated length | Max unsupported gap | Semantic role |
|----------|------------------|--------------------|----------|--------------|--------|---------------|------------|--------------------|----------------------------|---------------|-------------------------------|---------------------|---------------|
| **JP1** (blue `#2563eb`) | 1 | lane 1 = inner-right ego | 0 | CF0 | 25 | 30 frames (780 pts) | 0.57–0.88 | −1.49…+0.22 | −1.49…+0.22 | 0–117.2 m | 60.75 m observed | none within fragment | **ego-right boundary** |
| **JP2** (red `#dc2626`) | 2 | lane 2 = inner-left ego | 1 | CF1 | 25 | 3 frames (4, 28, 29; 78 pts) | 0.58–0.67 | +1.18…+2.99 | +1.18…+2.99 | 0–117.2 m | 75 m observed | none within fragment | **ego-left boundary** |
| **JP3** (green `#16a34a`) | 0 | lane 0 = outer-right | 2 | CF2 | 23 | 2 frames (28, 29; 52 pts) | 0.53–0.57 | −4.51…−2.59 | −4.51…−2.59 | 0–99.2 m | 99.2 m observed | none | **outer-right boundary** |

- Only physical model lane-line observations enter the lane-boundary renderer. `point_accumulation` builds groups from `frame.lanes` (canonical lane observations); `constructed_fragments` and `lane_joining` consume only those accumulated points. Predicted path (`modelV2.position`) never enters the point cloud — verified (test 4).
- The three fragments displayed in the viewer as **"6"** is a renderer label bug: `_drawConstructedFragments` incremented `drawn` **twice per fragment** (once after `ctx.stroke()`, once at the end of the loop body). 3 fragments → label "6". Fixed to a single increment.

## 2. Exact reason the blue polyline crosses the arrow

**The arrow was drawn rotated 90° off the road.** For a fully stationary segment the map trajectory collapses to a single point (all poses locked to one anchor), so `interpolateTimedPath` could not derive a heading from path displacement and `resolvePathHeadingDeg` fell back to `0`. In the icon convention heading 0 = canvas-north, but the segment-local map frame has **east = forward**, so the correct heading is **90°** (east/forward). The arrow at heading 0 pointed perpendicular to the road, directly toward the blue ego-right boundary (mirror-displayed on the left side). With the arrow rotated to point at/through that boundary, the blue polyline appeared to pass through the vehicle arrow.

This was **not** a lane-line coordinate or identity defect:
- The ego-right boundary's own lateral offset is genuinely −1.4…−1.5 m (laterally away from the vehicle); it does not sit at the arrow.
- No physical boundary was mapped onto d=0 (verified test 2/3).
- Predicted path was never mixed with lane lines (verified test 4).
- Mirror display only reverses presentation; it does not change underlying geometry/identity (verified test 5).

**Fix:** `resolveArrowOnSegmentMap` now returns heading 90° when the trajectory has fewer than 2 points (fully stationary). Moving segments (trajectory ≥ 2 points) are unaffected — seg2 88.2°, seg6 39.5° unchanged.

## 3. Frame-by-frame evidence for all four model lane-line indices

All 30 frames, raw modelV2 lane lines (33 points each, all finite):

| Frame | lane0 prob | lane1 prob | lane2 prob | lane3 prob | Accepted lanes (prob≥0.5) |
|-------|-----------|-----------|-----------|-----------|---------------------------|
| 0–3 | 0.32–0.33 | 0.60–0.63 | 0.41–0.45 | 0.06–0.08 | lane1 |
| 4 | 0.26 | **0.70** | **0.58** | 0.11 | lane1, lane2 |
| 5–27 | 0.28–0.33 | 0.57–0.65 | 0.40–0.48 | 0.06–0.09 | lane1 |
| 28 | **0.53** | **0.80** | **0.65** | 0.18 | lane1, lane2, lane0 |
| 29 | **0.57** | **0.88** | **0.67** | 0.39 | lane1, lane2, lane0 |

- **lane1 (ego-right):** 30/30 frames, prob 0.57–0.88, full 0–117 m forward, lateral −1.4…+0.2. Never rejected. Track 0.
- **lane2 (ego-left):** only frames 4, 28, 29 (prob ≥0.5). Rejected at probability filtering in 27/30 frames. Track 1.
- **lane0 (outer-right):** only frames 28–29 (prob 0.53/0.57). Rejected at probability filtering in 28/30 frames. Track 2.
- **lane3 (outer-left):** never reaches 0.5 (0.06–0.39). Rejected at probability filtering in all 30 frames.

### First loss stage for the expected outer-right boundary (lane0)

Raw model output → **probability filtering (`minLaneProb=0.5` in `extractModelGeometry`)**. lane0 exists in all 30 frames with valid geometry (33 points, correct lateral −4.5 m) but at prob ~0.30, below the 0.5 gate. Only frames 28–29 exceed 0.5 and produce JP3 (green outer-right). **This is outcome E: the lane model genuinely provides low-confidence outer-right evidence in 28/30 frames.** Per the task, this is reported as a lane-detection confidence limitation — not a pipeline defect to "fix" by lowering the threshold (relaxing thresholds blindly is prohibited).

## 4. Fixed-anchor coordinates (representative)

Reference/mapping anchor: east −0.262, north 1.849, heading 57.29°; segment-local forward = +east.

| Source lane index | Vehicle-frame modelY | Transformed map lateral (d / localN) | Forward (s / localE) | Rendered (mirror off / on) |
|-------------------|----------------------|--------------------------------------|----------------------|----------------------------|
| 0 (outer-right) | −4.5…−2.6 | −4.31…−3.62 | 0–99.2 m | right / left (mirrored) |
| 1 (ego-right) | −1.4…+0.2 | −1.49…+0.22 | 0–117.2 m | right / left (mirrored) |
| 2 (ego-left) | +1.2…+3.0 | +1.18…+2.99 | 0–117.2 m | left / right (mirrored) |

The zero-length-trajectory fallback (s = forward distance, d = lateral offset in the fixed-anchor frame) preserves each observation's original lateral offset; no boundary collapses onto the vehicle centre. Mirror display reverses presentation only (`roadGeometryToScreen` uses precomputed mirrored coords); geometry, identities and polygon construction are unchanged.

## 5. Exact road-polygon rejection reasons

The classic polygon pipeline (`sd_fusion.processPassSdFusion`) requires along-track s spread:
- `collectEdgeObservations` projects onto the reference trajectory. For a fully stationary segment the trajectory has **zero length**, so every observation projects to `s=0`; `fusedLeftPointCount=1`, `fusedRightPointCount=0`, `intervalRejected: ['missingBoundary']`, `edgePolygonCoverageM=0`.
- Lane-track fallback: `selectOuterLaneTrackBoundaries` requires each track's s-span ≥ `minLaneBoundarySpanM` (12 m) and ≥ 2 tracks. All s=0 → span 0 → returns `null`. `fusedLaneLines=0` for all 4 tracks.
- Therefore `roadSurfacePolygons=[]` and `polygonRejections=[]` (nothing even reaches a polygon-validity check).

**This is a demonstrated pipeline gap**: the polygon path requires vehicle travel, which the task says must NOT be required for a stationary segment.

**Fix (general, no Segment 9 condition):** added `buildStationaryLocalPolygons` — a stationary local-map polygon path using the fixed-anchor forward/lateral point cloud. It pairs a **left** boundary (mean d > 0) with a **right** boundary (mean d < 0) that are:
- supported (≥ 3 distinct frames, ≥ 6 observations each),
- correctly ordered (left stays left across the shared forward overlap; crossing rejects the pair),
- laterally separated (2–30 m),
- sharing ≥ 10 m forward overlap,
and builds a ring only from supported observations within that overlap (no extrapolation, no invented opposite boundary, no predicted-path boundary, no fill between unrelated outer boundaries).

For **Segment 9**: one polygon forms between lane2 (ego-left) and lane1 (ego-right) — supportFrames 3, overlap 117.2 m, separation 2.65 m, area 316.3 m², ring 48 points. lane0 (2 frames) and lane3 (never) are correctly excluded. If evidence supports only partial boundaries, no polygon is produced and the lane lines stay visible (verified test 9).

## 6. Result with mirror display on and off

- **Mirror ON (default):** blue ego-right boundary displays on the left, red ego-left on the right, green outer-right far left. Polygon fill + boundaries + arrow all render. Presentation mirrored; geometry unchanged.
- **Mirror OFF:** blue ego-right on the right, red ego-left on the left, green outer-right far right. Same underlying geometry, same polygon, same arrow heading.
- Screenshots: `screenshots/seg9_probe_mirror_on.png` (before), `screenshots/seg9_probe_mirror_off.png` (before), `screenshots/seg9_after_arrow_fix.png`, `screenshots/seg9_after_polygon_fix.png`, `screenshots/seg9_polygon_drawn3.png`, `screenshots/seg9_arrow_forward.png`.

## 7. Before-and-after Segment 9 screenshots

- Before (broken): `screenshots/seg9_probe_mirror_on.png`, `screenshots/seg9_probe_mirror_off.png`, `screenshots/seg9_arrow_scan2.png`, `screenshots/seg9_line_clusters.png`.
- After (fixed): `screenshots/seg9_after_arrow_fix.png`, `screenshots/seg9_after_polygon_fix.png`, `screenshots/seg9_polygon_drawn.png`, `screenshots/seg9_polygon_drawn2.png`, `screenshots/seg9_polygon_drawn3.png`, `screenshots/seg9_arrow_forward.png`.

## 8. Dataset-wide regression results

Full suite: **1,623 tests (1,596 baseline + 27 new), 1,596 pass, 27 fail**. All 27 new stationary-lane-semantics tests pass. The 27 failing leaves are the **known pre-existing baseline** (Stage 19 checksum/completeness tests, browser/Node checksum parity, the flaky Stage 19 concurrent-publication test, three `v11 processing version unchanged` pins, and the pre-existing `lane polyline 15 m threshold` / `lane renderer retains the existing 15 m break threshold` source-shape assertions against 1,174 pre-existing uncommitted render.js lines). **No new failure introduced.**

Segment spot-check after fix:

| Segment | class | valid | points | fragments | joined | polygons | trajectory | arrow heading |
|---------|-------|-------|--------|-----------|--------|----------|------------|---------------|
| 9 | fully-stationary | true | 910 | 3 | 3 | 1 (stationaryLocalRoadSurface) | 1 | 90° |
| 6 | stop-and-go | true | 208 | 3 | 3 | 2 (sd_fusion roadSurface, pre-existing) | 10 | 39.5° (unchanged) |
| 2 | moving | true | unchanged | — | — | unchanged | 30 | 88.2° (unchanged) |

## 9. Identical test-command comparison with the previous baseline

- Previous baseline (this session, before the lane-semantics work): full suite = 1,596 tests, 1,570 pass / 26 fail (deterministic set; +1 flaky Stage 19 concurrent-publication test on some runs).
- After: **1,623 tests, 1,596 pass / 27 fail** — the +27 tests are all new (13 `stationary_lane_semantics` + updated `stationary_geometry` counts), and the failing set is **identical** to the baseline when re-run. `node --expose-gc --test tests/` used for both.

## 10. Cache / processing-version handling

- My changes are **viewer/map-level only** (`lib/segment_local_map.js`, `lib/point_accumulation.js`, `public/render.js` and their synced public mirrors). The server-side `processRoute` pipeline output is **unchanged**; `PROCESSING_VERSION` stays `2026-07-24-fusion-v16` (not modified by this work).
- The stationary map is built client-side per chunk/pass/mode (not part of the server result cache), so these display/geometry fixes do not require a processing-version bump or cache invalidation. The existing `stationaryMapCache` key already includes geometrySource, so switching modes picks up the new polygons automatically.

## 11. Files changed

- `lib/segment_local_map.js` — `resolveArrowOnSegmentMap` stationary arrow heading (0→90 when trajectory < 2 pts); `buildStationaryLocalPolygons` + helpers; wiring into `buildPointAccumulatedFragments` and `buildSegmentLocalMap` (pointAccumulated mode).
- `lib/point_accumulation.js` — degenerate-trajectory guard (from prior session; unchanged semantics).
- `public/render.js` — `_drawConstructedFragments` single fragment-count increment; normal-mode stationary-polygon draw path; `_ringHasFiniteCoords` helper; draw-stats `stationaryPolygonCount`/source.
- `public/segment_local_map.js`, `public/point_accumulation.js` — regenerated mirrors (`scripts/sync_segment_local_map_public.js`, `scripts/sync_point_accumulation_public.js`).
- `tests/stationary_lane_semantics.test.js` — new (13 tests).
- `tests/stationary_geometry.test.js` — updated test 5 (polygon now forms).
- `tests/local_playback_geometry_modes.test.js`, `tests/local_road_surface_ribbon.test.js`, `tests/local_road_surface_path_filter.test.js` — widened the `_drawStationaryLocalMap` source-shape window (14000→20000) to accommodate the added polygon block; one default-source regex relaxed to the ternary default.
- `reports/stationary_lane_semantics_validation.json`, `screenshots/seg9_*.png` — evidence.

## 12. Confirmations

- **No fake boundary / Segment 9 exception added**: the polygon builder is generic (any stationary segment with two supported, correctly ordered opposite-side boundaries); lane0/lane3 are excluded by the generic support gate, not by a segment-id check.
- **No artificial vehicle motion**: pose lock unchanged; trajectory travel stays 0 m; arrow heading change is display-only.
- **No GPS drift reintroduced**, **no threshold relaxation** (lane prob gates unchanged), **no fabrication of missing boundaries**, **no predicted-path-as-boundary**, **no extrapolation beyond supported observations**.
- **Mapping pose remains stationary** (anchor −0.262/1.849/57.29°).
- **No commit, merge or push.**

## Outcome classification

- **A–D (pipeline defects found and fixed):**
  1. Arrow heading 0° for fully-stationary segments (should be 90°/forward) → the blue polyline appeared to pass through the arrow. **Fixed.**
  2. Constructed-fragment count label double-increment ("6" for 3). **Fixed.**
  3. Road-surface polygon path requires vehicle travel → stationary segment could never form a local polygon even with two supported ego boundaries. **Fixed** (general `buildStationaryLocalPolygons`).
- **E (genuine lane-detection limitation, reported, not thresholded away):** lane0 (outer-right) is output by the model in all 30 frames but at prob ~0.30, below the standard 0.5 gate, in 28/30 frames; only frames 28–29 exceed 0.5 and are displayed (JP3). The video shows the marking; the model's confidence is genuinely low.
