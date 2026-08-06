# Amendment A (Draft) — Explicit Pass, Chunk and Pose Metadata Propagation

**Status:** DRAFT — NOT APPROVED  
**Investigation date:** 2026-07-28  
**Parent specification:** Stage 19 Revision 37 (unchanged)  
**Does not fix:** Within-track chain formation (see Amendment B)

---

## 1. Problem Statement

Stage 19 cross-pass candidate construction requires `temporalPassId`, `chunkId`, and `poseSectionId` on `supportedRuns`. The persisted Stage 17 artifact `lane_divider_supported_runs_v0.json` omits these fields on all 878 runs. Stage 19 `buildCrossPassCandidates()` therefore produces zero candidates despite upstream tracks carrying explicit boundary IDs.

This is a **schema propagation defect**, not a dataset absence of multi-pass traversals.

---

## 2. Scope

### In scope

- Add explicit `temporalPassId`, `chunkId`, `poseSectionId` to supported-run records at authoritative creation time
- Propagate to downstream consumers (Stage 18 validation, Stage 19 cross-pass, bundle artifacts)
- Define same-pass, cross-pass, same-chunk, and pose-section boundary semantics
- Legacy v0 record handling and rejection rules
- Deterministic serialization and schema versioning (`lane_divider_supported_runs_v1`)

### Non-goals

- Modifying frozen v11 geometry
- Modifying Stage 19 Rev 37 partition/linking thresholds
- Fixing singleton chain formation (Amendment B)
- Approving experimental 50 m spatial overlay
- Publishing new Stage 19 bundle or changing `current.json`
- Production lane counting or deployment

---

## 3. Authoritative Inputs

| Field | Authoritative source | Module |
|-------|---------------------|--------|
| `temporalPassId` | Parent track at run creation | `lib/stage17_supported_run_fusion.js` |
| `chunkId` | Parent track at run creation | same |
| `poseSectionId` | Parent track at run creation | same |
| `parentTrackId` | Existing FK | same |
| `segmentId` | Derived from first observation in run | Stage 16 observation |

**Normative rule:** Fields are copied from the parent track object at `flushRun()` time. They must not be inferred from `parentTrackId` string parsing in normative logic.

---

## 4. Normative Outputs

### Schema: `lane_divider_supported_runs_v1`

Add to `buildSupportedRunTemplate()`:

```json
{
  "chunkId": "integer, required, non-null",
  "temporalPassId": "integer, required, non-null",
  "poseSectionId": "integer, required, non-null",
  "segmentId": "integer, required, non-null",
  "boundaryProvenance": {
    "source": "parent_track",
    "parentTrackId": "string, FK",
    "copiedAt": "ISO-8601"
  }
}
```

### Identifier format

Unchanged: `dividerRunId` = `{parentTrackId}:run:{n}`

### Foreign-key rules

| FK | Target | Validation |
|----|--------|--------------|
| `parentTrackId` | `lane_divider_tracks_v0.json` track | Must exist |
| `chunkId` | Must equal parent track `chunkId` | Equality gate |
| `temporalPassId` | Must equal parent track `temporalPassId` | Equality gate |
| `poseSectionId` | Must equal parent track `poseSectionId` | Equality gate |
| `observationIds[]` | Stage 16 observations | Each must share run boundary IDs |

---

## 5. Grouping Rules

### Same-chunk

`chunkIdA === chunkIdB` and both non-null.

### Cross-chunk rejection

Observations or runs with different `chunkId` **cannot** form cross-pass pairs. Classification: `invalid_across_chunk_boundary`.

### Same-pass

`chunkId`, `temporalPassId`, `poseSectionId`, and `segmentId` all equal.

### Cross-pass (genuine)

- Same `parentTrackId` prefix (divider hypothesis)
- Same `chunkId` and `poseSectionId`
- **Different** `temporalPassId` (authoritative field comparison)
- Route-s overlap ≥ 5 m
- Both runs have ≥ 1 projected observation match

### Pose-section boundary

Different `poseSectionId` → `invalid_across_pose_section_boundary`. Not treated as cross-pass.

---

## 6. Supported-run Temporal Traversal Proof

A supportedRun proves membership in one temporal traversal when:

1. `temporalPassId` is explicit and matches every observation in `observationIds[]`
2. `boundaryProvenance.source === 'parent_track'`
3. FK validation passes against parent track
4. No observation in the run has conflicting `temporalPassId`

---

## 7. Missing, Conflicting, and Legacy Records

