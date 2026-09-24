# Review — Station Support v2

Candidate **default OFF**. Enable with `representativeStationSupportCandidate=1`.

Base URL (`http://localhost:3847/`):
`?local=1&fit=1&mirror=1&connected=1&connectedMode=perFrame&representativeLaneLinesCandidate=1&representativeMethod=purityRevisit&representativeStationSupportCandidate=1&progressiveCombinedPlaybackCandidate=1&progressiveViewportCandidate=1&segments=<N>`

## ON links (one per segment)
- Seg14: `...&segments=14`
- Seg16: `...&segments=16`
- Seg18: `...&segments=18`
- Seg89: `...&segments=89`
- Seg2:  `...&segments=2`
- Seg99: `...&segments=99`

## Expected
- **Seg14**: lines follow their matching dot bands; no apparent left/right lane reversal;
  no long line floating between bands; fewer gaps only where local real dots confirm
  continuity (gaps 79 → 23, not the rejected v1 79 → 1). A diagnostic line shows
  `Station robust mode: retained X stations · ...`.
- Seg16/18/89: fewer real breaks; lane count unchanged.
- Seg2/Seg12/Seg99: visually unchanged (no restorations).

## Verdict
**USER VISUAL REVIEW REQUIRED.**
