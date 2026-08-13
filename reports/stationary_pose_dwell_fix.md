# Stationary Pose Drift — Dwell-Window Regression Fix Report

**Status:** FIXED.
**Date:** 2026-08-12
**Scope:** Correct the remaining visual regression: geometry and the arrow still drifted
during the CANDIDATE_STOP (3-second stop-confirmation) window before the stationary lock
activated. No lane-detection, identity, construction, joining, chunk/pass or mirror logic
changed. No segment-specific handling. No commit/merge/push.

---

## 1. Exact cause of the remaining Segment 6 arrow movement

The previous single-pass pose lock **labelled** states forward and locked future poses
only when STATIONARY was confirmed (after the 3-second dwell). Poses produced during
CANDIDATE_STOP (the dwell window) were committed at their raw drifting GPS values. On
Segment 6:

- fi=8 mapEast=43.78 (MOVING), fi=9 mapEast=47.70 (MOVING, last reliable moving pose)
- **fi=10-11 CANDIDATE_STOP**: raw poses 46.84 → 45.86 (the arrow moved backward 1.84 m
  while the video showed the car already stopped)
- fi=12+ STATIONARY locked at 45.86

The arrow moved backward during the dwell, and lane/road observations projected from
those drifting poses remained scattered around the stop.

## 2. Exact cause of the remaining scattered geometry in Segments 6 and 9

Same root cause: lane observations are transformed through `frame.pose` at every model
frame. During CANDIDATE_STOP, `frame.pose` was the raw interpolated GPS pose (drifting),
so the geometry committed in that window was offset from the eventual anchor. On Seg9,
frames 0-2 used raw poses (-0.00, -0.16, -0.21) before the lock at fi=3, leaving a
small scatter.

## 3. First frame/time where physical motion and mapping motion diverge

| Segment | last visible physical motion (video) | last raw moving pose | mapping still drifting (before fix) |
|---------|---------------------------------------|----------------------|--------------------------------------|
| 6 | ~fi=10 | fi=9 (47.70) | fi=10-11 (46.84, 45.86) |
| 9 | from start (stationary) | — | fi=0-2 (-0.00,-0.16,-0.21) |

## 4. Stop confirmation time versus effective stop time

| Segment | CANDIDATE_STOP start | STATIONARY confirmed (before) | effective stop onset (after) |
|---------|----------------------|-------------------------------|------------------------------|
| 6 | fi=10 | fi=12 | fi=10 (anchor from fi=9 last moving pose) |
| 9 | fi=0 | fi=2/3 | fi=0 (initially stationary) |

## 5. Anchor selection before and after

- **Before**: median of a near-stop window (could include post-stop GPS drift; e.g. Seg6
  anchor 45.86, behind the actual stop at 47.70).
- **After**: **last reliable moving pose** strictly before the effective stop (reported
  speed ≥ stop threshold), so post-stop drift cannot centre the anchor and there is no
  backward jump. Seg6 anchor = 47.70 (fi=9). Seg9 (initially stationary) = first usable
  frame (-0.26).

## 6. Two-pass fix (dwell correction)

`lib/stationary_pose_lock.js` is now **two-pass**:
- **Pass 1**: classify each frame's state (MOVING/CANDIDATE_STOP/STATIONARY/CANDIDATE_MOVE)
  with time-based dwell on continuous low/high-speed evidence. No poses committed.
- **Pass 2**: for each confirmed STATIONARY interval, find `effectiveStopTime` (start of
  the validated CANDIDATE_STOP run, or interval start if initially stationary), select
  the anchor from the **last reliable moving pose**, and apply that anchor to EVERY
  frame from effectiveStopTime through the end of the interval.

This **retroactively corrects CANDIDATE_STOP poses** — geometry produced during the
confirmation window is rebuilt (transformed) using the confirmed anchor, not left
committed at drifting raw values.

## 7. Before-and-after arrow travel and geometry spread

