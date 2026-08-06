# Amendment A — Metadata Propagation and Cross-Pass Identity Specification

**Status:** APPROVED — IMPLEMENTED (v3)  
**Version:** `stage20-amendment-a-spec-v3` (scope correction 2026-07-28)  
**Prior versions:**
- `stage20-amendment-a-spec-v1` — withdrawn (same-`parentTrackId` cross-pass contradiction)
- `stage20-amendment-a-spec-v2` — withdrawn (`dividerCorridorId` treated as authoritative corridor identity)

**Date:** 2026-07-28  
**Does not modify:** Stage 19 Revision 37, Stage 19 v5, frozen v11, published bundles, `current.json`

**Supporting documents:**

- [stage20-amendment-a-schema.md](./stage20-amendment-a-schema.md)
- [stage20-amendment-a-test-matrix.md](./stage20-amendment-a-test-matrix.md)
- [stage20-amendment-a-compatibility.md](./stage20-amendment-a-compatibility.md)

**Specification correction (v2 → v3):** `dividerCorridorId` is reclassified as a **within-segment comparison key**, not authoritative corridor identity. Cross-pass promotion requires Stage 20 **corridor linkage records**. Numeric equality of locally scoped components does not prove corridor equivalence. **Not implementation.**

---

## §1 — Problem statement

Stage 19 cross-pass construction requires explicit boundary metadata on `supportedRuns`. v0 omits these fields on all 878 runs. Additionally:

1. **`parentTrackId` is not a corridor identity** — it embeds `temporalPassId`.
2. **`dividerCorridorId` is not a corridor identity** — it is a deterministic within-segment comparison key composed entirely of locally scoped integers.

This specification defines:

1. Normative metadata propagation at Stage 17B `flushRun()`
2. The `dividerCorridorId` comparison key (within-segment scope only)
3. Stage 20 corridor linkage records as the authoritative cross-pass grouping layer
4. Separated evidence states from comparison-key equality through genuine cross-pass evidence

It does **not** address motion-aware linking (Amendment B).

---

## §2 — Identity hierarchy and cardinality

### 2.1 Hierarchy (authoritative)

```
route / session (qlog segment file: segmentId)
  └── route chunk (chunkId — segment-local, lib/chunking.js)
        └── temporal pass (temporalPassId — segment-local, lib/passes.js)
              └── pose section (poseSectionId — pass-local, lib/pose_continuity.js)
                    └── boundary group (chunkId + temporalPassId + poseSectionId)
                          └── divider track instance (parentTrackId / trackId)
                                └── supported run (dividerRunId)
                                      └── observations (observationId)

Stage 20 evidence layer (not yet published):
  └── corridor linkage record (corridorLinkageId, roadCorridorId)
        └── cross-segment alignment record (when segmentId differs)
```

### 2.2 Identifier reference table

| Identifier | Entity | Created | Scope | Uniqueness | Parent | Stable across passes? | Two passes may share? |
|------------|--------|---------|-------|------------|--------|----------------------|----------------------|
| `segmentId` | Qlog route segment | Qlog filename / Stage 16 | Per segment file | Global per file | session | **No** | **No** |
| `chunkId` | Route chunk within segment | `lib/chunking.js` | **Segment-local** | Unique within segment | segmentId | Coincidental numeric equality only | Coincidental only — **not identity** |
| `temporalPassId` | Independent traversal | `lib/passes.js` | **Segment-local** | Unique per pass within segment | segmentId | N/A | **No** |
| `poseSectionId` | Pose-continuous section | `lib/pose_continuity.js` | **Pass-local** within `(chunkId, temporalPassId)` | Unique within pass boundary group | temporalPassId | **No** | **No** — numeric equality is coincidental |
| `trackIndex` | Lateral divider ordinal | Stage 17 `makeTrackId(idx)` | **Boundary-group-local** `(chunkId, temporalPassId, poseSectionId)` | Unique within group | boundary group | **No** | Coincidental only — **not identity** |
| `parentTrackId` | Single track instance | Stage 17 L279 | Pass-local | Global string | boundary group + index | **No** | **No** |
| `dividerCorridorId` | **Within-segment comparison key** | `flushRun()` | **One segment** | Unique per `(segmentId, key text, temporalPassId)` | segment + local tuple | **No** — key text, not corridor | **No** — hypothesis only |
| `roadCorridorId` | **Authoritative corridor identity** | Stage 20 linkage validation | Cross-pass, cross-segment when linked | Globally unique in linkage artifact | corridor linkage record | **Yes** when validated | **Yes** — explicit purpose |
| `dividerRunId` | Supported evidence span | Stage 17B `flushRun()` | One parent track | Global | parentTrackId | **No** | **No** |

