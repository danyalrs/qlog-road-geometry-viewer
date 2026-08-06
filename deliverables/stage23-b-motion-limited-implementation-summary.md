# Stage 23 B-MOTION Limited Implementation Summary

Generated: 2026-07-30T08:06:10.329Z

## Feature flag
- Default enabled: **false**
- Default mode: **legacy_scalar**
- Env vars: `B_MOTION_VECTOR_ENABLED`, `B_MOTION_VECTOR_MODE`

## Vector formula
- poseCompensatedTarget = targetAnchorB - targetAnchorA - (poseB - poseA); vectorResidualM = |poseCompensatedTarget|
- Coordinate frame: east/north metres
- Anchor modelX: 15 m
- Threshold: <= 12 m (unchanged)

## Legacy regression (175 resolved)
- TP=142 TN=0 FP=11 FN=22
- Accuracy: 0.8114

## Config B reproduction via vector_limited (175 resolved)
- TP=158 TN=1 FP=10 FN=6
- Accuracy: 0.9086
- Positive F1: 0.9518
- Negative F1: 0.1111
- Macro F1: 0.5315
- Balanced accuracy: 0.5272
- Baseline correct: 142/175
- Config B correct: 159/175
- Corrected: 21
- Damaged: 4
- Net correct improvement: **+17**
- Baseline TPs retained: 138/142
- All manual positives retained: 158/164
- Reproduction passed: **true**
- Fallback count: 0

## Record 207 sensitivity
- Label unchanged
- Metric delta when excluded: {"accuracyDelta":-0.0006,"macroF1Delta":-0.0002,"correctedCountDelta":-1,"damagedCountDelta":0,"netCorrectImprovementDelta":-1}

## Corrected indices
0, 1, 2, 3, 121, 123, 124, 125, 126, 128, 129, 131, 139, 140, 142, 145, 186, 187, 206, 207, 210

## Damaged indices
111, 112, 120, 191

*Development-set limited implementation evaluation — not final model performance*
