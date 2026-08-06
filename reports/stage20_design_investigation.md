# Stage 20 — Design and Specification Investigation

**Generated:** 2026-07-28T03:12:09Z  
**Mode:** Read-only design and specification investigation — **not approved, not implementation**  
**Checkpoint reference:** `2026-07-27-stage19-v5`  
**Frozen baseline:** `2026-07-24-fusion-v11`  
**Stage 19 spec:** Revision 37 (unchanged)

---

## Executive Summary

Stage 19 dataset-sensitivity investigation established that **matching and filtering logic is the primary cause** of 5,809 singleton chains. This Stage 20 investigation decomposes that into **two independent problems**:

1. **Missing explicit metadata** on `supportedRuns` (`temporalPassId`, `chunkId`, `poseSectionId`) — blocks all cross-pass evidence.
2. **Raw 12 m euclidean spatial cap** — incompatible with ~2 s modelV2 spacing and ~33 m median displacement.

**Recommendation:** **PROCEED WITH METADATA PROPAGATION SPECIFICATION FIRST** (Amendment A before Amendment B).

**Recommended architecture:** Option 4 — separate versioned layers for metadata propagation and motion-aware linking, consuming immutable Stage 19 v5 artifacts.

---

## 1. Metadata Provenance Findings

See full table: [stage20_metadata_provenance.md](./stage20_metadata_provenance.md)

| Finding | Detail |
|---------|--------|
| Earliest correct propagation point | **Stage 17B** `fuseTrackSupportedRuns()` / `flushRun()` |
| Current drop location | `buildSupportedRunTemplate()` omits boundary IDs; fusion does not copy from track |
| Stage 18 partial recovery | In-memory enrichment only (`stage18_run_eligibility.js`) |
| Stage 19 impact | `buildCrossPassCandidates()` reads `run.temporalPassId` → **878/878 undefined** |
| `parentTrackId` parsing | **Not normative** — 0 parent prefixes span multiple passes |

---

## 2. Cross-Pass Identity Design (Amendment A Preview)

### Same-pass definition

Two observations qualify as **same-pass** when:

- `chunkId` equal and non-null
- `temporalPassId` equal and non-null
- `poseSectionId` equal (or both null with explicit sentinel policy)
- Same `segmentId` (session)
- `evidenceUnitKey` identical

### Cross-pass definition

Two supported runs are **genuinely cross-pass** when:

- Same `parentTrackId` spatial corridor (shared divider hypothesis)
- **Different** authoritative `temporalPassId` values (not inferred from ID format)
- Same `chunkId` and `poseSectionId` (same spatial frame, different traversal)
- Route-s overlap ≥ `minCrossPassTrajectoryOverlapM` (5 m, Rev 37)
- Neither run has `interpolationMetadata.permitted === true`

### False cross-pass prevention

| Blocker | Mechanism |
|---------|-----------|
| Same traversal, different chunks | `chunkId` must match for cross-pass pair; cross-chunk is rejection not cross-pass |
| Same pass, different IDs | Authoritative fields compared, not string parsing |
| Duplicated evidence | `evidenceUnitKey` + `featurePairId` uniqueness gates |
| Self-pairs | `temporalPassIdLo === temporalPassIdHi` rejected |
| Post-hoc ID assignment | IDs copied at run creation from track, not after grouping |

---

## 3. Motion-Linking Alternatives (5010 Pairs)

Evaluated on consecutive pairs within 573 multi-observation partition units. Full results: `stage20_design_investigation.json` → `linkingApproaches`.

| ID | Approach | Links formed | Notes |
|----|----------|-------------|-------|
| **A** | Rev37 `staticBranchCandidateEdge` (12 m raw euclidean) | **0** | Normative baseline |
| **A_fixed** | 50 m fixed spatial (experimental) | 17 | **Not approved** |
| **B** | speed × Δt adaptive | 17 | High false-link risk |
| **C** | Pose displacement residual ≤ 12 m | 9 | |
| **D** | \|routeS − speed×Δt\| ≤ 12 m | 17 | Route-s already consistent (median residual 1.0 m) |
| **E** | Motion-compensated frame (pose proxy) | 9 | |
| **F** | Separate along-track + lateral | 8 | |
| **G** | Motion prediction + hard cap | 17 | |
| **H** | 12 m residual after pose compensation | 9 | **12 m better as residual cap** |

### Key measurements

| Metric | Value |
|--------|-------|
| Pairs with spatial-only failure (no gap) | 19 |
| Pairs with gap-only failure | 608 |
| Pairs failing both | 4,372 |
| Median \|routeS − speed×Δt\| (all 5010) | **1.02 m** |
| Median raw spatial separation | **32.98 m** |
| No-boundary pairs (same chunk/pass/section/segment, no gap) | 20 |
| Rev37 static pass on no-boundary pairs | 0 |

**Conclusion:** The 12 m constant is inappropriate as a **raw displacement cap** at ~0.5 Hz sampling. It may be appropriate as a **residual safety cap** after motion compensation. Threshold selection is **not approved** — requires expanded ground-truth review.

