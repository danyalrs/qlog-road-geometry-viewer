# Amendment B — Specification

**Status:** APPROVED FOR SPECIFICATION REVIEW (implementation not authorized)  
**Version:** `stage20-amendment-b-spec-v1`  
**Approved at specification-review level:** 2026-07-28  
**Date:** 2026-07-28  
**Parent investigation:** [stage20-amendment-b-investigation.md](./stage20-amendment-b-investigation.md)

**Does not modify:** Stage 19 Revision 37 in place, Stage 19 v5 bundle, `stage19_bundle/current.json`, frozen v11 geometry, Amendment A v1 artifact, published bundles, P3, lane counting.

**Does not authorize:** Implementation, production promotion, threshold approval for motion residual cap.

---

## §1 — Scope overview

Amendment B comprises **two bounded sub-specifications** with independent validation boundaries:

| ID | Name | Purpose |
|----|------|---------|
| **B-MOTION** | Motion-aware within-track linking | Fix Rev 37 singleton chains via pose-compensated residual edges |
| **B-TRAV** | Traversal evidence and linkage | Define traversal proof artifacts required for `genuine_cross_pass_evidence` per Amendment A v3 |

**Naming correction:** “Motion-aware cross-pass” is **incorrect** in project records. Cross-pass evaluation remains Amendment A + corridor linkage + B-TRAV traversal linkage.

---

## §2 — B-MOTION: problem and inputs

### 2.1 Problem

Rev 37 `staticBranchCandidateEdge()` rejects consecutive match pairs when raw 3D hi-point euclidean distance exceeds `maxSpatialJumpM` (12 m). At ~0.5 Hz sampling, median separation is ~33 m while pose/route-s evidence is consistent (~1 m route-s residual vs speed×Δt).

### 2.2 Inputs

| Input | Source artifact | Required |
|-------|-----------------|----------|
| Match hi endpoints | Stage 19 match builder | Yes |
| `logMonoTime` | Stage 16 observation | Yes |
| `poseRecord.east`, `poseRecord.north`, `poseRecord.speed` | Stage 16 observation | Yes for residual model |
| `sLoUm` / `sHiUm` (route-s) | Match record | Yes |
| `headingDegLo`, `tangentLoDeg` | Match record | Yes |
| `meanLateralOffsetUm` | Match record | Yes |
| `chunkId`, `temporalPassId`, `poseSectionId`, `segmentId` | Stage 16 → match context | Yes |
| Stage 17 gap records | Runtime | Yes |

### 2.3 Outputs

| Output | Description |
|--------|-------------|
| Optional processing tag | e.g. `stage20_motion_linking_v0` when module enabled |
| Modified partition/chain results | When enabled on **new** runs only |
| Motion-linking audit artifact (optional) | `lane_divider_motion_link_audit_v0.json` — edge decisions, residuals |
| **No** cross-pass artifacts | B-MOTION must not emit corridor or traversal linkage |

### 2.4 Motion edge predicate (hypothesis — threshold NOT approved)

```
poseDisplacementM = hypot(east_B - east_A, north_B - north_A)
residualM = |euclideanHiDistanceM(A, B) - poseDisplacementM|
```

Accept edge when `residualM ≤ RESIDUAL_CAP_M` **and** all Rev 37 non-spatial checks pass **and** boundary rules (§2.5) pass.

`RESIDUAL_CAP_M` candidate: 12 m — **NOT APPROVED** (see investigation §6.3).

### 2.5 Mandatory boundary rejections (no relaxation)

| Boundary | Code |
|----------|------|
| Stage 17 gap intersection | `B-MOT-010` |
| Different `chunkId` | `B-MOT-011` |
| Different `poseSectionId` | `B-MOT-012` |
| Different `temporalPassId` | `B-MOT-013` |
| Different `segmentId` | `B-MOT-014` |
| Negative Δt | `B-MOT-015` |
| `interpolationMetadata.permitted` on run | `B-MOT-016` |
| Missing pose for residual | `B-MOT-020` |
| Pose inconsistency (GPS jump) | `B-MOT-021` |
| Implausible implied speed | `B-MOT-022` |

### 2.6 What B-MOTION must not change

- Rev 37 `lib/stage19_spec/geometry.js` (protected)
- Published Stage 19 v5 bundle snapshot
- Cross-pass state machine semantics (Amendment A)
- `maxSpatialJumpM: 12` when module disabled (default)

---

## §3 — B-TRAV: problem and inputs

### 3.1 Problem

Amendment A v3 defines `genuine_cross_pass_evidence` as structural candidate + **validated traversal linkage**, but no traversal artifact schema or emitter exists (Amendment A §14 Q1).

### 3.2 Inputs

| Input | Source | Required |
|-------|--------|----------|
| Supported runs v1 | `lane_divider_supported_runs_v1.json` | Yes |
| Corridor linkage records | `lane_divider_corridor_linkage_v0.json` | Required for validated traversal linkage |
| Motion observations | Stage 16 `poseRecord`, timestamps, route-s | Required for traversal proof |
| Cross-segment alignment | On corridor linkage record | Required for cross-segment structural path |

### 3.3 Outputs