### 2.3 Evidence sources

| Conclusion | Evidence |
|------------|----------|
| `parentTrackId` embeds `temporalPassId` | `lib/stage17_divider_association.js` L279 |
| Boundary group = `chunkId:temporalPassId:poseSectionId` | `boundaryKey()` L32–33; schema L110 |
| `poseSectionId` is pass-local | `lib/pose_continuity.js` L3: separated from temporal pass |
| `chunkId` is segment-local | `lib/chunking.js` — `chunkId` resets per segment processing |
| No upstream cross-pass corridor mapping | No artifact field links pose sections across passes; Stage 17 groups forbid cross-pass association |
| Real-data key collisions | Tracks `0:0:4:0` (seg 64) and `0:1:4:0` (seg 57) share key text `0:4:0` — **coincidental, cross-segment** |
| Stage 19 v5 grouping broken | `lib/stage19_cross_pass_production.js` groups by `parentTrackId` |

### 2.4 v1 contradiction (corrected in v2, retained)

Same `parentTrackId` with different `temporalPassId` is impossible. Cross-pass requires **different** `parentTrackId`.

### 2.5 v2 scope error (corrected in v3)

**v2 error (withdrawn):** treated equal `dividerCorridorId` text as **corridor-matched** / authoritative corridor identity.

**Why invalid:** `dividerCorridorId = {chunkId}:{poseSectionId}:{trackIndex}` combines segment-local `chunkId`, pass-local `poseSectionId`, and boundary-group-local `trackIndex`. Equal numeric components across passes or segments are **coincidental** unless an authoritative linkage record validates them.

**Correct model (v3):** Option **A + C** (see §3).

---

## §3 — `dividerCorridorId` semantics

### 3.1 Selected model: **Option A + Option C**

| Option | Verdict | Evidence |
|--------|---------|----------|
| **A** — Within-segment comparison key; requires linkage before cross-pass promotion | **Correct** | All components locally scoped; Stage 17 association is pass-local |
| **B** — Upstream proves matching tuple = same corridor | **Rejected** | No schema field or pipeline stage maps pose sections across passes |
| **C** — Stage 20 must create versioned corridor linkage | **Correct** | No published authoritative cross-pass corridor artifact exists |

### 3.2 `dividerCorridorId` definition

Assigned at `flushRun()`:

```
dividerCorridorId = `${chunkId}:${poseSectionId}:${trackIndex}`
```

| Property | Rule |
|----------|------|
| Semantics | **Within-segment comparison key** — deterministic string for indexing candidate pairs |
| Authoritative source | `track.chunkId`, `track.poseSectionId`, `track.trackIndex` at `flushRun()` |
| Scope | Valid only when `segmentId` is equal on both runs |
| NOT derived from | Geometry overlap, route-s overlap, cross-segment numeric coincidence |
| NOT proof of | Corridor equivalence, shared pose section, shared chunk across segments |
| Collision note | Same key text in different `segmentId` values is a **cross-segment key collision**, not a match |

### 3.3 `roadCorridorId` (authoritative — Stage 20 only)

Assigned only by a **validated corridor linkage record** (§5). Stable across passes and segments when linkage is proved. MUST NOT be copied from `dividerCorridorId` text without linkage provenance.

### 3.4 `parentTrackId` (unchanged)

Pass-local track-instance FK. Not redefined. FK validation not weakened.

---

## §4 — Component scope rules

### 4.1 `segmentId`

| Rule | Detail |
|------|--------|
| Scope | One qlog file |
| Same-pass | Required equal |
| Comparison-key match | Required equal |
| Cross-segment | Key text equality without alignment record → **linkage hypothesis (cross-segment collision)** only |

### 4.2 `chunkId`

