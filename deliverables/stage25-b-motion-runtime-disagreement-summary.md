# Stage 25 B-MOTION Runtime Disagreement Audit Summary

Generated: 2026-07-30T08:33:44.430Z

## Same-negative median clarification
- Reported Stage 24 median: 0.4293 m
- Recalculated median (vectorResidualM): 0.4293 m
- Cause: same_negative includes records where vector rejects due to boundary/geometry gates or legacy fallback, not only threshold_reject (residual > 12 m)
- Reporting fix required: **false**

## Changed-decision integrity
- Total changed: 267 (expected 267)
- Legacy+/vector−: 82 (expected 82)
- Legacy−/vector+: 185 (expected 185)
- Counts match: **true**

## Development vs runtime-only
- Changed in 175 development set: 25
- Changed runtime-only: 242

## Manual review manifest
- Selected cases: 134
- Priority 1 (legacy+/vector−): 82
- Priority 2 (fallback): 12
- Runtime-only in manifest: 123

## Recommendation
- **continue_shadow_collection**

*Targeted diagnostic verification — not final performance*
