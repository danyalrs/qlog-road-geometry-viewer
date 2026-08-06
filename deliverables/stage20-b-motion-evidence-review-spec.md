# B-MOTION Evidence Review Specification

**Status:** APPROVED FOR EVIDENCE COLLECTION (not threshold approval)  
**Version:** `stage20-b-motion-evidence-review-spec-v1`  
**Date:** 2026-07-28  
**Parent:** [stage20-amendment-b-specification.md](./stage20-amendment-b-specification.md)

---

## 1. Purpose

Define the manual evidence collection process for B-MOTION (`stage20_motion_linking_v0`) **before** any `RESIDUAL_CAP_M` threshold approval.

This specification does **not** implement B-MOTION, approve thresholds, or generate validated linkage records.

---

## 2. Review manifest

**File:** `deliverables/stage20-b-motion-evidence-review-manifest.json`  
**Builder:** `scripts/stage20_b_motion_review_manifest_build.js` (read-only generator)  
**Minimum pairs:** 200 (manifest contains **220**)

Each `reviewPairs[]` entry includes:

| Field | Description |
|-------|-------------|
| `reviewPairId` | Stable `{obsA}\|{obsB}` key |
| `observationIdA`, `observationIdB` | Stage 16 FKs |
| `segmentId`, `chunkId*`, `temporalPassId*`, `poseSectionId*` | Scoped identity |
| `logMonoTimeA/B`, `deltaTimeS` | Temporal evidence |
| `spatialM`, `poseDisplacementM`, `residualAfterPoseM` | Displacement evidence |
| `speedMps`, `expectedMotionM`, `routeSGapM` | Motion model inputs |
| `headingDiffDeg`, `lateralDeltaM` | Orientation / lateral |
| `stage17GapIntersection`, `rev37StaticEdgePass` | Boundary context |
| `ruleDerivedClassification` | **Pre-review pseudo-label — not ground truth** |
| `stratificationBucket` | Review queue category |
| `qlogReference` | `qlog_f449c_{segmentId}.bz2` |
| `videoReference` | `qlog:{file}:modelV2` placeholder |
| `videoAvailableInWorkspace` | Boolean at generation time |
| `reviewerLabel` | **null until manual review** |
| `reviewerNotes` | **null until manual review** |
| `reviewStatus` | `pending` \| `reviewed` \| `skipped` |
| `evidenceProvenance` | Generator metadata |

---

## 3. Required stratification coverage

The 220-pair manifest targets these buckets:

| Bucket | Target | Purpose |
|--------|-------:|---------|
| `gap_case` | 50 | Stage 17 gap boundaries |
| `session_boundary` | 30 | Cross-segment pairs |
| `chunk_boundary` | 15 | Chunk scope violations |
| `pose_section_boundary` | 15 | Pose-section scope |
| `pass_boundary` | 20 | Cross-pass candidates |
| `clear_continuation` | 20 | Rule-derived Rev37 pass (needs manual confirm) |
| `motion_residual_candidate` | 25 | Low pose residual, fails raw cap |
| `low_displacement` | 15 | spatialM < 12 m |
| `mid_displacement` | 15 | 12–35 m |
| `high_displacement` | 15 | ≥ 35 m |
| `stationary_or_drift` | 10 | speed < 0.5 m/s |
| `heading_change` | 10 | headingDiff ≥ 15° |

---

## 4. Reviewer labels (manual only)

| Label | Meaning |
|-------|---------|
| `positive_continuation` | Same within-track continuation — should link under correct motion model |
| `negative_non_continuation` | Should not link — boundary, gap, different feature, or motion incoherent |
| `unresolved` | Insufficient video/context — exclude from threshold calibration |

**Rule-derived classifications must not be copied into `reviewerLabel` without independent review.**

---

## 5. Review procedure

1. Open qlog video for `qlogReference` (modelV2 lane lines + vehicle motion context).
2. Inspect consecutive observations A→B on the same parent track context.
3. Assign `reviewerLabel` and optional `reviewerNotes`.
4. Record reviewer identity in manifest envelope `provenance.reviewerId` on submit.
5. Never approve `RESIDUAL_CAP_M` from rule-derived counts alone.

---

## 6. Relationship to misnamed ground-truth file

`reports/stage20_link_ground_truth_sample.json` is a **rule-derived candidate sample** — see [reports/stage20_link_candidate_pair_sample_v1.terminology.md](../reports/stage20_link_candidate_pair_sample_v1.terminology.md).

This manifest supersedes it for manual review purposes but does not delete the historical file.

---

## 7. B-TRAV boundaries (unchanged)

Traversal evidence remains specification-only. No promotion from motion similarity, geometry overlap, route-s overlap, or `dividerCorridorId` equality.

---

*Evidence collection specification — not implementation authorization.*
