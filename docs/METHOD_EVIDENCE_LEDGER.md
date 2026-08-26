# Method Evidence Ledger

**Generated:** 2026-08-26
**Workspace:** `C:\Kommu AI Project`
**Branch at generation:** `experiment/candidate-layer-display` @ `8ce0ab6`
**Processing version:** `2026-07-24-fusion-v16` (`lib/version.js`)

This ledger reconstructs methods attempted in the Kommu AI lane-mapping project from committed code, generated JSON, reports, tests, and development documentation. **No experiments were rerun for this document.**

---

## Summary table

| ID | Method | Goal | Status | Main result | Main reason | Evidence | Commit |
| -- | ------ | ---- | ------ | ----------- | ----------- | -------- | ------ |
| M-001 | Fusion-v16 baseline processing | Stable fused geometry + stationary pose lock | **CHECKPOINTED** | 92-seg v11 geometry compare: 0 diffs; fusion-v16 pose dwell fix | Production baseline preserved | `lib/version.js`, `reports/stationary_pose_dwell_fix.md` | `188a83c` |
| M-002 | Path 1 graph fitting | Smooth spline overlay on constructed fragments | **CHECKPOINTED** | Seg2 4 / Seg14 7 accepted; polygons unchanged | Passed corridor gates; display-only | `reports/fitted_layer_probe/segment_fitted_summary.json` | `8c5da91` |
| M-003 | Shared viewer/probe production path | Align probes with browser viewer | **CHECKPOINTED** | Probe/browser parity on accepted counts | Single authority `lib/viewer_map_build.js` | `reports/fitted_layer_probe/viewer_browser_parity.json` | `8c5da91` |
| M-004 | Hybrid graph-fitted lane map | One boundary/fragment with fit+fallback | **CHECKPOINTED** | 0 fallback mismatches; accepted counts match Path 1 | Complete-map only; off by default | `reports/hybrid_validation/HYBRID_VALIDATION_REPORT.md` | `bbd7448` |
| M-005 | Held-out graph-fit memoization | Speed complete-map fitting | **CHECKPOINTED** | Memoized held-out evaluation in `lib/graph_fit.js` | Reduces repeat fit cost | `tests/graph_fit.test.js` | `cea7aab` |
| M-006 | Persistent IndexedDB graph-fit cache | Warm reload without refit | **CHECKPOINTED** | Seg2 10/10; Seg14 warm ~1.3 s, 0 fitter calls | Display-only cache; origin-specific | `reports/graph_fit_performance/persist_browser_gate.json` | `f4932af` |
| M-007 | Hybrid map quality audit | Measure accepted-fit geometry quality | **ACCEPTED EXPERIMENTAL** | 100 accepted fits audited; heuristic flags 2,931 m | Audit-only heuristics; production gates pass | `reports/hybrid_map_quality/accepted_fit_geometry_metrics.json` | — |
| M-008 | Suspicious accepted-fit audit | Decide export safety for accepted fits | **ACCEPTED EXPERIMENTAL** | 9 category-E fragments optional downgrade | 84/100 flags are resample artifacts | `reports/hybrid_map_quality/suspicious_fit_audit/SUSPICIOUS_FIT_AUDIT.md` | — |
| M-009 | Category-E export downgrade | Safer hybrid export metadata | **ACCEPTED EXPERIMENTAL** | Export policy `safe` downgrades 9 fragments | Production acceptance unchanged | `reports/hybrid_export_validation/HYBRID_EXPORT_VALIDATION_REPORT.md` | — |
| M-010 | Experimental hybrid export | JSON/CSV deliverable from viewer map | **PARTIAL** | All-92 safe export reconciled; paused per user | Export path works; mapping quality still limited | `deliverables/hybrid_lane_map_v1/` | — |
| M-011 | Path 2 ordering recovery | Recover topology-aware graph fitting | **REJECTED** | Path 2 eligible 52 segs; **NO-GO** | Zero recovered ordering without ambiguity | `reports/path2_design/path2_feasibility_report.md` | — |
| M-012 | MST / kNN / PCA / temporal ordering prototypes | Alternative ordering for Path 2 | **REJECTED** | Subsumed by Path 2 scan | No method passed feasibility gate | `reports/path2_design/path2_feasibility_report.md` | — |
| M-013 | Insufficient-support audit | Explain 3,317 insufficientSupport fragments | **ACCEPTED EXPERIMENTAL** | 71% have exactly 2 distinct frames | Sparse temporal support at 0.5 Hz | `reports/insufficient_support_audit/INSUFFICIENT_SUPPORT_AUDIT.md` | — |
| M-014 | Threshold lowering (support / spatial) | Increase joined coverage | **REJECTED** | Dedup counterfactual: +0.04 pp coverage | Risk outweighs marginal gain | `reports/lane_mapping_quality/dedup_support/DEDUP_SUPPORT_REPORT.md` | — |
| M-015 | Video Stage V1 feasibility | qcamera inventory and sync | **ACCEPTED EXPERIMENTAL** | 64/92 segments have cached MP4; sync path proven | Inventory only; not mapping integration | `reports/video_lane_feasibility/video_lane_feasibility.json` | — |
| M-016 | Video Stage V2 / UFLD | Ultra-fast lane detector on video | **PARTIAL** | UFLD inference 150/150 frames complete | Image-space only; mapping integration blocked | `reports/video_lane_zero_label/ZERO_LABEL_VALIDATION_REPORT.md` | — |
| M-017 | Zero-label validation | Video lanes without manual labels | **PARTIAL** | Image-space zero-label gates recorded | No trusted reprojection to vehicle frame | `reports/video_lane_zero_label/ZERO_LABEL_VALIDATION_REPORT.md` | — |
| M-018 | Calibration investigation | Find usable camera intrinsics | **BLOCKED** | Decision C: partial calibration only | KA2-native intrinsics missing | `reports/video_lane_zero_label/CALIBRATION_INVESTIGATION_REPORT.md` | — |
| M-019 | CLRerNet deferral | Second detector for consensus | **BLOCKED** | PINTO tarball not downloaded | Environment not prepared | `reports/video_lane_zero_label/ZERO_LABEL_VALIDATION_REPORT.md` | — |
| M-020 | Missing camera intrinsics | Project video lanes to vehicle frame | **BLOCKED** | `pixelProjection: BLOCKED` | No qcamera K in workspace | `reports/video_lane_zero_label/calibration/modelv2_frame_provenance.json` | — |
| M-021 | Missing rlogs / higher-rate modelV2 | Denser temporal evidence | **BLOCKED** | Shared-event parity insufficient | qlog remains ~0.5 Hz | `reports/lane_mapping_quality/higher_rate_evidence/acceptance_gate.json` | — |
| M-022 | Provenance coverage audit | Why dots ≠ joined polylines | **ACCEPTED EXPERIMENTAL** | Dataset 40.41% obs in joined provenance | Insufficient support dominates | `reports/lane_mapping_quality/LANE_MAPPING_DEFECT_AUDIT.md` | — |
| M-023 | Spatial coverage audit | Geometric metres uncovered | **ACCEPTED EXPERIMENTAL** | 79,847 boundary-metres >0.5 m from join | Geometric ≠ provenance coverage | `reports/lane_mapping_quality/spatial_coverage/` | — |
| M-024 | Dedup support propagation | Recover support lost in dedup | **REJECTED** | +1,160 obs; +0.04 pp provenance | Negligible vs 56,954 unsupported | `reports/lane_mapping_quality/dedup_support/DEDUP_SUPPORT_REPORT.md` | — |
| M-025 | Point-to-polyline temporal support | Per-frame curves as support evidence | **ACCEPTED EXPERIMENTAL** | Candidate distance metrics recorded | Still far from joined geometry | `reports/lane_mapping_quality/polyline_support/` | — |
| M-026 | Frame alignment / registration | Fix pose misalignment tail | **REJECTED** | R1/R2/R3 all regress support/geometry | Transform chain already correct | `reports/lane_mapping_quality/frame_alignment/` | — |
| M-027 | Pose/heading tail investigation | Explain P95 1.56 m lateral residual | **REJECTED** | Gate E: no safe pose correction | Tail is motion-dominated, not GPS bug | `reports/lane_mapping_quality/pose_heading_tail/POSE_HEADING_TAIL_REPORT.md` | — |
| M-028 | Heading-source alternatives | Better reference heading for alignment | **INCONCLUSIVE** | Narrow counterfactuals recorded | No approved replacement | `reports/lane_mapping_quality/heading_source/` | — |
| M-029 | Lane-change identity investigation | Physical boundary through lane changes | **REJECTED** | 1 confirmed event (Seg99); raw lane index unsafe | Cannot use laneIndex as physical ID | `reports/candidate_layer_probe/CANDIDATE_LAYER_PROBE_REPORT.md` | — |
| M-030 | Higher-rate evidence request | Independent denser modelV2 | **BLOCKED** | Acceptance gate failed | No rlog source in workspace | `reports/lane_mapping_quality/higher_rate_evidence/` | — |
| M-031 | Constructed fragments | Local polylines from accumulated dots | **ACCEPTED EXPERIMENTAL** | 160 frags / 5 segs; median residual 0.13 m | Display-only; support gate excludes most dots | `reports/constructed_fragments_experimental.md` | `188a83c` |
| M-032 | Lane joining | Connect compatible fragments | **ACCEPTED EXPERIMENTAL** | Seg14: 6 polylines / 19 conns | Conservative on noisy segments | `reports/lane_joining_stage.md` | `188a83c` |
| M-033 | Mirror alignment (constructed/joined) | Fix mirror toggle desync | **ACCEPTED EXPERIMENTAL** | All layers move together; 10/10 tests | Precomputed mirrored coords path | `reports/mirror_alignment_fix.md` | — |
| M-034 | Candidate amber-line display | Show unconfirmed join candidates | **ACCEPTED EXPERIMENTAL** | Debug layer in viewer | Diagnostic only | `public/render.js` `_drawJoinCandidates` | — |
| M-035 | Raw same-colour dot connection | Connect all dots of same track | **REJECTED** | 890 zigzag edges Seg13; sawtooth | Cross-frame ordering by modelX | `reports/connected_accumulated/runtime/perframe_comparison.json` | — |
| M-036 | Robust longitudinal-bin representative | Bin-based medoid connection | **REJECTED** | Reduced zigzag; heavy fragmentation (239 polylines) | Improved stats, poor route coverage | `reports/connected_accumulated/runtime/robust_comparison.json` | — |
| M-037 | Per-frame connected lines | One polyline per frame per identity | **CHECKPOINTED** | Seg1: 91 polylines / 30 frames; 0 cross-frame | Removes sawtooth vs raw | `reports/connected_accumulated/runtime/final_validation.json` | `dbe7f26` |
| M-038 | Current-frame connected display | Show only active frame curves | **CHECKPOINTED** | Filters per-frame set to playback frame | Stable during playback | `reports/connected_accumulated/runtime/current_frame_validation.json` | `8ce0ab6` |
| M-039 | Consensus mode (v1) | Multi-frame agreement polylines | **REJECTED** | p95 contributor distance 6.14 m (Seg13) | Source-distance too large | `reports/connected_accumulated/runtime/consensus_comparison.json` | — |
| M-040 | Corrected consensus (v2 interpolated cluster) | Fix consensus distance/fragmentation | **PARTIAL** | p95 contributor 0.53 m; 28 polylines Seg13 | Better metrics; still incomplete vs joined map | `reports/connected_accumulated/runtime/consensus_comparison.json` | — |
| M-041 | Representative fused path | Medoid representatives then connect | **PARTIAL** | Documented in robust comparison | Incomplete route coverage | `reports/connected_accumulated/runtime/representative_path_validation.json` | — |
| M-042 | Trajectory-aligned current frame | Align curves to grey trajectory | **REJECTED** | Validation JSON present; did not replace joined map | No measurable improvement over current-frame baseline | `reports/connected_accumulated/runtime/trajectory_aligned_validation.json` | — |
| M-043 | Native-coordinate current-frame smoothing | Smooth in modelX/modelY | **PARTIAL** | p95 heading change rate reduced | Visual improvement unverified in repo | `reports/connected_accumulated/runtime/smoothed_current_frame_validation.json` | — |
| M-044 | Road-guided static v1 | Trajectory-guided static boundaries | **REJECTED** | Collapsed seg13/14/95 to 1 slot; seg99 6 slots; 62 crossLaneIntersections | Slot collapse and cross-lane errors | `reports/connected_accumulated/runtime/road_guided_static_validation.json` | — |
| M-045 | Road-guided static v2 | Lane-count-anchored static slots | **PARTIAL** | Seg13 15.0%; seg95 13.2%; seg14 62.9% supportedCoverage | Correct slot count; low span coverage | `reports/connected_accumulated/runtime/road_guided_static_v2_validation.json` | — |
| M-046 | Road-guided dot connection v1 | Connect eligible dots along trajectory slots | **REJECTED** | slotSpanCoverage 100% but guideCoverage 0.52%/0.49%/11.3%; p95_heading Seg14 16.42°; seg95 maxHeading 176.5° | Practical coverage failed | `reports/connected_accumulated/runtime/road_guided_dot_connection_validation.json` | — |
| M-047 | Segment 0 mirror display correction | Fix mirror contract in viewer | **ACCEPTED EXPERIMENTAL** | storedVsExpectedMax=0; viewer fix uncommitted | Production geometry unchanged | `reports/connected_accumulated/runtime/segment0_mirror_validation.json` | — |
| M-048 | Stage 19 v5 dataset-sensitivity audit | Audit singleton chains on real dataset | **ACCEPTED EXPERIMENTAL** | 5,809 singleton chains; P3 0/0/0 | NOT checkpointed on experiment branch | `audit_stage19_dataset_sensitivity.json`, `reports/stage19_v5_corrective_checkpoint_report.json` | — |
| M-049 | Stationary pose dwell correction | Lock pose during stop confirmation | **CHECKPOINTED** | 302 m false travel removed dataset-wide | Two-pass anchor retrospective apply | `reports/stationary_pose_dwell_fix.md` | `188a83c` |
| M-050 | Rank-by-bin road-guided connection | Static lane lines without anchor propagation | **PARTIAL** | Fragmentation (186/234 parts); manual review 2026-08-26; assignment metric bug fixed | Bidirectional fingerprint agreement; chain-split fragmentation | `reports/connected_accumulated/runtime/road_guided_ranked_validation.json` | — |
| M-051 | Sequence-wide road-guided lane connection | Stable slot assignment across valid guide runs | **PARTIAL** | Guide coverage ↑; part-count gates fail; lane/dot misalignment | Stroke fragmentation; rejected guide on Seg99 | `reports/connected_accumulated/runtime/road_guided_sequence_validation.json` | — |
| M-052 | Experimental lane-layer road-render isolation | Lane strokes without mutating road display | **ACCEPTED EXPERIMENTAL** | Mode parity + checkpoint road-pixel gate pass (M-053) | M-051 road replacement reverted; input checksum parity alone insufficient | `reports/connected_accumulated/runtime/road_layer_isolation_validation.json` | — |
| M-053 | Checkpoint road-pixel regression (Seg99) | Restore checkpoint road appearance at final canvas | **ACCEPTED EXPERIMENTAL** | Baseline vs after 0.000% road-only pixel diff | Trajectory mirror fallback on ribbon without precomputed coords | `reports/connected_accumulated/runtime/segment99_road_regression/` | — |

