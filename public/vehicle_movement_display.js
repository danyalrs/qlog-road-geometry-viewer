'use strict';

/**
 * Display-only helpers for vehicle movement state near the fixed vehicle-relative origin.
 * Does not classify movement — reads movementState / speed from processed data when present.
 */

const DISPLAY_STATES = Object.freeze(['MOVING', 'CREEPING', 'STOPPED', 'UNCERTAIN']);

const INTERNAL_TO_DISPLAY = Object.freeze({
  moving: 'MOVING',
  creeping: 'CREEPING',
  stationary: 'STOPPED',
  uncertain: 'UNCERTAIN',
});

function findVehiclePathPoint(vehiclePath, logMonoTime) {
  if (!vehiclePath?.length || logMonoTime == null) return null;
  const target = String(logMonoTime);
  const exact = vehiclePath.find((p) => String(p.logMonoTime) === target);
  if (exact) return exact;
  let best = null;
  let bestDiff = null;
  const tb = BigInt(target);
  for (const p of vehiclePath) {
    if (p.logMonoTime == null) continue;
    const diff = BigInt(p.logMonoTime) > tb
      ? BigInt(p.logMonoTime) - tb
      : tb - BigInt(p.logMonoTime);
    if (bestDiff == null || diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
  }
  return best;
}

function speedMpsFromSources({ timelineEntry, vehiclePathPoint, framePose }) {
  const candidates = [
    timelineEntry?.speed,
    vehiclePathPoint?.speed,
    framePose?.speed,
  ];
  for (const v of candidates) {
    if (Number.isFinite(v)) return v;
  }
  return null;
}

function mapInternalState(rawState) {
  if (rawState == null || rawState === '') return null;
  const key = String(rawState).toLowerCase();
  return INTERNAL_TO_DISPLAY[key] || null;
}

function resolveMovementDisplay({ timelineEntry, vehiclePathPoint, framePose } = {}) {
  const speedMps = speedMpsFromSources({ timelineEntry, vehiclePathPoint, framePose });
  const speedKmh = speedMps != null ? speedMps * 3.6 : null;

  const rawState = timelineEntry?.movementState
    ?? vehiclePathPoint?.movementState
    ?? framePose?.movementState
    ?? null;

  let displayState = mapInternalState(rawState);
  if (!displayState) {
    if (speedMps == null) displayState = 'UNCERTAIN';
    else if (speedMps <= 2.0) displayState = 'STOPPED';
    else if (speedMps <= 4.0) displayState = 'CREEPING';
    else displayState = 'MOVING';
  }

  return {
    displayState,
    speedMps,
    speedKmh,
    labelText: formatMovementLabel(displayState, speedKmh),
    ringStyle: displayState,
    rawMovementState: rawState,
  };
}

function formatMovementLabel(displayState, speedKmh) {
  const state = DISPLAY_STATES.includes(displayState) ? displayState : 'UNCERTAIN';
  if (speedKmh == null || !Number.isFinite(speedKmh)) return state;
  return `${state} · ${speedKmh.toFixed(1)} km/h`;
}

function enrichTimelineWithMovement(timeline, vehiclePath) {
  if (!timeline?.length) return timeline || [];
  return timeline.map((entry) => {
    const vp = findVehiclePathPoint(vehiclePath, entry.logMonoTime);
    const movementState = vp?.movementState ?? entry.movementState ?? null;
    return movementState != null && entry.movementState === movementState
      ? entry
      : { ...entry, movementState };
  });
}

const api = {
  DISPLAY_STATES,
  INTERNAL_TO_DISPLAY,
  findVehiclePathPoint,
  speedMpsFromSources,
  resolveMovementDisplay,
  formatMovementLabel,
  enrichTimelineWithMovement,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.VehicleMovementDisplay = api;
}
