# Stage 16 — Projected Lane-Line Observations

**Date:** 2026-07-23
**Status:** approved
**Projection schema:** `2026-07-24-lane-projection-v0`
**Frozen v11 baseline:** `2026-07-24-fusion-v11`
**v11 geometry modified:** false

## Scope

Stage 16 projects modelV2 lane-line observations from device frame into route coordinates.
It does **not** implement divider tracking, run fusion, lane intervals, or lane-count estimation.

## Transform conventions

- Device frame: x forward, y left, z up
- Global: east/north from first GPS fix; heading clockwise from north
- Route s: arc length along section-scoped vehicle path
- Route d: signed lateral offset (positive = left of travel)
- Pose: `interpolateGpsAtTime` (frozen GPS model)
- Projection: `projectPointTemporal` within pass+section boundary

## Perpendicular-distance semantics

- **Definition:** Perpendicular distance from the projected global (east, north) point to the nearest trajectory line segment within the temporal search window
- **Units:** metres
- **Assessment limit:** 25 m
- **Trajectory scope:** Section-scoped vehicle path for matching (temporalPassId, poseSectionId)
- **Temporal window:** ±temporalWindowSegments (default 4) around nearest path index to observation time
- **Tie resolution:** Minimum perpendicular distance among valid candidates within temporal window; ambiguous if two candidates within 1 m perp dist and >10 m s separation
- **Point-level filter rationale:** Long lane-line polylines extend beyond reliable trajectory association; distant points often exceed perp limit while near-field points remain valid. Point-level filtering retains valid near-field geometry instead of rejecting the entire observation.
- **Curved roads:** On curves, perp distance is measured to the local chord segment in the temporal window, not the global arc; points remain valid when within limit relative to nearby path segment
- **Pose-section ends:** Near section ends the temporal window may shrink; points projecting outside the window are rejected as pose_unavailable, not silently interpolated across boundaries

## Fragment assessment (prototype)

Disconnected projected point runs are split into fragments; only the primary fragment (longest route-s span) is retained.

| Check | Threshold |
|-------|-----------|
| min projected points | 2 |
| min retained fraction | 0.05 |
| min route-s span | 2 m |
| max source-index gap | 1 |
| monotonic route-s | true |

## Dataset totals

| Metric | Value |
|--------|-------|
| Physical segments | 92 |
| Route chunks | 97 |
| modelV2 frames | 2761 |
| Source slot observations | 11044 |
| Projected observations | 5809 (52.6% of 11044) |
| Projected frames | 2049 / 2761 |

## Source-point accounting (exhaustive)

| Bucket | Count | % of raw |
|--------|-------|----------|
| Raw decoded device points | 364452 | 100% (364452 / 364452) |
| Raw nonfinite | 0 | 0.0% (0 / 364452) |
| Rejected outside x ∈ [−5, 120] m window | 77308 | 21.2% (77308 / 364452) |
| After x-window | 287144 | 287144 / 364452 (78.8%) |
| In observation-rejected records | 125112 | 34.3% (125112 / 364452) |
| Submitted to projection | 162032 | 44.5% (162032 / 364452) |
| Successfully projected | 122439 | 122439 / 162032 (75.6%) |
| Rejected perp distance | 34504 | 21.3% (34504 / 162032) |
| Rejected pose unavailable/gap | 6 | 0.0% (6 / 162032) |
| Rejected forward window | 0 | 0.0% (0 / 162032) |
| Rejected nonfinite output | 0 | 0.0% (0 / 162032) |
| Rejected fragment discarded | 4933 | 3.0% (4933 / 162032) |
| **Reconciliation** | PASSED | accounted 364452 / expected 364452 |

### Point-level outcome distribution

- `in_observation_rejected`: 125112 (34.33% of 364452)
- `projected`: 122439 (33.60% of 364452)
- `rejected_x_window`: 77308 (21.21% of 364452)
- `rejected_perp_dist`: 34504 (9.47% of 364452)
- `rejected_fragment_discarded`: 5083 (1.39% of 364452)
- `rejected_pose_unavailable`: 6 (0.00% of 364452)
- `raw_nonfinite`: 0 (0.00% of 364452)

## Rejection breakdown (observation-level)

- `projected`: 5809 (52.6% of 11044)
- `rejected_low_assessment_confidence`: 4640 (42.0% of 11044)
- `rejected_fragment_policy`: 423 (3.8% of 11044)
- `rejected_missing_pose`: 89 (0.8% of 11044)
- `rejected_invalid_geometry`: 45 (0.4% of 11044)
- `rejected_pose_gap`: 29 (0.3% of 11044)
- `rejected_excessive_assessment_uncertainty`: 5 (0.0% of 11044)
- `rejected_pose_section_boundary`: 4 (0.0% of 11044)

