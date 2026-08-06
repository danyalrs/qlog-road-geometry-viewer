# Amendment A — Supported Runs v1 Schema

**Status:** DRAFT — NOT APPROVED  
**Schema identifier:** `2026-07-28-lane-divider-supported-runs-v1`  
**Specification version:** `stage20-amendment-a-spec-v3` (scope correction)  
**Artifact filename:** `lane_divider_supported_runs_v1.json`  
**Parent specification:** [stage20-amendment-a-specification.md](./stage20-amendment-a-specification.md)

---

## 1. Artifact envelope

### 1.1 Root object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | string | **yes** | Constant: `2026-07-28-lane-divider-supported-runs-v1` |
| `processingVersion` | string | **yes** | Stage 17B emission version tag (see §1.2) |
| `frozenBaselineVersion` | string | **yes** | `2026-07-24-fusion-v11` |
| `stage16InputChecksum` | string | **yes** | SHA-256 of Stage 16 input artifact |
| `tracksInputChecksum` | string | **yes** | SHA-256 of `lane_divider_tracks_v0.json` or successor track artifact |
| `supportedRunCount` | integer | **yes** | `supportedRuns.length` |
| `gapCount` | integer | **yes** | `gaps.length` |
| `contentHashSha256` | string | **yes** | Hash of canonical serialized `supportedRuns` + `gaps` arrays (see §6) |
| `supportedRuns` | array | **yes** | Sorted by `dividerRunId` ascending |
| `gaps` | array | **yes** | Sorted by `gapId` ascending |
| `provenance` | object | **yes** | Build metadata (see §1.3) |

### 1.2 Processing version

| Value | Meaning |
|-------|---------|
| `2026-07-24-lane-divider-tracking-v0` | Legacy v0 emission (no boundary fields on runs) |
| `2026-07-28-lane-divider-supported-runs-v1` | Amendment A normative emission |

v0 and v1 processing versions MUST NOT be mixed within a single artifact file.

### 1.3 Envelope provenance object

```json
{
  "pipelineStage": "stage17_supported_run_fusion",
  "amendment": "stage20_amendment_a",
  "createdAt": "ISO-8601 UTC",
  "normativePropagationPoint": "flushRun",
  "sourceTrackArtifact": "lane_divider_tracks_v0.json"
}
```

---

## 2. Supported run record (`supportedRuns[]`)

### 2.1 Field definitions

| Field | Type | Required | Nullable | Source | FK / invariant |
|-------|------|----------|----------|--------|----------------|
| `schemaVersion` | string | yes | no | Constant per record | `2026-07-28-lane-divider-supported-runs-v1` |
| `dividerRunId` | string | yes | no | `flushRun()` | `{parentTrackId}:run:{n}`; unique within artifact |
| `parentTrackId` | string | yes | no | Parent track | FK → `tracks[].trackId` |
| `segmentId` | integer | yes | no | Parent track + member validation | See §2.2 |
| `chunkId` | integer | yes | no | Parent track `chunkId` | Segment-local; MUST equal parent track |
| `temporalPassId` | integer | yes | no | Parent track `temporalPassId` | MUST equal parent track |
| `poseSectionId` | integer | yes | no | Parent track `poseSectionId` | Pass-local scope |
| `trackIndex` | integer | yes | no | Parent track `trackIndex` | Boundary-group-local |
| `dividerCorridorId` | string | yes | no | `flushRun()` | Within-segment comparison key; see §2.3 |
| `routeSStart` | number | yes | no | Member observations | Finite, ≤ `routeSEnd` |
| `routeSEnd` | number | yes | no | Member observations | Finite, ≥ `routeSStart` |
| `routeSpanM` | number | yes | no | Derived | `routeSEnd - routeSStart` |
| `representativeRouteD` | array | yes | no | Member points | Unchanged from v0 |
| `observationIds` | string[] | yes | no | Member list | FK → Stage 16 observations |
| `observationCount` | integer | yes | no | Derived | `observationIds.length` |
| `sourceFrameCount` | integer | yes | no | Derived | Distinct frame count |
| `supportDensity` | number | yes | no | Derived | Unchanged from v0 |
| `confidenceSummary` | object | yes | no | Derived | `{ mean: number }` |
| `uncertaintySummary` | object | yes | no | Derived | `{ mean: number }` |
| `precedingGapId` | string | no | yes | Gap linkage | FK → `gaps[].gapId` |
| `followingGapId` | string | no | yes | Gap linkage | FK → `gaps[].gapId` |
| `interpolationMetadata` | object | yes | no | Policy | `permitted` MUST be `false` for cross-pass eligibility |
| `boundaryProvenance` | object | yes | no | `flushRun()` | See §2.4 |
| `provenance` | object | yes | no | `flushRun()` | `{ pipelineStage, createdAt }` |

**Not on supported run record:** `roadCorridorId` — assigned only on corridor linkage records (§10).

### 2.2 `segmentId` authority rule

Tracks carry `segmentIds: integer[]`. Supported runs carry a **singular** `segmentId`.

At `flushRun()`:

1. Collect `segmentId` from each member observation.
2. **Reject** if member segmentIds differ → `A-MEM-004`.
3. Set `run.segmentId` to shared value.
4. **Reject** if `run.segmentId ∉ parentTrack.segmentIds` → `A-PTR-003`.

### 2.3 `trackIndex` and `dividerCorridorId`

