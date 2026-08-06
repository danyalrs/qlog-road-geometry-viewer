# Stage 17 — Temporal Divider Association & Supported-Run Fusion

**Date:** 2026-07-23
**Status:** approved
**Tracking schema:** `2026-07-24-lane-divider-tracking-v0`
**Stage 16 input:** `2026-07-24-lane-projection-v0` (checksum `c2bbfe2354f632bc…`)
**Frozen v11 baseline:** `2026-07-24-fusion-v11`

## Scope

Stage 17 associates Stage 16 projected observations into divider tracks and fuses supported runs with explicit gaps.
It does **not** construct lane intervals or estimate lane count.

## Track membership reconciliation

| Metric | Value |
|--------|-------|
| Total Stage 17 input observations | 5809 |
| Observations assigned to tracks | 5752 |
| Observations excluded from tracks | 57 |
| Associated | 5010 |
| Track-birth (new_track) | 742 |
| Rejected ambiguous | 57 |
| Sum observationCount across tracks | 5752 |
| Unique obs in supported runs | 5752 |
| Obs contributing to multiple runs | 0 |

## Outcome semantics

Only three primary outcomes appear in the current dataset: `associated`, `new_track`, `rejected_ambiguous`.
Other schema outcomes are reserved for explicit gate failures when all candidates fail the same gate family.
New-track vs rejection: Unmatched after Hungarian: if every candidate fails the same gate family → rejection; if mixed or competition → new_track with birthReason

### Birth reason counts

- `first_observation_in_group`: 16
- `lateral_gate_failed`: 366
- `temporal_gate_failed`: 309
- `insufficient_route_s_overlap`: 46
- `hungarian_unmatched_competition`: 2
- `heading_gate_failed`: 3

## Lateral-order audit

The audit found 1,230 legacy index-position mismatches caused by support changes. It found zero pairwise lateral-order inversions among persisting tracks. These mismatches are not evidence of physical divider crossings.

- Legacy index-position mismatches: 1230
- Pairwise lateral-order inversions (persisting tracks): 0
- Support-change-only transitions: 609
- Deduplicated order-change episodes: 609
- Comparable track pairs: 4529
- Comparable frame transitions: 2035
- Automatic physical crossing classification: disabled
- rejected_crossing outcomes: 0

## Chunk boundary behaviour

- Observations grouped by (chunkId, temporalPassId, poseSectionId); chunkId is part of the grouping key
- Cross-chunk continuation is impossible with current grouping. Any prior chunk_boundary_continuation BEV category is relabeled boundary_separation. Rejected continuations in audit reflect gate checks if grouping policy changes.
- Tracks within one chunk: 742
- Tracks spanning multiple chunks: 0
- Accepted continuations: 0
- Rejected continuations: 0

## Dataset totals

| Metric | Value |
|--------|-------|
| Stage 16 projected input | 5809 |
| Tracks created | 742 |
| Supported runs | 878 |
| Explicit gaps | 136 |
| Runs − tracks = gaps | 136 = 136 |

## Threshold sensitivity (prototype assessment)

| Parameter | Value | Associated | New track | Ambiguous | Tracks | Episodes |
|-----------|-------|------------|-----------|-----------|--------|----------|
| maxAssociationCost | 8 | 5009 | 743 | 57 | 743 | 610 |
| maxAssociationCost | 12 | 5010 | 742 | 57 | 742 | 609 |
| maxAssociationCost | 18 | 5010 | 742 | 57 | 742 | 609 |
| maxTimeGapSec | 2.5 | 4897 | 864 | 48 | 864 | 600 |
| maxTimeGapSec | 4 | 5010 | 742 | 57 | 742 | 609 |
| maxTimeGapSec | 6 | 5110 | 606 | 93 | 606 | 646 |
| maxLateralJumpM | 1.2 | 4603 | 1178 | 28 | 1178 | 822 |
| maxLateralJumpM | 1.8 | 5010 | 742 | 57 | 742 | 609 |
| maxLateralJumpM | 2.5 | 5146 | 618 | 45 | 618 | 508 |
| minRouteSOverlapM | 1 | 5010 | 742 | 57 | 742 | 609 |
| minRouteSOverlapM | 2 | 5010 | 742 | 57 | 742 | 609 |
| minRouteSOverlapM | 5 | 5010 | 742 | 57 | 742 | 609 |
| maxHeadingDiffDeg | 15 | 4973 | 782 | 54 | 782 | 626 |
| maxHeadingDiffDeg | 25 | 5010 | 742 | 57 | 742 | 609 |
| maxHeadingDiffDeg | 35 | 5017 | 735 | 57 | 735 | 604 |
| ambiguousCostRatio | 1.05 | 5050 | 730 | 29 | 730 | 616 |
| ambiguousCostRatio | 1.15 | 5010 | 742 | 57 | 742 | 609 |
| ambiguousCostRatio | 1.3 | 4935 | 764 | 110 | 764 | 617 |
| runSplitTimeGapSec | 2.5 | 5010 | 742 | 57 | 742 | 609 |
| runSplitTimeGapSec | 3.5 | 5010 | 742 | 57 | 742 | 609 |
| runSplitTimeGapSec | 5 | 5010 | 742 | 57 | 742 | 609 |
| maxSupportedGapM | 10 | 5010 | 742 | 57 | 742 | 609 |
| maxSupportedGapM | 15 | 5010 | 742 | 57 | 742 | 609 |
| maxSupportedGapM | 25 | 5010 | 742 | 57 | 742 | 609 |
| maxShapeRmseM | 1.5 | 5010 | 742 | 57 | 742 | 609 |
| maxShapeRmseM | 2.5 | 5010 | 742 | 57 | 742 | 609 |
| maxShapeRmseM | 4 | 5010 | 742 | 57 | 742 | 609 |
| maxUncertaintyM | 1 | 4992 | 761 | 56 | 761 | 627 |
| maxUncertaintyM | 1.5 | 5010 | 742 | 57 | 742 | 609 |
| maxUncertaintyM | 2 | 5010 | 742 | 57 | 742 | 609 |

## Consistency checks

- Tracking consistency: **passed**
- Run/gap invariants: **passed**

## Limitations

- All assessment thresholds are prototype values (not production)
- Ambiguity uses local second-best cost ratio, not global Hungarian alternative
- Lane counting **not implemented**
- Stage 18 **pending authorization** — not started