---

## Status totals

| Status | Count | Method IDs |
| ------ | ----- | ---------- |
| **CHECKPOINTED** | 9 | M-001, M-002, M-003, M-004, M-005, M-006, M-037, M-038, M-049 |
| **ACCEPTED EXPERIMENTAL** | 14 | M-007, M-008, M-009, M-013, M-015, M-022, M-023, M-025, M-031, M-032, M-033, M-034, M-047, M-048 |
| **PARTIAL** | 7 | M-010, M-016, M-017, M-040, M-041, M-043, M-045 |
| **REJECTED** | 13 | M-011, M-012, M-014, M-024, M-026, M-027, M-029, M-035, M-036, M-039, M-042, M-044, M-046 |
| **BLOCKED** | 5 | M-018, M-019, M-020, M-021, M-030 |
| **INCONCLUSIVE** | 1 | M-028 |
| **Total** | **49** | |

---

## Full-suite failure history

Exact sequence of full-suite (`node --expose-gc --test tests`) outcomes relevant to hybrid and pose work:

| Phase | Environment | Stage 7 | API parity (port 3847) | Fail count | Notes |
| ----- | ----------- | ------- | ---------------------- | ---------- | ----- |
| 1 — Pre-migration OneDrive | OneDrive workspace | **FAIL** — `setup: run stage 7 audit` could not write `audit_segment2_lane_continuity_stage7.json` (ReparsePoint placeholder) | Not isolated | **28** | Stage 7 audit JSON write failure; 27 baseline + 1 environmental. Evidence: `reports/hybrid_validation/HYBRID_VALIDATION_REPORT.md` Phase 14, `.cache/hybrid_full_suite.txt` |
| 2 — Post-migration local, no API server | Local workspace | **PASS** (48/48 isolated) | **FAIL** — `ECONNREFUSED` port 3847 | **28** | Stage 7 environmental flake resolved; API parity leaf still fails without server. Evidence: `reports/stationary_pose_dwell_fix.md` §11 |
| 3 — Local with API on 3847 | Local workspace + fresh v16 server | **PASS** | **PASS** | **27** | Established baseline failures only (no new hybrid regressions). Evidence: `docs/CURRENT_STATUS.md` validation snapshot |

**Interpretation:** The 28-failure count was an environmental artifact (OneDrive write + missing API server), not a hybrid-code regression. Focused suites (`tests/graph_fit.test.js` etc.) remain the authoritative regression gate for graph-fit work.

---

## Expanded metric corrections

| Misleading metric | What went wrong | Preferred future metric | Evidence |
| ----------------- | --------------- | ----------------------- | -------- |
| Provenance coverage % | Counts observations with joined-provenance metadata, not geometric nearness to a boundary | Report **provenance %** and **spatial %** separately | `reports/lane_mapping_quality/LANE_MAPPING_DEFECT_AUDIT.md` |
| Multi-lane length / single trajectory length | Normalizing total lane-metres by one centreline length inflates apparent coverage | Per-boundary length + route span separately | `reports/lane_mapping_quality/spatial_coverage/` |
| Joined coverage = 0 when unavailable | Treated missing joined layer as zero coverage | Explicit `joinedCoverageAvailable: false` | Audit scripts under `reports/lane_mapping_quality/` |
| Road-guided slot-span coverage (`slotSpanCoveragePct`) | Measured only over assigned-dot span; ignores compatible dots excluded before assignment | Report **guideCoveragePct**, **eligible-dot assigned rate**, **supportedLengthM**, and **routeCoveragePct** independently | `reports/connected_accumulated/runtime/road_guided_dot_connection_validation.json` |
| Gap count between rendered parts only | Omits missing leading/trailing ranges (halfway-start problem) | Include **prefix**, **internal**, and **suffix** gap lengths | Road-guided dot-connection metric review |
| P95 heading gate hides max reversal | P95 can pass while max heading reversal is 176.5° (Seg95 dot connection) | Report **p95**, **max**, and **reversal count** together | `reports/connected_accumulated/runtime/road_guided_dot_connection_validation.json` |
| Dense resampling roughness | More samples can reduce numerical roughness without visible benefit | Same-spacing comparison plus manual review | `reports/hybrid_map_quality/suspicious_fit_audit/SUSPICIOUS_FIT_AUDIT.md` |
| Joined coverage reported as zero | Joined data may be absent from validation map | Report `joinedCoverageAvailable: false`, not zero | Audit scripts under `reports/lane_mapping_quality/` |
| Source distance to all compatible samples | Can penalise valid selected modes | **Retained-contributor distance** plus nearest compatible curve | `reports/connected_accumulated/runtime/consensus_comparison.json`, `reports/lane_mapping_quality/polyline_support/` |
| Fragment-count coverage | Gives equal weight to short and long fragments | **Length-weighted coverage** by boundary span | `reports/lane_mapping_quality/spatial_coverage/` |
| UFLD zero-output rate | 59% zero-output frames reported as if they were label misses | Report **zero-output rate** separately from **detection miss rate**; no manual labels required | `reports/video_lane_zero_label/ZERO_LABEL_VALIDATION_REPORT.md` |
| Stage 19 singleton count | 5,809 singleton chains interpreted as implementation failure | Report **dataset constraint** (12 m cap vs ~33 m median separation) vs **implementation defect** | `audit_stage19_dataset_sensitivity.json`, `reports/stage19_dataset_sensitivity_investigation.json` |

---

## Checkpoint-to-method mapping

Nine checkpointed methods across seven local commits (not pushed):

| Method ID | Method | Commit | Parent | Pushed? |
| --------- | ------ | ------ | ------ | ------- |
| M-038 | Current-frame connected display | `8ce0ab6` | `dbe7f26` | No |
| M-037 | Per-frame connected lines | `dbe7f26` | `f4932af` | No |
| M-006 | Persistent IndexedDB graph-fit cache | `f4932af` | `cea7aab` | No |
| M-005 | Held-out graph-fit memoization | `cea7aab` | `bbd7448` | No |
| M-004 | Hybrid graph-fitted lane map | `bbd7448` | `8c5da91` | No |
| M-002 | Path 1 graph fitting | `8c5da91` | `188a83c` | No |
| M-003 | Shared viewer/probe production path | `8c5da91` | `188a83c` | No |
| M-001 | Fusion-v16 baseline processing | `188a83c` | `d8e0a1e` | No |
| M-049 | Stationary pose dwell correction | `188a83c` | `d8e0a1e` | No |