| Field | Rule |
|-------|------|
| `trackIndex` | Copied from parent track at `flushRun()` |
| `dividerCorridorId` | `` `${chunkId}:${poseSectionId}:${trackIndex}` `` at `flushRun()` |
| Semantics | **Within-segment comparison key** — not corridor identity |
| Valid comparison scope | Both runs MUST share `segmentId` for comparison-key equality |
| Cross-pass promotion | Requires validated corridor linkage record (§10) — key equality alone insufficient |
| Cross-segment | Equal key text across different `segmentId` = key collision only |

### 2.4 `boundaryProvenance` object

```json
{
  "source": "parent_track",
  "parentTrackId": "<string>",
  "trackChunkId": "<integer>",
  "trackTemporalPassId": "<integer>",
  "trackPoseSectionId": "<integer>",
  "trackIndex": "<integer>",
  "dividerCorridorId": "<chunkId:poseSectionId:trackIndex>",
  "memberSegmentId": "<integer>",
  "trackSegmentIds": "<integer[] snapshot>",
  "comparisonKeyScope": "within_segment",
  "copiedAt": "ISO-8601 UTC",
  "propagationPoint": "flushRun"
}
```

---

## 3. Gap record (`gaps[]`)

Unchanged from v2. Gaps do not carry boundary IDs or comparison keys.

---

## 4. Foreign-key graph

```
projected_lane_observations_v0.json
        │
        ▼
lane_divider_tracks_v0.json
        │
        ▼  flushRun() [Amendment A — normative propagation]
lane_divider_supported_runs_v1.json
  run.dividerCorridorId = within-segment comparison key
  run.parentTrackId → track (pass-local FK)
        │
        ▼  Stage 20 evidence layer [not Amendment A implementation]
lane_divider_corridor_linkage_v0.json
  corridorLinkageId, roadCorridorId, endpoints[]
        │
        ▼
cross-pass evaluation (structural / provisional / genuine)
```

---

## 5–8. Validation, serialization, compatibility, immutability

Unchanged from v2 except:

- Cross-pass consumers MUST NOT promote on `dividerCorridorId` equality alone
- `roadCorridorId` consumed from linkage artifact only

---

## 9. Example supported run record

```json
{
  "schemaVersion": "2026-07-28-lane-divider-supported-runs-v1",
  "dividerRunId": "0:0:0:0:run:0",
  "parentTrackId": "0:0:0:0",
  "segmentId": 0,
  "chunkId": 0,
  "temporalPassId": 0,
  "poseSectionId": 0,
  "trackIndex": 0,
  "dividerCorridorId": "0:0:0",
  "routeSStart": 0,
  "routeSEnd": 89.1,
  "boundaryProvenance": {
    "source": "parent_track",
    "comparisonKeyScope": "within_segment",
    "propagationPoint": "flushRun"
  }
}
```

---

## 10. Corridor linkage artifact (draft — Stage 20)

**Filename:** `lane_divider_corridor_linkage_v0.json`  
**Schema ID:** `2026-07-28-lane-divider-corridor-linkage-v0`

### 10.1 Envelope

| Field | Type | Required |
|-------|------|----------|
| `schemaVersion` | string | yes |
| `linkageRecordCount` | integer | yes |
| `contentHashSha256` | string | yes |
| `linkageRecords` | array | yes |
| `provenance` | object | yes |

### 10.2 Linkage record

| Field | Type | Required |
|-------|------|----------|
| `corridorLinkageId` | string | yes |
| `roadCorridorId` | string | yes |
| `linkageType` | `same_segment` \| `cross_segment` | yes |
| `segmentId` | integer | when `same_segment` |
| `endpoints` | array[2] | yes |
| `crossSegmentAlignment` | object | when `cross_segment` and structural promotion |
| `evidenceSource` | string | yes |
| `evidenceInputs` | object | yes |
| `provenance` | object | yes |
| `confidence` | number | yes |
| `validationState` | `pending` \| `validated` \| `rejected` \| `conflict` | yes |
| `validationReason` | string | when not `validated` |

### 10.3 Endpoint

| Field | Type | Required |
|-------|------|----------|
| `parentTrackId` | string | yes |
| `dividerRunId` | string | yes |
| `segmentId` | integer | yes |
| `chunkId` | integer | yes |
| `temporalPassId` | integer | yes |
| `poseSectionId` | integer | yes |
| `trackIndex` | integer | yes |
| `dividerCorridorId` | string | yes |
| `poseSectionRef` | string | yes — `{segmentId}:{chunkId}:{temporalPassId}:{poseSectionId}` |

### 10.4 Cross-segment alignment (nested)

| Field | Type | Required |
|-------|------|----------|
| `alignmentId` | string | yes |
| `segmentIds` | [integer, integer] | yes |
| `routeSCorridorMapping` | object | yes |
| `validationState` | string | yes — must be `validated` for structural |
| `provenance` | object | yes |

### 10.5 Linkage error codes

| Code | Condition |
|------|-----------|
| `A-LNK-001` | Duplicate `corridorLinkageId` |
| `A-LNK-002` | Conflicting `roadCorridorId` for same endpoints |
| `A-LNK-003` | Endpoint not in supported runs v1 |
| `A-LNK-004` | Endpoint FK mismatch |
| `A-LNK-005` | Missing provenance |
| `A-LNK-006` | Cross-segment validated without alignment |
| `A-LNK-007` | Geometry-only validation claim |

---

*Schema draft v3 — not approved for implementation.*