| Rule | Detail |
|------|--------|
| Scope | **Segment-local** (`lib/chunking.js`) |
| Within one segment | Both passes processed through same segment chunking — equal `chunkId` means same segment chunk, not cross-segment identity |
| Across segments | **MUST NOT** be compared directly; numeric equality is coincidental |
| Why stable within segment | Chunking runs on the segment frame timeline; both passes inherit segment-local chunk assignments |

### 4.3 `poseSectionId`

| Rule | Detail |
|------|--------|
| Scope | **Pass-local** within `(chunkId, temporalPassId)` |
| Authoritative cross-pass meaning | **None** without corridor linkage record mapping `poseSectionRef` per pass |
| Misclassification guard | Equal `poseSectionId` across passes is **not** shared pose-section identity |

### 4.4 `trackIndex`

| Rule | Detail |
|------|--------|
| Scope | **Boundary-group-local** — ordinal within `(chunkId, temporalPassId, poseSectionId)` |
| Authoritative cross-pass meaning | **None** without linkage record mapping `trackIndex` per pass endpoint |
| Misclassification guard | Equal `trackIndex` across passes is coincidental lateral slot numbering |

### 4.5 Same-segment cross-pass (clarification)

Within one `segmentId`, two runs from different `temporalPassId` values may share equal `dividerCorridorId` text. This establishes a **comparison-key match** only. Promotion to corridor-linked requires a **corridor linkage record** that explicitly maps:

- `segmentId` (shared)
- per-pass `temporalPassId`
- per-pass scoped `chunkId`, `poseSectionId`, `trackIndex`
- per-pass `parentTrackId`
- validated `roadCorridorId`

No pipeline stage currently emits this mapping. **Direct numeric equality is not proof.**

---

## §5 — Corridor linkage records (Stage 20 evidence layer)

Amendment A defines the draft schema; **implementation and publication are Stage 20 scope**, not Amendment A implementation.

### 5.1 Artifact

| Property | Value |
|----------|-------|
| Filename | `lane_divider_corridor_linkage_v0.json` |
| Schema ID | `2026-07-28-lane-divider-corridor-linkage-v0` |
| Created by | Stage 20 evidence layer (not `flushRun()`) |

### 5.2 Corridor linkage record

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `corridorLinkageId` | string | yes | Deterministic: `link:{roadCorridorId}:{endpointA.parentTrackId}:{endpointB.parentTrackId}` sorted |
| `roadCorridorId` | string | yes | Authoritative corridor identity: `corridor:{uuid}` or deterministic hash of validated endpoints |
| `linkageType` | string | yes | `same_segment` \| `cross_segment` |
| `segmentId` | integer | cond. | Required when `linkageType === same_segment` |
| `endpoints` | array[2] | yes | Exactly two endpoint objects (see §5.3) |
| `evidenceSource` | string | yes | e.g. `stage20_corridor_linkage_validator` |
| `evidenceInputs` | object | yes | Non-authoritative supporting signals (route-s overlap, pass detection refs) — **cannot alone create linkage** |
| `provenance` | object | yes | `{ createdAt, validatorVersion, inputChecksums[] }` |
| `confidence` | number | yes | 0.0–1.0; advisory only |
| `validationState` | string | yes | `pending` \| `validated` \| `rejected` \| `conflict` |
| `validationReason` | string | cond. | Required when not `validated` |
| `contentHashSha256` | string | yes | Canonical record hash |

### 5.3 Endpoint object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `parentTrackId` | string | yes | FK → track |
| `dividerRunId` | string | yes | FK → supported run |
| `segmentId` | integer | yes | Segment scope |
| `chunkId` | integer | yes | Segment-local chunk |
| `temporalPassId` | integer | yes | Pass within segment |
| `poseSectionId` | integer | yes | Pass-local section |
| `trackIndex` | integer | yes | Boundary-group-local index |
| `dividerCorridorId` | string | yes | Within-segment comparison key at endpoint |
| `poseSectionRef` | string | yes | Scoped ref: `{segmentId}:{chunkId}:{temporalPassId}:{poseSectionId}` |

### 5.4 Cross-segment corridor alignment record

