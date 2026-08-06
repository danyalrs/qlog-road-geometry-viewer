# Amendment B — Investigation Report

**Date:** 2026-07-28  
**Mode:** Investigation and specification only — no implementation  
**Approved baseline:** Amendment A v3 implemented and accepted (41/41 matrix cases; 878 v1 runs)

---

## 1. Executive finding: scope contradiction resolved

Project records **disagree** with the informal description “motion-aware cross-pass” or “traversal evidence Amendment B.”

| Source | What “Amendment B” means |
|--------|--------------------------|
| `deliverables/stage20-amendment-b-draft.md` | **Motion-aware within-track chain linking** — replaces raw 12 m euclidean cap with pose-compensated residual check |
| `deliverables/stage20-draft-specification.md` §B | Same — optional `stage20_motion_linking_v0` overlay |
| `docs/DECISIONS.md` D-012, D-013 | Amendment B = motion module; **does not** provide cross-pass evidence |
| `deliverables/stage20-amendment-a-specification.md` §14 Q1 | **Traversal linkage record schema unresolved** — belongs to Stage 20 evidence layer, not Amendment B draft |
| `lib/stage20_amendment_a_cross_pass.js` | Consumes `traversalLinkageByPair` as external input; no emitter exists |

**Conclusion:** Amendment B (canonical) solves **within-track singleton chains** caused by Rev 37’s raw spatial cap. **Traversal linkage** and **genuine cross-pass evidence** are a **separate bounded specification** (this package labels it **B-TRAV / Stage 20 Traversal Evidence**) that consumes Amendment A v1 runs and corridor linkage artifacts.

Cross-pass promotion rules remain in Amendment A v3; B-TRAV defines the missing traversal artifact schemas and validators Amendment A §14 Q1 left open.

---

## 2. Problem statements (two independent root causes)

### 2.1 B-MOTION — within-track linking (canonical Amendment B)

| Item | Evidence |
|------|----------|
| Symptom | 5,809 singleton chains; 0 multi-observation chains under Rev 37 |
| Primary failure | 81.4% first-failure = `spatial_distance` (>12 m cap) |
| Median consecutive displacement | 32.98 m at ~2.0 s sampling |
| Median \|routeS − speed×Δt\| | ~1.0 m — motion consistent with route-s |
| Multi-obs tracks exist | 573 Stage 17 tracks with >1 observation |
| Rev 37 links on multi-obs units | **0** |
| Approach H (pose residual ≤12 m) | 9 boundary-filtered links (all ambiguous) on investigation sample |
| No-boundary consecutive pairs | **20** — Rev 37 passes **0** |

**Source:** `reports/stage20_design_investigation.json`, `reports/stage19_dataset_sensitivity_investigation.json`, `deliverables/stage20-amendment-b-draft.md`

### 2.2 B-TRAV — traversal evidence for genuine cross-pass (Stage 20 evidence continuation)

| Item | Evidence |
|------|----------|
| Amendment A v1 runs | 878 runs; 100% boundary metadata |
| Validated corridor linkages (real data) | **0** |
| Same-segment comparison-key matches (real data) | **0** |
| Cross-segment key collisions | **3** (linkage hypotheses only) |
| Structural / genuine cross-pass (real data) | **0** / **0** |
| Traversal linkage artifact | **Not published**; test-time `Map` only |

**Source:** `deliverables/stage20-amendment-a-acceptance-audit.md`, `checkpoints/stage20-amendment-a-implementation-2026-07-28.json`, read-only analysis 2026-07-28

Amendment A fixed metadata propagation; it **did not** and **cannot** create genuine cross-pass evidence without validated corridor + traversal linkage records.

---

## 3. Relationship map

