# Review — Representative CVLP Parity Fix

One Seg14 candidate URL (hard-reload once to pick up `?v=20260930c`):

`http://localhost:3847/?local=1&fit=1&mirror=1&connected=1&connectedMode=perFrame&representativeLaneLinesCandidate=1&representativeMethod=purityRevisit&representativeStationSupportCandidate=1&progressiveCombinedPlaybackCandidate=1&progressiveViewportCandidate=1&segments=14`

Expected:
- dots top-to-bottom: **blue, red, green**;
- representative lines top-to-bottom: **blue, red, green**;
- each line on its matching same-colour dot band;
- diagnostic:
  `repPass=representativeLaneLines`
  `cvlpProjected=<total>/<total>`
  `missingSource=0`
  `fallback=0`
  plus the per-group line `gid0 dots=… line=… | gid1 … | gid2 …` with matching signs.

## Verdict
USER VISUAL REVIEW REQUIRED.