---

## 4. Ground-Truth Sample

**File:** `stage20_link_ground_truth_sample.json`

| Item | Value |
|------|-------|
| Target segments | 2, 6, 54, 58, 99 + controls 0, 7, 10, 20, 26, 30, 40, 46, 57, 62 |
| Candidate pairs | 576 |
| Classifications | 454 `invalid_across_stage17_gap`, 122 `invalid_across_session_boundary` |
| Video evidence | **Unavailable** (no qlog files in workspace) |
| Manual review required | Rule-based only; precision/recall targets deferred |

**Limitation:** Target-segment sample contains no `valid_same_track_continuation` or `ambiguous` pairs under current rules — expanded sampling required for Amendment B threshold approval.

---

## 5. Architecture Options

| Option | Description | Verdict |
|--------|-------------|---------|
| 1 | Amend Rev 37, replace v5 | **Rejected** — rewrites approved evidence |
| 2 | Stage 20 layer on v5 output only | Insufficient — metadata missing upstream |
| 3 | Upstream v1 artifact, Stage 20 consumes | **Partial** — good for Amendment A |
| **4** | **Separate layers for A and B** | **Recommended** |

### Recommended: Option 4

- **Amendment A:** `lane_divider_supported_runs_v1.json` with explicit boundary IDs; Stage 20 cross-pass consumer
- **Amendment B:** New motion-aware linking spec module; does not modify Rev 37 constants in place
- **Stage 19 v5 bundle:** Immutable baseline; `current.json` unchanged until explicit publication authorization
- **Frozen v11:** Unchanged

### Implementation order

1. Amendment A — metadata propagation specification and validation
2. Amendment B — motion-aware linking specification (requires expanded ground truth)
3. Stage 20 implementation checkpoint (future — not this task)

---

## 6. Acceptance Metrics

### Amendment A (proposed)

- 100% `temporalPassId` and `chunkId` coverage on supported runs
- 100% `poseSectionId` where parent track has section
- Zero same-pass pairs counted as cross-pass
- Zero FK conflicts; deterministic serialization
- Stage 19 v5 bundle unchanged; v11 geometry unchanged
- Cross-pass candidates > 0 only with genuine multi-pass evidence (not claimed until validated)

### Amendment B (proposed)

- Zero prohibited boundary violations
- Deterministic chain construction
- Precision/recall on reviewed sample — **targets deferred** (need ≥ 200 reviewed pairs; current valid continuations under Rev37 on no-boundary set: 0)
- No cross-pass claim from same-track chains alone

---

## 7. Backward Compatibility

| Component | Change class |
|-----------|--------------|
| `lane_divider_supported_runs_v0.json` | No change (immutable) |
| New `lane_divider_supported_runs_v1.json` | Versioned additive |
| Stage 19 v5 bundle | No change |
| `lib/stage19_spec/*` | Investigation required for Amendment B |
| Tests | Additive for A/B validation |
| API / viewer | Additive fields |
| `current.json` | No change until authorized |

---

## 8. Truthfulness Confirmation

| Statement | Status |
|-----------|--------|
| Stage 19 v5 approved for dataset-sensitivity auditing only | **Confirmed** |
| Rev 37 unchanged | **Confirmed** |
| Experimental 50 m overlay non-normative | **Confirmed** |
| Zero real multi-obs chains under approved defaults | **Confirmed** |
| Zero genuine cross-pass evidence | **Confirmed** |
| Production lane counting disabled | **Confirmed** |
| HD-map incomplete | **Confirmed** |
| No deployment authorized | **Confirmed** |
| Frozen v11 unchanged | **Confirmed** |
| `current.json` unchanged | **Confirmed** |
| Published v5 bundle unchanged | **Confirmed** |

---

## 9. Validation

| Command | Exit | Result |
|---------|------|--------|
| `node reports/stage20_design_investigation_runner.js` | 0 | Investigation JSON + ground-truth sample written |
| `npm test` | 0 | 432/432 pass, 0 skipped |

---

## 10. Deliverables

| File | Status |
|------|--------|
| `reports/stage20_design_investigation.json` | Created |
| `reports/stage20_design_investigation.md` | This file |
| `reports/stage20_metadata_provenance.md` | Created |
| `reports/stage20_link_ground_truth_sample.json` | Created |
| `deliverables/stage20-amendment-a-draft.md` | Created |
| `deliverables/stage20-amendment-b-draft.md` | Created |
| `deliverables/stage20-draft-specification.md` | Created |
| `reports/stage20_design_investigation_runner.js` | Created (read-only) |

---

## Unresolved Evidence Gaps

1. No qlog source files — video-supported ground truth unavailable
2. Only 20 no-boundary consecutive pairs — insufficient for Amendment B threshold approval
3. Zero Rev37-valid continuations on no-boundary pairs in automated sample
4. No demonstrated multi-pass supported runs under current schema
5. Precision/recall numeric targets require ≥ 200 manually reviewed pairs

---

**Final recommendation:** **PROCEED WITH METADATA PROPAGATION SPECIFICATION FIRST**
