# Test Results — Representative CVLP Parity Fix

## Commands and exact totals
- `node --check` on `combined_visible_lane_projection.js`,
  `connected_accumulated_display.js`, `render.js`, `app.js`,
  `tests/representative_cvlp_parity.test.js` — OK.
- `node --test tests/representative_cvlp_parity.test.js` — **8 / 8 pass**
  (kind approved, dot↔rep identical projection, mirror 0/1 parity, combinedPlaced
  parity, standalone ineligible → null, missing sourceFile safe fallback, no mutation,
  determinism).
- Combined battery: `representative_cvlp_parity + representative_display_alignment +
  representative_station_support + representative_lane_lines + purity + purityRevisit +
  point_accumulated_lane_polylines + combined_visible_lane_projection +
  combined_default_promotion + combined_boundary_anchoring + local_playback_geometry_modes +
  local_playback_stationary + progressive_viewport_candidate` — **242 / 242 pass**.
- `progressive_combined_playback.test.js` in named batches — **48 / 48 pass**
  (numeric 19, playback 11, uds 17, candidate-off 1).

## Not run
No suite timed out. Full single-process progressive run not used (environment limit); run
in batches.

## Geometry unchanged
The fix touches only the renderer projection and adds provenance metadata; line/lane/gap
counts and processing geometry are unchanged (92/92 dataset: lines 1492→1294,
gaps 1176→817, lanes 340→340, 0 mutation, 0 non-finite) — identical to the v2 run.
