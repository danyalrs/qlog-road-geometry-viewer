# Progressive Viewport Candidate — Test Results

**Date:** 2026-09-17
**Base commit:** `1a65da5152f818d3a0a5e7905b02ca5885459171` (Phase 1 unified snapshot)
**Status:** Phase 2 uncommitted — user visual review required

## Syntax checks

| File | Result |
|------|--------|
| `lib/progressive_viewport_candidate.js` | pass |
| `public/progressive_viewport_candidate.js` | pass |
| `public/app.js` | pass |
| `public/render.js` | pass |

## New tests

`node --test tests/progressive_viewport_candidate.test.js`

| Metric | Count |
|--------|------:|
| Tests | 36 |
| Pass | 36 |
| Fail | 0 |

Includes top playback toolbar wiring tests (pvp-23 … pvp-36).

## Regression suites (2026-09-18)

| Suite | Result |
|-------|--------|
| `tests/progressive_combined_playback.test.js` | 48 / 48 pass |
| `tests/progressive_viewport_candidate.test.js` | 36 / 36 pass |
| `tests/local_playback.test.js` + stationary + geometry_modes + current_frame + `combined_visible_lane_projection.test.js` | 115 / 116 pass |

**Note:** `local_playback.test.js` → “includes Local playback with stationary map label” fails on pre-existing HTML (`selected` attribute on the local option); unrelated to viewport candidate changes.
