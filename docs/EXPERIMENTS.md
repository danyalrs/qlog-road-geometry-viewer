# Experiments and Measurements

**Last updated:** 2026-08-26

**Ledger cross-reference:** Detailed method IDs (**M-001** …) are in [METHOD_EVIDENCE_LEDGER.md](./METHOD_EVIDENCE_LEDGER.md).

Reproducible experiments with configuration, scope, commands, metrics, interpretation, and classification.

**Classification:**

| Tag | Meaning |
|-----|---------|
| **NORM** | Normative / approved measurement |
| **EXP** | Experimental overlay — not approved for production |
| **FIX** | Fixture-only validation |
| **AUD** | Dataset audit (read-only) |

---

## E-001: Frozen v11 full-dataset geometry compare

| Field | Value |
|-------|-------|
| **Classification** | **NORM** |
| **Configuration** | `2026-07-24-fusion-v11` |
| **Dataset scope** | 92 segments |
| **Command** | Part of v5 validation suite (see `reports/stage19_v11_geometry_compare_v3.json`) |
| **Metrics** | segments: 92, differences: 0 |
| **Result** | All segments match frozen baseline |
| **Interpretation** | Stage 19 implementation does not alter v11 geometry |
| **Limitations** | Requires qlog files in project root |

---

## E-002: Stage 19 v5 validation suite

| Field | Value |
|-------|-------|
| **Classification** | **FIX** + **NORM** |
| **Configuration** | `2026-07-27-stage19-v5` |
| **Commands** | `npm test`; `npm run stage19:evidence`; `node scripts/stage19_independent_review.js` |
| **Metrics** | 432/432 tests pass; evidence runner exit 0; independent review exit 0 |
| **Result** | Implementation structurally verified |
| **Interpretation** | Fixture and controlled paths work; does not imply real-dataset multi-obs success |
| **Source** | `reports/stage19_v5_corrective_checkpoint_report.json` |

---

## E-003: Publication determinism repeat (30×)

| Field | Value |
|-------|-------|
| **Classification** | **FIX** |
| **Configuration** | `2026-07-27-stage19-v5` bundle build + publish |
| **Command** | `node scripts/stage19_rerun_publication_repeat.js` (default 30 reps via `STAGE19_RERUN_REPEAT`) |
| **Metrics** | pass: 30, fail: 0 |
| **Result** | Manifest byte-identical across rebuilds; no staging residue |
| **Source** | `reports/stage19_v5_corrective_checkpoint_report.json`, `reports/stage19_rerun_repeat_v4.json` (v4 baseline) |

---

## E-004: Stage 19 real-dataset baseline audit

| Field | Value |
|-------|-------|
| **Classification** | **NORM** (Rev 37 baseline recording) |
| **Configuration** | Approved Rev 37 config, checkpoint `2026-07-27-stage19-v5` |
| **Dataset scope** | Full upstream Stage 16–18 artifacts |
| **Command** | `npm run stage19:audit` or `node stage19_dataset_sensitivity_audit.js` |
| **Metrics** | |
| | — Observations: 5,809 |
| | — Singleton chains: 5,809 |
| | — Multi-obs chains: 0 |
| | — P3: 0/0/0 |
| | — Cross-pass candidates: 0 |
| | — Assessments: 5 × insufficient_evidence |
| | — Promotion: 5 × hold |
| **Result** | Baseline recorded; quality gates pass |
| **Interpretation** | Approved config produces all singletons on real data |
| **Source** | `audit_stage19_dataset_sensitivity.json`, `reports/stage19_dataset_sensitivity.md` |

---

## E-005: Rev 37 approved sensitivity table (baseline-only)

| Field | Value |
|-------|-------|
| **Classification** | **NORM** |
| **Configuration** | 7 parameters from `lib/stage19_spec/config.js` |
| **Note** | Rev 37 authorizes baseline recording only; rows do not mutate config |
| **Metrics** | All 7 rows: crossPassCount 0, multiObservationChains 0, partitionFailed 0 |
| **Result** | Zero deltas from baseline for all parameters |
| **Interpretation** | Dataset lacks cross-pass and multi-obs chains — sweeps are uninformative on real data |
| **Limitations** | Cannot validate parameter sensitivity on this dataset under approved scope |
| **Source** | `reports/stage19_dataset_sensitivity_investigation.json` → `approvedSensitivity` |

