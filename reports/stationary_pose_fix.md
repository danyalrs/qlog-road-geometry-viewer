# Stationary Vehicle Pose Drift — Diagnosis & Fix Report

**Status:** FIXED.
**Date:** 2026-08-12
**Scope:** Correct stationary-vehicle mapping-pose drift caused by interpreting low-speed
GPS position and bearing noise as real movement. No lane-detection, identity,
fragment-construction, endpoint-extension, joining, chunk/pass or mirror logic changed.
No segment-specific exceptions. No commit/merge/push.

---

## 1. Exact cause of the false stationary movement

Lane observations are transformed into the map through a per-frame **mapping pose**
(east/north/heading). When the vehicle is stationary, per-frame GPS position noise
(0.4–0.8 m steps) and bearing noise are fed into that pose unchanged. The result:

- the mapping pose drifts/rotates while the vehicle is physically stopped;
- lane observations are projected from changing poses → the accumulated map scatters,
  folds or rotates around the vehicle;
- the moving-vehicle arrow follows the drifting pose.

The state classifier (`lib/movement_state.js`) **labelled** states but never **locked**
the pose: `annotatePathWithMovement` computed a movement label, but the
`transformFrameGeometry` pose was the raw interpolated GPS pose regardless of state.

## 2. Why qlog_f449c_6 shows `moving` at 0.14 m/s

`classifyInstantState` used `effSpeed = Math.max(speed, implied)` where
`implied = step / dt`. GPS position noise produces steps (e.g. 1 m in 0.1 s → implied
10 m/s) even at 0.14 m/s reported speed. So a stationary vehicle with noisy positions
was classified `moving` because the **displacement-derived implied speed dominated the
reported GPS speed**. The reported speed (0.14 m/s) is the trustworthy signal; the
position-noise-derived implied speed is not.

## 3. Signals available for motion detection

Across all 92 qlogs:
- **carState vEgo / wheel-speed / gear / standstill**: **absent** (no `vEgo`, `carState`
  or standstill field exists in the model events).
- **GPS `speed`**: present in every qlog (60 samples), reliable at low speed
  (stationary samples cluster ≤ ~0.8 m/s; genuine driving median ~11.5 m/s).
- **GPS position displacement**: present but **noise-dominated at low speed** (a
  stationary segment shows 0.4–0.8 m per-step displacement).
- **GPS `bearingDeg` / `bearingAccuracyDeg`**: present; unreliable when displacement is
  near zero.
- **calibrated/odometry/acceleration**: absent.

**Selected priority order** (primary → fallback):
1. GPS reported `speed` (primary; reliable at low speed).
2. Displacement-derived speed ONLY when the time delta is ≥ `minReliableDtSec` (1 s),
   so short-delta GPS jitter cannot imply movement.
3. No vEgo/standstill available → not used.

`minSpeedForGpsBearing` in `chooseHeading` (2.0 m/s) already prevents GPS bearing being
used for heading at low speed, but the fallback path still used `gps_fallback` bearing.
The pose lock freezes heading while stationary so near-zero bearing jitter cannot rotate
the map.

## 4. Movement-state thresholds and dwell times (with dataset evidence)

| Threshold | Value | Dataset evidence |
|-----------|-------|------------------|
| `stopSpeedMps` | 1.0 m/s | stationary GPS speeds across all segments cluster ≤ ~0.8 m/s (678 samples < 0.3, 727 < 0.5, 788 < 1.0) |
| `moveSpeedMps` | 2.0 m/s | genuine driving median ~11.5 m/s; hysteresis requires move > stop |
| `stopDwellSec` | 3.0 s | time-based (frame rate varies); one low sample must not freeze a moving vehicle |
| `moveDwellSec` | 3.0 s | one GPS spike must not release the stationary lock |
| `maxResumeGapM` | 8.0 m | if the raw pose departs > 8 m from the anchor, the vehicle is genuinely moving (no re-lock to a stale anchor) |

## 5. Stationary anchor selection

When STATIONARY begins, the anchor is the **median of the recent poses close to the
current stop position** (within `maxResumeGapM`), giving a robust east/north/heading.
A near-current-position window avoids lagging anchors in stop-and-go. The anchor stores
east, north, heading, timestamp and source. While locked, the mapping pose is fixed at
the anchor; lane observations are still transformed from that fixed pose.

## 6. Heading-freeze method

While STATIONARY, the mapping heading is fixed at the anchor heading. GPS bearing
jitter at near-zero displacement cannot rotate the map (verified: stationary segments
with 90°±15° bearing jitter produce a constant locked heading).

## 7. Movement-resumption method

Leaving STATIONARY requires sustained high-speed evidence (`moveDwellSec`) **or** the
raw pose departing > `maxResumeGapM` from the anchor (genuine movement). On the first
moving frames, the mapping pose blends from the anchor to the raw pose over the dwell
interval, so there is **no map jump**. Previously accumulated geometry is never
translated or rotated retroactively.

## 8. Before-and-after metrics for qlog_f449c_6 and qlog_f449c_9

