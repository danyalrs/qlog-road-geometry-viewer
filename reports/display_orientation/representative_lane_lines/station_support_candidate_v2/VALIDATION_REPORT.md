# Validation Report — Station Support v2

## 1. Files changed / created
Changed: `public/connected_accumulated_display.js` (version → 2, local-band params,
`localBandForStation`, v2 gates in `guardStationExtension`), `public/render.js`
(candidate identity `stationSupport:0|1:v2`), `public/app.js` (diagnostic unchanged).
Created: `tests/representative_station_support.test.js` additions and this evidence dir.

## 2. Focus comparison (OFF → v1 → v2)
| Segment | lines OFF→v1→v2 | alongTrackGap OFF→v1→v2 | lanes OFF→v1→v2 |
|---|---|---|---|
| Seg14 | 82 → 5 → **46** | 79 → 1 → **23** | 3 → 3 → **3** |
| Seg16 | 82 → 7 → **62** | 75 → 0 → **26** | 3 → 3 → **3** |
| Seg18 | 79 → 19 → **73** | 76 → 15 → **39** | 5 → 5 → **5** |
| Seg89 | 77 → 33 → **53** | 62 → 15 → **28** | 3 → 3 → **3** |
| Seg20 | 8 → 7 → 9 | 3 → 2 → 2 | 5 → 5 → 5 |
| Seg19 | 5 → 5 → 5 | 2 → 2 → 2 | 3 → 3 → 3 |
| Seg2 | 3 → 3 → 3 | 2 → 2 → 2 | 3 → 3 → 3 |
| Seg12 | 4 → 4 → 4 | 2 → 2 → 2 | 3 → 3 → 3 |
| Seg99 | 13 → 13 → 13 | 8 → 8 → 8 | 5 → 5 → 5 |

## 3. Alignment envelope (restored point → nearest same-identity dot)
| Segment | baseline median / p90 / max | v2 restored median / p90 / max | v2 >1.5 m |
|---|---|---|---|
| Seg14 | 0.60 / 1.47 / 2.54 | **0.53 / 1.05 / 1.31** | **0 %** |
| Seg16 | 0.59 / 1.49 / 2.44 | 0.52 / 0.90 / 1.35 | 0 % |
| Seg18 | 0.78 / 1.86 / 4.02 | 0.46 / 1.01 / 1.49 | 0 % |
| Seg89 | 0.76 / 1.56 / 2.56 | 0.66 / 1.12 / 1.53 | 1 % |

v2 restored points are within (better than) the baseline envelope everywhere.

## 4. Dataset-wide (92 segments)
- processed 92/92, failed 0, changed 27, unchanged 65.
- representative lines 1492 → 1294; alongTrackGap 1176 → 817; logical lanes 340 → 340
  (**0 changes**).
- v2 accepted restorations 1759 (vs v1 6922).
- local-band rejections: insufficientLocalBandFrames 3311, noLocalBand 1622,
  localBandTooWide 104, extendedOutsideLocalBand 55, anchorOutsideLocalBand 53,
  fittedPointOutsideLocalBand 18.
- 0 input mutation, 0 non-finite, deterministic.
- runtime median 7.9 s, max 82.0 s.

## 5. Hard gates
All pass: Seg14 restored points align to their source-dot bands (better than baseline);
Seg18 cross-lane samples rejected; Seg12 unchanged; Seg2/Seg99 byte-identical with fold
absent; zero physical-band switches; no lateral-order reversal; no increased shared
overlap; no non-finite; candidate OFF identical.

## 6. Remaining risks
- v2 restores far fewer stations than v1 (1759 vs 6922), so gaps reduce less — this is the
  intended "smaller safe improvement".
- The 82 vs 85 Seg14 count discrepancy is a build-context difference; the exact live count
  needs the user's session URL/index.
- Seg20 line count 8 → 9 (a coordinate-level change); lanes/gaps unchanged.
- Not yet visually reviewed; candidate remains default OFF.
