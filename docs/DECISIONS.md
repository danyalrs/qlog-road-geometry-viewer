# Technical Decisions

**Last updated:** 2026-07-28

Major technical decisions with context, alternatives, evidence, risks, and current status.

---

## D-001: Corrected modelV2 event identification

| Field | Detail |
|-------|--------|
| **Context** | Early decoder treated lane-line slots incorrectly; right-ego lane used index 0 instead of 1 |
| **Decision** | Correct slot semantics: index 0 = outer-right; 1 = inner-right ego; 2 = inner-left ego; 3 = outer-left. Right ego corrected from index 0 → 1 on all 2,761 frames |
| **Alternatives** | Keep legacy indexing (rejected — systematic lateral-order errors) |
| **Evidence** | `checkpoints/admiral-investigation-2026-07-23.md` (road-edge interval metrics, corrected denominators) |
| **Risks** | Downstream Stage 16–17 association depends on correct lane slot identity |
| **Status** | **Accepted** — incorporated in frozen pipeline |

---

## D-002: GPS extraction and validation

| Field | Detail |
|-------|--------|
| **Context** | Raw GPS requires accuracy bounds, jump detection, and interpolation at model timestamps |
| **Decision** | Validate via `lib/gps_validate.js`; interpolate with `lib/alignment.js`; reject records exceeding `maxAccuracyM` (default 50 m) and implied speed limits |
| **Alternatives** | Unfiltered GPS (rejected — pose gaps and fusion instability) |
| **Evidence** | `lib/process_route.js` options; `extract_gps.js` |
| **Risks** | Over-aggressive rejection reduces observation count |
| **Status** | **Accepted** — frozen in v11 |

---

## D-003: Chunking and pass-aware fusion

| Field | Detail |
|-------|--------|
| **Context** | Long routes need temporal chunking; multi-pass routes must not fuse across passes |
| **Decision** | Stage 8 temporal-pass separation (frozen); `lib/chunking.js` chunks frames; fusion respects pass/section boundaries; Stage 17 chunk-boundary policy forbids cross-chunk association |
| **Alternatives** | Single-chunk full-route fusion (rejected — pass contamination) |
| **Evidence** | `checkpoints/admiral-investigation-2026-07-23.md` § Stage 8; `lib/stage17_tracking_schema.js` → `PASS_OR_SECTION_BOUNDARY` |
| **Risks** | Missing explicit `temporalPassId` on supported runs blocks Stage 19 cross-pass (see D-010) |
| **Status** | **Accepted** for v11 and Stages 16–17; metadata propagation gap remains open |

---

## D-004: Movement-state and pose-continuity handling

| Field | Detail |
|-------|--------|
| **Context** | Stationary vs moving classification and pose discontinuities affect pass detection and section splits |
| **Decision** | Stage 6 movement state (`2026-07-24-pose-v7` for movement-only audits); Stage 7 pose continuity v8; Stage 9 pose-section v10 with circular-speed fix |
| **Alternatives** | Pose-section fusion without movement gating (rejected — v7→v8 regression demonstrated harm) |
| **Evidence** | `lib/pose_continuity.js`; `checkpoints/admiral-investigation-2026-07-23.md` § Stage 6–9 |
| **Risks** | Aggressive section splits reduce contiguous evidence |
| **Status** | **Accepted** — frozen |

---

## D-005: Stage 17 tracker design

| Field | Detail |
|-------|--------|
| **Context** | Lane-divider observations must be associated temporally into tracks and supported runs |
| **Decision** | Hungarian association with ambiguity rejection; explicit gap reasons; supported-run fusion separate from v11 polygons; prototype thresholds (`maxAssociationCost: 12`, `maxTimeGapSec: 4.0`) |
| **Alternatives** | Greedy nearest-neighbour only (rejected — crossing and ambiguity failures) |
| **Evidence** | `lib/stage17_divider_association.js`, `audit_stage17_lane_divider_tracking.json` |
| **Risks** | Prototype thresholds not validated as production limits |
| **Status** | **Approved** for prototype pipeline; produces 573 multi-obs tracks upstream of Stage 19 |

---

## D-006: Preservation of frozen v11 geometry

| Field | Detail |
|-------|--------|
| **Context** | Stage 19 must not alter road-surface fusion baseline |
| **Decision** | `lib/version.js` frozen at `2026-07-24-fusion-v11`; 28 protected files including `lib/stage19_spec/*`; hash verification on every Stage 19 checkpoint |
| **Alternatives** | Coupled geometry+tuning changes (rejected — invalidates delivery-readiness audits) |
| **Evidence** | `checkpoints/stage19-implementation-2026-07-27-stage19-v5.json`; `audit_stage19_dataset_sensitivity.json` → `v11GeometryModified: false` |
| **Risks** | Real-dataset singleton behaviour may reflect geometry–threshold interaction, but v11 compare shows 0 segment differences |
| **Status** | **Enforced** |