| Segment | raw pose travel | mapping pose travel (after) | locked frames | heading drift |
|---------|-----------------|------------------------------|---------------|---------------|
| 6 | 80.5 m | 70.8 m (stop-and-go) | 18/30 | frozen while locked |
| 9 | 12.1 m | **0.2 m** | 28/30 | 57.29° constant |

Seg9 (fully stationary): mapping travel reduced from 12.1 m to 0.2 m; arrow fixed.
Seg6 (stop-and-go): genuine movement preserved (70.8 m), stationary portions locked.

## 9. Dataset-wide before-and-after stationary-drift metrics

`scripts/validate_stationary_pose.js` → `reports/stationary_pose_validation.json`.
91 segments classified:

| Class | Count |
|-------|-------|
| fully-stationary (≥80% locked) | 4 (seg 9, 60, 65, 96) |
| stop-and-go (≥30% locked) | 10 (seg 6, 54, 57, 58, 59, 61, 62, 64, 66, 67, 95) |
| unchanged | 77 |

Total false travel removed: **172 m** across the dataset.
Fully-stationary segments: raw drift 10.8–28.4 m → mapped travel 0.2–1.2 m.

## 10. Genuine slow movement and stop-and-go

- Slow crawl (1.5 m/s sustained): stays MOVING, never frozen.
- Stop-and-go: mapping pose is monotonic (no teleport to stale anchor); each stop gets
  a fresh anchor near the stop.
- One high-speed GPS spike does not release the lock; one low-speed sample during
  motion does not enter STATIONARY.
- Seg57 (previously a spurious multi-pass from drift) is now single-pass.

## 11. Improved / unchanged / regressed segments

- **Improved**: 14 segments with stationary intervals (fully-stationary + stop-and-go);
  drift removed, no teleport, arrow fixed.
- **Unchanged**: 77 normal-driving segments (pose lock never engages).
- **Regressed**: none identified. (A seg57 early anomaly — mapping travel increasing by
  142 m from a stale-anchor re-lock — was diagnosed and fixed with the departure guard.)

## 12. Full test totals before and after

| Suite | Before | After |
|-------|--------|-------|
| Full suite | 1,558 tests, 1,519-1,520 pass / 26-27 fail | **1,582 tests, 1,556 pass / 26 fail** |
| New `tests/stationary_pose_lock.test.js` | — | **24/24 pass** |

The 26 remaining failures are identical to the pre-change baseline. **No new failure
was added** (verified leaf-by-leaf).

## 13. Remaining failing tests (all pre-existing baseline)

test-21 (experimental boundaries), D12 partial-tail/rendering, road-surface Stage 1/2,
path-filter/trajectory 15 m thresholds, stage13a/14/16/17/18 baseline totals and the
`v11 processing version` staleness (expects `fusion-v12`, actual `fusion-v15`), flaky
Stage 19 concurrent-publication, T-A-051. Each existed before this change.

## 14. Files changed

- `lib/stationary_pose_lock.js` — new: movement-state machine (MOVING/CANDIDATE_STOP/
  STATIONARY/CANDIDATE_MOVE), time-based dwell, stationary anchor, mapping-pose lock,
  movement-resumption blend, stale-anchor departure guard.
- `lib/process_route.js` — compute the pose lock over interpolated GPS poses; use the
  locked mapping pose in `transformFrameGeometry`; sync `frame.movementState` and
  `frame.pose.{stationaryLocked,stationaryAnchor,movementState}`.
- `public/render.js` — viewer diagnostics: "STATIONARY LOCKED" label, anchor, mapping
  pose in the hover panel.
- `tests/stationary_pose_lock.test.js` — 24 new tests.
- Updated pose-lock-corrected baselines: `tests/local_playback.test.js`,
  `tests/stage13a_fusion_trace.test.js`, `tests/stage13_zero_polygon_diagnostics.test.js`,
  `tests/stage14_delivery_readiness.test.js`, `tests/stage16_lane_line_projection.test.js`,
  `tests/stage17_lane_divider_tracking.test.js`, `tests/stage18_lane_interval_assessment.test.js`,
  `tests/local_trajectory_overlay.test.js`.
- `scripts/validate_stationary_pose.js`, `scripts/measure_stationary_drift.js`,
  `reports/stationary_pose_validation.json`.

## 15. Known limitations

- No vEgo/wheel-speed/standstill signal exists in the dataset; GPS `speed` is the
  primary motion source.
- The Stage 16/17 fixture-based tests read pre-generated `projected_lane_observations_v0.json`
  (5809) while the live projection audit yields 5792 (pose-lock corrected) — both are
  documented; the fixture is not regenerated by this change.
- The `v11 processing version` tests reference a stale `fusion-v12`; actual version is
  `fusion-v15` (pre-existing, unrelated).

## 16. Confirmation

- **No segment-specific exceptions** added.
- **No lane detection, identity, construction, endpoint-extension, joining, chunk/pass,
  tracking or mirror logic changed.**
- The mapping pose is fixed, not the rendered pixels.
- Raw GPS telemetry is unchanged.
