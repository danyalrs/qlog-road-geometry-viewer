# Amendment B (Draft) — Motion-Aware Within-Track Chain Linking

**Status:** DRAFT — NOT APPROVED  
**Investigation date:** 2026-07-28  
**Parent specification:** Stage 19 Revision 37 (unchanged in place)  
**Does not provide:** Cross-pass evidence (see Amendment A)  
**Threshold status:** NOT APPROVED — evidence insufficient for final selection

---

## 1. Problem Statement

Stage 19 static partition linking uses `staticBranchCandidateEdge()` with a **raw euclidean** 3D displacement cap of 12 m. At ~0.5 Hz modelV2 sampling (~2.0 s median interval), median consecutive spatial separation is **32.98 m** while median |routeS − speed×Δt| is **~1.0 m**. The 12 m cap therefore rejects vehicle motion that is consistent with pose and route-s evidence.

573 Stage 17 multi-observation units produce **zero** static links under Rev 37. This is independent of missing cross-pass metadata.

---

## 2. Scope

### In scope

- Replace or supplement raw euclidean cap with motion-aware residual check
- Retain hard safety caps and all boundary rejections (chunk, pass, section, session, Stage 17 gap)
- Deterministic chain construction
- Stationary, low-speed, high-speed, and long-Δt behaviour specification

### Non-goals

- Cross-pass candidate formation
- Relaxing chunk, session, temporal-pass, or pose-continuity boundaries to increase chain count
- Treating every Stage 17 track continuation as automatically valid
- Approving 50 m experimental overlay as production threshold
- Modifying frozen v11 geometry
- Changing published Stage 19 v5 bundle

---

## 3. Normative Inputs

| Input | Source | Required? |
|-------|--------|-----------|
| Match hi endpoints (e, n, u) | Stage 19 match builder | Yes |
| `logMonoTime` | Stage 16 observation | Yes |
| `poseRecord.east`, `poseRecord.north` | Stage 16 observation | Yes for pose residual |
| `poseRecord.speed` | GPS interpolation | Yes for speed model; see missing handling |
| `routeS` (sLoUm/sHiUm) | Match record | Yes |
| `headingDegLo`, `tangentLoDeg` | Match record | Yes |
| `meanLateralOffsetUm` | Match record | Yes |
| Stage 17 gap injection | Runtime | Yes |

---

## 4. Proposed Motion Model (Draft — Not Selected)

**Preferred candidate:** Approach H — **residual cap after pose compensation**

### Expected displacement

```
poseDisplacementM = hypot(east_B - east_A, north_B - north_A)
```

Using vehicle pose at observation timestamps (already on Stage 16 observations).

### Spatial residual

```
residualM = |euclideanHiDistanceM(match_A, match_B) - poseDisplacementM|
```

### Draft link predicate (not approved)

A static branch candidate edge `(A → B)` may be accepted when **all** hold:

1. Existing Rev 37 preliminary checks except spatial jump replaced by:
   - `residualM ≤ RESIDUAL_CAP_M` (candidate: 12 m — **not approved**)
2. `|routeSGapM| ≤ maxConsecutiveRouteSGapM` (50 m — unchanged)
3. `|headingDiff| ≤ maxLocalHeadingDeltaDeg` (30° — unchanged)
4. `|lateralDelta| ≤ maxLateralOffsetDeltaM` (2 m — unchanged)
5. No Stage 17 gap intersection
6. Same `chunkId`, `temporalPassId`, `poseSectionId`, `segmentId`
7. Slope reciprocity checks (unchanged)

### Alternative considered: route-s only (Approach D)

Median |routeS − speed×Δt| ≈ 1.0 m — route-s is already consistent. **Does not address** raw euclidean failure. Not sufficient alone.

### Rejected as production correction

| Approach | Reason |
|----------|--------|
| A_fixed 50 m | Experimental only; 17 links, 0 P3 selected, 0 cross-pass |
| B speed×Δt on raw euclidean | 17 links, high false-link risk |
| Relaxing boundaries | Violates investigation constraints |

---

## 5. Boundary Rejection (Mandatory — No Relaxation)

| Boundary | Rejection |
|----------|-----------|
| Stage 17 gap intersection | Hard reject |
| Different `chunkId` | Hard reject |
| Different `poseSectionId` | Hard reject |
| Different `temporalPassId` within unit | Hard reject (not cross-pass linking) |
| Different `segmentId` | Hard reject (session) |
| `deltaTimeS < 0` | Hard reject |
| `interpolationMetadata.permitted` on run | Hard reject |

---

## 6. Speed and Pose Missing Handling

