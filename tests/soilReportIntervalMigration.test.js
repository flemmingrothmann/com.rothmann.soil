'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getReducedSoilReportIntervalSettings,
  migrateDeviceSoilReportIntervals,
} = require('../lib/soilReportIntervalMigration');

test('reduces existing report interval settings above 240 seconds', () => {
  assert.deepEqual(getReducedSoilReportIntervalSettings({
    soil_sampling: 600,
    temperature_sampling: 301,
    humidity_report_min_interval: 450,
    humidity_report_max_interval: 1800,
    temperature_report_min_interval: 15,
    temperature_report_max_interval: 300,
  }), {
    soil_sampling: 240,
    temperature_sampling: 240,
    humidity_report_min_interval: 240,
    humidity_report_max_interval: 240,
    temperature_report_max_interval: 240,
  });
});

test('does not raise existing report interval settings below 240 seconds', () => {
  assert.deepEqual(getReducedSoilReportIntervalSettings({
    soil_sampling: 120,
    temperature_sampling: 239,
    humidity_report_min_interval: 60,
    humidity_report_max_interval: 240,
  }), {});
});

test('migrates a device by writing only reduced report interval settings', async () => {
  const writes = [];
  const device = {
    getName: () => 'Bed sensor',
    getSettings: () => ({ soil_sampling: 600, soil_warning: 30 }),
    setSettings: async (settings) => writes.push(settings),
  };

  const result = await migrateDeviceSoilReportIntervals(device);

  assert.equal(result.changed, true);
  assert.deepEqual(result.settings, { soil_sampling: 240 });
  assert.deepEqual(writes, [{ soil_sampling: 240 }]);
});
