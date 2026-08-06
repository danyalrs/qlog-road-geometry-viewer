# Stage 18 — Lane-Interval Construction & Prototype Lane-Count Assessment

**Date:** 2026-07-24
**Status:** approved
**Approved:** 2026-07-24
**Schema:** `2026-07-24-lane-interval-assessment-v0`
**Stage 17 input:** 878 supported runs, 136 gaps

## Scope

Stage 18 constructs evidence-supported lane interval candidates from approved Stage 17 supported divider runs
and produces offline prototype **supported same-direction interval counts**.
It does **not** claim production-ready, physical-road-validated, HD-map-grade, or total physical road lane counts.

## Signed-width convention

- leftRouteD - rightRouteD with left assigned as the higher mean-d boundary within the pair
- Comparison tolerance: 0.001 m
- Positive floor tolerance: 1e-9 m

## Supported-run accounting

| Metric | Value |
|--------|-------|
| Stage 17 supported runs (input) | 878 |
| Eligible supported runs | 878 |
| Divider-pair candidates | 834 |
| Accepted pairings | 5 |
| Lane intervals created | 5 |
| Assessed numeric interval counts | 1 |

## Pairing outcomes

- `rejected_non_adjacent`: 329
- `rejected_boundary`: 227
- `rejected_intervening_divider`: 181
- `rejected_crossing`: 79
- `rejected_width_outlier`: 12
- `accepted`: 5
- `rejected_unstable_width`: 1

Pairing outcomes reconcile: **yes** (834 / 834)

## Width/order failure investigation

The pre-review `rejected_non_positive_width` aggregate (704) is **superseded** by local-adjacency and crossing classifications.
Current legacy `rejected_non_positive_width` outcome count: 0.

Width/order failures with per-pair records: 408
- `partial_order_exchange`: 329 (329 / 408)
- `geometric_intersection_candidate`: 79 (79 / 408)

## Count transition labels

- `stable_incomplete_boundary_evidence`: 7
- `stable_numeric_supported_count`: 1

## Gap preservation

- Stage 17 gaps: 136
- Stage 18 referenced: 136
- All preserved: yes

## Consistency

- Stage 18 consistency: **passed**

## Limitations

- Prototype assessment settings only — not Malaysian road-design limits
- Supported same-direction interval counts only; total physical road lanes not inferred
- Production lane counting **not implemented**
- Stage 19 **pending authorization** — not started

## Performance

- cached sorted interpolation geometry
- shared-overlap sampling capped at 250 samples
- lightweight mean-d candidate checks in findRightNeighbor()
- full sampled validation reserved for evaluatePair()
- Optimized full build: ~5 s (tested system)
- Historical pre-fix profiling (~438–473 s, 538 candidates) is superseded by the canonical 834-candidate total