---

## E-006: Dataset-sensitivity investigation — singleton formation

| Field | Value |
|-------|-------|
| **Classification** | **AUD** |
| **Configuration** | `2026-07-27-stage19-v5`, read-only |
| **Command** | `node reports/stage19_dataset_sensitivity_investigation_runner.js` |
| **Dataset scope** | 5,809 observations; 573 multi-obs partition units |
| **Metrics** | First-failure reasons (per-observation): |
| | — spatial_distance: 4,728 (81.39%) |
| | — chunk_boundary: 683 (11.76%) |
| | — evidence_unit_identity: 226 (3.89%) |
| | — temporal_gap: 164 (2.82%) |
| | — other: 8 (0.14%) |
| **Result** | 0 static links under default config in multi-obs units |
| **Interpretation** | Spatial distance cap is dominant first-failure reason |
| **Source** | `reports/stage19_dataset_sensitivity_investigation.json` → `singletonFormation` |

---

## E-007: Near-miss pair distributions (multi-obs units)

| Field | Value |
|-------|-------|
| **Classification** | **AUD** |
| **Configuration** | Default Rev 37 thresholds |
| **Metrics** | n = 5,010 consecutive pairs |
| | — Spatial separation median: **32.984 m** (threshold 12 m) |
| | — Route-s gap median: **27.234 m** (threshold 50 m) |
| | — Heading diff median: **1.47°** (threshold 30°) |
| | — Temporal separation median: **~2.00 s** |
| **Single-condition failures** | spatial_distance: 4,084; route_s_gap: 4; heading: 0; lateral: 5 |
| **Interpretation** | Pairs are temporally close (~0.5 Hz modelV2) but spatially far relative to 12 m cap |
| **Source** | `reports/stage19_dataset_sensitivity_investigation.json` → `nearMiss` |

---

## E-008: Experimental spatial overlay — 25 m (**EXP**)

| Field | Value |
|-------|-------|
| **Classification** | **EXP** — not approved |
| **Overlay** | `{ "maxSpatialJumpM": 25 }` |
| **Metrics** | singleton: 5,809; multi-obs: 0; P3: 0/0/0; cross-pass: 0 |
| **Result** | No change from baseline |
| **Interpretation** | 25 m still insufficient for median ~33 m separation |
| **Source** | `experimentalSensitivity.rows` → `spatial_jump_25m` |

---

## E-009: Experimental spatial overlay — 50 m (**EXP**)

| Field | Value |
|-------|-------|
| **Classification** | **EXP** — **not an approved threshold** |
| **Overlay** | `{ "maxSpatialJumpM": 50 }` |
| **Metrics** | singleton: 5,793; multi-obs: **7**; P3 eligible/executed: 7/7; P3 selected: **0**; cross-pass: 0 |
| **Result** | Marginal chain formation; no P3 selection; no cross-pass |
| **Interpretation** | Demonstrates sensitivity to spatial cap; does not justify production adoption |
| **Source** | `experimentalSensitivity.rows` → `spatial_jump_50m` |

---

## E-010: Experimental route-s gap overlay — 100 m (**EXP**)

| Field | Value |
|-------|-------|
| **Classification** | **EXP** |
| **Overlay** | `{ "maxConsecutiveRouteSGapM": 100 }` |
| **Metrics** | multi-obs: 0 (unchanged) |
| **Result** | Route-s gap is not the primary blocker (median 27 m < 50 m approved cap) |
| **Source** | `spatial_jump` investigation; `route_s_gap_100m` row |

---

## E-011: Experimental heading overlay — 45° (**EXP**)

| Field | Value |
|-------|-------|
| **Classification** | **EXP** |
| **Overlay** | `{ "maxLocalHeadingDeltaDeg": 45 }` |
| **Metrics** | multi-obs: 0 |
| **Result** | Heading is not the primary blocker (median 1.47°) |
| **Source** | `heading_tol_45deg` row |

---

## E-012: Experimental lateral overlay — 5 m (**EXP**)

| Field | Value |
|-------|-------|
| **Classification** | **EXP** |
| **Overlay** | `{ "maxLateralOffsetDeltaM": 5 }` |
| **Metrics** | multi-obs: 0 |
| **Result** | Lateral offset not primary blocker |
| **Source** | `lateral_tol_5m` row |