*Commit `188a83c` also introduced M-031 and M-032 (ACCEPTED EXPERIMENTAL, not checkpointed). M-048 has evidence on the Stage 19 v5 branch but is NOT checkpointed on `experiment/candidate-layer-display`.*

---

## Presentation-ready evidence

| Claim | Metric | Evidence | Status |
| ----- | ------ | -------- | ------ |
| Fusion-v16 preserves frozen v11 geometry | 92 segments, 0 geometry diffs | `reports/stage19_v5_corrective_checkpoint_report.json`, `lib/version.js` | **CHECKPOINTED** |
| Stationary pose dwell removes false travel | 302 m removed dataset-wide | `reports/stationary_pose_dwell_fix.md` | **CHECKPOINTED** |
| Path 1 graph fitting accepts fits on key segments | Seg2: 4; Seg14: 7 accepted; polygons unchanged | `reports/fitted_layer_probe/segment_fitted_summary.json` | **CHECKPOINTED** |
| Hybrid map preserves accepted fits and fallbacks | 0 fallback mismatches; 0 accepted-fit mismatches | `reports/hybrid_validation/HYBRID_VALIDATION_REPORT.md` | **CHECKPOINTED** |
| Joined polyline provenance is sparse | 40.41% dataset provenance; Seg1 31.95% | `reports/lane_mapping_quality/LANE_MAPPING_DEFECT_AUDIT.md` | **ACCEPTED EXPERIMENTAL** |
| Insufficient support dominates fragment rejection | 3,317 fragments; 71% with exactly 2 frames | `reports/insufficient_support_audit/INSUFFICIENT_SUPPORT_AUDIT.md` | **ACCEPTED EXPERIMENTAL** |
| Path 2 ordering recovery is infeasible | 52 eligible segments; orderingInvalid 67; **NO-GO** | `reports/path2_design/path2_feasibility_report.md` | **REJECTED** |
| Per-frame connection removes cross-frame sawtooth | Seg13: 890 zigzag → 0 cross-frame; Seg1: 91 polylines / 30 frames | `reports/connected_accumulated/runtime/final_validation.json` | **CHECKPOINTED** |
| Raw cross-frame dot connection fails | Seg13: 890 zigzag edges | `reports/connected_accumulated/runtime/perframe_comparison.json` | **REJECTED** |
| Road-guided dot connection fails practical coverage | guideCoverage Seg13/14/95: 0.52% / 0.49% / 11.3%; p95_heading Seg14 16.42° | `reports/connected_accumulated/runtime/road_guided_dot_connection_validation.json` | **REJECTED** |
| qcamera video inventory exists but mapping blocked | 64/92 cached MP4; pixelProjection BLOCKED | `reports/video_lane_feasibility/video_lane_feasibility.json`, `reports/video_lane_zero_label/calibration/modelv2_frame_provenance.json` | M-015 **ACCEPTED EXPERIMENTAL**; M-020 **BLOCKED** |
| Stage 19 real-dataset audit records all singletons | 5,809 singleton chains; P3 0/0/0 | `audit_stage19_dataset_sensitivity.json` | **ACCEPTED EXPERIMENTAL** (M-048) |

**Not claimed:** ground-truth lane-map accuracy, HD-map completeness, video-to-map projection, or complete static boundary coverage along route.

---

## Manual visual findings

| Finding | Segment / mode | Evidence type | Label |
| ------- | -------------- | ------------- | ----- |
| Raw dot connection sawtooth | Seg13 — raw mode | JSON: 890 zigzag edges | Automated metric; aligns with user reports. **User-reported manual visual finding; screenshot evidence not indexed in repository.** |
| Robust mode reduced zigzag but fragmented | Seg13/14 — robust | `reports/connected_accumulated/runtime/segment13_robust.png`, `segment14_robust.png`, `segment95_robust.png` | Heavy fragmentation (239 polylines Seg13) |
| Per-frame mode removed sawtooth; overlapping lines across frames | Seg13/14 — per-frame | `reports/connected_accumulated/runtime/segment13_perframe.png`, `segment14_perframe.png`, `segment95_perframe.png` | Expected structural trade-off |
| Current-frame mode stable during playback | Seg1 — current-frame | `reports/connected_accumulated/runtime/segment1_perframe_final.png` | Filters to active frame only |
| Mirror toggle sanity (on/off) | Seg1, Seg9 | `segment1_off.png`, `segment1_on.png`, `segment9_sanity_off.png`, `segment9_sanity_on.png` | Mirror layers move together post M-033 |
| Seg99 per-frame / mirror states | Seg99 | `segment99_off.png`, `segment99_on.png`, `segment99_perframe_final.png` | Lane-change segment diagnostic |
| Consensus v1 unusable at source distance | Seg13 — consensus v1 | `consensus_comparison.json` (p95 6.14 m) | **User-reported manual visual finding; screenshot evidence not indexed in repository.** |
| Consensus v2 improved distance but incomplete route | Seg13 — consensus v2 | `consensus_comparison.json` (28 polylines) | **User-reported manual visual finding; screenshot evidence not indexed in repository.** |
| Representative path incomplete coverage | Seg13/14 — representative | `representative_path_validation.json` | **User-reported manual visual finding; screenshot evidence not indexed in repository.** |
| Trajectory-aligned did not replace joined map | Seg13/14 — trajectory-aligned | `trajectory_aligned_validation.json` | **User-reported manual visual finding; screenshot evidence not indexed in repository.** |
| Smoothed current-frame heading calmer | Seg13 — smoothed | `smoothed_current_frame_validation.json` | **User-reported manual visual finding; screenshot evidence not indexed in repository.** |
| Road-guided v1 slot collapse | Seg13/14/95 — road-guided static v1 | `road_guided_static_validation.json` (1 slot each; seg99 6 slots) | **User-reported manual visual finding; screenshot evidence not indexed in repository.** |
| Road-guided v2 correct slots, low visible coverage | Seg13/14/95 — road-guided static v2 | `road_guided_static_v2_validation.json` (~15% supported Seg13) | Quantitative + manual incomplete lines |
| Road-guided dot connection incomplete despite slot metrics | Seg14 — dot connection | `road_guided_dot_connection_validation.json` | **User-reported manual visual finding; screenshot evidence not indexed in repository.** |
| Mirror toggle: dots moved but road ribbon stayed fixed (pre-fix) | Seg0 — mirror | `segment0_mirror_validation.json` | **User-reported manual visual finding; screenshot evidence not indexed in repository.** |

All screenshot paths under `reports/connected_accumulated/runtime/`.

---

## Road-guided history (three experiments)

### Experiment 1 — Road-guided static v1 (M-044) — **REJECTED**

| Field | Value |
| ----- | ----- |
| Algorithm | `road-guided-static-v1` |
| Key failure | Collapsed segments 13, 14, and 95 to **1 slot** each (should be 3); segment 99 rendered **6 slots** |
| Cross-lane | **62** `crossLaneIntersections` on Seg99 |
| Evidence | `reports/connected_accumulated/runtime/road_guided_static_validation.json` |
| Status | **REJECTED** — superseded by v2 |

### Experiment 2 — Road-guided static v2 (M-045) — **PARTIAL**

| Field | Value |
| ----- | ----- |
| Algorithm | `road-guided-static-v2` |
| Slot counts | Correct (3 slots Seg13/14/95) |
| Supported coverage | Seg13 **15.0%**; Seg95 **13.2%**; Seg14 **62.9%** |
| Heading | Seg95 p95Heading **12.63°** |
| Manual | Incomplete visible lines along route despite correct slot topology |
| Evidence | `reports/connected_accumulated/runtime/road_guided_static_v2_validation.json` |
| Status | **PARTIAL** |

### Experiment 3 — Road-guided dot connection v1 (M-046) — **REJECTED**

| Field | Value |
| ----- | ----- |
| Algorithm | `road-guided-dot-connection-v1` |
| Automated pass | `slotSpanCoveragePct` **100%** on Seg13/14/95 |
| Practical fail | `guideCoveragePct` **0.52%** / **0.49%** / **11.3%** on Seg13/14/95 |
| Formal gate fail | `p95_heading_15` Seg14 **16.42°** (> 15°) |
| Max heading | Seg95 `maxHeadingDiff` **176.5°** (near reversal) |
| Evidence | `reports/connected_accumulated/runtime/road_guided_dot_connection_validation.json` |
| Status | **REJECTED** — practical coverage failed despite span metrics |

---

## Video method statuses (corrected)

| ID | Method | Status | Key evidence |
| -- | ------ | ------ | ------------ |
| M-015 | qcamera inventory/sync | **ACCEPTED EXPERIMENTAL** | 64/92 MP4 cached; sync path proven — **not mapping** |
| M-016 | UFLD inference | **PARTIAL** | **150/150** frames complete; image-space only |
| M-017 | Zero-label validation | **PARTIAL** | Image-space zero-label gates only; no vehicle-frame projection |
| M-018 | Calibration investigation | **BLOCKED** | KA2 intrinsics missing |
| M-019 | CLRerNet deferral | **BLOCKED** | Model not provisioned |
| M-020 | Missing camera intrinsics | **BLOCKED** | `pixelProjection: BLOCKED` |
| M-021 | Missing rlogs / higher-rate modelV2 | **BLOCKED** | No denser source in workspace |

No manual video labels are required for these experiments. Video evidence is **not** in the confirmed mapping path.

---

## Rejected methods and why

