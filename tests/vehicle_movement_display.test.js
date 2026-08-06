'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveMovementDisplay,
  formatMovementLabel,
  enrichTimelineWithMovement,
  findVehiclePathPoint,
} = require('../lib/vehicle_movement_display');

describe('vehicle movement display', () => {
  it('maps internal movementState to display labels', () => {
    const moving = resolveMovementDisplay({
      timelineEntry: { speed: 5, movementState: 'moving' },
    });
    assert.equal(moving.displayState, 'MOVING');
    assert.equal(moving.speedKmh, 18);
    assert.equal(moving.labelText, 'MOVING · 18.0 km/h');

    const stopped = resolveMovementDisplay({
      timelineEntry: { speed: 0.5, movementState: 'stationary' },
    });
    assert.equal(stopped.displayState, 'STOPPED');

    const creeping = resolveMovementDisplay({
      timelineEntry: { speed: 3, movementState: 'creeping' },
    });
    assert.equal(creeping.displayState, 'CREEPING');
  });

  it('converts speed from m/s to km/h', () => {
    const d = resolveMovementDisplay({ timelineEntry: { speed: 10 } });
    assert.equal(d.speedMps, 10);
    assert.equal(d.speedKmh, 36);
    assert.equal(d.labelText, 'MOVING · 36.0 km/h');
  });

  it('returns UNCERTAIN when state and speed are missing', () => {
    const d = resolveMovementDisplay({ timelineEntry: {} });
    assert.equal(d.displayState, 'UNCERTAIN');
    assert.equal(d.labelText, 'UNCERTAIN');
  });

  it('reads movementState from vehiclePath when timeline lacks it', () => {
    const vp = { logMonoTime: '100', movementState: 'moving', speed: 8 };
    const d = resolveMovementDisplay({
      timelineEntry: { logMonoTime: '100', speed: 8 },
      vehiclePathPoint: vp,
    });
    assert.equal(d.displayState, 'MOVING');
  });

  it('enriches timeline entries with movementState from vehiclePath', () => {
    const timeline = [
      { index: 0, logMonoTime: '100', speed: 8 },
      { index: 1, logMonoTime: '200', speed: 0.2 },
    ];
    const vehiclePath = [
      { logMonoTime: '100', movementState: 'moving', speed: 8 },
      { logMonoTime: '200', movementState: 'stationary', speed: 0.2 },
    ];
    const enriched = enrichTimelineWithMovement(timeline, vehiclePath);
    assert.equal(enriched[0].movementState, 'moving');
    assert.equal(enriched[1].movementState, 'stationary');
  });

  it('finds nearest vehicle path point by logMonoTime', () => {
    const path = [
      { logMonoTime: '1000', movementState: 'moving' },
      { logMonoTime: '2000', movementState: 'stationary' },
    ];
    assert.equal(findVehiclePathPoint(path, '1000').movementState, 'moving');
    assert.equal(findVehiclePathPoint(path, '1999').movementState, 'stationary');
  });

  it('formats label without speed when km/h unavailable', () => {
    assert.equal(formatMovementLabel('STOPPED', null), 'STOPPED');
  });
});