---

## D-007: Stage 19 approval boundaries

| Field | Detail |
|-------|--------|
| **Context** | Stage 19 v5 passed full validation but real dataset shows no multi-obs chains |
| **Decision** | Approve v5 **for dataset-sensitivity auditing only** — not production lane counting, not deployment, not threshold correction |
| **Alternatives** | Full production approval (rejected — insufficient real-dataset chain evidence); block v5 entirely (rejected — fixture paths verified) |
| **Evidence** | Independent validation outcome; `audit_stage19_dataset_sensitivity.json` → `productionLaneCountImplemented: false` |
| **Risks** | Misinterpreting audit tooling as production lane counter |
| **Status** | **Active boundary** |

---

## D-008: 12 m static spatial cap (not the experimental 50 m overlay)

| Field | Detail |
|-------|--------|
| **Context** | `staticBranchCandidateEdge` in `lib/stage19_spec/geometry.js` enforces `maxSpatialJumpM: 12` from Rev 37 config |
| **Decision** | **12 m remains the approved static spatial cap.** The investigation's 50 m overlay is experimental read-only sensitivity only |
| **Alternatives** | Adopt 50 m based on experimental 7-chain result (rejected — not approved; cross-pass still 0; P3 selected still 0) |
| **Evidence** | `lib/stage19_spec/config.js`; `reports/stage19_dataset_sensitivity_investigation.json` → `experimentalSensitivity` |
| **Risks** | Median displacement ~33 m means most consecutive pairs fail spatial check — by design until separately investigated |
| **Status** | **No threshold correction approved** |

---

## D-009: Explicit metadata propagation vs motion-aware linking

| Field | Detail |
|-------|--------|
| **Context** | 878/878 supported runs lack `temporalPassId` and `chunkId`; cross-pass requires pass grouping |
| **Decision** | Investigate explicit metadata propagation **separately** from motion-aware static linking thresholds. Investigation attributed singleton chains primarily to matching/filtering logic (spatial cap), not as sole metadata issue |
| **Alternatives** | Conflate metadata fix with spatial threshold change (rejected — distinct root causes) |
| **Evidence** | `reports/stage19_dataset_sensitivity_investigation.json` → `dataAlignment`, `crossPassBlockers` |
| **Risks** | Metadata propagation alone may not create multi-obs chains if spatial cap unchanged |
| **Status** | **Open investigation topic** for Stage 20 design — not approved implementation |

---

## D-010: Rev 37 sensitivity scope (baseline recording only)

| Field | Detail |
|-------|--------|
| **Context** | Normative spec defines parameter constants but dataset has no cross-pass or multi-obs chains |
| **Decision** | Approved sensitivity production records baseline outcomes per parameter; does not authorize alternate ranges or config mutation |
| **Alternatives** | Normative parameter sweeps on real data (not possible — zero deltas) |
| **Evidence** | `lib/stage19_sensitivity_production.js`; investigation `approvedSensitivity` section |
| **Risks** | Experimental overlays in investigation must not be confused with Rev 37 authority |
| **Status** | **Active** |

---

## D-011: Production lane counting deferred

| Field | Detail |
|-------|--------|
| **Context** | Stages 15–18 define prototype lane-counting; Stage 19 audits evidence |
| **Decision** | `productionLaneCountImplemented: false` — lane counting remains design/prototype only |
| **Alternatives** | Promote Stage 18 assessments to production counts (rejected — insufficient evidence, 5× hold) |
| **Evidence** | `lib/stage15_lane_counting_design.js`; `audit_stage19_dataset_sensitivity.json` |
| **Risks** | User-facing outputs could be misread as authoritative lane counts |
| **Status** | **Deferred** |

---

## Rejected Alternatives (summary)

| Alternative | Reason rejected | Evidence |
|-------------|-----------------|----------|
| 25 m spatial overlay as new cap | Zero multi-obs chains; not approved | Investigation experimental rows |
| 50 m spatial overlay as new cap | Only 7 chains; P3 selected 0; cross-pass 0; experimental only | Investigation |
| Combined relaxed geometry as production config | Same as 50 m — marginal, experimental | Investigation |
| v4 implementation approval | D1/D2/D3/D6 partially verified | Superseded by v5 |
| 50 m spatial as production cap | Experimental only; not approved | Stage 20 investigation |
| `parentTrackId` parsing for cross-pass | Ambiguous; 0 multi-pass parents | Amendment A design |
| Amendment B before Amendment A | Cross-pass blocked without metadata | Stage 20 investigation |
| In-place Rev 37 geometry edit for motion | Protected spec; use new module | Stage 20 architecture Option 4 |

---