```
                    ┌─────────────────────────────────────┐
                    │  v11 geometry (frozen, VP)          │
                    └──────────────┬──────────────────────┘
                                   ▼
                    ┌─────────────────────────────────────┐
                    │  Stage 16 projected observations    │
                    │  pose, speed, route-s, timestamps   │
                    └──────────────┬──────────────────────┘
                                   ▼
         ┌─────────────────────────┴─────────────────────────┐
         ▼                                                   ▼
┌─────────────────────┐                         ┌─────────────────────────┐
│ B-MOTION (Amend. B) │                         │ Amendment A v1 runs     │
│ within-track links  │                         │ boundary metadata       │
│ stage20_motion_     │                         │ lane_divider_supported_ │
│ linking_v0          │                         │ runs_v1.json            │
└──────────┬──────────┘                         └────────────┬────────────┘
           │                                                   │
           │ does NOT create                                   ▼
           │ cross-pass evidence              ┌─────────────────────────────┐
           └──────────────────────────────────│ Corridor linkage artifact   │
                                                │ (manual / external process) │
                                                └────────────┬────────────────┘
                                                             ▼
                                                ┌─────────────────────────────┐
                                                │ B-TRAV traversal evidence   │
                                                │ + traversal linkage records │
                                                └────────────┬────────────────┘
                                                             ▼
                                                ┌─────────────────────────────┐
                                                │ Amendment A cross-pass      │
                                                │ state machine (structural / │
                                                │ provisional / genuine)      │
                                                └─────────────────────────────┘
```

**Hard boundaries:**
- Motion similarity alone → **not** corridor identity (D-021)
- Geometry overlap alone → **not** corridor identity (A-LEG-003 / LNK-007)
- Different `temporalPassId` alone → **not** genuine traversal (D-016)
- `dividerCorridorId` equality → linkage hypothesis only (Amendment A v3)

---

## 4. Prerequisite model (evidence-selected)

| Sub-spec | Selected model | Rationale |
|----------|----------------|-----------|
| **B-MOTION** | **D — additional evidence required** for threshold approval | Only 20 no-boundary pairs; <10 reviewed valid continuations; no qlog video; 576 ground-truth pairs are 100% rule-rejected (gap or session boundary). Spec may be written; **RESIDUAL_CAP_M not approvable** until ≥200 manually reviewed pairs. |
| **B-TRAV** | **A + B combined** | **A:** validated traversal linkage only after validated corridor linkage exists. **B:** provisional traversal hypotheses permitted but **unavailable for structural/genuine promotion** until corridor linkage validates. |
| **B-TRAV cross-segment** | **C (alignment already in Amendment A)** | Cross-segment structural promotion requires validated `crossSegmentAlignment` on corridor linkage record — not a new B-TRAV invention. |
| **Real-data genuine evidence** | **Blocked** | 0 validated corridor linkages → 0 structural → 0 genuine regardless of motion fields. |

Synthetic fixtures may demonstrate satisfiability; real-data genuine count **zero is valid**.

---

## 5. Inspected files and source locations

| Area | Path |
|------|------|
| Amendment B draft | `deliverables/stage20-amendment-b-draft.md` |
| Combined Stage 20 draft | `deliverables/stage20-draft-specification.md` |
| Amendment A v3 spec | `deliverables/stage20-amendment-a-specification.md` |
| Amendment A acceptance | `deliverables/stage20-amendment-a-acceptance-audit.md` |
| Amendment A checkpoint | `checkpoints/stage20-amendment-a-implementation-2026-07-28.json` |
| Design investigation | `reports/stage20_design_investigation.json`, `.md` |
| Metadata provenance | `reports/stage20_metadata_provenance.md` |
| Candidate pair sample (misnamed ground-truth) | `reports/stage20_link_ground_truth_sample.json` |
| Terminology correction | `reports/stage20_link_candidate_pair_sample_v1.terminology.md` |
| Rev 37 geometry | `lib/stage19_spec/geometry.js`, `config.js` |
| Motion state (ephemeral) | `lib/movement_state.js`, `lib/pose_continuity.js` |
| GPS / heading | `lib/alignment.js` |
| Stage 16 schema | `lib/stage16_projection_schema.js` |
| Stage 17 fusion | `lib/stage17_supported_run_fusion.js` |
| Amendment A cross-pass | `lib/stage20_amendment_a_cross_pass.js` |
| Corridor linkage validators | `lib/stage20_amendment_a_corridor_linkage.js` |
| Real v1 artifact | `lane_divider_supported_runs_v1.json` |
| Stage 16 observations | `projected_lane_observations_v0.json` |
| Living docs | `docs/CURRENT_STATUS.md`, `DECISIONS.md`, `KNOWN_ISSUES.md` |