| Method | What was attempted | Failure evidence | Reason rejected | Useful lesson |
| ------ | ------------------ | ---------------- | --------------- | ------------- |
| M-011 Path 2 ordering recovery | Topology-aware graph fit after Path 1 | `orderingInvalid: 67`; **NO-GO** | No ambiguity-free ordering recovery | Path 1 + hybrid remain the viable fit path |
| M-012 MST/kNN/PCA/temporal prototypes | Alternative orderings for Path 2 | Same feasibility scan | Zero eligible recovery | Ordering is structural blocker, not tuning |
| M-014 Threshold lowering | Lower minSupport / widen gates | +0.04 pp provenance | Violates project safety rules | Coverage gains require evidence density, not thresholds |
| M-024 Dedup support propagation | Count distinct frames across deduped sources | +0.04 pp provenance | Negligible benefit | Fix support gate placement instead |
| M-026 Frame registration R1/R2/R3 | Align poses to reduce tail | Forced variants regress geometry | Transform chain already correct | Do not register frames on this dataset |
| M-027 Pose/heading tail corrections | Counterfactual pose adjustments | All variants worsen or distort | **Gate E** — retain baseline | P95 tail is motion-dominated, not GPS bug |
| M-029 Lane-change via raw laneIndex | Treat laneIndex as physical boundary | Seg99 confirmed change; Seg1 unsafe mixing | Identity must use groupTrackId + guards | Raw lane index is not physical boundary ID |
| M-035 Raw same-colour dot connection | Connect dots by track across frames | Seg13: 890 zigzag edges | Sawtooth / cross-frame modelX ordering | Per-frame isolation required first |
| M-036 Robust longitudinal-bin representative | Bin-based medoid connection | 239 polylines Seg13; poor route coverage | Improved stats, unusable fragmentation | Bin medoids alone do not span route |
| M-039 Consensus v1 | Multi-frame bin consensus | p95 contributor **6.14 m** | Large source-distance error | Needs spatial clustering + interpolation (v2) |
| M-042 Trajectory-aligned current frame | Align curves to grey trajectory | No joined-map replacement | Did not beat current-frame baseline | Trajectory alignment insufficient alone |
| M-044 Road-guided static v1 | Trajectory-guided static boundaries | 1 slot collapse; 62 crossLaneIntersections | Slot collapse | Lane-count anchoring required (v2) |
| M-046 Road-guided dot connection v1 | Connect dots along trajectory slots | guideCoverage <1% Seg13/14; heading gate fail | Practical coverage failed | slotSpanCoverage masks route coverage failure |

---

## Blocked methods

| Method | Blocker | Evidence |
| ------ | ------- | -------- |
| M-018 Calibration investigation | KA2-native intrinsics missing; Decision C partial only | `reports/video_lane_zero_label/CALIBRATION_INVESTIGATION_REPORT.md` |
| M-019 CLRerNet deferral | PINTO tarball not downloaded | `reports/video_lane_zero_label/ZERO_LABEL_VALIDATION_REPORT.md` |
| M-020 Missing camera intrinsics | `pixelProjection: BLOCKED` | `reports/video_lane_zero_label/calibration/modelv2_frame_provenance.json` |
| M-021 Missing rlogs / higher-rate modelV2 | qlog ~0.5 Hz; shared-event parity insufficient | `reports/lane_mapping_quality/higher_rate_evidence/acceptance_gate.json` |
| M-030 Higher-rate evidence request | No rlog / denser source in workspace | `reports/lane_mapping_quality/higher_rate_evidence/` |

---

## Evidence conflicts reconciled

| Conflict | Sources | Likely reason | Authoritative | Uncertainty |
| -------- | ------- | ------------- | ------------- | ----------- |
| Lane-change confirmed count 1 vs 3 | `narrow_gate.json` vs `LANE_CHANGE_REPORT.md` | Report counted geometric candidates, not `evaluateNarrowGate` confirmed | `narrow_gate.json` + `reports/candidate_layer_probe/CANDIDATE_LAYER_PROBE_REPORT.md` | None |
| Path 2 topologyRejected 26 vs 24 | Path 2 scan vs insufficient-support audit | Borderline topology gate / fold tie-break | Both scans agree on core populations | Low |
| Full-suite fail count 27 vs 28 | Hybrid validation vs post-migration runs | Environmental flake (Stage 7 OneDrive write; missing API server) | Document both phases; use focused suites for regression | Medium |
| Segment 0 mirror: data vs viewer | `storedVsExpectedMax=0` but user saw defect | Viewer ribbon/polygon omitted mirror fallback | Production coords correct; viewer path fixed (M-047) | Resolved |
| M-048 checkpoint vs experimental | Stage 19 v5 on main branch vs experiment branch | M-048 evidence exists but not committed on `experiment/candidate-layer-display` | Treat as **ACCEPTED EXPERIMENTAL** audit evidence, not experiment-branch checkpoint | None |
| Video M-015 blocked vs inventory complete | Earlier ledger listed M-015 BLOCKED | Status corrected: inventory/sync is proven; mapping integration remains blocked at M-020 | M-015 **ACCEPTED EXPERIMENTAL** for inventory only | None |

---

## Evidence index

### Commits (local checkpoints on experiment branch)

- `8ce0ab6` — current-frame connected display (M-038)
- `dbe7f26` — per-frame connected display (M-037)
- `f4932af` — persistent graph-fit cache (M-006)
- `cea7aab` — held-out memoization (M-005)
- `bbd7448` — hybrid fitted lane map (M-004)
- `8c5da91` — Path 1 graph fitting + viewer/probe parity (M-002, M-003)
- `188a83c` — fusion-v16 + stationary pose dwell + constructed/joined layers (M-001, M-049, M-031, M-032)

### Tests (authoritative when passing at checkpoint)

- `tests/graph_fit.test.js`, `tests/graph_fit_persistent_cache.test.js`
- `tests/connected_accumulated_display.test.js`
- `tests/mirror_alignment.test.js`, `tests/segment_mirror_display.test.js`
- `tests/constructed_fragments.test.js`, `tests/lane_joining.test.js`
- `tests/viewer_probe_parity.test.js`, `tests/stationary_pose_lock.test.js`

### Reports (JSON + Markdown)

| Path | Method IDs | Role |
| ---- | ---------- | ---- |
| `reports/lane_mapping_quality/LANE_MAPPING_DEFECT_AUDIT.md` | M-022 | Authoritative coverage diagnosis |
| `reports/insufficient_support_audit/INSUFFICIENT_SUPPORT_AUDIT.md` | M-013 | Support histogram |
| `reports/path2_design/path2_feasibility_report.md` | M-011, M-012 | Path 2 NO-GO |
| `reports/hybrid_validation/HYBRID_VALIDATION_REPORT.md` | M-004 | Hybrid GO report |
| `reports/hybrid_export_validation/HYBRID_EXPORT_VALIDATION_REPORT.md` | M-009, M-010 | Export validation |
| `reports/connected_accumulated/runtime/*.json` | M-035–M-047 | Connected-lane experiments |
| `reports/video_lane_feasibility/video_lane_feasibility.json` | M-015 | Video inventory |
| `reports/video_lane_zero_label/ZERO_LABEL_VALIDATION_REPORT.md` | M-016, M-017, M-018, M-019 | Video partial/blocked |
| `reports/candidate_layer_probe/CANDIDATE_LAYER_PROBE_REPORT.md` | M-029 | Lane-change reconciliation |
| `audit_stage19_dataset_sensitivity.json` | M-048 | Dataset sensitivity audit |
| `reports/stage19_v5_corrective_checkpoint_report.json` | M-048 | Stage 19 v5 structural validation |

### Screenshots

- `reports/fitted_layer_probe/seg2_fitted_only_mirror_*.png` — fitted layer mirror states
- `reports/hybrid_validation/browser_captures/` — hybrid viewer captures
- `reports/connected_accumulated/runtime/*.png` — connected-accumulated mode comparisons

---

## Recommended next method (not completed)

**Rank-by-bin road-guided dot connection** — a follow-on to rejected M-046:

1. At every trajectory bin, cluster all eligible dots (no anchor propagation from a single seed frame).
2. Assign lateral slots by **rank order** within the bin (left-to-right by lateral offset `d`).
3. Connect assigned dots along `s` to form `d(s)` per slot; smooth `d(s)` with bounded curvature.
4. Count and report **prefix**, **internal**, and **suffix** coverage gaps explicitly.
5. Exclude invalid trajectory loops and mixed chunk/pass intervals before slot assignment.

This addresses M-046 failures where anchor propagation produced 100% slot-span but <1% guide coverage on Seg13/14. Status: **not started**; no validation JSON exists.

---

## Detailed method entries

### M-001 — Fusion-v16 baseline processing

* **Goal:** Establish stable production processing for fused road geometry and vehicle pose under stationary segments.
* **Method:** Two-pass stationary pose dwell locking in `lib/process_route.js` / `lib/stationary_pose_lock.js`; version bump to `2026-07-24-fusion-v16` in `lib/version.js`.
* **Evidence:** `reports/stationary_pose_dwell_fix.md`; `tests/stationary_pose_lock.test.js`; commit `188a83c`.
* **Result:** v11 geometry unchanged; pose semantics improved.
* **Status:** **CHECKPOINTED**
* **Reason:** 92-segment v11 compare: 0 diffs; validated processing bump.
* **Limitation:** Does not increase lane-boundary coverage or temporal support density.
* **Project implication:** All later experiments must use fusion-v16; v11 remains frozen geometry reference.

| Metric | Value |
| ------ | ----- |
| v11 geometry compare (92 seg) | 0 differences |
| Processing version | `2026-07-24-fusion-v16` |
| False travel removed (with M-049) | 302 m dataset-wide |

---

### M-002 — Path 1 graph fitting

* **Goal:** Fit smooth splines over constructed fragment runs for display diagnosis.
* **Method:** `lib/graph_fit.js`; `fitEnabled` via `?fit=1`; source-corridor gate 3.0 m.
* **Evidence:** `reports/fitted_layer_probe/segment_fitted_summary.json`; commit `8c5da91`.
* **Result:** Accepted fits on Seg2, Seg3, Seg14, Seg16; polygons unchanged.
* **Status:** **CHECKPOINTED**
* **Reason:** Passed corridor gates; display-only layer validated.
* **Limitation:** Complete-map only; long segments slow; does not feed polygons.
* **Project implication:** Foundation for hybrid map (M-004).

| Metric | Seg2 | Seg14 | Seg16 |
| ------ | ---- | ----- | ----- |
| Accepted fits | 4 | 7 | 9 |
| Polygons changed | No | No | No |

---

### M-003 — Shared viewer/probe production path

* **Goal:** Align CLI probes with browser viewer map construction.
* **Method:** Single authority `lib/viewer_map_build.js` shared by probes and `/api/process`.
* **Evidence:** `reports/fitted_layer_probe/viewer_browser_parity.json`; commit `8c5da91`.
* **Result:** Probe/browser parity on accepted fit counts.
* **Status:** **CHECKPOINTED**
* **Reason:** Eliminates probe/viewer drift.
* **Limitation:** Applies to fit-enabled complete-map path only.
* **Project implication:** All fit audits must use viewer_map_build.

---

### M-004 — Hybrid graph-fitted lane map

* **Goal:** One hybrid boundary per constructed fragment with fit-or-fallback rendering.
* **Method:** `GraphFit.buildHybridFittedBoundaries()` in `lib/graph_fit.js`; viewer checkbox; commit `bbd7448`.
* **Evidence:** `reports/hybrid_validation/HYBRID_VALIDATION_REPORT.md`.
* **Result:** 0 fallback mismatches; accepted counts match Path 1.
* **Status:** **CHECKPOINTED**
* **Reason:** Hybrid validation **GO**; polygons unchanged.
* **Limitation:** Off by default; complete-map only; suppressed during causal playback.
* **Project implication:** Best validated display-only fitted layer.

