# Stage 20 — Metadata Field Provenance

**Generated:** 2026-07-28  
**Mode:** Read-only design investigation  
**Scope:** Stages 15–19 and upstream v11 frame context

---

## Summary

| Field | First authoritative source | Persisted through Stage 17 runs? | Available to Stage 19 cross-pass? |
|-------|---------------------------|----------------------------------|-----------------------------------|
| `temporalPassId` | v11 frame / Stage 16 observation | **No** — tracks only | **No** — dropped on `supportedRuns` |
| `chunkId` | v11 chunk / Stage 16 observation | **No** | **No** |
| `poseSectionId` | pose continuity / Stage 16 observation | **No** | **No** |
| `parentTrackId` | Stage 17 track fusion | **Yes** | **Yes** |
| `comparisonSpatialFrameId` | Stage 19 match builder (synthesized) | N/A | N/A |
| `featurePairId` | Stage 19 (from trackId or observationId) | N/A | N/A |
| `evidenceUnitKey` | Stage 19 (`chunkId:temporalPassId`) | N/A | Requires both fields |
| `routeS` | Stage 16 projected points → match `sLoUm`/`sHiUm` | Partial (`routeSStart`/`routeSEnd` on runs) | Yes |
| `logMonoTime` | qlog model event | Via `observationIds` on runs | Yes (via observation FK) |
| `speed` | GPS interpolation → `poseRecord.speed` | **No** on runs | Via observation lookup only |
| `heading` | GPS pose → match `headingDegLo`/`tangentLoDeg` | **No** on runs | Via match records |

**Earliest correct propagation point:** Stage 17B `fuseTrackSupportedRuns()` → `flushRun()` in `lib/stage17_supported_run_fusion.js`. Copy `chunkId`, `temporalPassId`, `poseSectionId` from parent track at run creation.

---

## Stage-by-Stage Provenance Table

### Upstream (pre-Stage 15): v11 route processing

| Field | Authoritative input | Source schema | Transformation | Output | Retained? |
|-------|---------------------|---------------|----------------|--------|-----------|
| `chunkId` | `routeChunks[].chunkId` | `process_route.js` output | Assigned to frames | `frame.chunkId` | Yes until Stage 16 |
| `temporalPassId` | Pass detection (Stage 8) | `frame.passId` / `frame.temporalPassId` | Movement-aware pass split | Frame annotation | Yes until Stage 16 |
| `poseSectionId` | Pose continuity (Stage 9) | `lib/pose_continuity.js` | Section split on discontinuity | Frame annotation | Yes until Stage 16 |
| `logMonoTime` | qlog event | Cap'n Proto | Copied | Model/GPS event timestamp | Yes |
| `speed` | GPS record | `gps_validate.js` | Interpolation at model time | `poseRecord.speed` | Per observation |
| `heading` | GPS bearing | `alignment.js` | Interpolation | `poseRecord.headingDeg` | Per observation |

**Dropped:** None at this stage for boundary IDs.

---

### Stage 15 — design (read-only)

| Field | Input | Output | Notes |
|-------|-------|--------|-------|
| All boundary IDs | Documented in pipeline design | Template placeholders in `buildLaneCountRecordTemplate()` | `null` defaults; no artifact emission |
| `confidence` | modelV2 probs | Distribution stats | Threshold policy design only |

**Identity change:** None — design stage only.

---

### Stage 16 — lane-line projection

| Field | Authoritative input | Source schema | Transformation | Output schema | Retained? |
|-------|---------------------|---------------|----------------|---------------|-----------|
| `chunkId` | Frame `chunkId` | v11 frame index | Copied to observation | `projected_lane_observations_v0.json` | **Yes** |
| `temporalPassId` | Frame `passId` / `temporalPassId` | v11 frame | Copied | observation field | **Yes** |
| `poseSectionId` | Frame `poseSectionId` | v11 frame | Copied | observation field | **Yes** |
| `routeS` | Trajectory arc length | `temporal_projection.js` | Per-point `s` | `projectedRoutePoints[].s` | **Yes** |
| lateral (`d`) | Signed lateral | Projection | Per-point `d` | `projectedRoutePoints[].d` | **Yes** |
| `logMonoTime` | model event | qlog | Copied | observation field | **Yes** |
| `speed`, `heading` | GPS pose | Interpolation | `poseRecord` object | observation field | **Yes** |
| `confidence` | `laneLineProbs[slot]` | modelV2 | Assessment gates | `laneLineProb` | **Yes** |

**Observation ID format:** `{segmentId}:{chunkId}:{logMonoTime}:{sourceSlotIndex}`  
**FK:** observation → segment, chunk, pass, section via explicit fields  
**Validation:** `projectionStatus === 'projected'` requires finite geometry, confidence ≥ 0.5, pass/section present for association  
**Nullability:** Rejected observations may have `null` chunkId  
**Serialization:** `projected_lane_observations_v0.json`, schema `2026-07-24-lane-projection-v0`

---

### Stage 17A — divider association

