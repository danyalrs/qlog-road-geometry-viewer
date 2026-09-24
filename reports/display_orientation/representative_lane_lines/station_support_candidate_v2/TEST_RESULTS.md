# Test Results — Station Support v2

## Commands and exact totals
- `node --check` on `public/connected_accumulated_display.js`, `public/render.js`,
  `public/app.js`, `tests/representative_station_support.test.js` — OK.
- `node --test tests/representative_station_support.test.js` — **43 / 43 pass**
  (28 original v1 tests updated for the v2 contract + 15 new v2 local-band tests).
- Combined group (one process):
  `representative_station_support + representative_lane_lines + representative_lane_lines_purity + representative_lane_lines_purity_revisit + point_accumulated_lane_polylines + local_playback_geometry_modes + local_playback_stationary + progressive_viewport_candidate + combined_default_promotion + combined_visible_lane_projection + combined_boundary_anchoring`
  — **224 / 224 pass**.
- `progressive_combined_playback.test.js` in named batches — **48 / 48 pass**
  (numeric 19, playback 11, uds-1-8 8, uds-9-11 3, uds-12-17 6, candidate-off 1). The full
  single-process run is not used here (it exceeds the environment time limit); all tests
  pass in batches.

## v2-specific coverage
Local-band gates (missing / one-frame / wide / competing / anchor-outside /
extended-outside / fitted-outside / temporal-mismatch / safe-accept), cache-key v2,
same-identity band only, Seg14 restored-point envelope within baseline, v1 aggressive
collapse not reproduced, Seg12/Seg2/Seg99 restore nothing.

## Determinism / checksum
- Candidate OFF byte-identical to the pre-edit backup module (Seg2/12/14/16/18/89/99).
- Repeated OFF and ON builds identical.
- Dataset run: 0 input mutation, 0 non-finite, deterministic.
