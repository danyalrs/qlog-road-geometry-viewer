# Stage 19 Dataset Sensitivity Investigation

**Checkpoint:** `2026-07-27-stage19-v5`  
**Generated:** 2026-07-28T02:20:03.419Z  
**Mode:** Read-only investigation (no production or bundle changes)

## Executive summary

The real dataset produces **5809** observations, all **singleton chains**, **zero** cross-pass candidates, and **P3 0/0/0**. Upstream Stage 17 has **573 multi-observation tracks**, but Stage 19 static edge geometry rejects every within-unit link. Cross-pass is blocked structurally because **supportedRuns lack `temporalPassId`**.

## 1. Singleton formation — first failure reason

| Category | Count | % |
|----------|------:|--:|
| evidence_unit_identity | 226 | 3.89% |
| spatial_distance | 4728 | 81.39% |
| temporal_gap | 164 | 2.82% |
| chunk_boundary | 683 | 11.76% |
| other_eligibility | 8 | 0.14% |

Multi-observation partition units: **573** (all produce zero links).

## 2. Near-miss distributions (consecutive pairs in multi-obs units)

| Metric | n | min | median | p75 | max | Threshold |
|--------|--:|----:|-------:|----:|----:|------------|
| Spatial separation (m) | 5010 | 0.218 | 32.984 | 43.542 | 877.449 | 12 m |
| Route-s gap (m) | 5010 | 0 | 27.234 | 38.195 | 97.588 | 50 m |
| Heading diff (°) | 5010 | 0 | 1.47 | 3.88 | 85.64 | 30° |
| Temporal separation (s) | 5010 | 1.96 | 2.00 | 2.01 | 141.87 | — |

Single-condition failures (would link if only that constraint relaxed):
- spatial_distance: **4084**
- route_s_gap: **4**
- heading_difference: **0**
- lateral_offset_delta: **5**

## 3. Sensitivity

### Approved (Rev 37 baseline recording only)

Revision 37 authorizes baseline recording only; rows do not mutate config

### Experimental overlays (not normative)

| Variation | Singleton | Multi-obs chains | P3 e/x/s | Cross-pass |
|-----------|----------:|-----------------:|----------|----------:|
| baseline_config | 5809 | 0 | 0/0/0 | 0 |
| spatial_jump_25m ⚗️ | 5809 | 0 | 0/0/0 | 0 |
| spatial_jump_50m ⚗️ | 5793 | 7 | 7/7/0 | 0 |
| route_s_gap_100m ⚗️ | 5809 | 0 | 0/0/0 | 0 |
| heading_tol_45deg ⚗️ | 5809 | 0 | 0/0/0 | 0 |
| lateral_tol_5m ⚗️ | 5809 | 0 | 0/0/0 | 0 |
| combined_relaxed_geometry ⚗️ | 5793 | 7 | 7/7/0 | 0 |

## 4. Data alignment

- Stage 16: 11044 total → 5809 projected (5235 rejected)
- Stage 17 tracks: 742 (573 multi-obs, max 87/track)
- Supported runs missing temporalPassId: **878/878**
- Cross-pass blocker: supportedRuns lack temporalPassId/chunkId; parentTrackId embeds pass so no multi-pass groups form

## 5. Representative segment traces

| Segment | Projected | Rejected | Matches | Multi-obs units | Nearest failed link |
|--------:|----------:|---------:|--------:|----------------:|---------------------|
| 0 | 75 | 0 | 75 | 8 | 2.56m (stage17_gap) |
| 2 | 51 | 0 | 51 | 8 | 4.67m (stage17_gap) |
| 6 | 1 | 0 | 1 | 0 | — |
| 10 | 56 | 0 | 56 | 6 | 0.34m (stage17_gap) |
| 20 | 106 | 0 | 106 | 7 | 0.87m (stage17_gap) |
| 30 | 85 | 0 | 85 | 4 | 9.6m (stage17_gap) |
| 40 | 87 | 0 | 87 | 3 | 2.5m (stage17_gap) |
| 54 | 17 | 0 | 17 | 5 | 0.5m (stage17_gap) |
| 58 | 29 | 0 | 29 | 6 | 5.46m (stage17_gap) |
| 99 | 26 | 0 | 26 | 5 | 2.75m (stage17_gap) |

## 6. Audit truthfulness

- defaultConfigSingletonChains5809: **true**
- sensitivityLabeledExperimental: **true**
- fixtureP3NotClaimedAsRealData: **true**
- zeroConflictsNotAgreement: **true**
- productionLaneCountDisabled: **true**
- hdMapSystemIncomplete: **true**
- deploymentAuthorized: **false**

## 7. Recommendations

1. Fix supportedRuns metadata (temporalPassId, chunkId, poseSectionId) for cross-pass eligibility _(risk: medium, value: high)_
2. Reconcile Stage 17 track continuity with Stage 19 static edge geometry (spatial jump dominates) _(risk: high, value: high)_
3. Document modelV2 ~0.5 Hz + vehicle motion as structural limit on consecutive spatial jumps _(risk: low, value: medium)_
4. Evaluate whether route-s gaps reflect chunk/pose boundaries vs true temporal gaps _(risk: medium, value: medium)_
5. Do not relax Rev37 thresholds without specification amendment _(risk: high, value: low)_

## Conclusion

**MATCHING AND FILTERING LOGIC IS THE PRIMARY CAUSE**