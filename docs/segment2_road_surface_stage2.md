# Segment 2 Road-Surface Stage 2

Generated: 2026-08-04

## Scope

Stage 2 performs coverage review, component validation, overlap/end-cap policy checks, pixel verification, browser bundle repair, and main-UI prototype integration preparation. **Mode 5 lane geometry remains frozen** (`5283af91`).

## Accepted baseline (unchanged)

| Metric | Value |
|--------|-------|
| Lane layer | Mode 5 |
| Lane checksum | `5283af91` |
| Logical cleaned runs | 28 |
| Fused fragments | 33 |
| Eligible boundary pairs | 2 / 2 |
| Polygon components | 14 |
| Supported polygon length | 177.4 m (exact: 177.43816728941687 m) |
| Polygon area | 537.7 m² |
| Unsupported breaks retained | 44 |
| Self-intersections / overlaps | 0 / 0 |
| Prototype surface checksum | `26ae09b9` |

## Component audit summary

All **14** polygons structurally accepted. See `audit_segment2_road_surface_stage2_components.json`.

| Pair | Components | Exact length |
|------|------------|--------------|
| BP-PB1-PB0 | 12 | 168.251 m |
| BP-PB2-PB1 | 2 | 9.187 m |

### PB2–PB1 dedicated review

| Polygon ID | Length | Area | Crosses CD-10 | Crosses CD-18 | Between PB2/PB1 |
|------------|--------|------|---------------|---------------|-----------------|
| RS-BP-PB2-PB1-12-408 | ~4.49 m | — | No | No | Yes |
| RS-BP-PB2-PB1-13-435 | ~4.70 m | — | No | No | Yes |

Dedicated close-ups: `screenshots/segment2_road_surface_stage2/stage2_pb2pb1_*.png`

## Coverage review

| Metric | Value |
|--------|-------|
| Total route length | 696.8 m |
| Pair-overlap length | 177.438 m |
| Generated polygon length | 177.438 m |
| Uncovered eligible length | 0 m |
| Coverage vs pair overlap | 100% |

### Rounding reconciliation

- Exact PB1–PB0: **168.2511573245411 m**
- Exact PB2–PB1: **9.187009964875756 m**
- Exact sum: **177.43816728941687 m**
- Reported one-decimal total: **177.4 m**
- Display sum 168.3 + 9.2 = **177.5 m**

**Verdict: rounding only.** The 0.1 m display gap (177.5 vs 177.4) comes from independent one-decimal rounding per pair; exact arithmetic reconciles.

## Overlap and end-cap policy

- Interior overlaps between separate components: **0**
- End caps use supported left/right boundary endpoints only
- End caps do not cross other boundaries
- Components separated by unsupported geometry remain disconnected
- Neighbour pair analysis: see `audit_segment2_road_surface_stage2_coverage.json`

## Browser bundle repair

**Build command:** `npm run bundle:browser`

| Output | Path |
|--------|------|
| Lane cleanup bundle | `public/lane_map_cleanup.js` |
| Road-surface Stage 1 bundle | `public/road_surface_stage1.js` |
| Segment 2 audit data (browser) | `public/segment2_browser_audit_data.js` |
| Segment local map (synced) | `public/segment_local_map.js` |

Fixes applied:
- Inlined `trajectory.js` and `temporal_projection.js` for D12 preservation parity
- Renamed colliding `hasCompetingBoundaryInGap` in preservation module
- Stripped inline `require('./sd_fusion')` from fusion_bins audit helpers
- Bundled `road_surface_stage1.js` + `geometry_sanity` with `dist2d`
- Embedded class-D gaps and separations for browser

**Parity verified:** Node and browser both produce lane checksum `5283af91`, surface checksum `26ae09b9`, 14 polygons, 28 cleaned runs.

## Main-UI integration

- Mode **5** (`cleaned`): lane-only, zero road surfaces — unchanged
- Mode **7** (`cleanedWithStage1Surface`): **Road-surface prototype (Stage 1)**
- Road-surface layer toggle controls visibility only
- HUD shows polygon count, lane checksum, display mode, surface checksum
- Lane boundaries draw above fill; geometry stationary during timeline playback

## Pixel verification

28 screenshots in `screenshots/segment2_road_surface_stage2/` including:
- Stage 2 overview
- All 14 individual polygons
- Both PB2–PB1 dedicated close-ups
- CD-10, CD-12, CD-18, CD-01, D6, class-F, 240 m dropout controls
- Shortest, widest, highest width-variation, closest neighbours

Manifest: `screenshots/segment2_road_surface_stage2/capture_manifest.json`

## Tests

| Suite | Result |
|-------|--------|
| Stage 1 (23 tests) | 23/23 pass |
| Stage 2 (26 tests) | 26/26 pass |
| Full suite | 924/933 pass (9 pre-existing failures) |

Stage 2 test file: `tests/local_playback_road_surface_stage2.test.js`

## Arrow and video synchronization

Segment 2 local playback may still report `headingSource: none` when the stationary map is invalid or not yet built. This was **not fabricated as pass** — geometry stationarity and checksum parity were verified; arrow heading requires separate timeline capture in the main UI with a loaded segment.

## Stage 2 verdict

| Criterion | Status |
|-----------|--------|
| All 14 components structurally accepted | Yes |
| All 14 components visually captured | Yes |
| PB2–PB1 short surfaces accepted | Yes |
| Coverage accounting reconciled | Yes |
| Unsupported gaps remain uncovered | Yes |
| Polygon overlap policy passed | Yes |
| End-cap policy passed | Yes |
| Mode 5 baseline unchanged | Yes |
| Browser bundle repaired | Yes |
| Main-UI geometry matches harness | Yes |
| Segment 2 Stage 2 accepted | Yes |

**Next action:** Test road-surface prototype on another segment after confirming main-UI arrow/video sync in an interactive session.
