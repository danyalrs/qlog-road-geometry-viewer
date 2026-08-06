# Stage 15 — Lane-Divider Evidence Assessment

**Date:** 2026-07-23
**Stage 15 status:** approved
**Stage 15A status:** approved
**Frozen road-surface baseline:** `2026-07-24-fusion-v11`
**Lane-count schema version:** `2026-07-24-lane-count-v0`

## Executive summary

Stage 15 is a read-only investigation. No production lane-count estimation was implemented.
v11 road-surface geometry remains **unchanged**.

- **Physical segments:** 92
- **Route chunks:** 97
- **modelV2 frames:** 2761
- **Frames with lane lines:** 2761 (100.0%)
- **Frames with v11 prob-filtered lines (minLaneProb=0.5):** 2305 (83.5%)

## laneLineProb threshold (0.5) usage

The value **0.5** is the frozen **v11 production** default `minLaneProb` (config field `minLaneProb`).
It filters lane lines in `lib/transform.js` → `extractModelGeometry` before fusion geometry is built.
Stage 15 assessment reuses the same default when counting prob-filtered frames — it is not a separate Stage 15 invention.

**v11 code paths:**
- `lib/transform.js` → `extractModelGeometry` (Filters lane lines before transform; lines with prob < minLaneProb excluded from geometry)
- `lib/transform.js` → `transformXyztLine` (Per-line prob check during point projection)
- `lib/process_route.js` → `processRoute` (Passed to extractModelGeometry for frame building and fusion input)
- `dataset_audit.js` → `DEFAULT_OPTS` (Audit CLI default matching production pipeline)
- `lib/frame_stats.js` → `buildFrameStats` (validLaneFrames counting)

**Assessment-only thresholds** (Stage 15A, not production):
- evalForwardXM: 10 m
- assessmentMinProb: 0.5
- assessmentMaxStdM: 1.5 m

## Part 1 — Available signals

### modelV2 lane/road fields
| Field | Shape | Coordinate system | Used by v11 |
|-------|-------|-------------------|-------------|
| laneLines | List(XYZTData) | device: x=fwd, y=left, z=up (m) | yes (fusion) |
| laneLineProbs | Float32 per line | classification confidence [0,1] | yes (`minLaneProb` default 0.5 in transform) |
| laneLineStds | Float32 per line | spatial uncertainty (m) | **no** |
| roadEdges | List(XYZTData) | device frame | yes (fusion) |
| roadEdgeStds | Float32 per edge | spatial uncertainty (m) | yes (attached to edge geometry, not prob gate) |

**Important:** Not every modelV2 lane line represents a physical lane divider.

### Signal inventory (decoded data)

| Signal | Present | Coverage | Shape / units | Frequency | Uncertainty | v11 | Future pipeline |
|--------|---------|----------|---------------|-----------|-------------|-----|-----------------|
| laneLines | yes | 92/92 segments | List(XYZTData), device frame | 2761 msgs (~0.5 Hz) | per-point xStd/yStd (unused by v11) | **yes** | **yes** |
| laneLineProbs | yes | 92/92 segments | [0,1] per line | paired with lane lines | — | **yes** | **yes** |
| laneLineStds | yes | 92/92 segments | metres per line | paired with lane lines | spatial std | **no** | **yes** |
| roadEdges | yes | 92/92 segments | List(XYZTData) | paired with frames | per-edge std | **yes** | context only |
| roadEdgeStds | yes | 92/92 segments | metres per edge | paired with road edges | spatial std | **yes** (geometry attach) | context only |
| desireState | yes | 92/92 segments | meta array | per modelV2 | — | **no** | **yes** (unknown tagging) |
| laneChangeState | yes | 0/92 segments | meta enum | per modelV2 | — | **no** | **yes** (unknown tagging) |
| laneChangeDirection | yes | 0/92 segments | meta enum | per modelV2 | — | **no** | **yes** |
| temporalPose | no | 0/92 segments | Pose in device frame | per modelV2 | transStd/rotStd | **no** | proposed |
| GPS | yes | 92/92 segments | lat/lon/speed/bearing | ~1 Hz | accuracy fields | **yes** (pose) | **yes** (projection) |
| LiveLocationKalman | yes | 92/92 segments | fused pose | ~1 Hz | covariance | **no** | unsuitable (not used) |
| LiveCalibration | yes | 92/92 segments | extrinsic matrix | sparse | cal % | **no** | blocked (12B) |
| CameraOdometry | yes | 92/92 segments | visual odometry | per frame | — | **no** | unsuitable |