| Case | Behaviour |
|------|-----------|
| v0 run missing boundary IDs | **Rejected** for cross-pass; optional read-only fallback may parse `parentTrackId` with `legacyFallback: true` flag — output tagged `provenance: legacy_parsed`, excluded from normative cross-pass counts |
| Field conflict run vs track | **Reject run** — quality gate `boundary_metadata_conflict` |
| Field conflict run vs observation | **Reject run** — quality gate `observation_boundary_mismatch` |
| Null `temporalPassId` | **Reject** — no cross-pass eligibility |

### Legacy fallback limitations (non-normative)

- Only for read-only migration auditing
- Must log `legacyFallbackUsed: true`
- Cannot produce normative cross-pass candidates without explicit fields

---

## 8. Duplicate and Self-Pair Rejection

| Condition | Gate |
|-----------|------|
| `evidenceUnitKey` duplicate in cross-pass pair | Reject |
| `featurePairId` duplicate | Reject |
| Self-pair (`temporalPassIdLo === temporalPassIdHi`) | Reject (`cross_pass_self_pair`) |
| Same-pass repeated evidence | Reject (`cross_pass_same_evidence_unit`) |

---

## 9. Deterministic Serialization

- Sort supported runs by `dividerRunId` lexicographic
- Integer fields without leading-zero ambiguity
- `boundaryProvenance.copiedAt` excluded from content hash or fixed to build timestamp per checkpoint policy

---

## 10. Quality Gates (Amendment A)

| Gate | Condition |
|------|-----------|
| `metadata_coverage` | 100% runs have explicit `temporalPassId`, `chunkId`, `poseSectionId` |
| `fk_integrity` | All runs resolve parent track and observations |
| `no_boundary_conflict` | Zero run/track/observation mismatches |
| `no_legacy_in_normative_path` | Normative cross-pass uses v1 only |
| `deterministic_rerun` | Byte-identical v1 artifact across rebuild |

---

## 11. Semantic Validation

- Cross-pass candidate count may be > 0 after Amendment A **only if** genuine multi-pass supported runs exist
- Zero candidates with full metadata is **valid** — report `conflictEvidenceAvailable: false` truthfully
- Must not claim agreement from zero conflicts when evidence unavailable

---

## 12. Test Matrix (Specification)

| Test | Expectation |
|------|-------------|
| v1 run inherits track boundary IDs | Pass |
| v0 run rejected by normative cross-pass | Pass |
| Same-pass pair not counted cross-pass | Pass |
| Different chunk not cross-pass | Pass |
| Legacy parse fallback tagged non-normative | Pass |
| Stage 19 v5 bundle unchanged | Pass |
| Rev 37 12 m linking unchanged | Pass |
| Deterministic v1 serialization | Pass |

---

## 13. Migration Plan

1. Implement v1 emission in Stage 17B (new code path — future implementation)
2. Retain `lane_divider_supported_runs_v0.json` immutable
3. Stage 20 consumer reads v1 for cross-pass; v5 bundle remains historical reference
4. No in-place edit of published v5 run payloads

---

## 14. Rollback Boundary

- Rollback = continue consuming v0 with zero cross-pass (current behaviour)
- v1 artifact is additive; delete v1 to restore prior consumer behaviour

---

## 15. Affected Components

| Component | Impact |
|-----------|--------|
| `lib/stage17_supported_run_fusion.js` | Implementation (future) |
| `lib/stage17_tracking_schema.js` | Template extension |
| `lib/stage19_cross_pass_production.js` | Consumer validation |
| `lane_divider_supported_runs_v1.json` | New artifact |
| Stage 19 v5 bundle | **No change** |
| Rev 37 spec | Referenced, not edited in place |

---

## 16. Acceptance Metrics

| Metric | Target |
|--------|--------|
| `temporalPassId` coverage | 100% |
| `chunkId` coverage | 100% |
| `poseSectionId` coverage | 100% (where applicable) |
| Same-pass misclassified as cross-pass | 0 |
| FK conflicts | 0 |
| Duplicate evidence units in cross-pass | 0 |
| v5 bundle modified | 0 |
| v11 geometry modified | 0 |
| Deterministic serialization | Required |

---

## 17. Validation with Unchanged 12 m Linking

Amendment A validation **explicitly retains** Rev 37 `maxSpatialJumpM: 12` static linking. Success criteria:

- Cross-pass metadata correct
- Singleton chain count may remain 5,809 — **not a failure of Amendment A**
- P3 may remain 0/0/0 — **not a failure of Amendment A**

---

*This document is a draft for independent review. It is not approved for implementation.*
