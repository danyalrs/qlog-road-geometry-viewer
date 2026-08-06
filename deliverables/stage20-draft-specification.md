# Stage 20 — Draft Specification (Combined)

**Status:** DRAFT — NOT APPROVED  
**Investigation date:** 2026-07-28  
**Mode:** Design and specification investigation only  
**Baseline:** Stage 19 Revision 37 + implementation `2026-07-27-stage19-v5`  
**Frozen geometry:** `2026-07-24-fusion-v11`

> This document combines Amendment A and Amendment B for review. Neither amendment is approved. Stage 19 Rev 37 remains the authoritative normative specification until explicit amendment authorization.

---

## Document Structure

| Section | Amendment |
|---------|-----------|
| §A1–A17 | Amendment A — Metadata propagation and cross-pass grouping |
| §B1–B17 | Amendment B — Motion-aware within-track linking |
| §S1–S8 | Shared invariants |
| §I1–I5 | Implementation order and checkpoints |

Full standalone drafts:

- [stage20-amendment-a-draft.md](./stage20-amendment-a-draft.md)
- [stage20-amendment-b-draft.md](./stage20-amendment-b-draft.md)

---

## §S — Shared Invariants

### S1. Immutable artifacts

- Published Stage 19 v5 bundle (`stage19_bundle/runs/2026-07-27-stage19-v5/`)
- `stage19_bundle/current.json` (until explicit authorized publication)
- Frozen v11 geometry (`2026-07-24-fusion-v11`)
- `lane_divider_supported_runs_v0.json`
- Stage 19 Rev 37 normative package (`deliverables/stage19-revision37/`)

### S2. Truthfulness

- Zero conflicts ≠ agreement when `conflictEvidenceAvailable: false`
- Fixture-validated P3 ≠ real-data evidence
- Experimental overlays (25 m, 50 m) ≠ approved thresholds
- Production lane counting remains disabled
- HD-map remains incomplete
- No production deployment authorized

### S3. Independent validation boundaries

| Amendment | Validates | Does not claim |
|-----------|-----------|----------------|
| A | Metadata coverage, cross-pass eligibility, FK integrity | Within-track chain fix |
| B | Motion-aware linking, residual caps, boundary safety | Cross-pass support |

### S4. Determinism

All new artifacts must produce byte-identical output across deterministic reruns under fixed inputs.

### S5. Schema versioning

| Artifact | Version |
|----------|---------|
| Supported runs (metadata) | `lane_divider_supported_runs_v1` |
| Motion linking spec | `stage20_motion_linking_v0` (proposed) |
| Stage 20 evidence layer | `stage20_evidence_v0` (proposed) |

### S6. Protected files

Amendments must not modify protected `lib/stage19_spec/*` hashes in place. New normative modules are additive.

### S7. Investigation classification

This work is:

- Design and specification investigation
- **Not** implementation
- **Not** production validation
- **Not** deployment approval

### S8. Evidence sources

- `reports/stage19_dataset_sensitivity_investigation.json`
- `reports/stage20_design_investigation.json`
- `reports/stage20_metadata_provenance.md`
- `reports/stage20_link_ground_truth_sample.json`

---

## §A — Amendment A Summary (Metadata Propagation)

**Problem:** 878/878 supportedRuns lack explicit `temporalPassId` and `chunkId`.

**Solution:** Copy boundary IDs from parent track at Stage 17B `flushRun()` into v1 supported-run schema.

**Earliest propagation point:** `lib/stage17_supported_run_fusion.js`

**Key rules:**

- Same-pass: equal `chunkId`, `temporalPassId`, `poseSectionId`, `segmentId`
- Cross-pass: same parent corridor, same chunk/section, **different authoritative `temporalPassId`**
- `parentTrackId` parsing: legacy fallback only, non-normative
- Validates with **unchanged 12 m Rev 37 linking**

**Acceptance:** 100% metadata coverage; zero same-pass misclassified as cross-pass; v5 bundle unchanged.

→ Full text: [stage20-amendment-a-draft.md](./stage20-amendment-a-draft.md)

---

## §B — Amendment B Summary (Motion-Aware Linking)

**Problem:** Raw 12 m euclidean cap vs ~33 m median displacement at ~2 s sampling.

**Proposed model:** Residual cap after pose compensation (`|euclidean − poseDisplacement| ≤ RESIDUAL_CAP`).

**Key finding:** |routeS − speed×Δt| median ≈ 1.0 m — route-s is motion-consistent; euclidean is not.

**Threshold:** NOT APPROVED — requires ≥ 200 reviewed ground-truth pairs.

**Rejected:** 50 m experimental overlay as production correction.

**Validates without:** Cross-pass claims.

→ Full text: [stage20-amendment-b-draft.md](./stage20-amendment-b-draft.md)

---

## §I — Implementation Order and Checkpoints

### I1. Recommended order

1. **Amendment A** — metadata propagation specification → implementation checkpoint A
2. **Expanded ground-truth review** — manual/video sample (requires qlog data)
3. **Amendment B** — motion-aware linking specification → implementation checkpoint B
4. **Stage 20 evidence layer** — consumer of v5 + v1 upstream + optional motion module

### I2. Architecture (Option 4)

```
lane_divider_supported_runs_v0.json (immutable)
lane_divider_supported_runs_v1.json (Amendment A output)
stage19_bundle/runs/2026-07-27-stage19-v5/ (immutable)
stage20_evidence/ (future consumer layer)
```

### I3. Checkpoint strategy

| Checkpoint | Scope | Rollback |
|------------|-------|----------|
| `stage20-amendment-a-pre` | Before v1 emission | Delete v1 artifact |
| `stage20-amendment-a-post` | After v1 validation | Revert to v0 consumer |
| `stage20-amendment-b-pre` | Before motion module | Disable module |
| `stage20-amendment-b-post` | After motion validation | Rev 37 linking |

### I4. `current.json` policy

No change until explicit Stage 20 publication authorization separate from this investigation.

### I5. Final investigation recommendation

**PROCEED WITH METADATA PROPAGATION SPECIFICATION FIRST**

Rationale:

1. Cross-pass is structurally blocked (878/878 missing metadata)
2. Amendment A is independent and has clear acceptance criteria
3. Amendment B requires expanded evidence before threshold approval
4. Motion linking cannot substitute for metadata propagation

---

## Architecture Option Comparison

| Criterion | Opt 1: Amend Rev37 + replace v5 | Opt 2: Stage 20 on v5 only | Opt 3: Upstream v1 only | **Opt 4: Separate A+B layers** |
|-----------|--------------------------------|---------------------------|-------------------------|-------------------------------|
| v5 bundle preserved | No | Yes | Partial | **Yes** |
| Metadata fix | Yes | No | Yes | **Yes** |
| Motion fix | Yes | Partial | No | **Yes (B module)** |
| Rev 37 in-place edit | Yes | No | No | **No** |
| Rollback clarity | Poor | Medium | Good | **Best** |
| Traceability | Poor | Medium | Good | **Best** |
| **Selected** | | | | **✓** |

---

## Unresolved Evidence Gaps

1. No qlog files — video ground truth unavailable
2. Only 20 no-boundary pairs for motion validation
3. Zero automated valid same-track continuations under Rev37 on no-boundary set
4. No demonstrated multi-pass supported runs
5. Precision/recall targets require manual review expansion

---

*This combined draft is for independent review. It is not approved for implementation.*
