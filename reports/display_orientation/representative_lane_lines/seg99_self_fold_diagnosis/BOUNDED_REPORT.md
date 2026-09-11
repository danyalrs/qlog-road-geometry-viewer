# Seg99 self-fold diagnosis (bounded, diagnosis-only — no fix implemented)

## 1. Repository state
- Root `C:\Kommu AI Project`, branch `experiment/candidate-layer-display`, HEAD `488c61b` — as expected.
- Staged-file count 0; no staging/commit/push/revert performed; pre-existing dirty tree untouched.
- Port 3847 listening (PID 2524); server not restarted.

## 2. Exact reproduction
`http://localhost:3847/?segments=99&local=1&fit=1&mirror=1&representativeLaneLinesCandidate=1&representativeMethod=purity&connected=1&connectedMode=perFrame`
select `qlog_f449c_99.bz2`, process, fit-to-view (whole segment; no timeline seek needed).
Purity diagnostics: method `purity`, 13 frames, 29 source curves, 14 representative lines.

## 3. Pixel owners (layer ablation: source-only / reps-only / both, other lane layers off)
- **Thick red fold** (right side of viewport): representative layer. Survives reps-only, vanishes
  source-only. Owner: `render.js:_drawRepresentativeLaneLines` ←
  `buildRepresentativeLaneLinesPurityFromPerFrame` output **index #7**, colour `#dc2626`
  (TRACK_COLORS[1], `groupTrackId` 1). Screen bbox x[723,746] y[413,420].
- **Suspicious thick blue bend** (inward, left of the red fold): representative layer, same pass.
  Primary suspect **index #3**, colour `#2563eb` (`groupTrackId` 0), screen bbox x[561,608] y[387,398].
  Secondary blue fragments #0/#1 (`0:0:0:2:left:u0`) not excluded. Ownership is layer-proven;
  which blue fragment the screenshot shows is bbox-matched, not colour-inferred.
- Thin noisy curves: `connectedAccumulated` per-frame pass (out of scope for this task).

## 4. Offending representative IDs
| # | logicalLaneId | gt | pts | s | d | sup | maxMAD | curves/frames | verification |
|---|---|---|---|---|---|---|---|---|---|
| 7 (red fold) | `0:0:1:1:right:u0` | 1 | 21 | 272–292 | −0.3–1.7 | 3–4 | 2.58 | 4 / 4 | verified |
| 3 (blue suspect) | `0:0:0:2:left:u2` | 0 | 268 | 99–366 | 0.8–1.0 | 3 | 0.72 | 3 / 3 | verified |

## 5. Coordinate / provenance trace
- #7: EN x[135.1,147.3] y[−41.5,−37.6]; first (142.0,−37.6,s272) → last (135.1,−39.5,s292):
  net ≈ 7 m displacement over 20 m of s while accumulating **388° of turn** — winds inside a 12×4 m box.
  Source curves `0:0:1:1:right:{119123,119163,119643,119723}`, frames {119123,119163,119643,119723}.
- #3: EN x[46.9,72.4] y[−29.2,−23.1]; first (46.9,−23.2,s99) → last (61.1,−26.5,s366).
  Source curves `0:0:0:2:left:{119683,119763,119803}`, frames {119683,119763,119803} (contiguous).
- Full per-point data: `browser_owner_dump.json`, `fold_metrics_4seg.json` (same directory).

## 6. Measured failure type
- **#7 = category 3: one representative line incorrectly joining two revisit branches.**
  Evidence: (a) cumTurn 388° over 21 pts (18.5°/pt); chord/path ratio 0.353; (b) near-self-approaches
  (< 3 m) between vertices 9–15 indices apart at **s differing 9–15 m** (same EN revisited at
  different s); (c) support frames form **two time groups ~480–560 frames apart**
  (119123/119163 vs 119643/119723) — two separate visits through s∈[272,292] fused into one
  cluster/strand/output; (d) s strictly monotonic (0 backward steps) — a **longitudinal
  out-and-back fold**, not an s-reversal; (e) neighbours #6 (s≤173) and #8 (s≥293) leave #7 an
  isolated fragment across a ~99 m support gap.