Every v11 “yes” entry maps to an exact code path in `lib/transform.js` or `lib/process_route.js` (see audit JSON `v11SignalUsage`).

### Segment and chunk coverage

Dataset totals reconcile: 92 segments, 97 chunks, 2761 modelV2 frames, 11044 lane-line observations (4 slots × 2761 frames = 11044).

Per-segment and per-chunk summaries are in `audit_stage15_lane_divider_evidence.json` → `segmentSummaries` / `chunkSummaries`.

**Coverage outliers** (prob-filtered frame rate < 50% or other flags):

| Segment | Frames | Chunks | Frame coverage | Prob-filtered | Flags |
|---------|--------|--------|----------------|---------------|-------|
| 62 | 30 | 1 | 100% | 0% | low_prob_filtered_coverage |
| 65 | 30 | 1 | 100% | 0% | low_prob_filtered_coverage |
| 96 | 30 | 2 | 100% | 0% | low_prob_filtered_coverage |
| 66 | 30 | 1 | 100% | 10% | low_prob_filtered_coverage |
| 57 | 30 | 1 | 100% | 13% | low_prob_filtered_coverage |
| 6 | 30 | 1 | 100% | 23% | low_prob_filtered_coverage |
| 7 | 30 | 2 | 100% | 33% | low_prob_filtered_coverage |
| 63 | 30 | 1 | 100% | 37% | low_prob_filtered_coverage |
| 56 | 30 | 1 | 100% | 43% | low_prob_filtered_coverage |
| 99 | 30 | 1 | 100% | 43% | low_prob_filtered_coverage |
| 100 | 30 | 1 | 100% | 43% | low_prob_filtered_coverage |
| 23 | 30 | 1 | 100% | 47% | low_prob_filtered_coverage |
| 64 | 30 | 1 | 100% | 47% | low_prob_filtered_coverage |
| 95 | 30 | 1 | 100% | 47% | low_prob_filtered_coverage |
| 97 | 30 | 1 | 100% | 47% | low_prob_filtered_coverage |

No segment has missing raw lane-line frames (<4 lines). All 92 segments contain modelV2 evidence.

## Stage 15A — Classification audit ✅ APPROVED

### A. Candidate availability (exhaustive)

| Outcome | Frames | % |
|---------|--------|---|
| both_valid | 2077 | 75.2% |
| left_only_valid | 74 | 2.7% |
| right_only_valid | 153 | 5.5% |
| neither_valid | 457 | 16.6% |

**Reconciliation:** `2 × both_valid + left_only_valid + right_only_valid = retained ego classifications`
→ 2×2077 + 74 + 153 = 4381
(total retained = 4381)

### B. Frame assessment reasons (primary)

- `accepted_both`: 2077
- `rejected_left_uncertainty`: 2
- `rejected_left_confidence`: 152
- `rejected_both_confidence`: 456
- `rejected_right_confidence`: 71
- `rejected_right_uncertainty`: 3

**Confidence failure sides** (not merged into single “one side” label):
- left side only: 152
- right side only: 71
- both sides: 456

### 2×2 candidate-validity matrix

| | Right valid | Right invalid |
|--|-------------|---------------|
| Left valid | 2077 frames, 4154 retained | 74 frames, 74 retained |
| Left invalid | 153 frames, 153 retained | 457 frames, 0 retained |

