# Amendment B — Schema Specification

**Status:** DRAFT — NOT APPROVED  
**Specification version:** `stage20-amendment-b-spec-v1`  
**Parent:** [stage20-amendment-b-specification.md](./stage20-amendment-b-specification.md)

Schemas are **specified only**. No production artifacts populated with validated records.

---

## 1. Schema identifiers

| Artifact | `schemaVersion` | `implementationVersion` |
|----------|-----------------|----------------------|
| Motion link audit | `2026-07-28-lane-divider-motion-link-audit-v0` | `stage20-motion-linking-v0` |
| Traversal evidence | `2026-07-28-lane-divider-traversal-evidence-v0` | `stage20-traversal-evidence-v0` |
| Traversal linkage | `2026-07-28-lane-divider-traversal-linkage-v0` | `stage20-traversal-linkage-v0` |
| Traversal evaluation (optional) | `2026-07-28-lane-divider-traversal-evaluation-v0` | `stage20-traversal-evaluation-v0` |

Cross-segment alignment remains on **corridor linkage** records per Amendment A schema §10 — not duplicated here.

---

## 2. `lane_divider_motion_link_audit_v0.json` (B-MOTION)

### 2.1 Envelope

| Field | Type | Required |
|-------|------|----------|
| `schemaVersion` | string | yes |
| `implementationVersion` | string | yes |
| `frozenBaselineVersion` | string | yes — `2026-07-24-fusion-v11` |
| `residualCapM` | number | yes — **null if module disabled** |
| `residualCapApproved` | boolean | yes — **must be false until checkpoint authorizes** |
| `edgeDecisionCount` | integer | yes |
| `contentHashSha256` | string | yes |
| `edgeDecisions` | array | yes — sorted by `edgeId` |
| `provenance` | object | yes |

### 2.2 Edge decision record

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `edgeId` | string | yes | `{observationIdA}|{observationIdB}` sorted |
| `observationIdA` | string | yes | FK → Stage 16 |
| `observationIdB` | string | yes | FK → Stage 16 |
| `segmentId` | integer | yes | |
| `chunkId` | integer | yes | |
| `temporalPassId` | integer | yes | |
| `poseSectionId` | integer | yes | |
| `logMonoTimeA` | string | yes | ns |
| `logMonoTimeB` | string | yes | ns |
| `deltaTimeS` | number | yes | seconds |
| `euclideanHiDistanceM` | number | yes | metres |
| `poseDisplacementM` | number | yes | metres |
| `residualM` | number | yes | metres |
| `routeSGapM` | number | yes | metres |
| `speedMps` | number | no | m/s at A |
| `headingDiffDeg` | number | yes | degrees |
| `decision` | string | yes | `accepted` \| `rejected` |
| `rejectionCode` | string | when rejected | `B-MOT-*` |
| `movementState` | string | no | copy if available |

### 2.3 B-MOTION rejection codes

| Code | Condition |
|------|-----------|
| `B-MOT-010` | Stage 17 gap intersection |
| `B-MOT-011` | Different chunkId |
| `B-MOT-012` | Different poseSectionId |
| `B-MOT-013` | Different temporalPassId |
| `B-MOT-014` | Different segmentId |
| `B-MOT-015` | Negative Δt |
| `B-MOT-016` | Interpolation permitted on run |
| `B-MOT-020` | Missing pose |
| `B-MOT-021` | Pose inconsistency |
| `B-MOT-022` | Implausible speed |
| `B-MOT-030` | Residual exceeds cap |
| `B-MOT-031` | Duplicate edgeId |

---

## 3. `lane_divider_traversal_evidence_v0.json` (B-TRAV)

### 3.1 Envelope

| Field | Type | Required |
|-------|------|----------|
| `schemaVersion` | string | yes |
| `implementationVersion` | string | yes |
| `supportedRunsInputChecksum` | string | yes — SHA-256 of v1 artifact content hash |
| `evidenceRecordCount` | integer | yes |
| `contentHashSha256` | string | yes |
| `evidenceRecords` | array | yes — sorted by `traversalEvidenceId` |
| `provenance` | object | yes |

### 3.2 Evidence record

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `traversalEvidenceId` | string | yes | `tev:{corridorLinkageId}:{sortedDividerRunIds}` |
| `corridorLinkageId` | string | no | FK when corridor exists — hypothesis records omit |
| `linkageType` | string | yes | `same_segment` \| `cross_segment` |
| `segmentId` | integer | when same_segment | |
| `endpoints` | array[2] | yes | Scoped endpoint refs (mirror corridor linkage) |
| `timeRange` | object | yes | `{ startLogMonoTime, endLogMonoTime }` — ns strings |
| `routeSRange` | object | yes | `{ startM, endM }` per endpoint in local section scope |
| `directionOfTravel` | object | yes | `{ headingDegA, headingDegB, deltaHeadingDeg, consistent: boolean }` |
| `movementEvidence` | object | yes | See §3.3 |
| `sourceObservationRefs` | string[] | yes | Stage 16 observationIds used |
| `evidenceSource` | string | yes | Human/process identifier — not `geometry_inference` |
| `provenance` | object | yes | `createdAt`, `validatorVersion`, `inputChecksums[]` |
| `confidence` | number | yes | 0–1 |
| `validationState` | string | yes | `pending` \| `validated` \| `rejected` \| `conflict` |
| `validationReason` | string | when not validated | |
| `rejectionCode` | string | when rejected | `B-TRV-*` |

### 3.3 `movementEvidence` object