- **#3 = ambiguous between (1) true road loop and (3).** It winds smoothly (197° over 268 pts =
  0.7°/pt, ratio 0.381) with contiguous support frames (single visit) — consistent with a genuine
  loop, but near-approaches with s-separation 9–14 m keep revisit-winding on the table. Needs visual
  verdict; flagged, not convicted.
- Not a rendering-transform problem: map-frame EN already contains the winding; screen bbox matches.

## 7. Why current gates missed it (each gate's scope is too narrow)
- **shared-overlap (= 0):** cross-*line* metric; the fold is *intra*-line. Blind by construction.
- **max step/gap:** all neighbouring steps short (fold built from ~1 m steps). Blind.
- **corridor (2.34 ≤ 3.0):** the wound line stays near its own supporting curves — the support
  itself contains both revisit branches, so "distance to support" is small. Circular by construction.
- **support-count (3–4, verified):** both revisit branches support the stations; count cannot see
  that support comes from two *visits*.
- **MAD/spread (2.58):** moderate — the two branches agree laterally (d-range only 2 m). Lateral-only.
- **fold-apex gate (0):** worst single-vertex turn is **146° < 150°** threshold — a rectangular/U fold
  of sub-threshold corners passes. Cumulative 388° is never budgeted.
- **heading split:** per-step heading changes are individually legal; only their sum is absurd.
- **chunk/pass separation:** both visits share chunk 0 / pass 0 — revisit inside one pass is invisible.

## 8. Seg0/1/2/99 comparison (raw values; purity method)
| seg | worst maxTurn25m (accepted) | min chord/path ratio | #7-equivalent |
|---|---|---|---|
| 0 | 148 (#2) | 0.973 | none: selfX 0 everywhere, ratios ≈ 1 |
| 1 | 183 (#12) | 0.961 | none: selfX 0 everywhere |
| 2 | 186 (#0) | 0.861 (true loop road) | none: selfX ≤ 1 |
| 99 | **388 (#7)** / 179 (#3) | **0.353 (#7)** / 0.381 (#3) | #7 flagged by both; #3 by ratio only |
Near-approach counts do NOT discriminate (Seg2's accepted loop tracks score ~26k — smooth curves
self-approach legitimately); only s-separated approaches + turn concentration do.

## 9. Proposed general metric and tentative gate (untuned — gaps reported, not thresholds claimed)
Per representative line: (a) `maxTurn25m` = max cumulative absolute turn in any 25 m path window;
(b) `chordPathRatio` = chord/path length; (c) `revisitGap` = max temporal gap between support frame
clusters (frameId groups). Tentative flag (requires validation): `(maxTurn25m > 250 AND
chordPathRatio < 0.6) OR revisitGap ≫ strand continuity` — observed gap to accepted geometry:
388 vs 186 (turn), 0.353 vs 0.801 (ratio, excluding ambiguous #3 at 0.381), ~500 vs contiguous frames.

## 10. Recommended correction location (not implemented)
Post-fit split/reject gate on the wound fragment (#7 is already an isolated fragment — reject the
fragment, keep the lane), PLUS strand-association fix: treat a large support-frame temporal gap
inside one strand as a revisit boundary (split strands by visit contiguity, not just s-gap/heading).
Splitting preferred over deleting long lanes. Must preserve chunk/pass separation, stay colour-free,
stay opt-in.

## 11. Remaining uncertainty
- #3 true-loop vs false-wind unresolved (needs visual verdict on `seg99_both.png`).
- Exact visit topology of #7 (opposite-direction traversals vs fork/loop-ramp arm) unresolved.
- No pixel-colour counting performed (ownership is layer-ablation + bbox/colour mapping).
- Proposed gate validated on 4 segments only.

## 12. Exact files created (new directory only; no existing evidence touched)
- `reports/display_orientation/representative_lane_lines/seg99_self_fold_diagnosis/BOUNDED_REPORT.md` (this file)
- same dir: `browser_owner_dump.json`, `fold_metrics_4seg.json`, `seg99_source_only.png`,
  `seg99_reps_only.png`, `seg99_both.png`
- Temp scripts (outside repo): `$env:TEMP\opencode\seg99_owner.js`, `seg99_fold.js`

## 13. No production source files changed (no edits to source, tests, reports, or docs).
## 14. Branch `experiment/candidate-layer-display`, HEAD `488c61b`, staged-file count 0,
no commit, no push.
