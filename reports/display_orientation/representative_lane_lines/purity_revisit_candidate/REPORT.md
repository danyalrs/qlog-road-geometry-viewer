# purityRevisit candidate — implementation report

## 1. Root cause addressed
Seg99 purity representative line #7 (`0:0:1:1:right:u0`, gt1 red, 21 pts, s272-292) was one line
incorrectly joining two temporally separated revisit branches (frames ~119123/119163 and
~119643/119723). The shared-station median wound ~388° inside a 12×4 m area (chord/path 0.353) while
every existing gate passed. The correction adds a combined self-fold/revisit detection on the fitted
output and a visit-boundary split/reject response.

## 2. Exact algorithm added
`buildRepresentativeLaneLinesPurityRevisitFromPerFrame` = `purity` pipeline + a post-fit combined
self-fold gate and a visit-boundary splitter. Full rule description:
`purity_revisit_candidate/fitting_splitting_rules.md`. New helpers: `puritySelfFoldMetrics`,
`purityFoldTrigger`, `purityHasTemporalRevisit`, `purityVisitGapThreshold`, `purityVisitOrder`,
`purityLineFrameOrder`, `puritySplitLineAtVisitBoundary`, `puritySplitStrandByVisitGroups` (opt-in).
Testable API additions: `analyzeRepresentativeSelfFold`, `splitRepresentativeAtVisitBoundary`.
Opt-in via `representativeMethod=purityRevisit`; default `curveAssociation`, `purity`, and `legacy`
unchanged.

## 3. Exact trigger and thresholds
`maxTurnWindowDeg > 270 AND chordPathRatio < 0.60 AND (nearApproach > 0 OR temporalRevisit)`.
Window 25 m; near-approach < 3.0 m with s-separation > 5.0 m; temporal revisit = frame-id gap
> max(20, 5×typicalSpacing). Candidate values (not final dataset truth); reasoning and
non-discriminating raw-union evidence in `fitting_splitting_rules.md`.

## 4. How red line #7 was handled
Detected by the combined gate (fitted turn 387.7°, ratio 0.353, nearApproach 24, temporalRevisit
true). No safe visit-boundary split existed (per-point frame order did not cross a boundary), and
coverage 20 m < 50 m, so the short invalid piece was **rejected** with
`purityRejected='selfFold'` (`purityRejectedSelfFold=1`). Seg99 status: former red fold
`present=false`. Traceable rejection, not silent.

## 5. Why blue line #3 was retained
Survivor `0:0:0:2:left:u2`: 268 pts, s99-366, dRange 0.2, maxTurnWindow 196°, chord/path 0.381,
temporalRevisit true. It is smooth (0.7°/pt) with contiguous provenance and its turn (196°) is far
below the 270° trigger, so the combined gate does not fire. Per instruction it is preserved unless
independently proven invalid; no strong combined evidence exists.

## 6. Focused tests and results
`node --test tests/representative_lane_lines_purity_revisit.test.js` → **12 pass / 0 fail**
(fixtures 1-6 + Seg0/1/2/99 gates + wiring). Regression:
`node --test tests/representative_lane_lines.test.js tests/representative_lane_lines_purity.test.js`
→ **19 pass / 0 fail**. Raw output: `purity_revisit_candidate/test_results.txt`.

## 7. Seg0/1/2/99 metrics (purityRevisit)
| seg | lines (purity→revisit) | lanes | maxTurn25m | minChordRatio | nearApproach | visitMerges | sharedOverlap | deterministic |
|---|---|---|---|---|---|---|---|---|
| 0 | 15 → 15 | 4 | 147.8 | 0.973 | 0 | 0 | 0 | yes |
| 1 | 17 → 17 | 4 | 183.3 | 0.961 | 0 | 0 | 0 | yes |
| 2 | 3 → 3 | 4 | 190.6 | 0.861 | 52386* | 0 | 0 | yes |
| 99 | 14 → **13** | 5 | 198.2 | 0.381 | 23086* | **1** | 0 | yes |

Full JSON (per-line, checksums): `purity_revisit_candidate/metrics.json`. `*` near-approach counts
are dominated by legitimate smooth-curve proximity and are non-discriminating; the discriminating
signal is the combined trigger (Seg99 false fold 388/0.353 vs accepted ≤191/≥0.861). Only Seg99
changed (red fold removed); Seg0/1/2 identical to `purity`. No non-finite, cross-pass, or cross-chunk
output (fixtures 5, 11, 12; determinism checksums match on two rebuilds per segment).

## 8. Files changed
- `public/connected_accumulated_display.js` (purityRevisit builder + helpers + exports)
- `public/render.js` (`representativeMethod=purityRevisit` selection)
- `tests/representative_lane_lines_purity_revisit.test.js` (new)
- `reports/display_orientation/representative_lane_lines/purity_revisit_candidate/` (new: this
  report, `metrics.json`, `fitting_splitting_rules.md`, `test_results.txt`)
- `.checkpoint_test_backup/pre_purity_revisit_candidate/` (backups)
No existing tests, reports, or docs were modified; the pre-existing dirty tree is untouched.

## 9. Backup location
`.checkpoint_test_backup/pre_purity_revisit_candidate/connected_accumulated_display.js` and
`.../render.js` (exact files edited, copied before editing).

## 10. Candidate URL
`http://localhost:3847/?local=1&fit=1&mirror=1&representativeLaneLinesCandidate=1&representativeMethod=purityRevisit&connected=1&connectedMode=perFrame`

## 11. Remaining limitations / risks
- Server on port 3847 stopped during this session (port not listening; PID 2524 reused by svchost).
  Per stop conditions it was **not** restarted, so the live browser screenshot/verification for
  Stage 4 was not produced. Static wiring is unit-verified (render regex + API export).
- Thresholds are candidate values validated on 4 segments only; no wider dataset scan.
- The pre-fit visit separation is implemented but OFF by default (raw-union folding false-positives
  on Seg2's genuine loop). Documented in `fitting_splitting_rules.md`.
- `nearApproach` is non-discriminating on its own; it only corroborates the combined trigger.
- Blue Seg99 loop remains "suspicious but unproven"; visual review still required.

## 12. Branch and HEAD
Branch `experiment/candidate-layer-display`; HEAD `488c61b` (unchanged).

## 13. Staged-file count
0 (empty staged area; nothing staged, committed, or pushed).

## 14. No commit or push
No commit or push occurred. Candidate is display-only, opt-in, and **not accepted**.

---

CANDIDATE IMPLEMENTED — USER VISUAL REVIEW REQUIRED

Wider dataset validation has NOT run. The candidate remains unaccepted. Stop for user visual review.
