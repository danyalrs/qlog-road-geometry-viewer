# Experiments and Measurements

**Last updated:** 2026-07-28

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

## Reproduction Notes

1. Experimental overlays in E-008–E-013 were run by the read-only investigation runner; they do **not** modify `lib/stage19_spec/config.js`.
2. Fixture overlays for tests use `lib/stage19_partition_config_overlay.js` — test-only, not production.
3. Full-dataset commands require qlog segment files and upstream JSON artifacts (`projected_lane_observations_v0.json`, Stage 17/18 audits).

See [RUN_GUIDE.md](./RUN_GUIDE.md) for verified commands.
