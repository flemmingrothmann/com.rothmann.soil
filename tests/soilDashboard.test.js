'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  countWaterAlarmActivations,
  markZoneWaterAlarmTopscorers,
  normalizeSoilMoistureInsightHistory,
} = require('../lib/soilDashboard');
const {
  isWateringValve,
} = require('../dashboard/server');

test('counts water alarm activations within cutoff', () => {
  const cutoff = Date.parse('2026-05-01T00:00:00.000Z');
  const count = countWaterAlarmActivations([
    { t: '2026-04-30T23:59:59.000Z', v: true },
    { t: '2026-05-01T00:00:00.000Z', v: true },
    { t: '2026-05-02T00:00:00.000Z', v: false },
    { t: '2026-05-03T00:00:00.000Z', v: true },
    { t: 'not-a-date', v: true },
  ], cutoff);

  assert.equal(count, 2);
});

test('marks all tied water alarm topscorers per zone', () => {
  const zones = [
    {
      devices: [
        { name: 'Sensor B', waterAlarmStats: { monthlyActivations: 4, zoneTopScorer: false } },
        { name: 'Sensor A', waterAlarmStats: { monthlyActivations: 4, zoneTopScorer: false } },
        { name: 'Sensor C', waterAlarmStats: { monthlyActivations: 1, zoneTopScorer: false } },
      ],
    },
    {
      devices: [
        { name: 'Sensor D', waterAlarmStats: { monthlyActivations: 0, zoneTopScorer: false } },
      ],
    },
  ];

  markZoneWaterAlarmTopscorers(zones);

  assert.equal(zones[0].devices[0].waterAlarmStats.zoneTopScorer, true);
  assert.equal(zones[0].devices[1].waterAlarmStats.zoneTopScorer, true);
  assert.equal(zones[0].devices[2].waterAlarmStats.zoneTopScorer, false);
  assert.equal(zones[1].devices[0].waterAlarmStats.zoneTopScorer, false);
});

test('normalizes soil moisture insight history within dashboard window', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const history = normalizeSoilMoistureInsightHistory([
    { t: '2026-05-24T11:59:59.000Z', v: 10 },
    { t: '2026-05-25T12:00:00.000Z', v: '20.5' },
    { t: 'invalid', v: 30 },
    { t: '2026-06-01T12:00:00.000Z', v: 40 },
  ], now);

  assert.deepEqual(history, [
    { t: Date.parse('2026-05-25T12:00:00.000Z'), v: 20.5 },
    { t: Date.parse('2026-06-01T12:00:00.000Z'), v: 40 },
  ]);
});

test('detects watering valves by driver and water capabilities', () => {
  assert.equal(isWateringValve({
    name: 'Vandventil utility',
    driverId: 'homey:app:se.styrahem.sonoff.zigbee:SWV',
    capabilities: ['onoff', 'measure_water', 'meter_water', 'measure_battery'],
  }), true);

  assert.equal(isWateringValve({
    name: 'Vanding socket',
    driverId: 'homey:app:net.franceweb.nous:smart-socket-a1z',
    capabilities: ['onoff', 'meter_power'],
  }), false);
});