| Field | Type | Required |
|-------|------|----------|
| `poseDisplacementM` | number | yes |
| `medianSpeedMps` | number | yes |
| `stationaryFraction` | number | yes — 0–1 |
| `impliedSpeedMps` | number | yes |
| `routeSProgressM` | number | yes |
| `movementStateSummary` | string | yes — `moving` \| `stationary` \| `mixed` |
| `gpsAccuracyM` | number | no |

**Rule:** `stationaryFraction > 0.95` → reject `B-TRV-031` for validated state.

### 3.4 Endpoint reference (scoped)

Same fields as Amendment A corridor linkage endpoint (§10.3 of amendment-a-schema):

`parentTrackId`, `dividerRunId`, `segmentId`, `chunkId`, `temporalPassId`, `poseSectionId`, `trackIndex`, `dividerCorridorId`, `poseSectionRef`

---

## 4. `lane_divider_traversal_linkage_v0.json` (B-TRAV)

### 4.1 Envelope

| Field | Type | Required |
|-------|------|----------|
| `schemaVersion` | string | yes |
| `implementationVersion` | string | yes |
| `linkageRecordCount` | integer | yes |
| `contentHashSha256` | string | yes |
| `linkageRecords` | array | yes — sorted by `traversalLinkageId` |
| `provenance` | object | yes |

### 4.2 Linkage record

| Field | Type | Required |
|-------|------|----------|
| `traversalLinkageId` | string | yes — `tlink:{corridorLinkageId}:{sortedParentTrackIds}` |
| `corridorLinkageId` | string | yes — FK → corridor linkage |
| `roadCorridorId` | string | yes — copied from corridor record |
| `traversalEvidenceId` | string | yes — FK → evidence record |
| `endpoints` | array[2] | yes |
| `corridorLinkageValidationState` | string | yes — must be `validated` for validated traversal |
| `evidenceSource` | string | yes |
| `provenance` | object | yes |
| `confidence` | number | yes |
| `validationState` | string | yes |
| `validationReason` | string | when not validated |

### 4.3 Duplicate and conflict handling

| Case | Code | Fate |
|------|------|------|
| Duplicate `traversalLinkageId` | `B-TRV-004` | Reject artifact |
| Same endpoint pair, reversed | `B-TRV-005` | Reject duplicate |
| Conflicting `traversalEvidenceId` for same pair | `B-TRV-038` | `validationState: conflict` |
| Endpoint FK mismatch | `B-TRV-002` | Reject record |
| Missing corridor FK | `B-TRV-020` | Reject record |
| Corridor not validated | `B-TRV-021` | Provisional only |
| Missing provenance | `B-TRV-037` | Reject record |

---

## 5. `lane_divider_traversal_evaluation_v0.json` (optional audit)

Pairwise evaluation log consumed by Amendment A cross-pass state machine.

| Field | Type | Required |
|-------|------|----------|
| `schemaVersion` | string | yes |
| `evaluationCount` | integer | yes |
| `evaluations` | array | yes — sorted by `pairKey` |
| `contentHashSha256` | string | yes |

### Evaluation record

| Field | Type |
|-------|------|
| `pairKey` | string — sorted `dividerRunId` pair |
| `dividerRunIdA`, `dividerRunIdB` | string |
| `amendmentAState` | string — from `CROSS_PASS_STATES` |
| `amendmentACode` | string — `A-XPS-*` |
| `traversalLinkageId` | string \| null |
| `corridorLinkageId` | string \| null |
| `bTravRejectionCode` | string \| null |
| `finalClassification` | `genuine` \| `structural` \| `provisional` \| `hypothesis` \| `unavailable` |

---

## 6. Serialization rules

1. Sort object keys recursively (canonical JSON)
2. Exclude from content hash: `provenance.createdAt`, endpoint `copiedAt` if present
3. `edgeDecisions` sorted by `edgeId`
4. `evidenceRecords` sorted by `traversalEvidenceId`
5. `linkageRecords` sorted by `traversalLinkageId`
6. Endpoint pairs ordered by `parentTrackId` ascending within each record

---

## 7. Foreign-key graph (B-TRAV)

```
lane_divider_supported_runs_v1.json
        │
        ├──────────────────────────────────────┐
        ▼                                      ▼
lane_divider_corridor_linkage_v0.json   lane_divider_traversal_evidence_v0.json
        │                                      │
        └──────────────┬───────────────────────┘
                       ▼
        lane_divider_traversal_linkage_v0.json
                       │
                       ▼
        Amendment A evaluateCrossPassPair(traversalLinkageByPair)
```

**No automatic edges** from geometry, route-s overlap, or `dividerCorridorId` text equality.

---

## 8. Example records (synthetic fixtures only — NOT production)

### 8.1 Traversal evidence (hypothesis — not validated)

```json
{
  "traversalEvidenceId": "tev:pending:0:0:4:0:run:0|0:1:4:0:run:0",
  "linkageType": "same_segment",
  "segmentId": 10,
  "validationState": "pending",
  "evidenceSource": "fixture_fx_b_001",
  "provenance": { "createdAt": "2026-07-28T00:00:00.000Z", "validatorVersion": "fixture-v0" }
}
```

### 8.2 Validated traversal linkage (requires validated corridor FK)

```json
{
  "traversalLinkageId": "tlink:link:corridor:test:0:0:4:0:0:1:4:0",
  "corridorLinkageId": "link:corridor:test:0:0:4:0:0:1:4:0",
  "roadCorridorId": "corridor:test",
  "validationState": "validated",
  "corridorLinkageValidationState": "validated"
}
```

---

*Schema draft v1 — not approved for implementation.*
