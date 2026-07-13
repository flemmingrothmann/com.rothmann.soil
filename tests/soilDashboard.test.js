'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canSetSoilAlarmThreshold,
  countWaterAlarmActivations,
  getActiveSince,
  getDanishPeriodRange,
  getLatestCapabilityUpdatedAt,
  getSoilMaintenanceStatus,
  isActiveCapability,
  isContactSensor,
  isLightDevice,
  isMotionSensor,
  isWateringValve,
  enrichWateringValveFlows,
  markZoneWaterAlarmTopscorers,
  normalizeSoilHistory,
  normalizeSoilWarningThresholdInput,
  normalizeEnergyPeriodOffset,
  shouldShowActiveDevice,
  updateSoilIssueCounterState,
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
  const history = normalizeSoilHistory([
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

test('keeps dense soil moisture history above high-frequency sensor volume', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const history = Array.from({ length: 7600 }, (_, index) => ({
    t: new Date(now - ((7599 - index) * 60 * 1000)).toISOString(),
    v: 40 + (index % 10),
  }));

  const normalized = normalizeSoilHistory(history, now);

  assert.equal(normalized.length, 7500);
  assert.equal(normalized[0].t, Date.parse(history[100].t));
});

test('validates dashboard soil warning threshold range', () => {
  assert.equal(normalizeSoilWarningThresholdInput('30.4'), 30);
  assert.equal(normalizeSoilWarningThresholdInput(90), 90);
  assert.throws(() => normalizeSoilWarningThresholdInput(91), /mellem 0 og 90/);
  assert.throws(() => normalizeSoilWarningThresholdInput('abc'), /skal være et tal/);
});

test('normalizes energy period offsets to past or current periods', () => {
  assert.equal(normalizeEnergyPeriodOffset('-2.9'), -2);
  assert.equal(normalizeEnergyPeriodOffset(1), 0);
  assert.equal(normalizeEnergyPeriodOffset('abc'), 0);
  assert.equal(normalizeEnergyPeriodOffset(-999), -120);
});

test('builds shifted energy ranges for all period choices', () => {
  const now = Date.parse('2026-07-03T10:15:00.000Z');

  const currentDay = getDanishPeriodRange('day', now, 0);
  assert.equal(currentDay.from.toISOString(), '2026-07-02T22:00:00.000Z');
  assert.equal(currentDay.to.toISOString(), '2026-07-03T10:15:00.000Z');

  const previousDay = getDanishPeriodRange('day', now, -1);
  assert.equal(previousDay.from.toISOString(), '2026-07-01T22:00:00.000Z');
  assert.equal(previousDay.to.toISOString(), '2026-07-02T22:00:00.000Z');

  const previousThreeDays = getDanishPeriodRange('3days', now, -1);
  assert.equal(previousThreeDays.from.toISOString(), '2026-06-27T22:00:00.000Z');
  assert.equal(previousThreeDays.to.toISOString(), '2026-06-30T22:00:00.000Z');

  const previousWeek = getDanishPeriodRange('week', now, -1);
  assert.equal(previousWeek.from.toISOString(), '2026-06-19T22:00:00.000Z');
  assert.equal(previousWeek.to.toISOString(), '2026-06-26T22:00:00.000Z');

  const previousMonth = getDanishPeriodRange('month', now, -1);
  assert.equal(previousMonth.from.toISOString(), '2026-05-04T22:00:00.000Z');
  assert.equal(previousMonth.to.toISOString(), '2026-06-03T22:00:00.000Z');

  const previousBillingPeriod = getDanishPeriodRange('billing', now, -1);
  assert.equal(previousBillingPeriod.from.toISOString(), '2026-05-31T22:00:00.000Z');
  assert.equal(previousBillingPeriod.to.toISOString(), '2026-06-30T22:00:00.000Z');
});

test('allows soil threshold control only for live supported sensors', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const device = {
    available: true,
    capabilities: ['measure_soil_moisture', 'soil_warning_threshold'],
    settings: { soil_warning: 30, soil_sampling: 600 },
    capabilitiesObj: {
      measure_soil_moisture: { lastUpdated: new Date(now - 60000).toISOString() },
    },
  };

  assert.equal(canSetSoilAlarmThreshold(device, now), true);
  assert.equal(canSetSoilAlarmThreshold({ ...device, settings: { soil_sampling: 600 } }, now), false);
  assert.equal(canSetSoilAlarmThreshold({ ...device, available: false }, now), false);
  assert.equal(canSetSoilAlarmThreshold({
    ...device,
    capabilitiesObj: { measure_soil_moisture: { lastUpdated: new Date(now - (7 * 60 * 60 * 1000)).toISOString() } },
  }, now), false);
});

