# purityRevisit — fitting / splitting rule description

Method: `representativeMethod=purityRevisit` (`buildRepresentativeLaneLinesPurityRevisitFromPerFrame`).
Display-only, opt-in. Existing `curveAssociation`, `purity`, and `legacy` methods are unchanged.

## Pipeline
1. Admission + enrichment: identical to `purity` (complete per-frame source curves, trusted
   near-field `modelX <= 80`).
2. Seed identity `chunk:pass:groupTrackId` → strands (identical rule to `purity`).
3. Station fitting (1 m) identical to `purity`, including the persistent-bimodality guard.
4. Post-fit combined self-fold gate (new):
   - `maxTurnWindowDeg` = max cumulative absolute turn inside any 25 m sliding path window.
   - `chordPathRatio` = endpoint chord / path length of the line.
   - `nearApproach` = count of non-adjacent (index gap > 8) vertex-to-segment distances < 3.0 m
     where the two vertices' `s` differ > 5.0 m.
   - `temporalRevisit` = the line's `distinctFrameIds`, sorted, contain a gap exceeding
     `max(20, 5 * typicalSpacing)`; `typicalSpacing` is the median of positive gaps after dropping
     the single largest gap (so a two-group line does not use its own revisit gap as baseline).
   - Trigger (combined, never a single threshold):
     `maxTurnWindowDeg > 270 AND chordPathRatio < 0.60 AND (nearApproach > 0 OR temporalRevisit)`.
5. Response to a detected fold (preferred order):
   - Split at the proven temporal visit boundary: `distinctFrameIds` gap > threshold defines the
     boundary; the point sequence is cut where per-point frame order crosses it; both pieces must
     have >= `minPolylinePoints`.
   - Keep both valid pieces.
   - If no safe split exists and line coverage < 50 m → reject the short invalid piece
     (`purityRejected = 'selfFold'`).
   - If no safe split exists and the line is long (>= 50 m) → keep and flag (`purityFlagged = 'selfFold'`),
     never delete a long supported lane for one local window.
6. Same-identity overlap sweep (identical to `purity`).

## Candidate thresholds and reasoning
| Parameter | Value | Reasoning |
|---|---|---|
| window | 25 m | path window matching the diagnosis sliding-window metric |
| turn threshold | 270° | Seg99 false fold 388° vs accepted Seg0/1/2 max 186° |
| chord/path ratio | 0.60 | Seg99 false fold 0.353 vs accepted Seg0/1/2 min 0.801 |
| near-approach dist | 3.0 m | diagnosis near-self-approach distance |
| near-approach s-sep | 5.0 m | excludes adjacent-vertex proximity |
| visit min gap | 20 | absolute floor for a real revisit |
| visit gap factor | 5× | relative to the strand's own typical spacing |
| pre-split | OFF | raw/median union folding false-positives on Seg2's genuine loop (union turn 1175-1212) more than the Seg99 fold (699); the fitted gate is the safe discriminator |
| min-keep coverage | 50 m | below this a folded fragment is rejected, not flagged |

## Why the pre-fit visit split is OFF by default
The task's preferred primary correction was pre-fit association separation. It is implemented
(`puritySplitStrandByVisitGroups`) and reachable via `purityRevisitPreSplit: true`, but focused
evidence shows the raw trusted-point union folds *more* for Seg2's legitimate loop than for the Seg99
false fold (Seg2 union turn 1175-1212 / ratio 0.011-0.014; Seg99 union 699 / 0.059; a 1 m station-median
proxy is equally non-discriminating: Seg2 751-773, Seg99 616). Only the *fitted* combined gate
separates them (Seg2 fitted 191 / 0.861; Seg99 fitted 388 / 0.353). Default is therefore the fitted
post-fit gate; pre-split remains available but off.