## D-012: Stage 20 architecture — Option 4 (separate Amendment A and B layers)

| Field | Detail |
|-------|--------|
| **Context** | Two independent root causes: missing metadata vs raw spatial cap |
| **Decision** | Retain Stage 19 v5 bundle immutable; add `lane_divider_supported_runs_v1` (Amendment A) and optional motion-linking module (Amendment B); do not amend Rev 37 in place |
| **Alternatives** | Option 1 replace v5 (rejected); Option 2 Stage 20 on v5 only (insufficient for metadata); Option 3 upstream only (insufficient for motion) |
| **Evidence** | `reports/stage20_design_investigation.json` → `architectureRecommendation` |
| **Risks** | Multiple versioned artifacts increase consumer complexity |
| **Status** | **Draft recommendation — not approved for implementation** |

---

## D-013: Implementation order — Amendment A before Amendment B

| Field | Detail |
|-------|--------|
| **Context** | Cross-pass requires metadata; motion linking does not provide cross-pass |
| **Decision** | Proceed with metadata propagation specification first |
| **Alternatives** | Motion linking first (rejected — cannot unblock cross-pass); parallel (rejected — B lacks ground truth) |
| **Evidence** | 878/878 runs missing metadata; 0 cross-pass candidates |
| **Risks** | Amendment A alone does not fix singleton chains |
| **Status** | **Draft recommendation** |

---

## D-014: 12 m as residual cap (hypothesis only — not approved)

| Field | Detail |
|-------|--------|
| **Context** | Median raw spatial 32.98 m; median \|routeS − speed×Δt\| ≈ 1.0 m |
| **Decision** | Investigate 12 m as **residual cap after pose compensation**, not as raw euclidean cap — **threshold not approved** |
| **Alternatives** | 50 m raw cap (rejected — experimental); route-s only (insufficient alone) |
| **Evidence** | `reports/stage20_design_investigation.json` → `linkingProblem.twelveMeterBetterAsResidualCap` |
| **Risks** | Only 20 no-boundary pairs; precision/recall sample insufficient |
| **Status** | **Open — requires expanded ground truth** |

---

## D-015: segmentId on supported runs — member-uniform derivation

| Field | Detail |
|-------|--------|
| **Context** | Tracks carry `segmentIds[]`; supported runs need singular `segmentId` |
| **Decision** | `segmentId` = uniform member observation segmentId; reject run if members differ; must be element of `track.segmentIds` |
| **Alternatives** | Copy first observation only (rejected); parse from trackId (rejected) |
| **Evidence** | `lane_divider_tracks_v0.json` structure; Amendment A spec §3.2 Step 4 |
| **Status** | **Draft specification** |

---

## D-018: `parentTrackId` is pass-local — not corridor identity

| Field | Detail |
|-------|--------|
| **Context** | v1 Amendment A spec required same `parentTrackId` with different `temporalPassId` for cross-pass |
| **Decision** | `parentTrackId` = `trackId` = `{chunkId}:{temporalPassId}:{poseSectionId}:{trackIndex}`; one track, one pass; **cannot** group cross-pass runs |
| **Alternatives** | Redefine `parentTrackId` to span passes (rejected — FK violation); geometry overlap as identity (rejected) |
| **Evidence** | `lib/stage17_divider_association.js` L279; track schema; 3 proven multi-pass corridors with different `parentTrackId` per pass |
| **Status** | **Draft specification v2** |

---

## D-021: `dividerCorridorId` is comparison key only — not corridor identity (v3)

| Field | Detail |
|-------|--------|
| **Context** | v2 treated `{chunkId}:{poseSectionId}:{trackIndex}` as authoritative corridor identity |
| **Decision** | `dividerCorridorId` is a **within-segment comparison key**; corridor identity requires Stage 20 `roadCorridorId` on validated linkage records |
| **Alternatives** | Numeric tuple equality as proof (rejected); geometry overlap (rejected) |
| **Evidence** | `poseSectionId` pass-local; `chunkId` segment-local; Stage 17 `boundaryKey()` includes pass |
| **Status** | **Draft specification v3** |

---

## D-022: Corridor linkage records required for cross-pass promotion

| Field | Detail |
|-------|--------|
| **Context** | No upstream artifact maps pose sections across passes |
| **Decision** | Stage 20 creates `lane_divider_corridor_linkage_v0.json`; structural promotion requires `validationState: validated` |
| **Real data** | 3 cross-segment key collisions — linkage hypotheses only |
| **Status** | **Draft specification v3** |

---

## D-019: `dividerCorridorId` as cross-pass comparison identity

