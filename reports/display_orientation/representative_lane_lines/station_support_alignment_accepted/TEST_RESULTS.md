# Test Results — Representative Station Support & Display Alignment (Accepted)

## Syntax
`node --check` OK for `public/connected_accumulated_display.js`, `public/render.js`,
`public/app.js`, `public/combined_visible_lane_projection.js`,
`tests/representative_station_support.test.js`, `tests/representative_cvlp_parity.test.js`,
`tests/representative_display_alignment.test.js`.

## Suites (exact totals)
| Suite(s) | Result |
|---|---|
| representative_station_support + representative_cvlp_parity + representative_display_alignment + representative_lane_lines + purity + purityRevisit + point_accumulated_lane_polylines + combined_visible_lane_projection + combined_default_promotion + combined_boundary_anchoring + local_playback_geometry_modes + local_playback_stationary + progressive_viewport_candidate | **246 / 246 pass** |
| progressive_transaction_scope | **22 / 22 pass** |
| progressive_combined_playback (named batches: numeric 19, playback 11, uds 17, candidate-off 1) | **48 / 48 pass** |

No test was deleted, weakened, renamed, skipped, or excluded.

## Hygiene
- `git diff --check` — clean (exit 0; only LF→CRLF advice).
- UTF-8/mojibake scan of `public/**/*.{html,js,css}` — **0 hits**; `<meta charset="UTF-8">` present.
- Deterministic representative build — identical repeated output.
- Input mutation — none.
- Non-finite output — none.

## Dataset / regression gates (reused validated evidence)
The diagnostic-cleanup change alters **no** processing code — only removes the temporary
ALIGN UI text and the unused per-group lateral calculation. Fitting, Station Support,
CVLP mapping and geometry are unchanged, so the previously validated 92-segment dataset
result still holds (validated by code-identity of the processing paths):
92/92 processed, 0 failed, lane counts unchanged, Seg2 protections unchanged,
Seg99 self-fold/revisit protection unchanged, Seg12 unchanged where intended,
Seg14 accepted alignment retained, Seg18 cross-lane samples rejected,
0 input mutation, 0 non-finite, deterministic.
