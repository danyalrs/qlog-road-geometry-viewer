# Review — Representative Display Alignment Fix

The correction is **inside the representative build**, which is already candidate-gated
(`representativeLaneLinesCandidate=1`), so **no new flag is required**. Use the existing
Station Support V2 URL (default OFF candidates; the representative layer is opt-in).

## Primary manual-review URL (Seg14)
`http://localhost:3847/?local=1&fit=1&mirror=1&connected=1&connectedMode=perFrame&representativeLaneLinesCandidate=1&representativeMethod=purityRevisit&representativeStationSupportCandidate=1&progressiveCombinedPlaybackCandidate=1&progressiveViewportCandidate=1&segments=14`

(No `representativeDisplayAlignmentCandidate` — no new flag.)

## Check
- dots top-to-bottom and lines top-to-bottom use the **same colour order**;
- the blue line lies on the blue dots;
- the red line lies on the red dots;
- the green line lies on the green dots;
- no outer-lane (blue/green) swap, red stays central;
- append/playback controls still work.

## Verdict
**USER VISUAL REVIEW REQUIRED.**