#### Matrix cell detail

#### both_valid (left valid, right valid)

- **Frames:** 2077
- **Retained classifications:** 4154
- **Most common assessment reason:** `accepted_both` (2077)
- **Left slot indices:** 2 (2077)
- **Right slot indices:** 1 (2077)
- **Probability:** median 0.956, p10 0.731, p90 0.986
- **Uncertainty (std m):** median 0.074, p10 0.047, p90 0.254

#### left_only_valid (left valid, right invalid)

- **Frames:** 74
- **Retained classifications:** 74
- **Most common assessment reason:** `rejected_right_confidence` (71)
- **Left slot indices:** 2 (74)
- **Probability:** median 0.625, p10 0.515, p90 0.875
- **Uncertainty (std m):** median 0.330, p10 0.134, p90 0.792

#### right_only_valid (left invalid, right valid)

- **Frames:** 153
- **Retained classifications:** 153
- **Most common assessment reason:** `rejected_left_confidence` (151)
- **Right slot indices:** 1 (153)
- **Probability:** median 0.679, p10 0.527, p90 0.966
- **Uncertainty (std m):** median 0.209, p10 0.086, p90 0.400

#### neither_valid (left invalid, right invalid)

- **Frames:** 457
- **Retained classifications:** 0
- **Most common assessment reason:** `rejected_both_confidence` (456)


### Ego-boundary reconciliation

| Metric | Value |
|--------|-------|
| Total frames | 2761 |
| Retained ego classifications | 4381 |
| both_valid retained | 4154 |
| single-valid retained | 227 |
| Reconstruction matches | yes |

Retained ego classifications reconcile: 2×2077 + 74 + 153 = 4381. Single-valid frames (227) account for classifications beyond both-valid frames.

### Frame verdict outcomes (legacy summary)

- `two_valid_ego_candidates`: 2077 (75.2%)
- `right_only_valid`: 153 (5.5%)
- `uncertain_confidence`: 457 (16.6%)
- `left_only_valid`: 74 (2.7%)

### Slot semantics (per index at eval forward distance)

| Index | Median y (m) | Prob median | Std median | % left | % right | Ego selections | Inferred role |
|-------|-------------|-------------|------------|--------|---------|----------------|---------------|
| 0 | -4.548 | 0.585 | 0.361 | 0% | 100% | 0 | predominantly_outer_right |
| 1 | -1.604 | 0.935 | 0.094 | 0% | 100% | 2230 | predominantly_inner_right_ego_candidate |
| 2 | 1.394 | 0.927 | 0.095 | 100% | 0% | 2151 | predominantly_inner_left_ego_candidate |
| 3 | 4.287 | 0.035 | 0.404 | 100% | 0% | 0 | predominantly_outer_left |

**Slot semantics conclusion:** At 10 m forward, this dataset empirically supports index ordering
[outer-right, inner-right, inner-left, outer-left]. These are **dataset-inferred semantics**, not a
universal guarantee for every model version or driving condition.

Future production lane-divider logic must use geometry, confidence, uncertainty and temporal
consistency — **not** hard-coded slot identity alone.

### Right-boundary correction (before vs after)

- Frames compared: 2761
- Index changed: 2761
- Rule: Before: outermost right (most negative y). After: nearest eligible right-side line (max y among y<0).

## Part 2 — Evidence quality

### Distributions
| Metric | Count | Median | P10 | P90 |
|--------|-------|--------|-----|-----|
| laneLineProb | 11044 | 0.649 | 0.005 | 0.976 |
| laneLineStd (m) | 11044 | 0.294 | 0.057 | 0.976 |
| ego lane width (m) | 89 | 2.987 | 2.687 | 3.202 |

### Classification totals (heuristic per-line)
- ego-lane boundaries: 4381
- probable adjacent dividers: 697
- uncertain outer lines: 1284
- unclassifiable: 4682

### Road-edge interval metrics (corrected denominators)

Evaluation distance: **10 m** forward in device frame.

