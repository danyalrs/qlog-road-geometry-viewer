# Unified Display Snapshot — Manual Review

**Status:** `CANDIDATE FIX IMPLEMENTED — USER VISUAL REVIEW REQUIRED`

## URL

http://localhost:3847/?segments=0&local=1&fit=1&mirror=1&progressiveCombinedPlaybackCandidate=1

## Steps

1. Process progressively through Seg5 (append/reveal until `qlog_f449c_5.bz2` is visible).
2. Seek Seg5 to approximately **58 s** (frameId **7203**, logMonoTime **377571241302**).
3. Confirm the blue arrow lies on the grey point-accumulated road.
4. Confirm video still shows Seg5 (not hidden Seg6).
5. Confirm earlier geometry (Seg0–Seg4) remains frozen after append.
6. Do **not** expect stationary-boundary append fixes (Seg6→7 etc.) — out of scope.

## Diagnostics (geometry panel)

When progressive snapshot is active, panel should show:

- `diagProgressiveSnapshot`: `progressiveVisibleFrozen`
- `diagProgressiveVisible`: current visible prefix
- `diagProgressiveHidden`: prepared hidden source (e.g. Seg6) or `—`
- `diagProgressiveFrame`: active `sourceFile / frameId / logMonoTime`

## Expected Seg5 frame 7203 metrics (Node replay)

See `seg5_frame_7203_metrics.json`:

- `arrowMinusTrajM`: **0**
- `arrowToRoadMOnDisplaySnapshot`: **~2.89 m** (internal consistency)
- Prior cross-frame mixed value: **~56.7 m** (pre-fix diagnosis only)

## Remaining limitations

- Stationary-boundary placement (Seg6→7, Seg7→8, Seg8→9) unchanged.
- Progressive frozen coordinates may differ from all-at-once combined placement by design.
- Hidden lookahead still uses `fullMap` / `fullProcessData` for preparation only — must never bind renderer while visible snapshot is active.