---

## E-013: Experimental combined relaxed geometry (**EXP**)

| Field | Value |
|-------|-------|
| **Classification** | **EXP** — not approved |
| **Overlay** | `maxSpatialJumpM: 50`, `maxConsecutiveRouteSGapM: 100`, `maxLocalHeadingDeltaDeg: 45`, `maxLateralOffsetDeltaM: 5` |
| **Metrics** | Same as 50 m alone: 7 multi-obs, 5,793 singleton, P3 selected 0, cross-pass 0 |
| **Result** | Combined relaxation does not improve beyond 50 m spatial alone |
| **Interpretation** | Spatial cap dominates; other relaxations add no benefit at this dataset scale |
| **Source** | `combined_relaxed_geometry` row |

---

## E-014: Upstream data alignment

| Field | Value |
|-------|-------|
| **Classification** | **AUD** |
| **Metrics** | |
| | — Stage 16 total: 11,044; projected: 5,809; rejected: 5,235 |
| | — Stage 17 tracks: 742; multi-obs: 573; max obs/track: 87 |
| | — Supported runs: 878 (all missing temporalPassId and chunkId) |
| | — Gaps: 136 |
| **Interpretation** | Multi-observation evidence exists upstream; Stage 19 static linking does not consume it under approved config |
| **Source** | `dataAlignment` section |

---

## E-015: Stage 17 prototype sensitivity sweeps

| Field | Value |
|-------|-------|
| **Classification** | **EXP** (prototype) |
| **Configuration** | Stage 17 association assessment parameters |
| **Scope** | Fixture and prototype sweeps during Stage 17 approval |
| **Note** | Separate from Stage 19 Rev 37 sensitivity; prototype thresholds not production |
| **Evidence** | `checkpoints/admiral-investigation-2026-07-23.md` § Stage 17 |

---

## E-016: Stage 20 linking approach evaluation (5010 pairs)

| Field | Value |
|-------|-------|
| **Classification** | **AUD** (read-only design investigation) |
| **Command** | `node reports/stage20_design_investigation_runner.js` |
| **Scope** | 5,010 consecutive pairs in 573 multi-obs partition units |
| **Results** | A Rev37: 0 links; H pose-residual ≤12m: 9; A_fixed 50m: 17 (experimental); B speed×Δt: 17 |
| **Interpretation** | Raw euclidean cap is primary blocker; route-s motion-consistent; 12 m may suit residual cap |
| **Source** | `reports/stage20_design_investigation.json` → `linkingApproaches` |

---

## E-017: Route-s vs speed×Δt residual (all pairs)

| Field | Value |
|-------|-------|
| **Classification** | **AUD** |
| **Metrics** | n=5010; median \|routeS − speed×Δt\| = 1.023 m; p75 = 2.933 m |
| **Interpretation** | Along-track motion prediction already consistent; euclidean check is misaligned |
| **Source** | `reports/stage20_design_investigation.json` → `linkingProblem.residualRouteSAfterSpeedAllPairs` |

---

## E-018: Stage 20 ground-truth sample (rule-based)

| Field | Value |
|-------|-------|
| **Classification** | **AUD** |
| **Segments** | 2, 6, 54, 58, 99 + controls |
| **Metrics** | 576 candidate pairs; 454 stage17_gap; 122 session_boundary; 0 valid_same_track in sample |
| **Limitations** | No video; insufficient for Amendment B precision/recall targets |
| **Source** | `reports/stage20_link_ground_truth_sample.json` — **rule-derived candidate sample, not manual ground truth** (see `reports/stage20_link_candidate_pair_sample_v1.terminology.md`) |

---

## E-019: Constructed lane-boundary fragments (experimental display layer)

