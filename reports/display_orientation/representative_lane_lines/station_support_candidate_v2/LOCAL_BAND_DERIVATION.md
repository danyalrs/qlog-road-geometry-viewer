# Local-Band Parameter Derivation (v2)

Read-only. Source: `local_band_derivation.json`.

## Method
For every v1-restored station, a local band was built from **raw real same-identity
observation dots** (this cluster's own per-frame curve points) within ±R of the station,
for R ∈ {1,2,3,4,5} m. The band's unique-frame support, robust lateral centre, spread and
largest internal gap were measured, and the distance from the restored point to the band
centre and to the nearest same-identity dot was recorded.

## Results by radius
| R | restored with band (≥2 frames) | without band | restored point within 0.5 m of band centre | band spread median | restored nearest-dot median |
|--:|--:|--:|--:|--:|--:|
| 1 | 548 | 3453 | 2061 / 4001 | 0.00 | 0.55 |
| 2 | 1885 | 2116 | 3209 / 4001 | 0.00 | 0.78 |
| 3 | 3338 | 663 | 3688 / 4001 | 0.35 | 0.89 |
| 4 | 3983 | 18 | 3590 / 4001 | 0.48 | 0.89 |
| 5 | 4001 | 0 | 3510 / 4001 | 0.52 | 0.89 |

Key observation: at **R = 1 m** the restored points that are locally confirmed have a
nearest-dot median of **0.55 m** — better than the baseline accepted envelope (median
0.60 m, p90 1.47 m). At R ≥ 2 m the band becomes loose and the median (0.78-0.89 m) is
worse than baseline. So a **tight** band is what makes the restored point safe.

## Chosen v2 parameters
| Parameter | Value | Rationale |
|---|---|---|
| `stationSupportLocalBandRadiusM` | 1.5 | tight enough to reject loose bands (R=2+ degrades), wide enough to find ≥2 frames on the safest restored set |
| `stationSupportLocalBandMinFrames` | 2 | the band must be real multi-frame evidence |
| `stationSupportLocalBandSpreadM` | 1.5 | compact lateral mode (baseline on-band dots have spread ≲1.5) |
| `stationSupportLocalBandModeGapM` | 1.5 | no credible competing mode |
| `stationSupportAnchorBandTolM` | 1.0 | the in-range anchor must agree with the local dot band |
| `stationSupportExtendedBandTolM` | 1.0 | the extended observation must agree with the local dot band |
| `stationSupportFittedBandTolM` | 0.7 | the **final fitted point** must sit tightly on the local dot band |
| (v1 params retained) | maxRange 105, lateralTol 1.2, anchorTol 2.5, contextGap 48, competingGap 1.8, revisitFrameGap 160 | |

## Hard statistical requirement
v2 restored-point distance distribution (Seg14 median 0.53, p90 1.05, max 1.31,
>1.5 m 0%) is **not worse than** baseline (median 0.60, p90 1.47, max 2.54, >1.5 m 9%) —
it is strictly better at every reported percentile. Same holds for Seg16/18/89
(`seg14_alignment_comparison.json`).

## Stop condition
Not triggered: a safe parameter region exists (meaningful gap reduction — Seg14 79→23,
Seg16 75→26, Seg18 76→39, Seg89 62→28 — with restored alignment inside/ below the
baseline envelope).