## Coverage by slot

| Slot | Total | Projected | % |
|------|-------|-----------|---|
| 0 | 2761 | 1471 | 53.3% |
| 1 | 2761 | 1991 | 72.1% |
| 2 | 2761 | 1944 | 70.4% |
| 3 | 2761 | 403 | 14.6% |

## Projection quality by slot

| Slot | Obs rate | Point retention | Median route-s span | Median retained frac | Fragmented | Non-monotonic s |
|------|----------|-----------------|---------------------|----------------------|------------|-----------------|
| 0 | 53.3% | 44.0% | 65.7 m | 0.85 | 0 | 0 |
| 1 | 72.1% | 57.9% | 56.5 m | 0.81 | 0 | 0 |
| 2 | 70.4% | 56.8% | 58.1 m | 0.81 | 0 | 0 |
| 3 | 14.6% | 11.8% | 60.1 m | 0.85 | 0 | 0 |

## Sparse segments (named criteria)

- Segment 2: observation_projection_rate_below_50pct — projected 51/120
- Segment 4: observation_projection_rate_below_50pct — projected 37/120
- Segment 5: observation_projection_rate_below_50pct — projected 33/120
- Segment 6: observation_projection_rate_below_50pct — projected 1/120
- Segment 7: observation_projection_rate_below_50pct — projected 22/120
- Segment 8: observation_projection_rate_below_50pct — projected 36/120
- Segment 9: observation_projection_rate_below_50pct — projected 0/120
- Segment 10: observation_projection_rate_below_50pct — projected 56/120
- Segment 11: observation_projection_rate_below_50pct — projected 45/120
- Segment 22: observation_projection_rate_below_50pct — projected 35/120
- Segment 23: observation_projection_rate_below_50pct — projected 31/120
- Segment 24: observation_projection_rate_below_50pct — projected 53/120
- Segment 25: observation_projection_rate_below_50pct — projected 22/120
- Segment 26: observation_projection_rate_below_50pct — projected 28/120
- Segment 27: observation_projection_rate_below_50pct — projected 42/120
- Segment 50: observation_projection_rate_below_50pct — projected 58/120
- Segment 51: observation_projection_rate_below_50pct — projected 52/120
- Segment 54: observation_projection_rate_below_50pct — projected 17/120
- Segment 56: observation_projection_rate_below_50pct — projected 27/120
- Segment 57: observation_projection_rate_below_50pct — projected 6/120
- Segment 58: observation_projection_rate_below_50pct — projected 29/120
- Segment 59: observation_projection_rate_below_50pct — projected 42/120
- Segment 60: observation_projection_rate_below_50pct — projected 5/120
- Segment 61: observation_projection_rate_below_50pct — projected 25/120
- Segment 62: observation_projection_rate_below_50pct — projected 0/120
- Segment 63: observation_projection_rate_below_50pct — projected 26/120
- Segment 64: observation_projection_rate_below_50pct — projected 34/120
- Segment 65: observation_projection_rate_below_50pct — projected 0/120
- Segment 66: observation_projection_rate_below_50pct — projected 5/120
- Segment 67: observation_projection_rate_below_50pct — projected 15/120
- Segment 95: observation_projection_rate_below_50pct — projected 41/120
- Segment 96: observation_projection_rate_below_50pct — projected 0/120
- Segment 97: observation_projection_rate_below_50pct — projected 26/120
- Segment 99: observation_projection_rate_below_50pct — projected 26/120
- Segment 100: observation_projection_rate_below_50pct — projected 19/120

## BEV inspection categories

Required: straight_road, curved_road, low_confidence, single_valid_side, both_invalid, pose_section_boundary, sparse_segment, stage15_outlier, apparent_lane_change_geometry

## Consistency checks

- Projection consistency: **passed**
- Point reconciliation: **passed**
- Projected observations: 5809
- Projected points: 122439
- Nonfinite outputs: 0
- Pose-gap rejections: 29
- Fragment-policy rejections: 423
- Boundary rejections: 4

## Limitations

- Assessment thresholds are Stage 15A values (not production)
- Fragment assessment thresholds are prototype values (not production)
- Slot roles are dataset-specific metadata from Stage 15A
- Road edges and v11 polygons are geometric context only
- Camera validation blocked (Stage 12B) — no physical-road accuracy claims
- Lane counting **not implemented**

## Tests

Run `node --test tests/stage16_lane_line_projection.test.js`