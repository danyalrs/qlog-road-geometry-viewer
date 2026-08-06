# Stage 15 — Lane-Counting Design

**Schema version:** `2026-07-24-lane-count-v0`
**Road-surface context:** `2026-07-24-fusion-v11` (frozen)

## Problem definition

**Initial target:** Estimate the number of same-direction drivable lanes supported by continuous modelV2 lane-divider evidence within each valid route interval.

### Terminology
- **visibleLaneLines:** Raw modelV2 lane line detections per frame (typically up to 4). Not equivalent to physical dividers.
- **laneIntervals:** Regions between ordered neighbouring divider hypotheses. N dividers yield at most N−1 intervals.
- **drivableLanes:** Lane intervals wide enough and temporally supported to be traversable in the same travel direction.
- **sameDirectionLaneCount:** Number of drivable lanes in the ego travel direction only.
- **totalLanesBothDirections:** Requires centre-divider or opposing-flow classification — not inferable from road width alone.

### Must remain unknown

- junctions
- merges and splits
- opposing traffic without centre-divider classification
- missing or low-confidence lane lines
- lane changes
- short or fragmented evidence
- inconsistent temporal observations

## Candidate pipeline

Pipeline: `lane-divider-pipeline-v0` — outputs **separate** from frozen road-surface polygons.

1. **decode_lane_line_observations** — reuse: qlog_parse_once.modelV2ToJson
2. **filter_probability_uncertainty** — reuse: new — empirical thresholds from Stage 15 distributions
3. **associate_temporal_pass_pose_section** — reuse: passes.js, pose_continuity.js
4. **project_route_coordinates** — reuse: frozen GPS pose model (interpolateGpsAtTime)
5. **track_divider_hypotheses** — reuse: lane_tracking.js patterns (separate track IDs)
6. **fuse_supported_observations** — reuse: sd_fusion patterns (separate outputs)
7. **reject_unsupported_gaps** — reuse: supported-run logic patterns
8. **order_dividers_laterally** — reuse: lane_tracking rankLanesByLateral
9. **form_lane_intervals** — reuse: new
10. **estimate_lane_count** — reuse: new — only where temporal support sufficient
11. **attach_confidence_provenance** — reuse: geometry_provenance patterns
12. **compare_v11_road_surface** — reuse: read-only v11 polygon bounds

## Output schema (v0)

```json
{
  "schemaVersion": "2026-07-24-lane-count-v0",
  "roadSurfaceBaselineVersion": "2026-07-24-fusion-v11",
  "processingVersion": null,
  "segmentId": null,
  "chunkId": null,
  "temporalPassId": null,
  "poseSectionId": null,
  "routeInterval": {
    "sStartM": null,
    "sEndM": null
  },
  "sameDirectionLaneCount": "unknown",
  "confidence": null,
  "supportingDividerIds": [],
  "boundaryTypes": [],
  "meanLaneWidthsM": [],
  "sourceFrameCount": 0,
  "uncertainty": {
    "laneLineStdMedian": null,
    "temporalAgreement": null
  },
  "rejectionOrUnknownReason": null,
  "linkedV11PolygonIds": [],
  "provenance": {
    "pipelineStage": null,
    "createdAt": null,
    "notes": null
  }
}
```

### Unknown reasons

- `junction`
- `merge_or_split`
- `opposing_traffic_undivided`
- `missing_lane_lines`
- `low_confidence_lane_lines`
- `excessive_uncertainty`
- `lane_change_in_progress`
- `short_fragmented_evidence`
- `inconsistent_temporal_observations`
- `crossing_or_inconsistent_lines`
- `multi_pass_ambiguity`
- `pose_section_gap`
- `insufficient_temporal_support`
- `divider_order_ambiguous`
- `inconclusive_without_camera_imagery`

## Threshold policy

No production thresholds selected in Stage 15

### Candidates (not selected)

- `minLaneLineProb` = 0.5 — Fraction of raw lane-line observations that pass probability filter
- `minLaneLineProb` = 0.6 — Fraction of raw lane-line observations that pass probability filter
- `minLaneLineProb` = 0.7 — Fraction of raw lane-line observations that pass probability filter
- `minLaneLineProb` = 0.75 — Fraction of raw lane-line observations that pass probability filter
- `minLaneLineProb` = 0.8 — Fraction of raw lane-line observations that pass probability filter
- `minLaneLineProb` = 0.9 — Fraction of raw lane-line observations that pass probability filter
- `maxLaneLineStdM` = 0.1 — Approximate — lines with spatial std below threshold
- `maxLaneLineStdM` = 0.2 — Approximate — lines with spatial std below threshold
- `maxLaneLineStdM` = 0.3 — Approximate — lines with spatial std below threshold
- `maxLaneLineStdM` = 0.4 — Approximate — lines with spatial std below threshold
- `maxLaneLineStdM` = 0.5 — Approximate — lines with spatial std below threshold
- `minTemporalSupportFrames` = [3,5,8,12] — Requires implementation — mean modelV2 frames per segment ~25; ~0.5 Hz

