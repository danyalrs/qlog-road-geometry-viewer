# Accepted Review — Representative Station Support & Display Alignment

- Review date: 2026-09-30
- Branch: `experiment/lane-map-accuracy`
- Accepted checkpoint (base HEAD before this commit): `0138e50b1a0ddd976cd855c1737fc800d792b748`

## Visual acceptance

### Seg14
- Blue representative lines follow blue dots.
- Red lines follow red dots.
- Green lines follow green dots.
- Blue/green outer-lane reversal removed.
- Lateral order correct.

### Seg18
- Same-colour line/dot alignment correct.
- Order remains correct through the curve.
- No visible 9.3 m cross-lane pull.
- No outer-lane swap.

## Corrected behaviour
- Colour order corrected (dots and lines share one ordering).
- Same-colour dot/line alignment corrected.
- Cross-lane control result: Seg18 9.3 m samples remain rejected.
- Representative points enter the approved CVLP kind `representativeLaneLines` and
  carry matched canonical/placed provenance so they project identically to their
  source point-accumulated dots.

## Accepted limitation
- Representative output remains fragmented in several areas.
- Some short gaps remain.
- Faint thin per-frame source curves may extend away from the representative result.
- This fragmentation is out of scope here and will be handled separately later.
- **No bridge / gap-filling work is included in this change.**

## Candidate status
- Station Support V2 remains candidate-controlled: `representativeStationSupportCandidate=1`.
- Absent / invalid / `0` remains OFF. Representative lane lines remain opt-in.
- Candidate remains **default OFF**.

## Review URL
`http://localhost:3847/?local=1&fit=1&mirror=1&connected=1&connectedMode=perFrame&representativeLaneLinesCandidate=1&representativeMethod=purityRevisit&representativeStationSupportCandidate=1&progressiveCombinedPlaybackCandidate=1&progressiveViewportCandidate=1&segments=14`
