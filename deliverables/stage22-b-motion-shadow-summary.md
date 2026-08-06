# Stage 22 B-MOTION Shadow Evaluation Summary

Generated: 2026-07-30T07:56:49.682Z

## Input integrity
- manualReviews: `326e81dd0a22a6c3cb8af681bccffdbddaa7b91d271998b78478981d789d01df`
- automaticManifest: `4b5adefe8e1ae42ad3caeeb68785203c2568e10bc6478f55fbf722b2429c6131`
- baselineComparison: `db2d3f9ae3c8e49aa5d2e6b88fab147e4f3145a71daf68e1202872437b8d7c9d`
- baselineDisagreements: `70f8d4303a75e34a30e7760dd8fdf40d8d5959523a0eb0bd0a5764b42d7d1df1`
- stage21ErrorAnalysis: `c2c5261358e6d469a11a3ffc9373b2acf3a02e2424ccdeffd8b2437f4a8990f3`
- stage21RecheckList: `9c9994197bd9d0323020ce24b40319f3b2331c04cf6bd0a87a6a8473b17b9d76`
- Resolved records: **175**

## Vector compensation
- Formula: poseCompensatedTarget = targetAnchorB - targetAnchorA - (poseB - poseA); euclidean residual = |poseCompensatedTarget|
- Coordinate frame: east/north metres
- Opposite-direction cases (scalar masking): **0**

## Candidate metrics (zero-division=0, primary 175 records)
| Config | Acc | Pos F1 | Neg F1 | Macro F1 | Bal Acc | Corrected | Damaged |
|--------|-----|--------|--------|----------|---------|-----------|---------|
| A | 0.8114 | 0.8959 | 0 | 0.4479 | 0.4329 | 0 | 0 |
| B | 0.9086 | 0.9518 | 0.1111 | 0.5315 | 0.5272 | 21 | 4 |
| C | 0.8114 | 0.8959 | 0 | 0.4479 | 0.4329 | 0 | 0 |
| D | 0.9086 | 0.9518 | 0.1111 | 0.5315 | 0.5272 | 21 | 4 |
| E | 0.9086 | 0.9518 | 0.1111 | 0.5315 | 0.5272 | 21 | 4 |
| F | 0.7829 | 0.8699 | 0.3448 | 0.6073 | 0.8417 | 25 | 30 |
| G | 0.7829 | 0.8699 | 0.3448 | 0.6073 | 0.8417 | 25 | 30 |

## Record 207 sensitivity
- Label unchanged in primary evaluation
- Macro F1 delta when excluded: {"A":{"accuracyDelta":0.0047,"macroF1Delta":0.0015,"correctedCountDelta":0,"damagedCountDelta":0},"B":{"accuracyDelta":-0.0006,"macroF1Delta":-0.0002,"correctedCountDelta":-1,"damagedCountDelta":0},"C":{"accuracyDelta":0.0047,"macroF1Delta":0.0015,"correctedCountDelta":0,"damagedCountDelta":0},"D":{"accuracyDelta":-0.0006,"macroF1Delta":-0.0002,"correctedCountDelta":-1,"damagedCountDelta":0},"E":{"accuracyDelta":-0.0006,"macroF1Delta":-0.0002,"correctedCountDelta":-1,"damagedCountDelta":0},"F":{"accuracyDelta":0.0045,"macroF1Delta":0.0046,"correctedCountDelta":0,"damagedCountDelta":0},"G":{"accuracyDelta":0.0045,"macroF1Delta":0.0046,"correctedCountDelta":0,"damagedCountDelta":0}}

## Rank soft signal (Config F vs baseline)
- Fixes: 0, 1, 2, 3, 22, 25, 56, 75, 92, 98, 121, 123, 124, 125, 126, 128, 129, 131, 132, 142, 145, 170, 174, 206, 210
- Damages: 8, 9, 10, 15, 16, 30, 34, 35, 36, 38, 40, 67, 72, 76, 102, 111, 112, 113, 114, 117, 119, 120, 172, 173, 191, 193, 194, 198, 203, 205

## Correct vs baseline accounting (Config B)
- Baseline correct: **142 / 175**
- Config B correct: **159 / 175**
- Corrected decisions: **21**
- Damaged decisions: **4**
- Net correct improvement: **+17** (21 − 4; not confusion-matrix cell deltas)

## Recommendation
- **proceed_to_limited_implementation**
- Config B shows shadow improvement without catastrophic TP loss
- Best-supported candidate: **B**

## Offline threshold sweep (not approved)
- Tested values (m): 3, 5, 8, 10, 12, 15, 20

*Development-set shadow evaluation — not final model performance*