## Validation plan

### Internal consistency
Status: defined

- divider ordering is monotonic left-to-right without unexplained crossings
- lane widths within realistic bounds (typically 2.8–4.0 m per lane)
- temporal stability of divider tracks across consecutive frames
- lane intervals fit within v11 road-surface polygon lateral bounds
- gaps between supported divider runs are explicit, not bridged silently

### BEV evidence consistency
Status: defined

- projected lane-line observations align with fused divider runs
- gaps remain explicit in BEV overlay
- estimated lane count matches number of supported lane intervals
- comparison with v11 fused road edges where available

### Camera validation
Status: BLOCKED

- lane divider visibility in front-camera frames
- physical road marking alignment
- junction and merge behaviour verification

## Recommended implementation stages

### Stage 15 (approved)

Read-only lane-divider evidence assessment and lane-counting design

- **Permitted:** read-only audit tooling; reports; tests
- **Frozen:** 2026-07-24-fusion-v11
- **Deliverables:** assessment report; design report; audit JSON
- **Approval criteria:** signal inventory complete; accounting invariants pass; design schema with unknown default

### Stage 15A (approved)

Ego-boundary classification validation audit

- **Permitted:** stage15a_classification_audit.js; fixture tests
- **Frozen:** 2026-07-24-fusion-v11
- **Deliverables:** corrected ego selection; dual accounting dimensions; road-edge denominators
- **Approval criteria:** 4,381 classifications reconcile; availability and reason sums = 2,761

### Stage 16 (not_started)

Projected lane-line observation prototype (decode + probability/uncertainty filter)

- **Permitted:** new lane-divider observation module; assessment thresholds only — not v11
- **Frozen:** 2026-07-24-fusion-v11, passes.js, pose_continuity.js
- **Deliverables:** per-frame observation records; filter sensitivity report
- **Approval criteria:** observations tagged with pass/section; explicit unknown on filter failure
- **Blockers:** Stage 15 approval required before start

### Stage 17 (not_started)

Temporal divider association and supported-run fusion

- **Permitted:** divider tracking module; separate output files from v11 polygons
- **Frozen:** 2026-07-24-fusion-v11, lane_tracking.js patterns
- **Deliverables:** divider track IDs; supported runs; explicit gap markers
- **Approval criteria:** gaps never silently bridged; no writes to v11 polygon outputs
- **Blockers:** Stage 16 completion

### Stage 18 (not_started)

Lane-interval formation and same-direction count prototype with unknown-state policy

- **Permitted:** interval builder; count estimator returning unknown by default
- **Frozen:** 2026-07-24-fusion-v11
- **Deliverables:** lane-count v0 records; structured rejection reasons
- **Approval criteria:** schema compliance; junction/merge/lane-change → unknown
- **Blockers:** Stage 17 completion

### Stage 19 (not_started)

Dataset-wide threshold sensitivity and BEV evidence audit

- **Permitted:** sensitivity sweeps; BEV overlay tooling; read-only v11 comparison
- **Frozen:** 2026-07-24-fusion-v11
- **Deliverables:** threshold sensitivity tables; BEV consistency report
- **Approval criteria:** no production threshold selected; BEV layer A+B checks pass
- **Blockers:** Stage 18 completion

### Stage 20 (blocked)

Camera and physical-road validation when HEVC footage and calibration are available

- **Permitted:** camera overlay harness; calibration application (Stage 12B path)
- **Frozen:** 2026-07-24-fusion-v11
- **Deliverables:** camera validation report; physical marking alignment metrics
- **Approval criteria:** matching HEVC available; calibration decode verified
- **Blockers:** Stage 12B blocked; matching HEVC unavailable; calibration not verified

### Stage 12B (blocked)

Camera validation prerequisite for physical accuracy claims

- **Frozen:** 2026-07-24-fusion-v11
- **Deliverables:** calibration decode; HEVC frame matching
- **Approval criteria:** usable calibration; matching camera frames
- **Blockers:** HEVC files unavailable; calibration decode unverified


## Limitations

- Lane counting is **not complete** after Stage 15
- No production thresholds chosen
- Camera validation blocked until HEVC + calibration available
- v11 provides road-surface context only; not a lane-counting system