| Case | Draft behaviour |
|------|-----------------|
| Missing `speed` | Fall back to pose displacement only; if pose also missing → reject edge |
| Missing pose | Reject edge (cannot compute residual) |
| Stationary (`speed < 0.5 m/s`) | Use `residualM` with `poseDisplacementM`; if both displacements < 2 m, allow link |
| Low speed (`< 2 m/s`) | Standard residual check |
| High speed (`> 20 m/s`) | Standard residual check + optional tighter residual cap (investigation required) |
| Long Δt (`> 5 s`) | Reject — exceeds Stage 17 association envelope |
| GPS jump (pose delta >> speed×Δt) | Reject — `pose_inconsistency` |

---

## 7. Deterministic Chain Construction

Unchanged from Rev 37:

1. Sort matches by `sLoUm`, then `observationId`
2. Greedy chain: link consecutive if motion-aware edge passes
3. Partition DP on resulting chains

Ordering and tie-break rules unchanged for backward-compatible determinism tests.

---

## 8. Ambiguity Handling

| Case | Behaviour |
|------|-----------|
| Residual near cap (within 10%) | Mark partition unit `link_ambiguous`; do not auto-promote |
| Multiple valid branch paths | Existing P3 path (fixture-validated only on real data today) |
| Conflicting motion models | Reject edge |

---

## 9. Quality Gates (Amendment B)

| Gate | Condition |
|------|-----------|
| `no_prohibited_boundary_links` | Zero links across gap/chunk/section/session |
| `deterministic_chains` | Identical chains on rerun |
| `no_cross_pass_from_same_track` | Same-track chains do not imply cross-pass |
| `residual_cap_not_raw_euclidean` | Spatial check uses residual, not raw 33 m rejection |

---

## 10. Test Matrix (Specification)

| Test | Expectation |
|------|-------------|
| Rev37 baseline unchanged when Amendment B disabled | Pass |
| Stationary pair with low residual | Link allowed |
| High-speed pair with residual > cap | Rejected |
| Gap intersection | Rejected |
| Cross-segment pair | Rejected |
| Deterministic rerun | Pass |
| v5 bundle unchanged | Pass |

---

## 11. Investigation Measurements (Read-Only)

On 5,010 consecutive pairs (see `stage20_design_investigation.json`):

| Approach | Links (boundary-filtered) |
|----------|--------------------------|
| A Rev37 | 0 |
| H pose residual ≤ 12 m | 9 |
| A_fixed 50 m (experimental) | 17 |

**No-boundary pairs:** 20 (same chunk/pass/section/segment, no gap)  
**Rev37 pass on no-boundary:** 0  
**Ground-truth valid continuations in reviewed sample:** Insufficient for precision/recall targets

---

## 12. Experiment Required Before Threshold Approval

| Requirement | Detail |
|-------------|--------|
| Minimum reviewed pairs | 200 |
| Current reviewed valid continuations | < 10 (automated rule-based) |
| Video support | Requires qlog files in workspace |
| Segments | Expand beyond 2, 6, 54, 58, 99 |
| Output | Precision/recall with 95% CI before approving `RESIDUAL_CAP_M` |

**Do not approve 12 m residual cap during this investigation** — supported as hypothesis only.

---

## 13. Migration Plan

1. Amendment B specified as optional overlay module (e.g. `stage20_motion_linking_v0`)
2. Default consumer uses Rev 37 behaviour until explicit checkpoint authorization
3. Published v5 bundle remains Rev 37 linking snapshot
4. New runs may opt into motion-aware linking via processing version tag

---

## 14. Rollback Boundary

Disable motion-aware module → Rev 37 `staticBranchCandidateEdge` exactly as v5.

---

## 15. Affected Components

| Component | Impact |
|-----------|--------|
| `lib/stage19_spec/geometry.js` | **Protected** — Amendment B requires new spec module, not in-place edit |
| `lib/stage19_partition_production.js` | Future optional consumer |
| Stage 19 v5 bundle | **No change** |
| Tests | Additive motion-linking matrix |

---

## 16. Acceptance Metrics (Proposed — Targets Deferred)

| Metric | Target | Status |
|--------|--------|--------|
| Prohibited boundary violations | 0 | Specified |
| Deterministic construction | Required | Specified |
| Precision on reviewed valid links | ≥ 95% | **Deferred** — insufficient sample |
| Recall on reviewed valid continuations | ≥ 90% | **Deferred** |
| Ambiguous link rate | < 5% of formed links | **Deferred** |
| v5 bundle modified | 0 | Required |
| Cross-pass from same-track only | 0 claims | Required |

---

## 17. Validation Without Cross-Pass Claims

Amendment B success is measured on **within-track chain formation only**. A successful Amendment B validation may show:

- Multi-observation chains > 0
- P3 eligible > 0 (fixture or real)
- Cross-pass candidates = 0 (if Amendment A not yet applied)

This is **valid and expected** during independent Amendment B validation.

---

*This document is a draft for independent review. No threshold is approved. It is not approved for implementation.*