| Field | Value |
|-------|-------|
| **Classification** | **AUD** (display-only; not production) |
| **Module** | `lib/constructed_fragments.js` + browser mirror `public/constructed_fragments.js` |
| **Design** | Accumulated Point dots → short reliable local polylines: group by physical boundary (chunk/pass/groupTrackId), order by along-track `s`, connect only when all local checks pass, split on gaps/conflicts/revisit/support, 5-pt moving-average smoothing (endpoints kept, shift capped 0.8 m), residuals reported |
| **Segments** | 0, 13, 14, 22, 50 (sample) |
| **Metrics** | 160 fragments; median length ~27 m (seg 14: 42.8 m); median fragment residual ~0.13 m; source points unmodified in all segments; split reasons balanced (direction 75, temporal 69, step 62, lateral 55, spatial gap 52, revisit 34) |
| **Tuning notes** | Temporal gates are deliberately tolerant (cadence ~2 s, skips to 4 s; backward interleave up to ~4 s); `minSupportCount` 2 excludes single-observation outliers from fragments while dots keep them; curve apexes split by design |
| **Limitations** | Cross-fragment joining out of scope; `groupTrackId` can be reassigned mid-pass on some segments; causal playback rebuilds fragments at draw time so counts differ from "complete map" |
| **Source** | `reports/constructed_fragments_experimental.md`; `scripts/audit_constructed_fragments.js`; `tests/constructed_fragments.test.js` |

---

## E-020: Lane-boundary fragment joining (experimental stage)

| Field | Value |
|-------|-------|
| **Classification** | **AUD** (display-only; not production) |
| **Module** | `lib/lane_joining.js` + browser mirror `public/lane_joining.js` |
| **Design** | Hard prohibitions (revisit, discontinuity, boundary/identity mismatch, unsupported gap, crossing); bounded spatial candidate generation (40 m grid); 10 connection checks; evidence-corridor classification (directly/weakly/occluded/unsupported); composite score; mutual-best selection with ambiguity margin and no branching; chaining into disjoint polylines; cubic tangent-continuous connectors |
| **Segments (threshold basis)** | 14, 16 only |
| **Metrics** | Seg14: 42 candidates → 19 accepted / 11 ambiguous / 6 polylines / 12 unjoined; connector gaps min 0.65, med 1.09, max 4.81 m. Seg16: 14 → 13 accepted / 4 polylines / 0 unjoined; gaps med 1.07, max 3.98 m. All 10 validation checks PASS |
| **Regression** | Seg 2 (6 accepted within distinct boundaries), 6/54/58/99 (0 accepted — hard prohibitions dominate). No mixing, crossing, reversal or unsupported bridging anywhere |
| **Limitations** | Conservative on noisy segments by design; pre-existing fragment-tip kinks visible (connector adds none); no fork/merge topology yet; thresholds fixed from Seg14/16 |
| **Source** | `reports/lane_joining_stage.md`; `reports/lane_joining/*.json`; `screenshots/lane_joining/*.png`; `tests/lane_joining.test.js` (16/16) |

---

## E-021: Path 1 graph fitting (experimental fitted layer)

| Field | Value |
|-------|-------|
| **Classification** | **EXP** (display-only; off by default; not production) |
| **Module** | `lib/graph_fit.js` + browser mirror `public/graph_fit.js`; wired via `lib/segment_local_map.js`; shared viewer path `lib/viewer_map_build.js` |
| **Configuration** | `fitEnabled: false` by default; enable with `?fit=1` or viewer toggle. Processing version `2026-07-24-fusion-v16`. Source-corridor gate `fitMaxSourceCorridorM: 3.0` |
| **Commands** | `node scripts/probe_fitted_segments_summary.js`; `node scripts/probe_viewer_browser_parity.js`; `node --expose-gc --test tests/graph_fit.test.js`; `node --expose-gc --test tests/viewer_probe_parity.test.js` |
| **Segments** | 2, 3, 9, 14, 16, 54 (viewer-authoritative audit set) |
| **Metrics** | Accepted fits: Seg2 **4**, Seg3 **11**, Seg9 **0** (1 stationary polygon), Seg14 **7**, Seg16 **9**, Seg54 **0**. Polygons unchanged with fitting on/off. Seg9 CF0 rejected: `sourceCorridorExceeded` maxDist 4.10 m > 3 m gate |
| **Visual encoding** | Cyan polylines = accepted fitted curves; purple markers = fitted endpoints |
| **Limitations** | Complete-map only (causal playback suppresses fitting); long segments slow; fitted output does not feed polygons; Path 2 not implemented |
| **Source** | `reports/fitted_layer_probe/segment_fitted_summary.json`; `reports/fitted_layer_probe/viewer_browser_parity.json`; `tests/graph_fit.test.js` (74/74 hybrid-inclusive) |

