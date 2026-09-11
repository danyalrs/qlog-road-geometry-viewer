# purityRevisit — 92-segment dataset validation

## 1. Repository state
- Root `C:\Kommu AI Project`, branch `experiment/candidate-layer-display`, HEAD `488c61b` — as expected.
- Staged-file count 0; no reset/checkout/clean/undo; no staging/commit/push; production source untouched.
- New output only in `reports/display_orientation/representative_lane_lines/purity_revisit_dataset_validation/`.

## 2. Exact qualified dataset inventory
- Enumeration rule (matches the viewer server): root-level files matching `/^qlog_f449c.*\.bz2$/i`, sorted by numeric suffix.
- Expected 92; found 92; processed 92; missing 0; failed 0; skipped 0.
- Indices present: 0-20, 22-37, 39-51, 53-69, 71-75, 81-100 (92 files). No 40-segment substitution.

## 3. Test results (Stage 1)
`node --test tests/representative_lane_lines_purity_revisit.test.js tests/representative_lane_lines.test.js tests/representative_lane_lines_purity.test.js`
→ **31 pass / 0 fail**. No unrelated failures touched.

## 4. Baseline versus candidate method
- Baseline: `buildRepresentativeLaneLinesPurityFromPerFrame` (`representativeMethod=purity`).
- Candidate: `buildRepresentativeLaneLinesPurityRevisitFromPerFrame` (`representativeMethod=purityRevisit`).
- Identical source data (same `pointAccumulated` map + per-frame connected polylines) and identical
  display-independent fitting parameters. Candidate adds only the combined post-fit self-fold/revisit
  gate and visit-boundary splitter. No thresholds changed.

## 5. Aggregate results
- Total qualified processed: **92**.
- Passing all hard integrity gates: **92**. Failed: **0**.
- Changed by purityRevisit: **1** (Seg99).
- Fold triggers: **1**. Safe splits: **0**. Self-fold rejections: **1**. Retained ambiguous triggers: **0**.
- Logical lanes lost or added: **0**.
- Representative lines: 1493 (purity) → **1492** (candidate).
- Aggregate coverage: 122653.0 m → 122633.0 m (**−20.0 m**, the removed Seg99 fold fragment).
- Candidate surviving fold triggers (turn > 270° AND ratio < 0.6): **0** dataset-wide.
- Candidate lines with turn > 270° at any ratio: 22 (all ratio ≥ 0.6; identical to baseline — tight but non-folding).
- Deterministic rebuilds: **92/92**.
- Worst ten by max 25 m cumulative turn (candidate): 68 (358.7), 73 (322.9), 95 (302.9), 81 (289.9),
  10 (282.2), 25 (275.7), 19 (275.4), 71 (272.5), 82 (269.7), 75 (266.2) — all unchanged from baseline.
- Worst ten by min chord/path ratio (candidate): 24 (0.232), 99 (0.381), 51 (0.814), 25 (0.831),
  75 (0.842), 2 (0.861), 74 (0.871), 59 (0.899), 63 (0.919), 92 (0.923).
- Temporal-revisit evidence: **69 segments** (lines with `temporalRevisit=true`); see `dataset_metrics.json`.
- Regression flags: **0**.
- Processing time: total 378300 ms (~6.3 min); median 4250 ms; min 54 ms; max 13459 ms
  (slowest: seg19 13459, seg36 12690, seg87 12262, seg93 12060, seg37 11339).

## 6. Hard-gate results
| Gate | Result |
|---|---|
| processing crash | pass (0) |
| non-finite output | pass (0) |
| cross-pass connection | pass (0) |
| cross-chunk connection | pass (0) |
| non-deterministic output | pass (92/92) |
| increased shared overlap | pass (0) |
| increased confirmed self-fold | pass (0) |
| Seg0/Seg1/Seg2 regression | pass (all unchanged) |
| Seg99 red fold returned | pass (absent) |
**All hard gates pass.**