test('marks live soil sensors for maintenance when moisture is unchanged for 22 hours', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const device = {
    available: true,
    capabilitiesObj: {
      measure_soil_moisture: {
        value: 42,
        lastUpdated: new Date(now - (23 * 60 * 60 * 1000)).toISOString(),
      },
      measure_temperature: { lastUpdated: new Date(now - 60000).toISOString() },
    },
  };

  const status = getSoilMaintenanceStatus(device, now, true);

  assert.equal(status.needed, true);
  assert.equal(status.unchangedMinutes, 1380);
  assert.equal(status.thresholdHours, 22);
});

test('does not mark live soil sensors for maintenance before 22 hours', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const device = {
    available: true,
    capabilitiesObj: {
      measure_soil_moisture: {
        value: 42,
        lastUpdated: new Date(now - (21 * 60 * 60 * 1000)).toISOString(),
      },
      measure_temperature: { lastUpdated: new Date(now - 60000).toISOString() },
    },
  };

  assert.equal(getSoilMaintenanceStatus(device, now, true).needed, false);
});

test('does not mark offline soil sensors for maintenance even after 22 hours', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const device = {
    available: true,
    capabilitiesObj: {
      measure_soil_moisture: {
        value: 42,
        lastUpdated: new Date(now - (23 * 60 * 60 * 1000)).toISOString(),
      },
    },
  };

  assert.equal(getSoilMaintenanceStatus(device, now, false).needed, false);
});

test('does not mark soil sensors for maintenance while moisture changes inside window', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const device = {
    available: true,
    capabilitiesObj: {
      measure_soil_moisture: {
        value: 42,
        lastUpdated: new Date(now - (2 * 60 * 60 * 1000)).toISOString(),
      },
      measure_temperature: { lastUpdated: new Date(now - 60000).toISOString() },
    },
  };

  assert.equal(getSoilMaintenanceStatus(device, now, true).needed, false);
  assert.equal(getSoilMaintenanceStatus(device, now, false).needed, false);
});

test('increments soil issue counters only on inactive to active transitions', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const devices = [{
    apiDeviceId: 'sensor-1',
    offline: true,
    needsMaintenance: false,
  }];

  const first = updateSoilIssueCounterState({}, devices, now);
  const second = updateSoilIssueCounterState(first.state, devices, now + 60000);
  const cleared = updateSoilIssueCounterState(second.state, [{
    apiDeviceId: 'sensor-1',
    offline: false,
    needsMaintenance: false,
  }], now + 120000);
  const third = updateSoilIssueCounterState(cleared.state, devices, now + 180000);

  assert.equal(first.state.sensorIssueCounters['sensor-1'].offlineCount, 1);
  assert.equal(second.state.sensorIssueCounters['sensor-1'].offlineCount, 1);
  assert.equal(cleared.state.sensorIssueCounters['sensor-1'].offlineActive, false);
  assert.equal(third.state.sensorIssueCounters['sensor-1'].offlineCount, 2);
});

test('tracks offline and move-clean counters separately', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const devices = [{
    apiDeviceId: 'sensor-1',
    offline: true,
    needsMaintenance: true,
  }];

  const result = updateSoilIssueCounterState({}, devices, now);

  assert.deepEqual(devices[0].issueCounters, { offline: 1, maintenance: 1 });
  assert.equal(result.state.sensorIssueCounters['sensor-1'].offlineCount, 1);
  assert.equal(result.state.sensorIssueCounters['sensor-1'].maintenanceCount, 1);
});