---

## E-022: Hybrid graph-fitted lane map

| Field | Value |
|-------|-------|
| **Classification** | **EXP** (display-only; off by default; not production) |
| **Module** | `GraphFit.buildHybridFittedBoundaries()` in `lib/graph_fit.js`; exposed on `pointAccumulated.hybridFittedBoundaries` when `fitEnabled: true`; renderer `public/render.js` |
| **Configuration** | Requires `?fit=1` **and** viewer checkbox **Hybrid fitted lane map (experimental)** (off by default). Processing version `2026-07-24-fusion-v16`. Path 1 thresholds unchanged (`fitMaxSourceCorridorM: 3.0`) |
| **Commands** | `node --expose-gc --test tests/graph_fit.test.js tests/viewer_probe_parity.test.js` (86/86); validation report `reports/hybrid_validation/HYBRID_VALIDATION_REPORT.md` |
| **Segments** | 2, 3, 9, 14, 16, 54, 58, 95, 99 (nine-segment production audit) |
| **Metrics** | Accepted hybrid fragments: Seg2 **4**, Seg3 **11**, Seg9 **0**, Seg14 **7**, Seg16 **9**, Seg54/58/95/99 **0**. Fallback exactness 0 mismatches; accepted-fit exactness 0 mismatches; polygon checksums identical fit-off vs fit-on |
| **Visual encoding** | Solid cyan 4 px = `acceptedFit`; lane-colour dashed 2 px = `fragmentFallback`; fitted endpoints diagnostic-only |
| **Limitations** | Complete-map only (causal playback suppresses hybrid draw); no hybrid export; constructed-fragment layer suppressed while hybrid active; long-segment fit-enabled builds remain slow; video/calibration branch paused separately |
| **Source** | `reports/hybrid_validation/HYBRID_VALIDATION_REPORT.md`; `tests/graph_fit.test.js` describe "13. hybrid fitted boundaries" (tests 70–74) |

---

## E-023: Path 2 ordering recovery feasibility

| Field | Value |
|-------|-------|
| **Ledger ID** | M-011, M-012 |
| **Classification** | **AUD** |
| **Hypothesis** | Topology-aware ordering can unlock Path 2 graph fitting |
| **Scope** | 92 segments; MST/kNN/PCA/temporal prototypes scanned |
| **Result** | **NO-GO** — `orderingInvalid: 67`; zero recovered ordering without ambiguity |
| **Status** | **REJECTED** |
| **Evidence** | `reports/path2_design/path2_feasibility_report.md` |

---

## E-024: Lane-mapping provenance and spatial coverage audit

| Field | Value |
|-------|-------|
| **Ledger ID** | M-022, M-023 |
| **Classification** | **AUD** |
| **Scope** | Full dataset + Segment 1 deep dive |
| **Metrics** | Dataset provenance 40.41%; Seg1 joined obs 31.95%; 79,847 boundary-metres >0.5 m from join |
| **Status** | **ACCEPTED EXPERIMENTAL** (diagnostic) |
| **Evidence** | `reports/lane_mapping_quality/LANE_MAPPING_DEFECT_AUDIT.md` |

---

## E-025: Insufficient-support fragment audit

| Field | Value |
|-------|-------|
| **Ledger ID** | M-013 |
| **Classification** | **AUD** |
| **Metrics** | 3,317 `insufficientSupport` fragments; 71% have exactly 2 distinct frames |
| **Status** | **ACCEPTED EXPERIMENTAL** |
| **Evidence** | `reports/insufficient_support_audit/INSUFFICIENT_SUPPORT_AUDIT.md` |

---

## E-026: Per-frame connected accumulated display

| Field | Value |
|-------|-------|
| **Ledger ID** | M-037 |
| **Classification** | **EXP** |
| **Hypothesis** | Isolate each frame's dots into polylines to remove cross-frame sawtooth |
| **Metrics** | Seg13 raw zigzag 890 → per-frame 22; Seg1 91 polylines / 30 frames |
| **Status** | **CHECKPOINTED** (`dbe7f26`) |
| **Evidence** | `reports/connected_accumulated/runtime/final_validation.json` |