| Metric | Value |
| ------ | ----- |
| Fallback exactness mismatches | 0 |
| Accepted-fit exactness mismatches | 0 |
| Focused tests | 149/149 pass |

---

### M-005 — Held-out graph-fit memoization

* **Goal:** Reduce repeat complete-map fitting cost.
* **Method:** Memoized held-out evaluation inside `lib/graph_fit.js`; commit `cea7aab`.
* **Evidence:** `tests/graph_fit.test.js` (+112 tests).
* **Result:** Repeat fits skip redundant held-out work.
* **Status:** **CHECKPOINTED**
* **Reason:** Measurable speedup without geometry change.
* **Limitation:** In-memory only (superseded by M-006 for persistence).
* **Project implication:** Enabled practical hybrid validation on long segments.

---

### M-006 — Persistent IndexedDB graph-fit cache

* **Goal:** Warm viewer reload without refitting.
* **Method:** `lib/graph_fit_persistent_cache.js`; IndexedDB store `kommuGraphFitPersistV1`; commit `f4932af`.
* **Evidence:** `reports/graph_fit_performance/persist_browser_gate.json`.
* **Result:** Seg2 10/10 cycles; Seg14 warm ~1.3 s, 0 fitter calls.
* **Status:** **CHECKPOINTED**
* **Reason:** Browser gate passed; display-only cache.
* **Limitation:** Origin-specific; 512 MB LRU; fit-disabled path bypasses cache.
* **Project implication:** Makes hybrid layer usable across reloads.

| Metric | Seg2 | Seg14 warm |
| ------ | ---- | ---------- |
| Browser gate cycles | 10/10 | E2E pass |
| Fitter calls (warm) | 0 | 0 |
| Build time (warm) | — | ~1.3 s |

---

### M-007 — Hybrid map quality audit

* **Goal:** Measure accepted-fit geometry quality beyond acceptance gates.
* **Method:** Heuristic audit over 100 accepted fits.
* **Evidence:** `reports/hybrid_map_quality/accepted_fit_geometry_metrics.json`.
* **Result:** 2,931 m flagged by heuristics; production gates still pass.
* **Status:** **ACCEPTED EXPERIMENTAL**
* **Reason:** Diagnostic overlay; not a production gate.
* **Limitation:** Heuristic flags ≠ defects.
* **Project implication:** Informed M-008 export downgrade policy.

---

### M-008 — Suspicious accepted-fit audit

* **Goal:** Decide export safety for accepted fits.
* **Method:** Category A–E classification of fit quality flags.
* **Evidence:** `reports/hybrid_map_quality/suspicious_fit_audit/SUSPICIOUS_FIT_AUDIT.md`.
* **Result:** 9 category-E fragments; 84/100 flags are resample artifacts.
* **Status:** **ACCEPTED EXPERIMENTAL**
* **Reason:** Export policy input only.
* **Limitation:** Resample sensitivity can inflate smoothness metrics.
* **Project implication:** Led to M-009 safe export downgrade.

---

### M-009 — Category-E export downgrade

* **Goal:** Safer hybrid export metadata for marginal fits.
* **Method:** Export policy `safe` downgrades category-E fragments in export bundle.
* **Evidence:** `reports/hybrid_export_validation/HYBRID_EXPORT_VALIDATION_REPORT.md`.
* **Result:** 9 fragments downgraded; production acceptance unchanged.
* **Status:** **ACCEPTED EXPERIMENTAL**
* **Reason:** Export contract safety without changing viewer acceptance.
* **Limitation:** Downgrade is metadata-only in safe mode.
* **Project implication:** Enables M-010 export path with guardrails.

---

### M-010 — Experimental hybrid export

* **Goal:** JSON/CSV deliverable from viewer hybrid map.
* **Method:** `lib/hybrid_lane_export*.js`; deliverables under `deliverables/hybrid_lane_map_v1/`.
* **Evidence:** `deliverables/hybrid_lane_map_v1/` manifests; export validation report.
* **Result:** All-92 safe export reconciled; user paused rollout.
* **Status:** **PARTIAL**
* **Reason:** Export architecture works; underlying mapping quality still limited.
* **Limitation:** Display geometry only; not confirmed mapping.
* **Project implication:** Export paused pending mapping quality improvements.

---

### M-011 — Path 2 ordering recovery

* **Goal:** Recover topology-aware graph fitting where Path 1 ordering fails.
* **Method:** Feasibility scan across 92 segments for ordering recovery.
* **Evidence:** `reports/path2_design/path2_feasibility_report.md`.
* **Result:** 52 eligible segments; **NO-GO** — zero safe ordering recovery.
* **Status:** **REJECTED**
* **Reason:** `orderingInvalid: 67`; structural ambiguity.
* **Limitation:** Path 2 cannot proceed without ordering breakthrough.
* **Project implication:** Path 1 + hybrid remain the only fit path.

| Metric | Value |
| ------ | ----- |
| Path 2 eligible segments | 52 |
| orderingInvalid | 67 |
| Recovered orderings | 0 |

---

### M-012 — MST / kNN / PCA / temporal ordering prototypes

* **Goal:** Alternative ordering strategies for Path 2.
* **Method:** Prototype ordering algorithms scanned in Path 2 feasibility report.
* **Evidence:** `reports/path2_design/path2_feasibility_report.md`.
* **Result:** No prototype passed feasibility gate.
* **Status:** **REJECTED**
* **Reason:** Subsumed by M-011 NO-GO.
* **Limitation:** Ordering is structural, not algorithm-tuning problem.
* **Project implication:** Do not invest in Path 2 prototypes without new evidence type.

---

### M-013 — Insufficient-support audit

* **Goal:** Explain why 3,317 fragments are `insufficientSupport`.
* **Method:** Histogram audit over fragment support frames.
* **Evidence:** `reports/insufficient_support_audit/INSUFFICIENT_SUPPORT_AUDIT.md`.
* **Result:** 71% have exactly 2 distinct frames.
* **Status:** **ACCEPTED EXPERIMENTAL**
* **Reason:** Confirms sparse 0.5 Hz support as root cause.
* **Limitation:** Audit only; does not change gates.
* **Project implication:** Coverage improvements need denser evidence, not threshold cuts.

| Metric | Value |
| ------ | ----- |
| insufficientSupport fragments | 3,317 |
| Exactly 2 distinct frames | 71% |

---

### M-014 — Threshold lowering (support / spatial)

* **Goal:** Increase joined coverage by relaxing support/spatial gates.
* **Method:** Dedup counterfactual + policy review.
* **Evidence:** `reports/lane_mapping_quality/dedup_support/DEDUP_SUPPORT_REPORT.md`.
* **Result:** +0.04 pp provenance coverage.
* **Status:** **REJECTED**
* **Reason:** Negligible gain; violates project safety rules.
* **Limitation:** Cannot overcome sparse evidence by threshold change.
* **Project implication:** Threshold correction not approved.

---

### M-015 — Video Stage V1 feasibility (qcamera inventory/sync)

* **Goal:** Establish qcamera video inventory and sync to modelV2 timeline.
* **Method:** Video feasibility scan; MP4 cache inventory.
* **Evidence:** `reports/video_lane_feasibility/video_lane_feasibility.json`.
* **Result:** **64/92** segments have cached MP4; sync probes pass.
* **Status:** **ACCEPTED EXPERIMENTAL**
* **Reason:** Inventory and sync proven; mapping integration separate.
* **Limitation:** Video not in confirmed mapping path; no manual labels required.
* **Project implication:** Video remains preparatory until M-020 unblocked.

| Metric | Value |
| ------ | ----- |
| qlog segments | 92 |
| cached MP4 | 64 |

---

### M-016 — Video Stage V2 / UFLD

* **Goal:** Run ultra-fast lane detector on qcamera frames.
* **Method:** UFLD v2 PINTO ONNX on 526×330 image space.
* **Evidence:** `reports/video_lane_zero_label/ZERO_LABEL_VALIDATION_REPORT.md`.
* **Result:** **150/150** frames inferred; 59% zero-output rate.
* **Status:** **PARTIAL**
* **Reason:** Inference complete; vehicle-frame projection blocked.
* **Limitation:** Image-space only; temporal persistence weak on several segments.
* **Project implication:** UFLD usable for diagnostics, not mapping.

| Metric | Value |
| ------ | ----- |
| UFLD frames | 150/150 |
| Zero-output rate | 59% |

---

### M-017 — Zero-label validation

* **Goal:** Validate video lanes without manual labels.
* **Method:** Image-space zero-label gates; cross-source agreement scaffolding.
* **Evidence:** `reports/video_lane_zero_label/ZERO_LABEL_VALIDATION_REPORT.md`.
* **Result:** Image-space gates recorded; mapping-integration gates blocked.
* **Status:** **PARTIAL**
* **Reason:** No trusted reprojection to vehicle frame.
* **Limitation:** Zero-label in pixels ≠ zero-label in map coordinates.
* **Project implication:** Blocked at calibration (M-018–M-020).

---

### M-018 — Calibration investigation

* **Goal:** Find usable camera intrinsics for video-to-model alignment.
* **Method:** Provenance audit of qcamera, modelV2 frame mapping, KA2 release chain.
* **Evidence:** `reports/video_lane_zero_label/CALIBRATION_INVESTIGATION_REPORT.md`.
* **Result:** Decision C — partial calibration only; KA2-native intrinsics missing.
* **Status:** **BLOCKED**
* **Reason:** Cannot project pixels to vehicle frame reliably.
* **Limitation:** Requires external Kommu calibration delivery.
* **Project implication:** Video mapping paused until intrinsics supplied.

---

### M-019 — CLRerNet deferral

* **Goal:** Second detector for cross-detector consensus.
* **Method:** CLRerNet selection and environment preparation.
* **Evidence:** `reports/video_lane_zero_label/second_detector/selection_report.json`.
* **Result:** PINTO tarball not downloaded; separate venv required.
* **Status:** **BLOCKED**
* **Reason:** Environment not prepared.
* **Limitation:** Single-detector consensus only (UFLD).
* **Project implication:** Defer until calibration path exists.

---

### M-020 — Missing camera intrinsics

* **Goal:** Project video lane detections to vehicle/model frame.
* **Method:** Pixel projection gate using qcamera intrinsics.
* **Evidence:** `reports/video_lane_zero_label/calibration/modelv2_frame_provenance.json`.
* **Result:** `pixelProjection: BLOCKED` — no qcamera K in workspace.
* **Status:** **BLOCKED**
* **Reason:** Missing intrinsics matrix.
* **Limitation:** Blocks all video-to-map integration.
* **Project implication:** Hard gate for video mapping.