Required when `linkageType === cross_segment` before structural promotion.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `alignmentId` | string | yes | FK from linkage record |
| `corridorLinkageId` | string | yes | Parent linkage |
| `segmentIds` | [integer, integer] | yes | Ordered pair of distinct segments |
| `routeSCorridorMapping` | object | yes | Deterministic route-s correspondence (not geometry-only) |
| `validationState` | string | yes | `validated` required for structural promotion |
| `provenance` | object | yes | Validator version and input checksums |

Geometry and route-s overlap MAY appear in `evidenceInputs` but **MUST NOT** independently set `validationState: validated`.

### 5.5 Deterministic serialization

Records sorted by `corridorLinkageId` ascending. Endpoint pair ordered by `parentTrackId` ascending. Canonical JSON with sorted keys.

### 5.6 Conflict and duplicate handling

| Case | Fate | Code |
|------|------|------|
| Duplicate `corridorLinkageId` | Reject artifact | `A-LNK-001` |
| Conflicting `roadCorridorId` for same endpoint pair | `validationState: conflict` | `A-LNK-002` |
| Endpoint `parentTrackId` not in supported runs v1 | Reject record | `A-LNK-003` |
| Endpoint FK mismatch (run fields ≠ endpoint fields) | Reject record | `A-LNK-004` |
| Missing provenance | Reject record | `A-LNK-005` |
| `validationState: validated` without required alignment (cross-segment) | Reject record | `A-LNK-006` |
| Geometry-only validation claim | Reject record | `A-LNK-007` |

### 5.7 Missing linkage behaviour

Without a `validationState: validated` corridor linkage record, cross-pass evaluation stops at **linkage hypothesis** or **unavailable**. Zero structural candidates from missing linkage is a **valid empirical outcome**.

---

## §6 — Evidence states and promotion

### 6.1 State definitions

| State | Definition |
|-------|------------|
| **Comparison-key match** | Same `segmentId`; equal `dividerCorridorId` text; different `temporalPassId` and `parentTrackId`; valid v1 FKs |
| **Linkage hypothesis** | Comparison-key match **OR** cross-segment key collision (equal key text, different `segmentId`, no alignment record) |
| **Corridor-linked** | Linkage hypothesis + `validationState: validated` corridor linkage record referencing both runs |
| **Structural cross-pass candidate** | Corridor-linked + route-s overlap ≥ 5.0 m (same-segment) **OR** corridor-linked + validated cross-segment alignment record |
| **Provisional cross-pass candidate** | Corridor-linked but traversal proof incomplete; **OR** linkage hypothesis only (no validated linkage) |
| **Genuine cross-pass evidence** | Structural candidate + validated traversal linkage |
| **Unavailable** | v0 input, missing comparison key, or evaluation blocked by scope violation |

### 6.2 Promotion conditions

```
comparison-key match
  → linkage hypothesis (automatic; no promotion to structural)

linkage hypothesis + validated corridor linkage record
  → corridor-linked

corridor-linked + same segment + routeSOverlapM ≥ 5.0
  → structural cross-pass candidate

corridor-linked + cross_segment + validated alignment record
  → structural cross-pass candidate

corridor-linked + insufficient overlap / missing alignment
  → provisional cross-pass candidate

linkage hypothesis without validated linkage record
  → provisional OR unavailable (never structural, never genuine)

structural candidate + validated traversal linkage
  → genuine cross-pass evidence

structural candidate without traversal linkage
  → provisional cross-pass candidate
```

**Required but insufficient:** different `parentTrackId`, different `temporalPassId`, equal `dividerCorridorId` text, route-s overlap, geometry overlap.

### 6.3 Same-pass (unchanged)

Runs **A** and **B** are **same-pass** iff equal `segmentId`, `chunkId`, `temporalPassId`, `poseSectionId`, `parentTrackId`.

### 6.4 Real-data treatment (three pairs)

The dataset contains **three cross-segment key-collision linkage hypotheses** (not corridor matches):

| Key text | Pass 0 track | Seg | Pass 1 track | Seg | Classification |
|----------|--------------|-----|--------------|-----|----------------|
| `0:4:0` | `0:0:4:0` | 64 | `0:1:4:0` | 57 | Cross-segment key collision → linkage hypothesis |
| `0:4:1` | `0:0:4:1` | 64 | `0:1:4:1` | 57 | Cross-segment key collision → linkage hypothesis |
| `0:4:2` | `0:0:4:2` | 64 | `0:1:4:2` | 57 | Cross-segment key collision → linkage hypothesis |

