# Algorithm v2 — Local-Band-Confirmed Station Support

Default-off candidate `representativeStationSupportCandidate=1`, version
`stationSupport:1:v2`. Changes only the representative station-fitting path in
`public/connected_accumulated_display.js`. No transform/mirror/colour change; no
interpolation, bridge or fragment joining.

## Three passes (deterministic)

### PASS 1 — exact baseline
Reproduces the accepted station fitting byte-for-byte. Only insufficient-support stations
are collected as eligible; baseline bimodal and other non-support rejections are preserved.
Candidate OFF stops here (byte-identical).

### PASS 2 — context preparation
Builds context from **baseline-accepted stations only** (two-sided, `contextMaxGapM`)
and freezes it before any restoration; restored stations never become context (no cascade).

### PASS 3 — guarded restoration
For each eligible station:
1. in-range anchor required;
2. interior gap only (both-sided context, span > `maxSupportedGapM`);
3. extended observation in (80, 105] m, unique new frame, agreeing with the two-sided
   expected mode (v1 lateral guard) and the anchor;
4. no competing extended mode; no temporal/revisit gap;
5. **v2 local same-identity dot-band confirmation** — a band built from this cluster's own
   raw observation points within ±1.5 m must have ≥2 unique frames, spread ≤1.5 m,
   largest internal gap ≤1.5 m, and the anchor, every extended observation and the
   **final fitted point** must lie within 1.0/1.0/0.7 m of the band centre;
6. fit from retained real observations only, feed into the existing assembler.

New v2 rejection reasons: `noLocalBand`, `insufficientLocalBandFrames`,
`localBandTooWide`, `competingLocalBand`, `anchorOutsideLocalBand`,
`extendedOutsideLocalBand`, `fittedPointOutsideLocalBand`, `localBandTemporalMismatch`;
acceptance reason `localBandConfirmed`. All v1 reasons retained.

## Why v2 fixes the rejected v1
v1 placed a restored station at the median of `{one in-range anchor} + {one extended
observation}`, so the point could sit up to ~0.6 m off the local dot band (measured median
0.79 m, 11 % with no dot within 2 m). v2 additionally requires the point to be **directly
confirmed by nearby real same-identity dots**, so restored points now align to median
0.53 m (p90 1.05 m, max 1.31 m) — inside the baseline envelope.