---

### M-021 — Missing rlogs / higher-rate modelV2

* **Goal:** Obtain denser temporal lane evidence than 0.5 Hz qlog.
* **Method:** Higher-rate evidence acceptance gate.
* **Evidence:** `reports/lane_mapping_quality/higher_rate_evidence/acceptance_gate.json`.
* **Result:** Shared-event parity insufficient; no rlog source in workspace.
* **Status:** **BLOCKED**
* **Reason:** Cannot validate denser modelV2 without rlogs.
* **Limitation:** qlog remains sole evidence source.
* **Project implication:** Coverage ceiling is evidence-density limited.

---

### M-022 — Provenance coverage audit

* **Goal:** Explain why accumulated dots ≠ joined polyline provenance.
* **Method:** Dataset-wide and Seg1 deep-dive provenance audit.
* **Evidence:** `reports/lane_mapping_quality/LANE_MAPPING_DEFECT_AUDIT.md`.
* **Result:** 40.41% dataset provenance; insufficient support dominates.
* **Status:** **ACCEPTED EXPERIMENTAL**
* **Reason:** Authoritative coverage diagnosis.
* **Limitation:** Provenance % ≠ spatial coverage %.
* **Project implication:** Sets expectations for joined-map completeness.

| Metric | Dataset | Seg1 |
| ------ | ------- | ---- |
| Joined provenance % | 40.41% | 31.95% |

---

### M-023 — Spatial coverage audit

* **Goal:** Measure geometric metres uncovered by joined polylines.
* **Method:** Boundary-metre distance-to-join analysis.
* **Evidence:** `reports/lane_mapping_quality/spatial_coverage/`.
* **Result:** 79,847 boundary-metres >0.5 m from nearest join.
* **Status:** **ACCEPTED EXPERIMENTAL**
* **Reason:** Geometric gap quantified separately from provenance.
* **Limitation:** Does not identify fix; diagnosis only.
* **Project implication:** Spatial and provenance metrics must be reported together.

| Metric | Value |
| ------ | ----- |
| Boundary-metres >0.5 m from join | 79,847 |

---

### M-024 — Dedup support propagation

* **Goal:** Recover temporal support lost during deduplication.
* **Method:** Counterfactual: count distinct frames across deduped sources.
* **Evidence:** `reports/lane_mapping_quality/dedup_support/DEDUP_SUPPORT_REPORT.md`.
* **Result:** +1,160 obs; +0.04 pp provenance.
* **Status:** **REJECTED**
* **Reason:** Negligible vs 56,954 unsupported observations.
* **Limitation:** Dedup is not primary coverage blocker.
* **Project implication:** Do not change dedup policy for coverage.

---

### M-025 — Point-to-polyline temporal support

* **Goal:** Use per-frame curves as support evidence for joining.
* **Method:** Candidate distance metrics between dots and polyline support corridors.
* **Evidence:** `reports/lane_mapping_quality/polyline_support/`.
* **Result:** Metrics recorded; still far from joined geometry.
* **Status:** **ACCEPTED EXPERIMENTAL**
* **Reason:** Useful diagnostic; not a production join rule.
* **Limitation:** Per-frame curves do not span route.
* **Project implication:** Support evidence needs multi-frame density.

---

### M-026 — Frame alignment / registration

* **Goal:** Fix pose misalignment tail via frame registration.
* **Method:** Variants R1/R2/R3 frame alignment counterfactuals.
* **Evidence:** `reports/lane_mapping_quality/frame_alignment/`.
* **Result:** All variants regress support and/or geometry.
* **Status:** **REJECTED**
* **Reason:** Transform chain already correct.
* **Limitation:** Registration cannot fix motion-dominated tail.
* **Project implication:** Retain baseline pose pipeline.

---

### M-027 — Pose/heading tail investigation

* **Goal:** Explain P95 1.56 m lateral residual in pose tail.
* **Method:** Pose continuity and speed analysis; Gate E counterfactuals.
* **Evidence:** `reports/lane_mapping_quality/pose_heading_tail/POSE_HEADING_TAIL_REPORT.md`.
* **Result:** No safe pose correction; tail is motion-dominated.
* **Status:** **REJECTED**
* **Reason:** **Gate E** — retain baseline.
* **Limitation:** P95 tail is not a GPS interpolation bug.
* **Project implication:** Do not apply pose corrections for mapping.

| Metric | Value |
| ------ | ----- |
| P95 lateral residual (featured) | 1.56 m |
| Safe correction found | No |

---

### M-028 — Heading-source alternatives

* **Goal:** Find better reference heading for alignment checks.
* **Method:** Narrow counterfactual heading sources.
* **Evidence:** `reports/lane_mapping_quality/heading_source/`.
* **Result:** Counterfactuals recorded; no approved replacement.
* **Status:** **INCONCLUSIVE**
* **Reason:** No alternative beat baseline under project gates.
* **Limitation:** Small sample counterfactuals only.
* **Project implication:** Retain default heading source pending new evidence.

---

### M-029 — Lane-change identity investigation

* **Goal:** Determine if raw laneIndex can identify physical boundaries through lane changes.
* **Method:** Candidate layer probe; narrow gate evaluation; Seg99 focus.
* **Evidence:** `reports/candidate_layer_probe/CANDIDATE_LAYER_PROBE_REPORT.md`.
* **Result:** 1 confirmed lane-change event (Seg99); Seg1 unsafe mixing.
* **Status:** **REJECTED**
* **Reason:** laneIndex is not a physical boundary ID.
* **Limitation:** groupTrackId required with lane-change guards.
* **Project implication:** Identity rules must use groupTrackId + chunk/pass context.

---

### M-030 — Higher-rate evidence request

* **Goal:** Independent validation of denser modelV2 source.
* **Method:** Acceptance gate for higher-rate evidence bundle.
* **Evidence:** `reports/lane_mapping_quality/higher_rate_evidence/`.
* **Result:** Gate failed — no rlog source in workspace.
* **Status:** **BLOCKED**
* **Reason:** Same blocker as M-021.
* **Limitation:** Cannot proceed without external data delivery.
* **Project implication:** Formal evidence request documented; awaiting data.

---

### M-031 — Constructed fragments

* **Goal:** Build local polylines from accumulated dots with support gates.
* **Method:** `lib/constructed_fragments.js`; 5-pt moving-average smoothing; split on gaps/conflicts.
* **Evidence:** `reports/constructed_fragments_experimental.md`; commit `188a83c`.
* **Result:** 160 fragments / 5 segments; median residual ~0.13 m.
* **Status:** **ACCEPTED EXPERIMENTAL**
* **Reason:** Display layer works; source points unmodified.
* **Limitation:** Support gate excludes most dots; display-only.
* **Project implication:** Input layer for Path 1 fitting and joining.

| Metric | Value |
| ------ | ----- |
| Fragments (5 segs) | 160 |
| Median fragment residual | ~0.13 m |

---

### M-032 — Lane joining

* **Goal:** Connect compatible constructed fragments into polylines.
* **Method:** `lib/lane_joining.js`; mutual-best selection; evidence corridor checks.
* **Evidence:** `reports/lane_joining_stage.md`; commit `188a83c`.
* **Result:** Seg14: 6 polylines / 19 connections; all 10 K-checks PASS.
* **Status:** **ACCEPTED EXPERIMENTAL**
* **Reason:** Conservative joining validated on threshold segments.
* **Limitation:** Noisy segments remain largely unjoined by design.
* **Project implication:** Best validated joined display layer.

| Metric | Seg14 | Seg16 |
| ------ | ----- | ----- |
| Polylines | 6 | 4 |
| Accepted connections | 19 | 13 |

---

### M-033 — Mirror alignment (constructed/joined)

* **Goal:** Fix mirror toggle desync between dots and constructed/joined layers.
* **Method:** Precomputed mirrored coordinates through `roadGeometryToScreen` selector.
* **Evidence:** `reports/mirror_alignment_fix.md`; `tests/mirror_alignment.test.js`.
* **Result:** All layers move together; 10/10 tests pass.
* **Status:** **ACCEPTED EXPERIMENTAL**
* **Reason:** Mirror regression fixed for constructed/joined path.
* **Limitation:** Viewer display only.
* **Project implication:** Mirror contract prerequisite for M-047.

---

### M-034 — Candidate amber-line display

* **Goal:** Show unconfirmed join candidates for diagnosis.
* **Method:** `_drawJoinCandidates` in `public/render.js`; amber debug layer.
* **Evidence:** `public/render.js`; candidate layer probe reports.
* **Result:** Debug layer renders candidate connections.
* **Status:** **ACCEPTED EXPERIMENTAL**
* **Reason:** Diagnostic visibility for joining decisions.
* **Limitation:** Not production geometry.
* **Project implication:** Supports lane-change and join debugging.

---

### M-035 — Raw same-colour dot connection

* **Goal:** Connect all dots of same track colour across frames.
* **Method:** Cross-frame ordering by `modelX` in `connected_accumulated_display.js`.
* **Evidence:** `reports/connected_accumulated/runtime/perframe_comparison.json`.
* **Result:** Seg13: 890 zigzag edges; severe sawtooth.
* **Status:** **REJECTED**
* **Reason:** Cross-frame modelX ordering produces sawtooth.
* **Limitation:** Cannot order across frames by modelX alone.
* **Project implication:** Led to per-frame isolation (M-037).

| Metric | Seg13 raw |
| ------ | --------- |
| zigzagEdgeCount | 890 |
| polylineCount | 31 |

---

### M-036 — Robust longitudinal-bin representative

* **Goal:** Reduce zigzag via bin-based medoid representatives.
* **Method:** Longitudinal binning + medoid selection before connection.
* **Evidence:** `reports/connected_accumulated/runtime/robust_comparison.json`.
* **Result:** Zigzag reduced (890→137 Seg13) but 239 polylines; poor route coverage.
* **Status:** **REJECTED**
* **Reason:** Fragmentation unacceptable despite improved jump stats.
* **Limitation:** Medoids do not span full route.
* **Project implication:** Bin representatives insufficient alone.

| Metric | Seg13 raw | Seg13 robust |
| ------ | --------- | ------------ |
| zigzagEdgeCount | 890 | 137 |
| polylineCount | 31 | 239 |

---

### M-037 — Per-frame connected lines

* **Goal:** One polyline per frame per identity — no cross-frame connections.
* **Method:** `connected_accumulated_display.js` per-frame algorithm; commit `dbe7f26`.
* **Evidence:** `reports/connected_accumulated/runtime/final_validation.json`.
* **Result:** Seg1: 91 polylines / 30 frames; 0 cross-frame connections.
* **Status:** **CHECKPOINTED**
* **Reason:** Removes sawtooth; validated structural metrics.
* **Limitation:** Overlapping lines across frames when all shown.
* **Project implication:** Foundation for current-frame filter (M-038).