These MUST NOT be labelled corridor-matched, corridor-linked, or structural. Without validated linkage + alignment records, they remain **linkage hypotheses** or **unavailable** for structural promotion.

---

## §7 — Normative propagation at `flushRun()`

Unchanged in scope from v2. Amendment A metadata propagation is **independently valid** even when corridor linkage is unavailable.

```
run.parentTrackId     = track.trackId
run.chunkId           = track.chunkId
run.temporalPassId    = track.temporalPassId
run.poseSectionId     = track.poseSectionId
run.trackIndex        = track.trackIndex
run.dividerCorridorId = `${track.chunkId}:${track.poseSectionId}:${track.trackIndex}`
```

FK strict: `run.temporalPassId === track.temporalPassId` always. Same `parentTrackId` + different `temporalPassId` → `A-PTR-001`.

---

## §8 — Prohibited cases

| Case | Code |
|------|------|
| Same `parentTrackId`, different `temporalPassId` | `A-PTR-001` |
| Treating comparison-key match as corridor-linked without linkage record | `A-XPS-012` |
| Treating cross-segment key collision as corridor-linked | `A-XPS-013` |
| Direct `chunkId` comparison across segments | `A-XPS-010` |
| Direct `poseSectionId` comparison across passes as identity | `A-XPS-011` |
| Geometry overlap as corridor identity | `A-LEG-003` |
| Same-pass classified as cross-pass | `A-XPS-001` |
| Self-pair | `A-XPS-002` |
| Cross-chunk same pass (not cross-pass) | `A-XPS-003` |

---

## §9 — Satisfiability invariants

| ID | Invariant |
|----|-----------|
| **SAT-1** | Synthetic fixture T-A-034: same-segment comparison-key match + validated corridor linkage + route-s overlap ≥ 5 m → structural candidate |
| **SAT-2** | Same-pass fixture cannot satisfy corridor-linked (requires different `parentTrackId`) |
| **SAT-3** | No parent track holds two `temporalPassId` values |
| **SAT-4** | Locally scoped identifiers compared only within declared scope |
| **SAT-5** | Real dataset: 3 cross-segment key collisions → linkage hypotheses only; zero structural — **valid** |
| **SAT-6** | Metadata propagation validates independently; Rev 37 `maxSpatialJumpM: 12` unchanged |
| **SAT-7** | Negative fixture T-A-045: equal local numerics across segments without linkage → unavailable |

---

## §10 — Error codes (v3 additions)

| Code | Name | Fate |
|------|------|------|
| `A-XPS-012` | `comparison_key_not_corridor_identity` | Reject promotion |
| `A-XPS-013` | `cross_segment_key_collision_unlinked` | Linkage hypothesis / unavailable |
| `A-LNK-001`–`A-LNK-007` | Linkage artifact errors | See §5.6 |

---

## §11 — Independent validation boundary

Amendment A metadata propagation validates independently. Zero structural/genuine cross-pass on real data is acceptable when caused by missing corridor linkage — **not** by logical impossibility.

---

## §12 — Acceptance criteria

| Gate | Target |
|------|--------|
| v1 boundary field coverage on v1 runs | 100% |
| Same `parentTrackId` + different `temporalPassId` conflicts | 0 |
| Comparison-key match promoted without linkage record | 0 |
| Cross-segment key collision promoted without alignment | 0 |
| Logical impossibility in spec | 0 |

---

## §13 — Revision history

| Version | Date | Change |
|---------|------|--------|
| v1 | 2026-07-28 | Initial specification |
| v2 | 2026-07-28 | `dividerCorridorId`; removed parentTrackId contradiction |
| v3 | 2026-07-28 | **Scope correction:** comparison key vs corridor identity; linkage records; evidence states |

---

## §14 — Unresolved questions

| # | Question |
|---|----------|
| 1 | Traversal linkage record schema (paired with corridor linkage) |
| 2 | Deterministic `roadCorridorId` assignment algorithm |
| 3 | Explicit `trackIndex` on track artifact emission |

---

*DRAFT — NOT APPROVED. Specification correction only — not implementation.*
