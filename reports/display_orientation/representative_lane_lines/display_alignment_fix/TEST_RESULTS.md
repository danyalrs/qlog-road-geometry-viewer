# Test Results — Representative Display Alignment Fix

## Commands and exact totals
- `node --check public/connected_accumulated_display.js` — OK.
- `node --check tests/representative_display_alignment.test.js` — OK.
- `node --test tests/representative_display_alignment.test.js` — **10 / 10 pass**
  (placed-frame propagation, order match, outer-lane no-swap, mirror both ways,
  same-identity band proximity, non-combined unchanged, OFF+ON, no mutation, no
  non-finite, deterministic, identity preserved).
- Combined group (one process): `representative_display_alignment +
  representative_station_support + representative_lane_lines +
  representative_lane_lines_purity + representative_lane_lines_purity_revisit +
  point_accumulated_lane_polylines + local_playback_geometry_modes +
  local_playback_stationary + progressive_viewport_candidate +
  combined_default_promotion + combined_visible_lane_projection +
  combined_boundary_anchoring` — **234 / 234 pass**.
- `progressive_combined_playback.test.js` in named batches — **48 / 48 pass**
  (numeric 19, playback 11, uds 17, candidate-off 1).

## Pre-existing suites (not weakened)
All prior station-support, representative, purity, purityRevisit tests still pass
unchanged (75/75 before adding the alignment suite).

## Not run
No suite timed out. The full single-process `progressive_combined_playback` run was not
used (environment time limit); it was run in named batches.