| Field | Detail |
|-------|--------|
| **Context** | No existing artifact field groups runs from different temporal passes for the same lateral divider hypothesis |
| **Decision** | New field `dividerCorridorId` = `{chunkId}:{poseSectionId}:{trackIndex}` assigned at `flushRun()`; cross-pass requires equal corridor ID, different `parentTrackId` |
| **Alternatives** | Group by `parentTrackId` (rejected — contradictory); group by geometry overlap (rejected) |
| **Evidence** | Corridor `0:4:0` ↔ tracks `0:0:4:0`, `0:1:4:0`; Amendment A spec v2 §3.2 |
| **Risks** | Cross-segment corridors (64 vs 57) yield provisional only until traversal proof exists |
| **Status** | **Superseded by D-021 (v3)** |

---

## D-020: Identifier scope for cross-pass comparison

| Field | Detail |
|-------|--------|
| **Context** | Locally scoped IDs must not be compared outside their scope |
| **Decision** | `chunkId` segment-local; `poseSectionId` pass-local; `segmentId` equality required for same-pass, not for cross-pass; cross-segment corridor comparison requires linkage proof |
| **Alternatives** | Require equal `segmentId` for all cross-pass (rejected — contradicts evidence) |
| **Evidence** | `lib/chunking.js`; corridor `0:4:0` segments 64 vs 57; Amendment A spec v2 §4 |
| **Status** | **Retained in v3** |

---

## D-023: Amendment A v3 implementation approved

| Field | Detail |
|-------|--------|
| **Context** | Approved spec v3; metadata propagation at `flushRun()` |
| **Decision** | Implement v1 artifact emission; linkage schema validation only; no auto-generated validated linkage |
| **Checkpoint** | `2026-07-28-stage20-amendment-a-v1` |
| **Status** | **Implemented — acceptance audited; not production-approved** |

---

## D-024: Amendment B scope — B-MOTION vs B-TRAV

| Field | Detail |
|-------|--------|
| **Context** | Informal descriptions conflate “motion-aware cross-pass” with Amendment B |
| **Decision** | **Canonical Amendment B = B-MOTION** (within-track pose-residual linking). **B-TRAV** (traversal evidence/linkage artifacts) is a separate bounded sub-spec resolving Amendment A §14 Q1 — not cross-pass linking |
| **Alternatives** | Redefine Amendment B as traversal-only (rejected — contradicts `stage20-amendment-b-draft.md`, D-012, D-013) |
| **Evidence** | `deliverables/stage20-amendment-b-investigation.md` §1 |
| **Status** | **Draft specification v1** |

---

## D-027: Link sample terminology — not manual ground truth

| Field | Detail |
|-------|--------|
| **Context** | `reports/stage20_link_ground_truth_sample.json` misnamed as ground truth |
| **Decision** | Document as **rule-derived candidate-pair sample**; preserve original file; correct living docs |
| **Evidence** | `reports/stage20_link_candidate_pair_sample_v1.terminology.md` |
| **Status** | **Corrected** |

---

## D-026: Amendment B specification approved for review (not implementation)

| Field | Detail |
|-------|--------|
| **Context** | Amendment B v1 specification package complete; prerequisite hardening stage |
| **Decision** | Approve B-MOTION + B-TRAV specifications at **specification-review level only**; implementation, threshold approval, and production promotion remain unauthorized |
| **Evidence** | `deliverables/stage20-amendment-b-specification.md`; evidence manifest 220 pairs |
| **Status** | **Approved for specification review** |

---

## D-025: B-TRAV prerequisite — corridor linkage before validated traversal

| Field | Detail |
|-------|--------|
| **Context** | Genuine cross-pass requires validated corridor + traversal linkage (Amendment A v3 §6) |
| **Decision** | Validated traversal linkage records require validated corridor linkage FK. Provisional traversal hypotheses permitted but unavailable for structural/genuine promotion without corridor linkage |
| **Alternatives** | Auto-promote from motion similarity or `dividerCorridorId` equality (rejected) |
| **Evidence** | Real data: 0 validated corridor linkages → 0 genuine evidence |
| **Status** | **Draft specification v1** |

---

## D-016: Cross-pass genuine vs provisional classification

| Field | Detail |
|-------|--------|
| **Context** | Different `temporalPassId` ≠ proven separate traversals |
| **Decision** | Structural candidate requires traversal proof for `genuine`; else `provisional` with `A-XPS-007` |
| **Alternatives** | Treat any different passId as genuine (rejected) |
| **Evidence** | Stage 20 investigation: 0 multi-pass parent prefixes |
| **Status** | **Draft specification** |

---

## D-017: Stage 18 re-join non-normative for cross-pass

| Field | Detail |
|-------|--------|
| **Context** | Stage 18 currently re-joins track metadata in-memory for v0 runs |
| **Decision** | Re-join permitted audit-only; normative cross-pass requires v1 explicit fields |
| **Alternatives** | Continue silent re-join in Stage 19 (rejected — masks schema defect) |
| **Status** | **Draft specification** |
