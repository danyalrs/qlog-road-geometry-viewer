# B-MOTION Threshold Approval Criteria

**Status:** SPECIFIED — NOT APPROVED  
**Version:** `stage20-b-motion-threshold-approval-v1`  
**Date:** 2026-07-28  
**Parent:** [stage20-amendment-b-specification.md](./stage20-amendment-b-specification.md)

No final `RESIDUAL_CAP_M` value is selected by this document.

---

## 1. Minimum evidence before threshold approval

| Criterion | Minimum | Current status (2026-07-28) |
|-----------|--------:|----------------------------|
| Manually reviewed pairs | **200** | **0** reviewed |
| Manually confirmed **positive** continuations | **≥ 30** | **0** |
| Manually confirmed **negative** non-continuations | **≥ 80** | **0** |
| Unresolved (excluded from metrics) | ≤ 20% of reviewed | N/A |
| Distinct qlog segments represented | **≥ 15** | 220 pairs span multiple segments |
| Qlog/video available for reviewed positives | **100%** of positive labels | Pending manual review |

**Blocker:** `deliverables/stage20-b-motion-evidence-review-manifest.json` has **220 pending** pairs and **zero** `reviewerLabel` values. `RESIDUAL_CAP_M` **must not** be approved.

Rule-derived `valid_same_track_continuation` counts (20 in manifest) **do not** satisfy the positive-continuation minimum.

---

## 2. Coverage requirements

### Displacement

| Range | Minimum positive + negative examples |
|-------|--------------------------------------:|
| < 12 m (below current cap) | 15 |
| 12–35 m (above cap, motion-plausible) | 40 |
| > 35 m (high separation) | 20 |

### Speed

| Regime | Minimum examples |
|--------|-----------------:|
| Stationary (< 0.5 m/s) | 10 |
| Low (0.5–5 m/s) | 20 |
| Normal (5–20 m/s) | 80 |
| High (> 20 m/s) | 10 |

### Time gap

| Δt | Minimum examples |
|----|-----------------:|
| < 2 s | 50 |
| 2–4 s | 80 |
| > 4 s | 20 |

### Boundary cases (must be negative)

| Case | Minimum negatives |
|------|------------------:|
| Stage 17 gap intersection | 40 |
| Session (segment) boundary | 30 |
| Chunk boundary | 10 |
| Pose-section boundary | 10 |
| Cross-pass (different temporalPassId) | 15 |

---

## 3. Quality metrics (on held-out validation set)

Computed only on **manually labelled** pairs with **train/validation separation** (see §5).

| Metric | Target | Notes |
|--------|--------|-------|
| Precision | ≥ **0.95** | False link rate ≤ 5% |
| Recall | ≥ **0.90** | Missed-link rate ≤ 10% |
| False-link rate | ≤ **0.05** | Primary safety gate |
| Missed-link rate | ≤ **0.10** | Primary recovery gate |
| Ambiguous rate | ≤ **0.05** of accepted links | Near-cap residuals marked `link_ambiguous` |

95% confidence intervals required for precision/recall before approval checkpoint.

---

## 4. Ambiguous-case handling

| Condition | Action |
|-----------|--------|
| Residual within 10% of candidate cap | Mark `link_ambiguous`; exclude from precision/recall numerator |
| Reviewer `unresolved` | Exclude from calibration and validation sets |
| Conflicting reviewer labels on same pair | Escalate; pair excluded until resolved |
| GPS jump / pose inconsistency | Must classify **negative** |

---

## 5. Train / calibration vs validation separation

| Set | Fraction | Use |
|-----|--------|-----|
| Calibration | ≤ 60% of labelled pairs | Threshold tuning only |
| Validation | ≥ 40% of labelled pairs | Final precision/recall gate — **single use** |

Separation by `reviewPairId` hash — deterministic, documented seed.  
**No validation-set peeking** during cap selection.

---

## 6. Reviewer provenance

Each reviewed pair must record:

- `reviewerId` (pseudonymous identifier acceptable)
- `reviewedAt` (ISO-8601 UTC)
- `reviewMethod` (`qlog_video` \| `frame_inspection` \| `dual_review`)
- `qlogReference` and frame/time cursor where applicable

Dual review required for first **50** positive labels.

---

## 7. Deterministic evaluation

Threshold candidates evaluated with:

- Fixed pair ordering (`reviewPairId` ascending)
- Frozen Rev 37 non-spatial gates unchanged
- Same Stage 17 gap injection
- Identical motion audit output hash on rerun

---

## 8. Approval checkpoint (future)

Threshold approval requires a new checkpoint (e.g. `stage20-amendment-b-motion-threshold-approved`) with:

- Labelled pair count ≥ 200
- Validation precision/recall meeting targets
- `residualCapApproved: true` in motion audit schema
- Stage 19 v5 bundle hash unchanged

---

## 9. Current blockers

1. **Zero manually confirmed positive continuations**
2. **Zero manually confirmed negative continuations**
3. Rule-derived pseudo-labels in historical sample must not be used as ground truth

Qlog files may be present in workspace (92 segments) — manual video review has **not** been performed on the manifest.

---

*Criteria specification only — no threshold selected.*
