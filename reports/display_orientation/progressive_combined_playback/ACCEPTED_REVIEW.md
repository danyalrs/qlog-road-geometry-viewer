# Progressive Combined Playback — Accepted Review

**Branch:** `experiment/lane-map-accuracy`
**Parent HEAD:** `6d8c8fd08595ebfa05ead2294e22cbdc8a4db997`
**Candidate flag:** `progressiveCombinedPlaybackCandidate=1` (default-off; not promoted)

## Review URL

`http://localhost:3847/?segments=0&local=1&fit=1&mirror=1&progressiveCombinedPlaybackCandidate=1`

## Problem history

1. **Initial standalone-to-combined rotation bug** — Progressive `process([Seg0])` built a standalone map; first append rotated Seg0 into the combined frame because the visible prefix was not solved with hidden Seg1 in the accepted combined pipeline.
2. **Frozen-prefix Path B** — Interior sources stayed stable on later appends, but first-append orientation still failed without lookahead.
3. **Hidden one-segment lookahead** — Process visible prefix + one hidden next source through the accepted combined pipeline; render only the visible prefix; append reveals prepared geometry without re-solving the frozen visible prefix.
4. **Duplicate `const PCP` startup fix** — Removed a second `const PCP` in `process()` that blocked `public/app.js` from loading.
5. **Timeline/full-data mismatch fix** — Stopped using `findLastTimelineIndexForSource` for bootstrap and ordinary append; bound renderer/video/arrow to filtered `displayProcessData` instead of full `processData`.

## User visual acceptance (2026-09-15)

- Fresh progressive Seg0 starts at **0.0 s**
- Arrow starts correctly and remains visible during playback
- Seg0 uses its **combined-ready** orientation before Seg1 is visible
- Seg0 does **not** move or rotate when Seg1 is revealed
- Ordinary append preserves the current frame and remains paused
- Append-and-continue enters the appended segment
- Arrow and synchronized video switch to the appended segment
- Remove-last restores the previous state
- Seg2 still curves left

## Implementation scope

- `lib/progressive_combined_playback.js` — lookahead helpers, frozen append, visible filtering, timeline mapping
- `public/progressive_combined_playback.js` — browser mirror (sync script)
- `public/app.js` — progressive state, bootstrap/reveal/prepare/remove, playback data routing
- `public/index.html` — progressive panel + script tags
- `tests/progressive_combined_playback.test.js` — helper + app-wiring + playback timeline tests
- `scripts/sync_progressive_combined_playback_public.js` — lib → public sync

**Not modified:** combined-orientation mathematics, CVLP, purityRevisit, lane extraction, road geometry, fused geometry, qlog processing, cache algorithms.

## Automated verification (pre-commit)

| Command / suite | Result |
|-----------------|--------|
| `node --check public/app.js` | pass |
| `node --check lib/progressive_combined_playback.js` | pass |
| `node --check public/progressive_combined_playback.js` | pass |
| `tests/progressive_combined_playback.test.js` | 31 / 31 pass |
| `tests/combined_default_promotion.test.js` | 11 / 11 pass |
| `tests/combined_boundary_anchoring.test.js` | pass |
| `tests/combined_visible_lane_projection.test.js` | pass |
| `tests/combined_full_layer_alignment.test.js` | pass |
| `tests/boundary_bridge_playback.test.js` | pass |
| `tests/cross_layer_alignment_shared_frame.test.js` | pass |
| `tests/local_playback_geometry_modes.test.js` | pass |
| `tests/local_playback_stationary.test.js` | pass |
| `tests/point_accumulated_lane_polylines.test.js` | pass |
| `tests/representative_lane_lines_purity_revisit.test.js` | pass |

**Test-count note:** `combined_default_promotion.test.js` defines **11** `test()` blocks whose titles reference items 1–15 (e.g. `1-2`, `13-14`); Node reports **11 tests**, not 13 or 15.

## Remaining limitations

- Opt-in only via URL flag; not default-enabled
- Full 92-segment validation not run
- No committed browser screenshot bundle
- Diagnosis/backup artifacts intentionally excluded from commit
