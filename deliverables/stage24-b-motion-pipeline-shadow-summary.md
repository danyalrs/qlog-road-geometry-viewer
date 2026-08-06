# Stage 24 B-MOTION Pipeline Shadow Integration Summary

Generated: 2026-07-30T08:25:38.239Z

## Runtime integration
- Entry: `evaluatePairAtPipeline` in `lib/stage24_b_motion_pipeline_shadow.js`
- Authoritative classification: `classifyPair (lib/stage20_b_motion_pair_pipeline.js)`
- Shadow hook: `evaluateBMotionDecision with decisionMode=vector_shadow (lib/stage23_b_motion_vector_residual.js)`

## Feature flag
- Default enabled: **false**
- Default mode: **legacy_scalar**
- Shadow mode used: **vector_shadow**

## Dataset discovery
- Discovered qlog segments: **92** (expected 92)
- Processed successfully: **92**
- Failed/skipped: **0**
- Total B-motion consecutive pairs: **5010**

## Output equivalence (legacy vs shadow)
- Authoritative mismatches: **0**
- Equivalence passed: **true**

## Aggregate shadow statistics
- Total decisions: 5010
- Legacy +/-: 3673/1337
- Vector +/-: 3776/1234
- Changed decisions: 267 (rate 0.0533)
- Geometry available: 4998 (0.9976)
- Fallback count: 12

## Development set revalidation (integrated vector_limited)
- Reproduction passed: **true**
- TP/TN/FP/FN: 158/1/10/6
- Net improvement: +17

## Manual review sample
- Sample size: 178
- Development records in sample: 12
- Runtime-only in sample: 166

*Development-set shadow integration — not final model performance*