| Artifact | Purpose |
|----------|---------|
| `lane_divider_traversal_evidence_v0.json` | Motion observations supporting a traversal hypothesis between two runs |
| `lane_divider_traversal_linkage_v0.json` | Validated traversal linkage records referencing corridor linkage |
| `lane_divider_traversal_evaluation_v0.json` (optional) | Pairwise evaluation audit with rejection codes |

**No auto-generation from geometry overlap, route-s overlap, or `dividerCorridorId` equality.**

### 3.4 Evidence concept definitions

| Concept | Definition | Authority |
|---------|------------|-----------|
| **Motion observation** | Timestamped pose + speed (+ optional heading) at an observation or derived sample | Authoritative locally |
| **Vehicle movement state** | `moving` / `stationary` / `creeping` / `uncertain` from speed + displacement | Ephemeral upstream; may be copied into evidence record if exported |
| **Temporal pass** | `temporalPassId` scoped to segment | Authoritative boundary |
| **Traversal** | Directed vehicle passage along route-s between two evidence endpoints in **different** passes | Inferred claim — requires proof |
| **Traversal linkage** | Validated record binding two v1 runs with motion proof + corridor FK | Authoritative when `validationState: validated` |
| **Corridor linkage** | Amendment A corridor record with `roadCorridorId` | Authoritative when validated |
| **Route-s overlap** | Overlap length of route-s intervals (same segment) or mapped overlap (cross-segment) | Supporting evidence, not identity |
| **Structural cross-pass candidate** | Corridor-linked + overlap/alignment rules (Amendment A) | Provisional without traversal |
| **Provisional candidate** | Corridor-linked without traversal, or linkage hypothesis only | Not promotable to genuine |
| **Genuine cross-pass evidence** | Structural + validated traversal linkage | Authoritative |
| **Unavailable** | Missing prerequisite, scope violation, or legacy input | No promotion |

**Prohibited promotions:**
- Motion similarity alone → corridor identity (`B-TRV-040`)
- Geometry overlap alone → corridor identity (`B-TRV-041`, aligns with `A-LEG-003`)
- Different `temporalPassId` alone → genuine traversal (`B-TRV-042`)

---

## §4 — Prerequisite rules (B-TRAV)

### 4.1 Corridor linkage prerequisite

| State | Corridor linkage required? | Max promotion |
|-------|---------------------------|---------------|
| Traversal hypothesis | No | Hypothesis only — `B-TRV-001` if promoted without corridor |
| Provisional traversal hypothesis | No | Unavailable for structural (`B-TRV-030`) |
| Validated traversal linkage | **Yes** — validated corridor linkage referencing same endpoint pair | Input to genuine evaluation |
| Structural candidate | Validated corridor + overlap/alignment | Provisional without traversal (`A-XPS-007`) |
| Genuine evidence | Validated corridor + validated traversal | Full promotion |

### 4.2 Evaluation order

1. Scope guards (same-pass, self-pair, cross-chunk same pass — delegate to Amendment A codes where applicable)
2. Corridor linkage lookup
3. Traversal evidence validation
4. Traversal linkage validation
5. Amendment A cross-pass state machine (consumer)

---

## §5 — Promotion state machine (B-TRAV + Amendment A consumer)

```
raw_motion_observations
  → traversal_hypothesis (pair selected, motion fields present, no validation)
  → [requires validated corridor linkage]
  → validated_traversal_linkage
  → [Amendment A: corridor-linked + structural rules]
  → structural_cross_pass_candidate | provisional_cross_pass_candidate
  → [requires validated_traversal_linkage on pair]
  → genuine_cross_pass_evidence

linkage_hypothesis (Amendment A, key collision or comparison-key match)
  → NEVER structural/genuine without corridor linkage

unavailable ← any scope violation or missing prerequisite
```

### Transition table

| From | To | Required inputs |
|------|-----|-----------------|
| raw motion | traversal_hypothesis | Two distinct runs; different `temporalPassId`; motion fields on evidence; **not** same-pass |
| traversal_hypothesis | validated_traversal_linkage | Validated corridor linkage for pair; traversal evidence passes validators; provenance present |
| validated_traversal_linkage + corridor-linked | structural_candidate | Amendment A overlap ≥5 m (same segment) or validated cross-segment alignment |
| structural_candidate | genuine | Validated traversal linkage on same pair |
| any | unavailable | Missing corridor linkage, missing movement evidence, direction conflict, etc. |

**Invariant SAT-B-1:** Synthetic fixture with validated corridor + traversal linkages + overlap can reach `genuine_cross_pass_evidence`.

**Invariant SAT-B-2:** Missing corridor linkage cannot reach structural or genuine.

**Invariant SAT-B-3:** Missing traversal linkage cannot reach genuine.

**Invariant SAT-B-4:** Equal local IDs across scopes without linkage remain unavailable.

**Invariant SAT-B-5:** Zero real-data genuine evidence is valid.

---

## §6 — Validation and rejection (B-TRAV codes)

See [stage20-amendment-b-schema.md](./stage20-amendment-b-schema.md) for field-level schema.

