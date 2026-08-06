# Stage 20 B-MOTION Baseline Comparison Summary

Generated: 2026-07-30T07:37:06.495Z

## Inputs
- Automatic manifest: `deliverables\stage20-b-motion-evidence-review-manifest.json`
- Manual reviews: `deliverables\stage20-b-motion-manual-reviews-qc-v1.json`
- Automatic SHA-256: `4b5adefe8e1ae42ad3caeeb68785203c2568e10bc6478f55fbf722b2429c6131`
- Manual SHA-256: `326e81dd0a22a6c3cb8af681bccffdbddaa7b91d271998b78478981d789d01df`

## Automatic decision fields
- Pair ID: `reviewPairId`
- Rule/reason: `ruleDerivedClassification` with `applicableRejectionConditions`
- Automatic continuation decision: derived positive for `valid_same_track_continuation`, `ambiguous_motion_residual_candidate`
- Confidence score: `residualAfterPoseM` (lower_is_stronger_continuation)
- Threshold: `residualAfterPoseM <= 12` via `maxSpatialJumpM` (candidate RESIDUAL_CAP_M, not approved)

## Join
- Matched resolved manual labels: **175**
- Unresolved manual labels (excluded from metrics): **45**
- Unmatched manual pair IDs: **0**
- Duplicate automatic pair IDs: **0**
- Duplicate manual pair IDs: **0**

## Manual label counts (QC-reviewed reference)
- positive_continuation: 164
- negative_non_continuation: 11
- unresolved: 45

## Confusion matrix (resolved manual labels only)
- True positive: 142
- True negative: 0
- False positive: 11
- False negative: 22

## Metrics (raw counts shown with every rate)
- Accuracy: 0.8114 (142/175)
- Positive precision: 0.9281 (142/153)
- Positive recall: 0.8659 (142/164)
- Positive F1: 0.8959
- Negative precision: 0 (0/22)
- Negative recall: 0 (0/11)
- Negative F1: null
- Balanced accuracy: 0.433
- Macro F1: null
- Class support: manual positive 164, manual negative 11

## Confidence separation (`residualAfterPoseM`, lower = stronger continuation)
- Missing scores: 0
- Non-finite scores: 0
- Manual positive distribution: {"count":164,"min":0,"max":39.961,"mean":5.7078,"median":0.429,"p10":0.0073,"p25":0.0285,"p75":8.2425,"p90":16.1909}
- Manual negative distribution: {"count":11,"min":0.01,"max":11.256,"mean":2.2721,"median":0.648,"p10":0.198,"p25":0.3165,"p75":3.3745,"p90":4.17}

## Disagreement record indices
- False positives: 22, 25, 46, 56, 75, 92, 98, 131, 132, 170, 174
- False negatives: 0, 1, 2, 3, 57, 101, 121, 123, 124, 125, 126, 128, 129, 139, 140, 142, 145, 186, 187, 206, 207, 210

## Unresolved category counts (not automatic errors)
- missing_playback_or_frame_evidence: 0
- cross_session_boundary: 42
- timestamp_unavailable: 1
- lane_target_mapping_failure: 0
- visual_ambiguity_or_overlap: 2
- other: 0

*QC-reviewed manual reference labels are not treated as perfect ground truth*