| Segment | arrow travel during dwell (before) | arrow travel while locked (after) | distinct locked poses | false travel removed |
|---------|------------------------------------|-----------------------------------|-----------------------|----------------------|
| 6 | 1.84 m backward | **0 m** | **1** | 13.2 m |
| 9 | 0.21 m | **0 m** | **1** | 12.1 m |

Every locked frame uses exactly one mapping pose, so point-cloud / polygon spread near
the anchor is eliminated.

## 8. Every geometry layer's pose source

The corrected mapping-pose sequence is applied in `process_route.js`:
`frame.pose` (used by the arrow, point-accumulated observations, road polygons, fused
observations, constructed fragments, joined polylines, playback frames and bounds) now
carries the locked anchor for every frame in a confirmed stationary interval. No layer
uses the raw interpolated GPS pose during a confirmed stop.

## 9. Cache/version evidence

- `PROCESSING_VERSION` bumped `2026-07-24-fusion-v15` → `v16` (pose semantics changed),
  invalidating stale cached processed results.
- Pose-lock params are **not** in `DEFAULT_PROCESS_OPTIONS` / `normalizeProcessOptions` /
  `buildProcessingOptionsSnapshot`, so the processing-options snapshot and server cache
  key are unchanged apart from the version bump — stale results cannot be served.
- A leftover server on port 3847 was running the old v15 code; with a fresh server the
  API parity test returns v16 and passes (verified: 41/41 geometry-modes tests pass with
  a fresh server).

## 10. Dataset-wide before/after

| Metric | single-pass | two-pass (after) |
|--------|-------------|------------------|
| fully-stationary segments | 4 | 6 |
| stop-and-go segments | 10 | 12 |
| unchanged | 77 | 71 |
| total false travel removed | 172 m | **302 m** |
| fully-stationary mapped travel | 0.2-1.2 m | **0 m** |

## 11. Exact test totals before and after

| Suite | Before (single-pass) | After (two-pass) |
|-------|----------------------|------------------|
| Full suite | 1,582 tests, 1,556 pass / 26 fail | **1,596 tests, 1,570 pass / 26 fail** (deterministic) |
| `tests/stationary_pose_lock.test.js` | 24 | **38** (24 core + 14 dwell-correction) |

The 26 deterministic failures are identical to the pre-change baseline. The 27th
(`28. API produces same pre-Stage-7/8 geometry checksums`) requires an externally-running
server on port 3847 and fails with `ECONNREFUSED` when no server is running — an
environment-dependent pre-existing test, not a code regression (verified: it passes with
a fresh server).

## 12. Files changed

- `lib/stationary_pose_lock.js` — two-pass dwell correction (effectiveStopTime anchor
  applied retrospectively), last-reliable-moving-pose anchor.
- `lib/process_route.js` — unchanged (already wired the pose lock).
- `lib/version.js` — `PROCESSING_VERSION` → `fusion-v16`.
- `public/render.js` — viewer diagnostics unchanged.
- `tests/stationary_pose_lock.test.js` — 14 new dwell-correction tests (now 38).
- Updated baselines: `tests/local_playback.test.js`, `tests/stage14_delivery_readiness.test.js`,
  `tests/stage16_lane_line_projection.test.js`, `tests/stage17_lane_divider_tracking.test.js`,
  `tests/stage18_lane_interval_assessment.test.js`, and 8 test files updated for the
  `fusion-v16` version bump.
- `scripts/validate_stationary_pose.js`, `reports/stationary_pose_validation.json`.

## 13. Confirmation

- **No segment-specific conditions** added.
- **No lane detection, tracking identity, construction, endpoint extension, joining,
  chunk, pass or mirror logic changed.**
- The mapping pose is fixed, not the rendered pixels.
- Genuine small movement is preserved (the two-pass anchor only applies to confirmed
  stationary intervals; moving frames keep their raw pose).
- No commit/merge/push.