| Metric | Value |
|--------|-------|
| Comparable frames | 2761 |
| Comparable line observations | 11044 |
| Line observations inside road-edge interval | 8901 |
| % line observations inside | 80.6% |
| Both retained ego inside | 2076 / 2077 both_valid frames |
| ≥1 retained ego inside | 2304 / 2304 frames with any retained ego |

Frame-level inside metrics count **retained valid ego candidates only** — rejected ego candidates are excluded.

#### Road-edge breakdown (line observations)

**By line index**
| Index | Comparable | Inside | % inside |
|-------|------------|--------|----------|
| 0 | 2761 | 2167 | 78.5% |
| 1 | 2761 | 2748 | 99.5% |
| 2 | 2761 | 2746 | 99.5% |
| 3 | 2761 | 1240 | 44.9% |

**By inferred slot role**
| Role | Comparable | Inside | % inside |
|------|------------|--------|----------|
| predominantly_outer_right | 2761 | 2167 | 78.5% |
| predominantly_inner_right_ego_candidate | 2761 | 2748 | 99.5% |
| predominantly_inner_left_ego_candidate | 2761 | 2746 | 99.5% |
| predominantly_outer_left | 2761 | 1240 | 44.9% |

**By heuristic class**
| Class | Comparable | Inside | % inside |
|-------|------------|--------|----------|
| unclassifiable | 4682 | 2580 | 55.1% |
| ego_lane_boundaries | 4381 | 4380 | 100.0% |
| uncertain_outer_lines | 1284 | 1249 | 97.3% |
| probable_adjacent_dividers | 697 | 692 | 99.3% |

**By ego candidate status**
| Status | Comparable | Inside | % inside |
|--------|------------|--------|----------|
| not_ego_candidate | 5523 | 3429 | 62.1% |
| valid_retained_ego | 4381 | 4380 | 100.0% |
| rejected_ego_candidate | 1140 | 1092 | 95.8% |
| **total** | 11044 | 8901 | 80.6% |

Line-level inside uses all comparable observations. Frame-level inside metrics use retained valid ego candidates only; denominators are availability-based.

### Behaviour flags
- Lateral order crossings: 0
- Missing-line frames (<4 raw): 0
- Continuity gaps: 0
- Lane-change meta frames: 0

### Other signals
- GPS pose: present, **used** by frozen pose pipeline
- LiveLocationKalman: present in 92 segments, **not used** for projection
- LiveCalibration: present in 92 segments, **not applied** (Stage 12B blocked)
- CameraOdometry: present, not used
- desireState / laneChangeState: in modelV2.meta, decoded, not used in geometry

## Major ambiguity classes

- **classification_vs_physical_divider:** modelV2 lane lines include road markings, edges, and phantom lines — laneLineProbs vary widely
- **lateral_order_instability:** Line index order crosses between frames when ego moves or model reassigns indices
- **missing_partial_lines:** Frames with fewer than 4 raw lines or gaps in continuity
- **lane_change_and_desire:** meta.laneChangeState and desireState active during manoeuvres
- **edge_line_disagreement:** Outermost lane lines beyond road-edge bounds or inconsistent with v11 fused edges
- **multi_pass_and_pose_fragmentation:** Same physical road traversed multiple times or pose-section gaps break continuity
- **low_confidence_outer_lines:** uncertain_outer_lines and unclassifiable observations

## Feasibility

Same-direction lane counting is **feasible in principle** where continuous, high-confidence divider
evidence exists, but requires a separate pipeline with explicit unknown handling.
Without camera imagery (Stage 12B blocked), physical-road accuracy cannot be validated.

## v11 production geometry

**Confirmed unchanged.** Stage 15 tooling is read-only.

## Tests

- Deliverable consistency: **passed**
- Accounting invariants: **passed**
- Stage 15A invariant tests cover availability sum, reason sum, classification reconstruction, and road-edge subtotals
- Full suite: **200/200** passed at approval