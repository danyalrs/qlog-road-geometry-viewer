# Progressive Viewport Candidate — Manual Review

**Status:** `CANDIDATE IMPLEMENTED — USER VISUAL REVIEW REQUIRED`

**Important:** Restart the local server (or hard-refresh with cache bust) so `progressive_viewport_candidate.js`, `render.js?v=20260918a`, and `app.js?v=20260918a` load.

## URL

http://localhost:3847/?segments=9&local=1&fit=1&mirror=1&progressiveCombinedPlaybackCandidate=1&progressiveViewportCandidate=1

## Steps

1. Open the URL and process Seg9.
2. **Without scrolling down**, use the top playback toolbar (below **Remove last segment**):
   - **Next frame** / **Prev frame** — arrow, video, and source/time line update.
   - **Play** / **Pause** — lower Timeline controls stay in sync.
3. Append progressively through Seg19 using top or lower controls.
4. Click **Fit visible route** — entire visible prefix should fill the canvas.
5. Click **Fit active segment** — view should focus on the current segment’s geometry.
6. Enable **Follow arrow**, play forward from the top toolbar — arrow stays near centre; zoom unchanged.
7. Disable Follow arrow and pan manually — follow should turn off.
8. Scroll ordinary mouse wheel over canvas — zoom must **not** change (hint shown).
9. Hold **Ctrl** and scroll — zoom should change.
10. Intentionally pan away, then recover with both fit buttons.
11. At first/last visible frame, confirm top and lower Prev/Next disabled states match.
12. Confirm lane/road geometry unchanged (no placement drift).

## Keyboard shortcuts

- `Home` — Fit active segment
- `Shift + Home` — Fit visible route

(ignored while typing in form controls)

## Limitations

- Does not change stationary-boundary placement (Seg6→7 etc.).
- LOD is draw-only; stored geometry checksums unchanged.
- ~27% draw reduction at moderate zoom for Seg9–19 point dots; full detail returns when zoomed in.
- Server must be restarted if it predates these file changes.
