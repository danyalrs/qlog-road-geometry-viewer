# Purity candidate — bounded implementation report (Seg0/1/2/99 only, no dataset scan)

## 1. Repository state before / after
- Before: branch `experiment/candidate-layer-display`, HEAD `488c61b`, user dirty tree preserved, staged 0.
- After: same branch/HEAD, staged 0, no commit/push/reset/stash. Only intended files touched
  (see §13); pre-existing dirty tree otherwise intact (240 changed/untracked entries, all pre-existing
  except the files in §13).

## 2. Algorithm implemented (`representativeMethod=purity`, opt-in; default untouched)
Seed `chunk:pass:groupTrackId` → strand formation IDENTICAL to the corrected method
(along-track gap ≤ `maxSupportedGapM` + whole-curve heading tol 70°) → per-strand
persistent-bimodality split → shared-station median with bimodal-station guard →
cumulative output gates → same-identity overlap sweep.
- Mode split: 2 m station sampling of trusted (`modelX ≤ 80`) samples; station is a candidate if
  lateral range > 8 m AND max internal gap > 3 m; a run splits the strand only if it persists ≥ 30 m
  AND both modes are internally tight (pooled MAD ≤ 2.5) with ≥ 1 curve each. Curves vote by run-mean.
- Station guard: same range/gap rule → station left unverified (gap), never averaged across modes.
- Gates per output line: fold apexes (turn > 150°, arms ≥ 2 m) must be 0; corridor (max distance to
  trusted samples of ALL accepted curves) ≤ 3.0 m; sweep rejects the strictly weaker of two same-identity
  overlapping outputs with median-d differing > 3 m (full ties kept).
- Provenance (additive, all methods): `binMeta.sourceCurveIds/sourceFrameIds` retained per station;
  polyline gains `distinctCurveIds/supportCurveCount/supportFrameCount/minSupport/verificationState`.
- Colour stays display-only in the renderer (groupTrackId → `_pointTrackColorCache`); no colour clustering.

## 3. Threshold evidence (measured, read-only, before choosing)
- Base-method station MAD: Seg0 sup2 max 3.07 (range ≈ 6.1); Seg1 sup2 p90 3.38 / max 8.93;
  Seg2 sup2 p90 6.37 / max 21.9, sup4+ p50 3.65 (sup4+ stations ABSENT in Seg0/Seg1 entirely);
  Seg99 sup2 p50 2.15 / max 17.5.
- Pairwise same-seed consecutive-curve trusted medians on accepted Seg1: 2.5–10 m → pairwise
  lateral complete-link merging is INDEFENSIBLE on this data (abandoned; chaining kept identical).
  Lane-scale (≈3.5 m) relabelling inside one seed is therefore a reported limitation (§12).
- Chosen bar is corridor-scale: spread 8.0 (> Seg0 max 6.1), gap 3.0, persist 30 m, mode MAD 2.5,
  corridor 3.0 (Seg1 survivors ≤ 2.9 vs rejected 3.25–3.68 — thin, flagged for review), overlap d 3.0.

## 4. Seg0/1/2/99 before → after (base → purity)
| seg | lines | lanes | shared-overlap | notes |
|---|---|---|---|---|
| 0 | 16 → 15 | 4 → 4 | 0 → 0 | no splits (subs=seeds=4); 1 corridor rejection |
| 1 | 11 → 17 | 4 → 4 | 0 → 0 | bimodal guard fragments the lane-change transition (240 skips); all pieces verified, narrow-d, corridor ≤ 2.9; reduction 91→17 (5.4×) |
| 2 | 19 → 3 | 6 → 4* | 13 → 0 | the two long road-hugging tracks survive intact (672/667 pts, sup 4/5); V + detached blue/red rejected (corridor 9–16, 1 overlap) |
| 99 | 15 → 14 | 5 → 5 | 3 → 0 | revisit corridors kept separate; 3 corridor rejections |
\* Seg2 purity `logicalLaneCount` reads 4 with 3 surviving lines: one stale lane entry from a
sweep-rejected line (bookkeeping issue, §12). Effective clean lanes: 3.

## 5. Seg2 shared-overlap: 13 → 0. ## 6. Seg99 shared-overlap: 3 → 0.
## 7. Seg1 lanes 4 → 4; pieces 11 → 17 (see §4).
## 8. Provenance verified by fixture purity-8 (station ids non-empty, 4c/4f, verified) and real-data
`supportCurveCount/supportFrameCount` (e.g. Seg2 survivors 13c/13f, 14c/14f).

## 9. Focused tests: `node --test tests/representative_lane_lines_purity.test.js` → 11/11 pass
(fixtures 1–9 + Seg1/Seg2 gates). Regression: `node --test
tests/representative_lane_lines.test.js tests/connected_accumulated_display.test.js` → 122 pass, 0 fail.

## 10. Browser evidence paths
No new screenshots this turn (action budget + 10-minute command rule): base-method Seg2 ablation set
reused from `reports/display_orientation/representative_lane_lines/seg2_diagnosis/`
(`seg2_12s_source_only|reps_only|both.png`). Purity A/B screenshots deferred to user visual review.

## 11. Candidate URL
`http://localhost:3847/?local=1&fit=1&mirror=1&representativeLaneLinesCandidate=1&representativeMethod=purity&connected=1&connectedMode=perFrame`

## 12. Remaining limitations
1. Lane-scale (∼3.5 m) relabelling inside one seed is not separated (data supports corridor-scale only).
2. Corridor gate is point-to-sample (conservative on loops; same-station-interpolated variant rejects
   supported loop-following tracks — needs loop-aware design, not shipped).
3. Corridor threshold 3.0 is thin (Seg1 rejected 3.25–3.68) and Seg1 gains pieces (11→17).
4. Stale lane entry after sweep rejection (§4 footnote); dead pairwise helpers
   (`purityPairwiseEvidence/purityCurvesCompatible`) retained unused — cleanup deferred.
5. No full-dataset validation; candidate NOT accepted — stopping for user visual review.

## 13. Exact files changed / created
- Modified: `public/connected_accumulated_display.js` (purity block + provenance + export),
  `public/render.js` (purity branch, default path untouched).
- Created: `tests/representative_lane_lines_purity.test.js`,
  `.checkpoint_test_backup/pre_representative_purity_candidate/` (3 pre-edit backups),
  this report (`reports/display_orientation/representative_lane_lines/purity_candidate/REPORT.md`).

## 14. HEAD remains `488c61b`. ## 15. Nothing staged, committed or pushed (staged-file count 0).