| Metric | Seg1 | Seg13 |
| ------ | ---- | ----- |
| polylines | 91 | 90 |
| crossFrameConnections | 0 | 0 |
| zigzag (vs raw) | — | eliminated |

---

### M-038 — Current-frame connected display

* **Goal:** Show only the active playback frame's connected curves.
* **Method:** Filter per-frame set to current timeline index; commit `8ce0ab6`.
* **Evidence:** `reports/connected_accumulated/runtime/current_frame_validation.json`.
* **Result:** Stable during playback; map checksum unchanged.
* **Status:** **CHECKPOINTED**
* **Reason:** Removes cross-frame overlap artifact.
* **Limitation:** Display-only; not joined map.
* **Project implication:** Default connected-accumulated viewer mode.

---

### M-039 — Consensus mode (v1)

* **Goal:** Multi-frame bin consensus polylines.
* **Method:** Bin-wise agreement without spatial clustering.
* **Evidence:** `reports/connected_accumulated/runtime/consensus_comparison.json`.
* **Result:** Seg13 p95 contributor distance **6.14 m**.
* **Status:** **REJECTED**
* **Reason:** Source-distance too large for usable consensus.
* **Limitation:** v1 bin consensus ignores spatial cluster structure.
* **Project implication:** Led to v2 interpolated cluster (M-040).

| Metric | Seg13 consensus v1 |
| ------ | ------------------ |
| p95ContributorDistance | 6.14 m |
| polylineCount | 376 |

---

### M-040 — Corrected consensus (v2 interpolated cluster)

* **Goal:** Fix consensus distance and fragmentation via spatial clustering + interpolation.
* **Method:** `consensus-v2-interpolated-spatial-cluster` algorithm.
* **Evidence:** `reports/connected_accumulated/runtime/consensus_comparison.json`.
* **Result:** Seg13 p95 contributor **0.53 m**; 28 polylines; still incomplete vs joined map.
* **Status:** **PARTIAL**
* **Reason:** Metrics improved but route coverage incomplete.
* **Limitation:** Does not replace constructed/joined map.
* **Project implication:** Best consensus variant; still display-only.

| Metric | Seg13 v1 | Seg13 v2 |
| ------ | -------- | -------- |
| p95ContributorDistance | 6.14 m | 0.53 m |
| polylineCount | 376 | 28 |

---

### M-041 — Representative fused path

* **Goal:** Select medoid representatives per bin then connect.
* **Method:** Representative-point selection + connection (documented alongside robust comparison).
* **Evidence:** `reports/connected_accumulated/runtime/representative_path_validation.json`.
* **Result:** Incomplete route coverage; crossLaneIntersections on some segments.
* **Status:** **PARTIAL**
* **Reason:** Representatives do not span full route.
* **Limitation:** Fragmentation and gaps remain.
* **Project implication:** Representative selection alone insufficient.

---

### M-042 — Trajectory-aligned current frame

* **Goal:** Align current-frame curves to grey vehicle trajectory.
* **Method:** Trajectory-aligned offset correction on current-frame polylines.
* **Evidence:** `reports/connected_accumulated/runtime/trajectory_aligned_validation.json`.
* **Result:** Validation JSON present; did not replace joined map.
* **Status:** **REJECTED**
* **Reason:** No measurable improvement over M-038 baseline for mapping use.
* **Limitation:** Alignment does not create multi-frame support.
* **Project implication:** Trajectory alignment deferred.

---

### M-043 — Native-coordinate current-frame smoothing

* **Goal:** Smooth polylines in native modelX/modelY coordinates.
* **Method:** Heading change rate reduction filter on current-frame curves.
* **Evidence:** `reports/connected_accumulated/runtime/smoothed_current_frame_validation.json`.
* **Result:** p95 heading change rate reduced (e.g. Seg13: 2.68→0.20 °/step).
* **Status:** **PARTIAL**
* **Reason:** Quantitative smoothness gain; visual improvement not indexed.
* **Limitation:** Smoothing ≠ coverage; unverified visually in repo.
* **Project implication:** Optional display polish only.

| Metric | Seg13 before | Seg13 after |
| ------ | ------------ | ----------- |
| p95HeadingChangeRate | 2.68 | 0.20 |

---

### M-044 — Road-guided static v1

* **Goal:** Trajectory-guided static slot boundaries along grey path.
* **Method:** `road-guided-static-v1` in connected accumulated display.
* **Evidence:** `reports/connected_accumulated/runtime/road_guided_static_validation.json`.
* **Result:** Seg13/14/95 collapsed to 1 slot; Seg99 6 slots; 62 crossLaneIntersections.
* **Status:** **REJECTED**
* **Reason:** Slot collapse and cross-lane intersections.
* **Limitation:** No lane-count anchoring.
* **Project implication:** Superseded by v2 (M-045).

| Metric | Seg13/14/95 | Seg99 |
| ------ | ----------- | ----- |
| staticLaneSlotCount | 1 (collapsed) | 6 |
| crossLaneIntersections | 0 / 0 / 0 | 62 |

---

### M-045 — Road-guided static v2

* **Goal:** Lane-count-anchored static slots along trajectory.
* **Method:** `road-guided-static-v2`; per-frame lane count histogram anchoring.
* **Evidence:** `reports/connected_accumulated/runtime/road_guided_static_v2_validation.json`.
* **Result:** Correct slot counts; low supported coverage.
* **Status:** **PARTIAL**
* **Reason:** Topology correct; span coverage too low for mapping.
* **Limitation:** ~15% supported coverage on key segments.
* **Project implication:** Led to dot-connection experiment (M-046).

| Metric | Seg13 | Seg14 | Seg95 |
| ------ | ----- | ----- | ----- |
| supportedCoveragePct | 15.0% | 62.9% | 13.2% |
| p95HeadingDiff | 6.80° | 1.20° | 12.63° |
| slotCountMatch | true | true | true |

---

### M-046 — Road-guided dot connection v1

* **Goal:** Connect eligible dots into trajectory-aligned slot boundaries.
* **Method:** `road-guided-dot-connection-v1`; anchor propagation along trajectory bins.
* **Evidence:** `reports/connected_accumulated/runtime/road_guided_dot_connection_validation.json`.
* **Result:** slotSpanCoverage 100% but guideCoverage 0.52%/0.49%/11.3%; heading gate fail Seg14.
* **Status:** **REJECTED**
* **Reason:** Practical coverage failed; p95_heading Seg14 16.42°; Seg95 maxHeading 176.5°.
* **Limitation:** Anchor propagation leaves route largely uncovered.
* **Project implication:** Recommended next: rank-by-bin variant (see above).

| Metric | Seg13 | Seg14 | Seg95 |
| ------ | ----- | ----- | ----- |
| slotSpanCoveragePct | 100% | 100% | 100% |
| guideCoveragePct | 0.52% | 0.49% | 11.3% |
| p95HeadingDiff | 10.03° | **16.42°** | 0.93° |
| maxHeadingDiff | 10.03° | 18.52° | **176.5°** |

---

### M-047 — Segment 0 mirror display correction

* **Goal:** Fix incorrect lateral mirror behaviour in viewer for Segment 0.
* **Method:** Shared mirror resolver in `lib/viewer_mirror_coords.js`, `public/render.js`, `connected_accumulated_display.js`. **Uncommitted** at generation.
* **Evidence:** `reports/connected_accumulated/runtime/segment0_mirror_validation.json`; `tests/segment_mirror_display.test.js`.
* **Result:** Production `storedVsExpectedMax=0`; viewer ribbon/polygon fallback fixed.
* **Status:** **ACCEPTED EXPERIMENTAL**
* **Reason:** Generic viewer mirror contract restored; production geometry unchanged.
* **Limitation:** Viewer display fix only; ribbon fallback error up to ~1.1 m on legacy path.
* **Project implication:** All road-geometry viewer layers must use shared mirror resolver.

| Metric | Seg0 |
| ------ | ---- |
| storedVsExpectedMax | 0 m |
| wrongFallbackVsStoredMax | 339 m (legacy) |
| mapChecksum | unchanged (`a5d08fd0`) |

---

### M-048 — Stage 19 v5 dataset-sensitivity audit

* **Goal:** Audit Stage 19 behaviour on real dataset under approved Rev 37 config.
* **Method:** Read-only dataset sensitivity audit; BEV evidence bundle; singleton chain analysis.
* **Evidence:** `audit_stage19_dataset_sensitivity.json`; `reports/stage19_v5_corrective_checkpoint_report.json`.
* **Result:** 5,809 singleton chains; multi-obs chains 0; P3 0/0/0; median separation ~33 m vs 12 m cap.
* **Status:** **ACCEPTED EXPERIMENTAL**
* **Reason:** Authoritative dataset constraint record; **NOT checkpointed on experiment branch** (no commit).
* **Limitation:** Documents dataset limitation, not implementation defect.
* **Project implication:** Stage 19 matching/filtering is primary singleton cause on this dataset.

| Metric | Value |
| ------ | ----- |
| Observations | 5,809 |
| Singleton chains | 5,809 |
| Multi-obs chains | 0 |
| P3 eligible/executed/selected | 0/0/0 |
| Median spatial separation | ~32.98 m |
| Approved spatial cap | 12 m |

---

### M-049 — Stationary pose dwell correction

* **Goal:** Lock mapping pose during stop-confirmation dwell window.
* **Method:** Two-pass anchor retrospective apply in `lib/stationary_pose_lock.js`; commit `188a83c`.
* **Evidence:** `reports/stationary_pose_dwell_fix.md`; `tests/stationary_pose_lock.test.js`.
* **Result:** 302 m false travel removed dataset-wide; fully-stationary mapped travel → 0 m.
* **Status:** **CHECKPOINTED**
* **Reason:** Validated pose semantics bump paired with M-001 fusion-v16.
* **Limitation:** Does not affect lane detection or joining logic.
* **Project implication:** Pose lock is part of production processing baseline.

| Metric | single-pass | two-pass (M-049) |
| ------ | ----------- | ---------------- |
| False travel removed | 172 m | **302 m** |
| Fully-stationary mapped travel | 0.2–1.2 m | **0 m** |

---

### M-050 — Rank-by-bin road-guided dot connection