| Code | Condition | Fate |
|------|-----------|------|
| `B-TRV-001` | Missing traversal endpoint | Reject record |
| `B-TRV-002` | Unresolved endpoint FK (`dividerRunId` not in v1) | Reject record |
| `B-TRV-003` | Same-pass self-pair | Unavailable evaluation |
| `B-TRV-004` | Duplicate traversal pair | Reject artifact |
| `B-TRV-005` | Reversed duplicate pair | Reject artifact |
| `B-TRV-010` | Incompatible segment scope | Reject / unavailable |
| `B-TRV-011` | Incompatible chunk scope | Unavailable |
| `B-TRV-012` | Incompatible pose-section scope | Unavailable |
| `B-TRV-020` | Missing corridor linkage reference | Reject validated linkage |
| `B-TRV-021` | Unvalidated corridor linkage | Provisional only |
| `B-TRV-030` | Missing movement evidence | Reject / unavailable |
| `B-TRV-031` | Stationary-only evidence | Reject traversal proof |
| `B-TRV-032` | Direction conflict | Reject |
| `B-TRV-033` | Timestamp conflict | Reject |
| `B-TRV-034` | Route-s overlap failure (when required) | Provisional |
| `B-TRV-035` | Implausible displacement or speed | Reject |
| `B-TRV-036` | Cross-segment alignment unavailable | Unavailable for structural |
| `B-TRV-037` | Missing provenance | Reject record |
| `B-TRV-038` | Conflicting traversal records | `validationState: conflict` |
| `B-TRV-039` | Non-deterministic grouping | Reject artifact envelope |
| `B-TRV-040` | Motion similarity as corridor identity | Unavailable |
| `B-TRV-041` | Geometry-only corridor claim | Reject (aligns `A-LNK-007`) |
| `B-TRV-042` | temporalPassId difference as traversal proof | Unavailable |

---

## §7 — Determinism

Both B-MOTION and B-TRAV require:

- Stable sort keys documented in schema
- Canonical JSON with sorted keys
- Content hash excluding envelope timestamps
- Identical output on rerun with identical inputs

B-MOTION inherits Rev 37 greedy ordering: `sLoUm` ascending, then `observationId`.

B-TRAV sorts linkage records by `traversalLinkageId` ascending.

---

## §8 — Positive and negative fixtures (specification only)

| Fixture ID | Purpose |
|------------|---------|
| `FX-B-001` | Valid same-segment traversal linkage with corridor FK |
| `FX-B-002` | Valid cross-segment traversal with alignment + corridor FK |
| `FX-B-003` | Same local numeric IDs without linkage — unavailable |
| `FX-B-004` | Same pass presented as two traversals — reject |
| `FX-B-005` | Stationary GPS drift — reject `B-TRV-031` |
| `FX-B-006` | Heading reversal without corridor proof — reject |
| `FX-B-007` | Missing movement evidence — `B-TRV-030` |
| `FX-B-008` | Route-s overlap without corridor linkage — provisional only |
| `FX-B-009` | Corridor linkage without traversal — structural max provisional |
| `FX-B-010` | Traversal without corridor — reject `B-TRV-020` |
| `FX-B-011` | Duplicate / reversed duplicate pairs |
| `FX-B-012` | Conflicting traversal records |
| `FX-M-001` | Valid motion edge — low residual, same boundary |
| `FX-M-002` | High residual — reject |
| `FX-M-003` | Gap intersection — `B-MOT-010` |

Positive fixtures **must not** assume the relationship they prove — corridor and traversal records require external provenance fields.

---

## §9 — Real-data feasibility summary

| Metric | Real data | Synthetic fixtures |
|--------|-----------|-------------------|
| Motion fields on observations | 100% | N/A |
| Validated corridor linkages | **0** | FX-B-001+ |
| Same-segment comparison-key matches | **0** | FX-B-001 |
| Cross-segment key collisions | **3** | FX-B-002 |
| Structural candidates | **0** | SAT-B-1 |
| Genuine evidence | **0** | SAT-B-1 |
| B-MOTION threshold approval | **Blocked** | FX-M-* |

---

## §10 — Amendment A hardening

Before B-MOTION implementation, recommended small Amendment A patch to add direct tests for:

- `A-ART-001`, `A-ART-002`, `A-LNK-004`

Does not block B specification review. Not part of B semantics.

---

## §11 — Implementation authorization

| Component | Authorized |
|-----------|------------|
| B-MOTION implementation | **No** — threshold not approved |
| B-TRAV schema validators | **No** — spec review only |
| Production promotion | **No** |
| P3 / lane counting | **No** |

---

## §12 — Revision history

| Version | Date | Change |
|---------|------|--------|
| v1 | 2026-07-28 | Initial specification; separates B-MOTION from B-TRAV; resolves naming contradiction |

---

*DRAFT — NOT APPROVED. Specification only — not implementation.*

**Specification-review approval (2026-07-28):** B-MOTION and B-TRAV specifications approved at review level only. Implementation, threshold approval, and production promotion remain unauthorized. See `deliverables/stage20-b-motion-evidence-review-spec.md` and `deliverables/stage20-b-motion-threshold-approval-criteria.md`.