---

## E-027: Current-frame connected accumulated display

| Field | Value |
|-------|-------|
| **Ledger ID** | M-038 |
| **Classification** | **EXP** |
| **Metrics** | Filters per-frame set to active playback frame; map checksum unchanged |
| **Status** | **CHECKPOINTED** (`8ce0ab6`) |
| **Evidence** | `reports/connected_accumulated/runtime/current_frame_validation.json` |

---

## E-028: Raw vs robust dot-connection comparison

| Field | Value |
|-------|-------|
| **Ledger ID** | M-035, M-036 |
| **Classification** | **EXP** |
| **Metrics** | Seg13 raw: 890 zigzag, 31 polylines; robust: 137 zigzag, 239 polylines |
| **Status** | Raw **REJECTED**; robust **REJECTED** (fragmentation; bridge/source-distance gates) |
| **Evidence** | `reports/connected_accumulated/runtime/robust_comparison.json`, `perframe_comparison.json` |

---

## E-029: Consensus connected polylines (v1 vs v2)

| Field | Value |
|-------|-------|
| **Ledger ID** | M-039, M-040 |
| **Classification** | **EXP** |
| **Metrics** | v1 p95 contributor 6.14 m (Seg13) **FAIL**; v2 p95 0.53 m, 28 polylines |
| **Status** | v1 **REJECTED**; v2 **PARTIAL** |
| **Evidence** | `reports/connected_accumulated/runtime/consensus_comparison.json` |

---

## E-030: Road-guided static v1 (rejected)

| Field | Value |
|-------|-------|
| **Ledger ID** | M-044 |
| **Result** | Seg13/14/95 collapsed to 1 slot; Seg99 6 slots, 62 crossLaneIntersections |
| **Status** | **REJECTED** |
| **Evidence** | `reports/connected_accumulated/runtime/road_guided_static_validation.json` |

---

## E-031: Road-guided static v2 (partial)

| Field | Value |
|-------|-------|
| **Ledger ID** | M-045 |
| **Metrics** | Seg13 15.0%, Seg95 13.2%, Seg14 62.9% supportedCoveragePct; slot counts correct |
| **Status** | **PARTIAL** |
| **Evidence** | `reports/connected_accumulated/runtime/road_guided_static_v2_validation.json` |

---

## E-032: Road-guided dot connection (rejected)

| Field | Value |
|-------|-------|
| **Ledger ID** | M-046 |
| **Automated** | slotSpanCoverage 100%; only formal fail Seg14 p95 heading 16.42° > 15° |
| **Metric review** | guideCoverage 0.52%/0.49%/11.3%; Seg95 maxHeading 176.5° |
| **Status** | **REJECTED** — practical coverage failed |
| **Evidence** | `reports/connected_accumulated/runtime/road_guided_dot_connection_validation.json` |

---

## E-033: Segment 0 mirror (accepted experimental, uncommitted)

| Field | Value |
|-------|-------|
| **Ledger ID** | M-047 |
| **Status** | **ACCEPTED EXPERIMENTAL** — not checkpointed |
| **Evidence** | `reports/connected_accumulated/runtime/segment0_mirror_validation.json` |

---

## E-034: Video inventory (accepted experimental)

| Field | Value |
|-------|-------|
| **Ledger ID** | M-015 |
| **Result** | 64/92 segments with cached MP4; sync path documented |
| **Status** | **ACCEPTED EXPERIMENTAL** — mapping integration blocked |
| **Evidence** | `reports/video_lane_feasibility/video_lane_feasibility.json` |

---

## E-035: UFLD inference (partial)

| Field | Value |
|-------|-------|
| **Ledger ID** | M-016 |
| **Result** | 150/150 frames inferred; image-space only |
| **Status** | **PARTIAL** |
| **Evidence** | `reports/video_lane_zero_label/ZERO_LABEL_VALIDATION_REPORT.md` |

---

## E-036: Zero-label image-space validation (partial)

| Field | Value |
|-------|-------|
| **Ledger ID** | M-017 |
| **Result** | Image-space gates recorded; reprojection BLOCKED; no manual labels required |
| **Status** | **PARTIAL** |
| **Evidence** | `reports/video_lane_zero_label/ZERO_LABEL_VALIDATION_REPORT.md` |