* **Goal:** Static trajectory-aligned lane boundaries by ranking lateral clusters at every 1 m bin without anchor propagation.
* **Method:** `road-guided-ranked-connection-v1`; `buildRoadGuidedRankedConnectionDisplay`; forward rank assignment with backward agreement on ambiguous bins (M≠K); reuse `buildDotConnectionParts` with ranked display mode.
* **Evidence:** `reports/connected_accumulated/runtime/road_guided_ranked_validation.json`; `tests/connected_accumulated_display.test.js` (tests 91–95).
* **Result:** Automated gates **FAIL** (eligible assignment &lt;80%; Seg13/14 guide coverage below 70%/75%; suffix gaps). Seg14 improved vs anchor dot connection (61.8% guide vs 0.49%); Seg13 48.8% vs 0.52%. No 176.5° heading spike on Seg95 (max 9.5°). Map checksum unchanged.
* **User manual viewer review, 2026-08-26.** Screenshots supplied in chat but not indexed in repository. Seg13 **186** rendered parts; Seg14 **234**; Seg95 **23**; Seg99 **3** short valid parts. Long sections often begin correctly but split into many short dashed parts. Seg99 grey road shows a malformed loop/revisit trajectory. Manual decision: M-050 remains **PARTIAL**, not approved for checkpoint.
* **Assignment-metric bug (fixed in M-051):** `eligibleDotAssignmentPct` mixed bidirectional-filtered vote numerators with bin-cluster vote denominators (e.g. Seg13 reported 37.3% vs correct bin evidence 2030/2340 = 86.8%). Replaced by three explicit metrics in sequence builder stats.
* **Status:** **PARTIAL**
* **Reason:** Meaningful improvement on Seg14 heading and coverage vs M-046 anchor algorithm; coverage and vote-assignment gates not met on Seg13/95/99.
* **Limitation:** Viewer-only experimental geometry; uncommitted on `experiment/candidate-layer-display`; `Current frame` remains default.
* **Project implication:** Rank-by-bin replaces anchor propagation for manual review; further work on ambiguous-bin agreement and gap bridging before ACCEPTED EXPERIMENTAL.

| Metric | Seg13 | Seg14 | Seg95 | Seg99 |
| ------ | ----- | ----- | ----- | ----- |
| guideCoveragePct | 48.8% | 61.8% | 22.9% | 4.0% |
| eligibleDotAssignmentPct (deprecated) | 37.3% | 52.2% | 13.4% | 5.0% |

---

### M-051 — Sequence-wide road-guided lane connection

* **Goal:** Viewer-only static lane boundaries via one global ordered slot assignment per valid trajectory run, without anchor propagation or forward/backward fingerprint agreement.
* **M-050 fragmentation cause:** Bidirectional fingerprint rejection at ambiguous bins plus 8 m chain-split in ranked display mode produced hundreds of short dashed parts despite good local bin evidence.
* **Method:** `road-guided-sequence-connection-v1`; `buildRoadGuidedSequenceConnectionDisplay`; reuse M-050 bin clustering; beam search (width 64) with emission/transition scoring and confidence-margin dashing; no ranked chain-split; orphan suppression &lt;3 m; validated-guide overlay on `validTrajectoryRuns` only (`_drawValidatedGuideTrajectoryOverlay`).
* **Metric correction:** `originalObservationAssignmentPct`, `dedupVoteAssignmentPct`, `slotBinFillPct`; `deprecatedAssignmentMetric` records retired mixed-unit percentage.
* **Evidence:** `reports/connected_accumulated/runtime/road_guided_sequence_validation.json`; `tests/connected_accumulated_display.test.js` (tests 96–101); runtime **43.6 s** on segments 13/14/95/99.
* **Before/after rendered parts (ranked → sequence):** Seg13 186→170; Seg14 234→221; Seg95 23→28; Seg99 3→8.
* **Guide coverage (sequence):** Seg13 89.3%; Seg14 94.4%; Seg95 83.3%; Seg99 66.2%.
* **Prefix/suffix gaps (sequence):** Seg13 0/0 m; Seg14 0/0 m; Seg95 0/0 m; Seg99 0/2 m.
* **Automated result:** Acceptance **FAIL** — part-count gates only (`seg13_parts_30`, `seg14_parts_30`, `seg95_parts_15`, `seg99_parts_6`). Coverage, heading, checksum, slot-count, and cross-lane gates pass.
* **Manual-review status:** **PENDING MANUAL REVIEW** — enable *Connected accumulated lane observations* → *Road-guided continuous connection* on `http://localhost:3847/`.
* **User manual viewer review, 2026-08-26.** User manual viewer review; screenshots supplied in chat but not indexed in repository. Seg13/14 lane strokes largely continuous but do not align accurately enough with accumulated dots. Seg99 lost almost entire grey road backdrop in initial M-051 integration (road layer improperly replaced). M-051 remains **PARTIAL**; not approved for checkpoint.
* **Status:** **PARTIAL**
* **Limitation:** Viewer-only; uncommitted; `Current frame` default; stroke-style splits still produce many parts; Segment 99 validated guide hides loop in experimental mode only.
* **Project implication:** Sequence assignment fixes coverage and suffix gaps vs M-050; further part-merging needed before ACCEPTED EXPERIMENTAL.

| Metric | Seg13 | Seg14 | Seg95 | Seg99 |
| ------ | ----- | ----- | ----- | ----- |
| renderedPartCount | 170 | 221 | 28 | 8 |
| guideCoveragePct | 89.3% | 94.4% | 83.3% | 66.2% |
| dedupVoteAssignmentPct | 46.0% | 57.2% | 30.3% | 28.1% |
| prefixGapM / suffixGapM | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 2 |
| slotCountMatch | true | true | true | true (2 slots) |

---

### M-052 — Experimental lane-layer road-render isolation

* **Goal:** Connected-accumulated lane modes add strokes only; normal road polygons, ribbon, dashed trajectory, and blue arrow remain identical across modes.
* **Road disappearance cause:** M-051 integration hid `LocalRoadSurfaceRibbon` when `roadGuidedSequenceConnection` was active and replaced `_drawLocalVehiclePathOverlay` with `_drawValidatedGuideTrajectoryOverlay` drawing only `validTrajectoryRuns`.
* **Surgical renderer correction:** Removed `hideRibbonForSequence`, restored full trajectory overlay path, removed validated-guide road replacement; lane invalid-interval message moved to connected-lane layer only.
* **Canvas state isolation:** `_drawConnectedAccumulatedPolylines` wrapped in `ctx.save()` / `try` / `finally` with explicit `setLineDash([])` reset.
* **Road-checksum parity:** `computeRoadDisplayInputChecksum` — trajectory, ribbon input, and polygon checksums identical across Current frame, sequence, all per-frame, and layer-off states (map inputs unchanged).
* **Segment 99 result:** Normal malformed grey road restored; static lane lines remain absent over rejected guide intervals; lane warning text only.
* **Test result:** `tests/connected_accumulated_display.test.js` tests 101–106; `road_layer_isolation_validation.json` automated parity **PASS**.
* **Manual review (2026-08-26):** User confirmed Segment 99 grey road looks correct after M-053; road unchanged when switching Current frame ↔ Road-guided continuous connection (in uncommitted M-051 viewer). M-052 input-checksum gate alone was insufficient; M-053 checkpoint canvas comparison **0 / 706560** differing road pixels.
* **Status:** **ACCEPTED EXPERIMENTAL** — mode isolation proven; checkpoint baseline road-pixel gate pass via **M-053**.

---

### M-053 — Checkpoint road-pixel regression (Segment 99)

* **Goal:** Compare Segment 99 final road-only canvas pixels against checkpoint `1b3b1c82b818daa6a12bad409a0671fa30eaafe2`; restore earlier road appearance with smallest safe change; keep experimental lane layer additive.
* **Baseline harness:** Detached worktree at `%TEMP%\Kommu-road-baseline-1b3b1c8`; task-owned ROOT server with baseline `public/` asset interception (port 3847 untouched).
* **Viewer configuration:** `qlog_f449c_99.bz2`, local playback, point-accumulated geometry, mirror on (`mirrorRoadLateral=1`), connected layer off, timeline index 0, fit-to-view once, canvas 960×736 @ DPR 1.
* **First proven divergence:** `resolveRoadDisplayCoords` in `lib/viewer_mirror_coords.js` / `public/viewer_mirror_coords.js` applied trajectory reflection to ribbon vertices without precomputed mirror coords (uncommitted integration). Checkpoint `roadGeometryToScreen` leaves canonical `(east,north)` when precomputed mirror absent.
* **Root cause class:** **mirror-coordinate selection** — opt-in trajectory fallback distorted ribbon on Segment 99’s malformed trajectory loop; input checksums unchanged.
* **Surgical correction:** `useTrajectoryFallback: false` in `roadGeometryToScreen` / `_mirrorRoadPoint`; trajectory fallback requires explicit `useTrajectoryFallback: true`; reference-pose fallback opt-in for near-field points.
* **Input checksum comparison (baseline = current):** `mapChecksum` `2bd1a4a8`, `trajectoryChecksum` `4649e2e3`, `ribbonInputChecksum` `1351af67`, `roadPolygonChecksum` `779e3d5a` — identical across baseline, before, and after captures.
* **Road-only pixel comparison:**

| Comparison | Differing pixels | % | Road checksum |
|------------|------------------|---|---------------|
| baseline vs current_before (broken mirror) | 7668 / 706560 | 1.085% | `145138bf` vs `3a00088f` |
| baseline vs current_after (repair) | 0 / 706560 | 0.000% | `145138bf` vs `145138bf` |
| current_before vs current_after | 7668 / 706560 | 1.085% | — |

* **Control segments (ribbon canonical vs trajectory delta, mirror on):** Seg0/13/14/95/99 all show up to 15.00 m vertex delta when trajectory fallback is enabled — same mirror-selection defect class. After repair, all segments align with checkpoint canonical ribbon contract; pixel capture run on Seg99 only (bounded runtime).
* **M-051 lane isolation:** Sequence lane checksum stable across mode toggles (test 108); `verify_connected_accumulated_runtime.js` road isolation **PASS**; lane part-count gates unchanged **FAIL** (pre-existing).
* **Focused tests:** 127 pass (`connected_accumulated_display` 114 + `segment_mirror_display` 13); new tests 107–109 and mirror ribbon parity cases.
* **Remaining limitation:** Segment 99 experimental static lane may remain sparse over rejected guide intervals (M-051 limitation, separate from road repair).
* **Manual review (2026-08-26):** User confirmed Segment 99 road correct; mode-switch road parity pass; checkpoint canvas **0 / 706560** pixel diff vs `1b3b1c8`.
* **Status:** **ACCEPTED EXPERIMENTAL** (checkpointed in commit `restore canonical mirrored road rendering`)

---

*For methods marked **—** in the summary commit column, evidence exists in uncommitted working tree or reports only. Viewer diagnostic layers are not confirmed mapping. For Stage 19 / Stage 20 history see `docs/DEVELOPMENT_LOG.md` and `docs/DECISIONS.md`.*