---

## 6. Real-data feasibility (read-only, 2026-07-28)

### 6.1 Motion field availability (Stage 16)

| Field | Records with field | % of 5,809 obs |
|-------|-------------------:|---------------:|
| `poseRecord` (east, north, heading) | 5,809 | 100.00 |
| `poseRecord.speed` | 5,809 | 100.00 |
| `projectedRoutePoints` (route-s) | 5,809 | 100.00 |
| Distinct temporal passes | 88 | — |
| Distinct pose sections | 91 | — |
| Stationary (speed < 0.5 m/s) | 33 | 0.57 |
| Moving (speed ≥ 0.5 m/s) | 5,776 | 99.43 |

`movementState` is **not persisted** in divider artifacts (computed upstream only).

### 6.2 Amendment A v1 cross-pass posture

| Counter | Value |
|---------|------:|
| Supported runs | 878 |
| Same-segment linkage hypotheses (comparison-key match) | **0** |
| Cross-segment key collisions | **3** |
| Validated corridor linkages | **0** |
| Could become structural (real data) | **0** |
| Could become genuine (real data) | **0** |

**Blocking prerequisite for structural/genuine:** missing validated corridor linkage records (all 878 runs).

### 6.3 B-MOTION feasibility

| Counter | Value |
|---------|------:|
| Multi-observation tracks | 573 |
| Rev 37 static links | 0 |
| Ground-truth candidate pairs | 576 |
| Rule-classified valid continuations | **0** |
| Video evidence | **unavailable** |

**Blocking prerequisite for threshold approval:** insufficient manually reviewed ground truth (KI-010).

### 6.4 Ground-truth sample classification

From `reports/stage20_link_ground_truth_sample.json`:

| Classification | Count |
|----------------|------:|
| `invalid_across_stage17_gap` | 454 |
| `invalid_across_session_boundary` | 122 |
| `valid_same_track_continuation` | **0** |
| `ambiguous` | **0** |

---

## 7. Amendment A hardening (out of scope for B semantics)

Three Amendment A codes lack direct unit tests (see specification §11):

- `A-ART-001`, `A-ART-002`, `A-LNK-004`

**Recommendation:** close in a small **Amendment A hardening patch** before B-MOTION implementation; does not block B specification review.

**Separate known issue:** Stage 19 v4 concurrent-publication flaky test (pre-existing; not Amendment B).

---

## 8. Protected artifacts

No protected files modified during this investigation. Verified unchanged:

- `lane_divider_supported_runs_v0.json`, `lane_divider_supported_runs_v1.json`
- `stage19_bundle/current.json` (sole `current.json` in repo)
- Stage 19 v1–v5 bundle manifests
- `lib/stage19_spec/config.js` (`maxSpatialJumpM: 12`)
- `lib/version.js` (`2026-07-24-fusion-v11`)

---

## 9. Recommendation inputs

| Question | Answer |
|----------|--------|
| Can B-MOTION be specified now? | Yes — as optional overlay module with **unapproved** threshold |
| Can B-MOTION be threshold-approved now? | **No** — additional motion ground truth required |
| Can B-TRAV schemas be specified now? | Yes — validators and fixtures; no production records |
| Can real data reach genuine cross-pass today? | **No** — 0 corridor linkages |
| Is zero genuine evidence valid? | **Yes** |

---

*Investigation complete — specification deliverables follow.*
