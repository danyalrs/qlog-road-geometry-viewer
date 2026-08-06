# Stage 21 B-MOTION Error Analysis Summary

Generated: 2026-07-30T07:47:18.860Z

## Input integrity
- manualReviews: `326e81dd0a22a6c3cb8af681bccffdbddaa7b91d271998b78478981d789d01df`
- automaticManifest: `4b5adefe8e1ae42ad3caeeb68785203c2568e10bc6478f55fbf722b2429c6131`
- baselineComparison: `db2d3f9ae3c8e49aa5d2e6b88fab147e4f3145a71daf68e1202872437b8d7c9d`
- baselineDisagreements: `70f8d4303a75e34a30e7760dd8fdf40d8d5959523a0eb0bd0a5764b42d7d1df1`
- Matched disagreements: **33**
- Join unmatched manual: **0**
- QC manual file preserved: **true**

## False-positive categories
- divider_rank_swap: 8
- divider_side_swap: 1
- divider_crossing: 1
- road_edge_association_change: 1

## False-negative categories
- vehicle_motion_not_compensated: 4
- coordinate_frame_mismatch: 2
- stable_rank_despite_high_residual: 15
- manual_label_suspect: 1

## FN observation-pair clusters
- 73700718671|75701987372|seg0: indices 0, 1, 2, 3
- 1213505750614|1215507244096|seg19: indices 123, 124, 125, 126
- 1753390726877|1755395170363|seg28: indices 139, 140
- 2773068940332|2775071001390|seg45: indices 186, 187

## Rank evidence
- Strong rank evidence: 33/33
- Method: lateral_sort_at_anchor_modelX_15m

## Manual recheck list
- [207] 72:0:4392664981322:1|72:0:4394669147870:0: structured evidence conflicts with reviewer note or label

## Candidate signals (ranked by likely benefit)
- **pose_compensated_anchor_displacement** (benefit score 18): may correct 18, may damage 0
  - Limitation: Pose displacement is pair-level, not divider-anchor-specific
- **motion_normalised_residual** (benefit score 11): may correct 22, may damage 11
  - Limitation: Current 12 m cap accepts all low-residual identity swaps
- **crossing_detection** (benefit score 2): may correct 2, may damage 0
  - Limitation: No crossing detector in current manifest
- **divider_side_stability** (benefit score 1): may correct 1, may damage 0
  - Limitation: Side relation not stored structurally; requires geometry or visual review
- **road_edge_association** (benefit score 0): may correct 3, may damage 3
  - Limitation: Overlap alone does not prove identity switch
- **evidence_availability_gating** (benefit score 0): may correct 0, may damage 0
  - Limitation: Does not resolve disagreements where evidence was available
- **divider_rank_stability** (benefit score -7): may correct 10, may damage 17
  - Limitation: Rank derivation needs visible lane geometry; sourceSlotIndex alone is insufficient

## Metric convention clarification (baseline unchanged)
- Negative F1 null convention: null — TN=0 under current rule; negative precision/recall denominators leave F1 undefined (null)
- Zero-division=0 convention: negative F1 = 0, macro F1 ≈ 0.448
- Reporting clarification only; not an algorithm improvement

*QC-reviewed manual reference labels are not perfect ground truth; findings distinguish direct evidence from inference*
