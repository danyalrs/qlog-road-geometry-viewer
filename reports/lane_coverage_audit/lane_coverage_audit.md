# Lane coverage audit — Segments 44 vs 27

Generated: 2026-08-05T14:01:22.842Z
Processing version: 2026-07-24-fusion-v15

## Segment 44 (high_coverage_reference)

- modelV2 frames: 30
- usable lane observations: 89
- obs spacing mean/median: 13.48 / 13.32 m
- fused tracks: 3
- path length: 390.8 m
- raw mapped span sum: 10448 m
- fused length sum: 1077.6 m

### Raw mapped length by lane index
- lane 0: 3403.8 m
- lane 1: 3521.7 m
- lane 2: 3522.5 m

### Fused tracks
- track 0: length 348 m, route coverage 88.1%, largest gap 0 m, lane indices [0]
- track 1: length 378 m, route coverage 95.7%, largest gap 0 m, lane indices [1]
- track 2: length 351 m, route coverage 94.8%, largest gap 13.41 m, lane indices [2]

### Tracker summary
```json
{
  "createdTracks": 3,
  "continuedTracks": 86,
  "terminatedTracks": 0,
  "rejectedMatches": 0,
  "ambiguousMatches": 0,
  "oneFrameTracks": 0,
  "fragmentationRate": 0,
  "observationAssociationPct": 96.62921348314607
}
```

## Segment 27 (low_coverage_case)

- modelV2 frames: 30
- usable lane observations: 47
- obs spacing mean/median: 7.63 / 5.72 m
- fused tracks: 4
- path length: 221.4 m
- raw mapped span sum: 5509.9 m
- fused length sum: 379.3 m

### Raw mapped length by lane index
- lane 0: 1758.2 m
- lane 1: 2931.3 m
- lane 2: 820.4 m

### Fused tracks
- track 0: length 198 m, route coverage 79.7%, largest gap 0 m, lane indices [1]
- track 1: length 159 m, route coverage 75.5%, largest gap 11.37 m, lane indices [0]
- track 2: length 0 m, route coverage 0%, largest gap 0 m, lane indices [2]
- track 3: length 22 m, route coverage 9.8%, largest gap 0 m, lane indices [2]

### Tracker summary
```json
{
  "createdTracks": 1,
  "continuedTracks": 3,
  "terminatedTracks": 0,
  "rejectedMatches": 0,
  "ambiguousMatches": 0,
  "oneFrameTracks": 0,
  "fragmentationRate": 0,
  "observationAssociationPct": 75
}
```

## Comparison answers

1. Fewer raw obs on seg 27: **true**
2. Raw present but removed in fusion: **false**
3. Probable lane identity split: **false**
4. Largest loss stage: **raw_observations**
5. Qlog fix without inventing connections: **true**
6. Move to higher-frame-rate .ts video: **false**