---

## E-037: Hybrid export validation (paused)

| Field | Value |
|-------|-------|
| **Ledger ID** | M-009, M-010 |
| **Classification** | **EXP** |
| **Result** | Export architecture validated; 9 category-E downgrade; user paused rollout |
| **Evidence** | `reports/hybrid_export_validation/HYBRID_EXPORT_VALIDATION_REPORT.md`, `deliverables/hybrid_lane_map_v1/` |

---

## E-038: Candidate layer probe (lane-change reconciliation)

| Field | Value |
|-------|-------|
| **Ledger ID** | M-029 |
| **Classification** | **AUD** |
| **Result** | 1 confirmed lane-change (Seg99); `LANE_CHANGE_REPORT.md` overstated vs `narrow_gate.json` |
| **Evidence** | `reports/candidate_layer_probe/CANDIDATE_LAYER_PROBE_REPORT.md` |

---

## E-039: Road-guided ranked connection (**EXP**)

| Field | Value |
|-------|-------|
| **Ledger ID** | M-050 |
| **Classification** | **EXP** |
| **Configuration** | `road-guided-ranked-connection-v1`; viewer mode `roadGuidedRankedConnection` |
| **Command** | `node scripts/verify_connected_accumulated_runtime.js` |
| **Segments** | 13, 14, 95, 99 |
| **Result** | Automated acceptance **FAIL**; Seg14 guide coverage 61.8% (vs 0.49% anchor dot connection); Seg13 48.8%; assignment 37–52% |
| **Interpretation** | Rank-by-bin without anchor improves Seg14 vs M-046; coverage/assignment gates not met |
| **Evidence** | `reports/connected_accumulated/runtime/road_guided_ranked_validation.json` |

---

## E-040: Road-guided sequence connection (**EXP**)

| Field | Value |
|-------|-------|
| **Ledger ID** | M-051 |
| **Classification** | **EXP** |
| **Configuration** | `road-guided-sequence-connection-v1`; viewer mode `roadGuidedSequenceConnection` |
| **Command** | `node scripts/verify_connected_accumulated_runtime.js` |
| **Segments** | 13, 14, 95, 99 |
| **Result** | Automated acceptance **FAIL** (part-count gates); guide coverage 66–94%; suffix gaps resolved on 13/14 |
| **Interpretation** | Sequence assignment fixes M-050 fragmentation in coverage/gaps; stroke splits still yield too many parts |
| **Evidence** | `reports/connected_accumulated/runtime/road_guided_sequence_validation.json` |

---

## E-041: Road-layer isolation for experimental lane modes (**EXP**)

| Field | Value |
|-------|-------|
| **Ledger ID** | M-052 |
| **Classification** | **EXP** |
| **Configuration** | Road render path unified across connected-accumulated modes |
| **Command** | `node scripts/verify_connected_accumulated_runtime.js` |
| **Segments** | 13, 14, 95, 99 |
| **Result** | Road display input checksum parity **PASS** across modes; user manual: mode parity pass but Seg99 ≠ checkpoint road |
| **Evidence** | `reports/connected_accumulated/runtime/road_layer_isolation_validation.json` |

---

## E-042: Checkpoint road-pixel regression repair (**EXP**)

| Field | Value |
|-------|-------|
| **Ledger ID** | M-053 |
| **Classification** | **EXP** |
| **Configuration** | Checkpoint `1b3b1c82`; mirror on; connected layer off; Seg99 timeline 0 |
| **Command** | `node scripts/capture_segment99_road_regression.js all` |
| **Result** | Baseline vs after **0.000%** road-only pixels; user manual review pass; checkpointed |
| **Evidence** | `reports/connected_accumulated/runtime/segment99_road_regression/` |

---

## Reproduction Notes

1. Experimental overlays in E-008–E-013 were run by the read-only investigation runner; they do **not** modify `lib/stage19_spec/config.js`.
2. Fixture overlays for tests use `lib/stage19_partition_config_overlay.js` — test-only, not production.
3. Full-dataset commands require qlog segment files and upstream JSON artifacts (`projected_lane_observations_v0.json`, Stage 17/18 audits).

See [RUN_GUIDE.md](./RUN_GUIDE.md) for verified commands.