test('finds latest capability update even when some capabilities lack timestamps', () => {
  const latest = getLatestCapabilityUpdatedAt({
    capabilitiesObj: {
      measure_soil_moisture: { lastUpdated: '2026-06-07T15:32:46.948Z' },
      alarm_water: { lastUpdated: null },
      measure_battery: { lastUpdated: '2026-06-18T06:45:25.940Z' },
    },
  });

  assert.equal(latest, Date.parse('2026-06-18T06:45:25.940Z'));
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

test('detects contact sensors by alarm_contact capability', () => {
  assert.equal(isContactSensor({ capabilities: ['alarm_contact', 'measure_battery'] }), true);
  assert.equal(isContactSensor({ capabilities: ['onoff'] }), false);
  assert.equal(isContactSensor({
    driverId: 'homey:app:nl.qluster-it.DeviceCapabilities:virtualdevice',
    capabilities: ['measure_devicecapabilities_number-custom_36.number1', 'alarm_contact'],
  }), false);
});

test('detects motion sensors by alarm_motion capability', () => {
  assert.equal(isMotionSensor({ capabilities: ['alarm_motion', 'measure_battery'] }), true);
  assert.equal(isMotionSensor({ capabilities: ['alarm_contact'] }), false);
  assert.equal(isMotionSensor({
    driverId: 'homey:app:nl.qluster-it.DeviceCapabilities:virtualdevice',
    capabilities: ['alarm_motion'],
  }), false);
});

test('detects light devices by class and onoff capability', () => {
  assert.equal(isLightDevice({ class: 'light', capabilities: ['onoff', 'dim'] }), true);
  assert.equal(isLightDevice({ class: 'socket', capabilities: ['onoff'] }), false);
  assert.equal(isLightDevice({ class: 'light', capabilities: ['dim'] }), false);
  assert.equal(isLightDevice({
    id: '20a56e23-3720-475f-a197-0cfdfc9fce36',
    class: 'light',
    capabilities: ['onoff'],
  }), false);
});

test('finds active contact sensor open start from latest true entry', () => {
  const activeSince = getActiveSince([
    { t: '2026-06-01T10:00:00.000Z', v: true },
    { t: '2026-06-01T11:00:00.000Z', v: false },
    { t: '2026-06-01T12:00:00.000Z', v: true },
  ]);

  assert.equal(activeSince, Date.parse('2026-06-01T12:00:00.000Z'));
});

test('does not report active since when latest contact entry is closed', () => {
  const activeSince = getActiveSince([
    { t: '2026-06-01T10:00:00.000Z', v: true },
    { t: '2026-06-01T11:00:00.000Z', v: false },
  ]);

  assert.equal(activeSince, null);
});

test('shows active detail devices when active or unavailable', () => {
  assert.equal(shouldShowActiveDevice({ available: true, capabilitiesObj: { onoff: { value: true } } }, 'onoff'), true);
  assert.equal(shouldShowActiveDevice({ available: false, capabilitiesObj: { onoff: { value: false } } }, 'onoff'), true);
  assert.equal(shouldShowActiveDevice({ available: true, capabilitiesObj: { onoff: { value: false } } }, 'onoff'), false);
});

test('does not treat unavailable devices as active', () => {
  assert.equal(isActiveCapability({ available: false, capabilitiesObj: { onoff: { value: true } } }, 'onoff'), false);
  assert.equal(shouldShowActiveDevice({ available: false, capabilitiesObj: { onoff: { value: true } } }, 'onoff'), true);
});

test('treats linked watering timer as active valve source of truth', () => {
  const valves = [{ id: 'valve-1', on: false }];
  const flows = {
    flow1: {
      id: 'flow1',
      name: 'Vand bed',
      enabled: true,
      actions: [
        { ownerUri: 'homey:device:valve-1', id: 'homey:device:valve-1:onoff' },
        { ownerUri: 'homey:app:nl.fellownet.chronograph', id: 'timer_start', args: { name: 'Bed timer' } },
      ],
    },
  };
  const timers = [{
    name: 'Bed timer',
    running: true,
    duration: 60000,
    targetDuration: 300000,
  }];

  enrichWateringValveFlows(valves, flows, {}, timers);

  assert.equal(valves[0].wateringActive, true);
  assert.equal(valves[0].wateringFlow.timerName, 'Bed timer');
  assert.equal(valves[0].wateringFlow.timer.running, true);
});

test('does not treat open valve as active when linked timer is stopped', () => {
  const valves = [{ id: 'valve-1', on: true }];
  const flows = {
    flow1: {
      id: 'flow1',
      name: 'Vand bed',
      enabled: true,
      actions: [
        { ownerUri: 'homey:device:valve-1', id: 'homey:device:valve-1:onoff' },
        { ownerUri: 'homey:app:nl.fellownet.chronograph', id: 'timer_start', args: { name: 'Bed timer' } },
      ],
    },
  };
  const timers = [{
    name: 'Bed timer',
    running: false,
    duration: 0,
    targetDuration: 300000,
  }];

  enrichWateringValveFlows(valves, flows, {}, timers);

  assert.equal(valves[0].wateringActive, false);
});

test('uses running closing timer as watering valve source of truth', () => {
  const valves = [{ id: 'valve-1', on: false }];
  const flows = {
    flow1: {
      id: 'flow1',
      name: 'Vand bed',
      enabled: true,
      actions: [
        { ownerUri: 'homey:device:valve-1', id: 'homey:device:valve-1:onoff' },
        { ownerUri: 'homey:app:nl.fellownet.chronograph', id: 'timer_start', args: { name: 'Bed timer' } },
        { ownerUri: 'homey:app:nl.fellownet.chronograph', id: 'timer_start', args: { name: 'Bed timer lukning' } },
      ],
    },
  };
  const timers = [{
    name: 'Bed timer lukning',
    running: true,
    duration: 60000,
    targetDuration: 300000,
  }];

  enrichWateringValveFlows(valves, flows, {}, timers);

  assert.equal(valves[0].wateringActive, true);
  assert.equal(valves[0].wateringFlow.timerName, 'Bed timer lukning');
  assert.deepEqual(valves[0].wateringFlow.timerNames, ['Bed timer', 'Bed timer lukning']);
  assert.equal(valves[0].wateringFlow.timer.running, true);
});
