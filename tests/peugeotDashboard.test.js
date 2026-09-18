'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePeugeotVehicle } = require('../dashboard/server');

test('normalizes electric vehicle state and freshness', () => {
  const result = normalizePeugeotVehicle({
    vehicle: { modelName: 'e-208' },
    updatedAt: '2026-07-30T10:00:00Z',
    energy: [{
      type: 'Electric',
      level: 73,
      autonomy: 241,
      charging: { status: 'InProgress', plugged: true, remainingMinutes: 42 },
    }],
  }, Date.parse('2026-07-30T10:05:00Z'));

  assert.equal(result.vehicle.batteryLevel, 73);
  assert.equal(result.vehicle.rangeKm, 241);
  assert.equal(result.vehicle.charging, true);
  assert.equal(result.vehicle.plugged, true);
  assert.equal(result.vehicle.freshness, 'fresh');
  assert.equal(result.vehicle.ageMs, 5 * 60 * 1000);
  assert.equal(result.vehicle.stale, false);
});

test('marks one to six hour old vehicle data as not quite fresh', () => {
  const result = normalizePeugeotVehicle({
    updatedAt: '2026-07-30T07:00:00Z',
    energy: [{ type: 'Electric', level: 60 }],
  }, Date.parse('2026-07-30T10:00:00Z'));

  assert.equal(result.vehicle.freshness, 'aging');
  assert.equal(result.vehicle.stale, false);
});

test('marks old vehicle data as stale', () => {
  const result = normalizePeugeotVehicle({
    timestamp: '2026-07-29T20:00:00Z',
    status: { energy: [{ type: 'Electric', level: 34 }] },
  }, Date.parse('2026-07-30T10:00:00Z'));

  assert.equal(result.vehicle.batteryLevel, 34);
  assert.equal(result.vehicle.freshness, 'old');
  assert.equal(result.vehicle.stale, true);
});