| Field | Input | Transformation | Output | Identity |
|-------|-------|----------------|--------|----------|
| `chunkId`, `temporalPassId`, `poseSectionId` | Stage 16 observation | `boundaryKey()` grouping; association gate | **Track record** | **Retained on tracks** |
| `parentTrackId` | — | Assigned as `trackId` | `{chunk}:{pass}:{section}:{idx}` | **Created** |
| `routeS` | Point `s` min/max | Aggregated | `track.sMin`/`sMax` | Transformed |
| `heading` | `poseRecord.headingDeg` | Cost term | `track.headingDeg` | Aggregated |
| `confidence` | `laneLineProb` | Gate + mean | `track.confidence` | Rolled up |
| delta time | `logMonoTime` | `timeGapSec()` cost | Ephemeral | **Dropped** |
| route-s displacement | `sMin`/`sMax` | `routeSGapM` cost | Ephemeral | **Dropped** |

**FK:** `trackId` embeds chunk:pass:section:index — **embedding, not a substitute for explicit fields on downstream artifacts**  
**Validation:** Cross-chunk association forbidden; `maxTimeGapSec` 4.0; `maxRouteSGapM` 35; `maxHeadingDiffDeg` 25°

---

### Stage 17B — supported-run fusion

| Field | Input | Transformation | Output | Identity |
|-------|-------|----------------|--------|----------|
| `parentTrackId` | `track.trackId` | Set on run/gap | `supportedRuns[].parentTrackId` | **Retained** |
| `chunkId`, `temporalPassId`, `poseSectionId` | Parent track | **Not copied** | **Dropped** | **Lost on persist** |
| `routeS` | Observation points | Min/max span | `routeSStart`/`routeSEnd` | Retained |
| `observationIds` | Track members | Listed | FK array on run | Retained |
| `confidence` | Per-obs mean | Rolled up | `confidenceSummary.mean` | Transformed |

**Output schema:** `lane_divider_supported_runs_v0.json` — `buildSupportedRunTemplate()` has no boundary ID fields  
**Backward-compatibility risk:** Stage 19 cross-pass reads `run.temporalPassId` directly → always `undefined` on 878/878 runs  
**Stage 18 workaround:** `stage18_run_eligibility.js` re-joins track fields into in-memory `enriched` only — not persisted

---

### Stage 18 — lane intervals

| Field | Input | Transformation | Output |
|-------|-------|----------------|--------|
| `chunkId`, `temporalPassId`, `poseSectionId` | Parent track via enrichment | Copied to intervals | `laneIntervals[]` |
| `parentTrackId` | Run | Left/right FK | Interval record |
| `routeS` | Run overlap | Interval bounds | `routeSStart`/`routeSEnd` |
| `confidence` | Run summaries | Mean | `confidenceSummary` |

**Dropped after Stage 18:** Enrichment is in-memory; persisted interval JSON carries boundary IDs from group key parsing.

---

### Stage 19 — partition and cross-pass

| Field | Input | Transformation | Output |
|-------|-------|----------------|--------|
| `comparisonSpatialFrameId` | Observation boundary IDs | Synthesized `${chunk}:{pass}:{section}` | Match record |
| `featurePairId` | `trackId` or `observationId` | Assigned | Match / cross-pass / BEV FK hub |
| `evidenceUnitKey` | chunk + pass | `${chunkId}:${temporalPassId}` | Match record |
| `temporalPassId` | Observation | `temporalPassIdLo/Hi` strings | Canonical hash input |
| Cross-pass grouping | `supportedRun.temporalPassId` | Pass groups per parent | **Fails — field absent on runs** |

**Static linking:** `staticBranchCandidateEdge()` uses euclidean hi jump ≤ 12 m — does not use speed or pose displacement.

---

## `parentTrackId` Parsing — Legacy Fallback Only (Not Normative)

**Format:** `{chunkId}:{temporalPassId}:{poseSectionId}:{trackIndex}`

| Property | Limitation |
|----------|------------|
| Coverage | 0 parent prefixes span multiple passes on tracks in current dataset |
| Ambiguity | Index component is track ordinal, not evidence identity |
| Rejection rule | Must not be used for cross-pass grouping without explicit `temporalPassId` on run |
| Fallback use | Read-only recovery for legacy `lane_divider_supported_runs_v0.json` with validation against parent track FK |

---

## Foreign-Key Relationship Diagram

```
Stage 16 observation
  ├─ chunkId, temporalPassId, poseSectionId (explicit)
  └─ observationId
        ↓
Stage 17 track (explicit boundary IDs)
  └─ trackId (= parentTrackId prefix)
        ↓
Stage 17 supportedRun
  ├─ parentTrackId (explicit)
  └─ chunkId, temporalPassId, poseSectionId (DROPPED)  ← Amendment A target
        ↓
Stage 19 cross-pass
  └─ requires run.temporalPassId (currently undefined)
```

---

## Backward-Compatibility Risks

| Artifact | Risk | Mitigation (Amendment A) |
|----------|------|--------------------------|
| `lane_divider_supported_runs_v0.json` | Missing boundary fields | New `v1` schema; v0 remains immutable |
| Stage 19 v5 bundle | Published without cross-pass | Consume v5 unchanged; new runs use v1 upstream |
| Stage 18 loader | Re-joins track fields | Continue re-join as validation oracle |
| API / viewer | No pass display on runs | Additive fields only |

---

## Evidence Sources

- `lib/stage16_projection_schema.js`, `lib/stage16_lane_line_projection.js`
- `lib/stage17_tracking_schema.js`, `lib/stage17_supported_run_fusion.js`
- `lib/stage18_run_eligibility.js`
- `lib/stage19_match_builder.js`, `lib/stage19_cross_pass_production.js`
- `lane_divider_supported_runs_v0.json` (878 runs, 0 with `temporalPassId`)
- `reports/stage20_design_investigation.json`