## 7. Focus Seg0/1/2/99 results
| Segment | Expected | Actual | Match |
|---|---|---|---|
| Seg0 | 15 lines, 4 lanes, unchanged, overlap 0 | 15 / 4 / unchanged / 0 | yes |
| Seg1 | 17 lines, 4 lanes, unchanged, overlap 0 | 17 / 4 / unchanged / 0 | yes |
| Seg2 | 3 lines, 4 lanes, V/detached absent, overlap 0 | 3 / 4 / absent / 0 | yes |
| Seg99 | purity 14 → revisit 13, 5 lanes, red fold absent, blue retained, 1 selfFold, overlap 0 | 14→13 / 5 / absent / retained / 1 / 0 | yes |

## 8. Changed-segment table
| Seg | Purity lines | Revisit lines | Purity lanes | Revisit lanes | Rejection | Coverage Δ |
|---|---|---|---|---|---|---|
| 99 | 14 | 13 | 5 | 5 | 1× selfFold | −20.0 m (−0.02% of segment) |

No other segment changed (checksum-identical geometry to baseline).

## 9. Triggered-line classification
Two triggered records, both Seg99, both class 1 (high-confidence false fold removed):
- `baselineSelfFold`: `0:0:1:1:right:u0`, gt1, chunk 0/pass 0, coverage 20 m, maxTurn 387.7°,
  chord/path 0.353, nearApproach 24, temporalRevisit true, frames [119723,119643,119163,119123],
  curves `0:0:1:1:right:{119123,119163,119643,119723}` → decision **reject**, resulting line IDs none,
  coverage after 0 m.
- `selfFold` (candidate): same identity/evidence → decision **reject** (short 20 m fragment, no safe split).
Classes 2/3/4: none in changed segments. (Corridor/overlap rejections on unchanged segments are shared
with the baseline and are not candidate-triggered.)

## 10. Regression flags
`regression_flags.json` → **flags: []** (0). All 15 triage conditions evaluated; none fired.
Notably no line-count increase > 20%, no long-line (> 50 m) loss, no coverage reduction > 5%,
no new max-turn above baseline, no lower min chord ratio, no empty candidate output.

## 11. Determinism results
Canonical checksum (line ids sorted; rounded EN + s; timestamps/order/diagnostic text excluded) computed
twice per segment: **92/92 identical**. Representative checksums stored in `dataset_metrics.json`.

## 12. Performance summary
purityRevisit adds the O(n²) self-fold metric per line on top of the purity pipeline. Total scan
378.3 s for 92 segments; median 4.25 s/segment; max 13.46 s (seg19). No unusually large per-segment
increase relative to the purity baseline build observed (both built in the same pass).

## 13. Limitations
- The candidate was not tuned; thresholds are the ones under validation.
- Baseline `purity` does not populate `maxTurnWindowDeg`/`chordPathRatio`; for the 91 unchanged
  segments baseline fold metrics were derived from the checksum-identical geometry, and recomputed
  explicitly for the one changed segment (Seg99). Provenance in `changed_segments.json`.
- `nearApproach` counts are large on smooth curves and are non-discriminating alone; only the combined
  trigger uses them.
- 22 candidate lines have turn > 270° but ratio ≥ 0.6 (tight non-folding curves); unchanged from
  baseline, not flagged. They may merit future visual review but are outside this candidate's scope.
- No browser screenshots (not required for this scan).

## 14. Exact files created
`reports/display_orientation/representative_lane_lines/purity_revisit_dataset_validation/`
- `VALIDATION_REPORT.md` (this file)
- `dataset_metrics.json`
- `changed_segments.json`
- `triggered_lines.json`
- `regression_flags.json`

Temp analysis scripts only (outside repo): `$env:TEMP\opencode\revisit_scan.js`,
`revisit_assemble.js`, `revisit_metrics.js` (prior-turn), `revisit_scan_progress.json`.

## 15. Production source unchanged
No production source, tests, existing reports, or docs were modified. Only the new evidence directory
was written.

## 16. Branch / HEAD / staging / commit
Branch `experiment/candidate-layer-display`; HEAD `488c61b`; staged-file count 0; no commit; no push.

## 17. Final verdict
**PASS.** All 92 qualified segments processed with zero hard-gate failures and zero regression flags.
The only change is the intended Seg99 red self-fold removal (1 trigger → 1 self-fold rejection, no safe
split needed). Seg0/Seg1/Seg2 are checksum-identical to the accepted baseline; Seg99 retains the long
blue loop. The wider candidate remains unaccepted pending the user's product decision; no code or
thresholds were changed.
