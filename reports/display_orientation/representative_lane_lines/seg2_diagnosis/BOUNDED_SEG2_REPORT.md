# Bounded Seg2 diagnosis (this turn, no fix, no production edits)

URL: `http://localhost:3847/?local=1&fit=1&mirror=1&representativeLaneLinesCandidate=1&connected=1&connectedMode=perFrame`,
file `qlog_f449c_2.bz2` @ ~12 s. Read-only reproduction confirms diagnostics:
26 frames, 53 all-per-frame source curves, 19 representative lines, 2 rejected.

## 1. Pixel owners

All three thick objects vanish when `layers.representativeLaneLines=false` and persist with
sources off; all thin shooting curves vanish when `layers.connectedAccumulated=false`.
Ownership below is by ablation, not colour.

| Object | Draw pass | Draw function | Source collection | Polyline / ID | logicalLaneId | Support | Final canvas points | Stroke |
|---|---|---|---|---|---|---|---|---|
| Thick blue V across road interior | `representativeLaneLines` | `render.js:_drawRepresentativeLaneLines` | `ConnectedAccumulatedDisplay.buildRepresentativeLaneLinesFromPerFrame` output (`renderer._representativeLaneLines`) | rep #6, gt0, 125 pts, s232–356, d−7.2…+5.5 | `0:0:0:1:right` | line supportCount 3; apex vertex (121.2,198.5) sup 3, MAD 6.05 | first (121.2,198.6), last (114.6,211.2) | `#2563eb`, width max(4,min(5.5,scale·0.35)), α .95 |
| Detached thick blue inside loop | same rep pass | same | same | rep #9 (23 pts, s262–284, d−26.5…−9.1) + #10 (23 pts, s285–307, d−21.4…−7.6), gt0 | `0:0:0:1:right` | supportCount 2 / 2; vertices sup 2, MAD 16.61 / 10.57 | #9 (143.8,176.1)→(129,180.8); #10 (134.8,178.8)→(123.7,186.4) | `#2563eb`, same width |
| Detached thick red inside loop | same rep pass | same | same | rep #16, gt1, 198 pts, s159–356, d−20.5…+17.0 | `0:0:1:2:left` | supportCount 2; vertex sup 2, MAD 6.32 | first (114.2,205.7), last (112.2,205.2) | `#dc2626`, same width |
| Thin blue/red curves shooting near arrow | `connectedAccumulated` per-frame | `render.js:_drawConnectedAccumulatedPolylines` | `ConnectedAccumulatedDisplay.buildPerFrameConnectedPolylines` (53 polylines, one modelV2 frame each) | per-frame curve polylines (groupTrackId-coloured) | n/a (per-frame) | 1 frame each by construction | along source tails | track-cache colour, width 1.6 (reps on) / 2.25, α .28/.62 |

Colour rule (verified `render.js:17-20,2190-2213,2304-2321`): `TRACK_COLORS=[#2563eb,#dc2626,#16a34a,…]`,
`_pointTrackColorCache: groupTrackId → trackColor()`. Per-point `sourceCurveIds/sourceFrameIds`
are empty on this builder's output points, so attribution is cluster-level (26 frames / 53 curves /
2 rejected; per-line `supportCount` 2–5; per-vertex sup/MAD above). Arrow/trajectory layers were not
isolated this turn; the thin curves are proven non-arrow by persisting with only the source pass on.

## 2. Root cause (general)

Cluster seed `chunk:pass:groupTrackId` is not one physical painted line on Seg2's curve/loop:
one `groupTrackId` cluster contains curves from ≥2 distinct physical lines (lane-index relabelling
around the bend). Shared 1 m-station median then cuts *between* the lines → cumulative fold/V (#6,
#16) and same-identity fragments at disjoint lateral levels over overlapping s (#8 vs #9/#10,
shared-gt overlap 18). Every per-step move is small, so step gates pass.

## 3. Why the 4.05 m gate missed it

Max single EN step over all 19 Seg2 reps is 4.05 m (#0); offenders: #6 2.04, #9 2.51, #10 1.90,
#16 3.53. The defect is cumulative lateral bimodality + cross-fragment overlap, invisible to any
single-step `maxGapM`/`maxStepM`.

## 4. Proposed correction (not implemented)

Inside each `groupTrackId` seed, split sub-clusters by trusted near-field (modelX) corridor purity
before the shared-station median; reject/flag stations whose supporting frames are laterally bimodal
(large MAD at support ≥2). Add a cumulative chord budget, not a single-step limit.

## 5. Metric / gate

Per line: fold-apex count (turn >150° w/ arms ≥2 m), shared-gt overlap count (same gt, overlapping s,
median-d differs >3 m), bimodal-station fraction, line d-range vs s-span. Gate: overlap 0,
bimodal ≈ 0, folds ≤ small bound. Seg2: overlap 18, d-range 37.5 m → flagged. Seg1: overlap 0 →
clean. Seg0: overlap 0 → clean. Seg99: overlap 13 → same-family revisit risk, needs purity fix +
dataset-wide validation before any threshold ships.

## 6. Confirmations

No production source file edited this turn (only this report + prior-turn evidence files + `/tmp`
scripts). Branch `experiment/candidate-layer-display`, HEAD `488c61b`, staged files 0, no
commit/push. Evidence: `reports/display_orientation/representative_lane_lines/seg2_diagnosis/`
(`seg2_12s_source_only|reps_only|both.png`, `owner_dump.json`, `fold_owner.json`,
`corridor_distance.json`, `vertex_fold.json`, `fold_metric_4seg.json`, `DIAGNOSIS.md`).
