# Unified Display Snapshot — Test Results

**Date:** 2026-09-15
**Branch:** `experiment/lane-map-accuracy`
**HEAD:** `ebfa6af55724125b48325d69ce348a189421b4e0` (uncommitted working-tree changes)

## Syntax checks

| File | Result |
|------|--------|
| `public/app.js` | pass |
| `lib/progressive_combined_playback.js` | pass |
| `public/progressive_combined_playback.js` | pass |

## Progressive combined playback

`node --test tests/progressive_combined_playback.test.js`

| Metric | Count |
|--------|------:|
| Tests | 48 |
| Pass | 48 |
| Fail | 0 |

Includes 17 new `uds-*` unified display snapshot tests.

## Focused regressions

| Suite | Pass |
|-------|-----:|
| `combined_default_promotion.test.js` | 13 |
| `combined_boundary_anchoring.test.js` | 18 |
| `combined_visible_lane_projection.test.js` | 13 |
| `combined_full_layer_alignment.test.js` | 11 |
| `boundary_bridge_playback.test.js` | 15 |
| `cross_layer_alignment_shared_frame.test.js` | (included) |
| `local_playback_geometry_modes.test.js` | 44 |
| `local_playback_stationary.test.js` | 18 |
| `point_accumulated_lane_polylines.test.js` | 12 |
| `representative_lane_lines_purity_revisit.test.js` | 26 |
| **Total (focused runs)** | **170** |

All focused regression tests passed.

## Not run

- Full 92-segment validation (per task stop condition)
- Long browser/CDP automation
