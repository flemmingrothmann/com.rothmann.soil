'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATES,
  deriveAdaptiveAlarmConfig,
  reconcileAdaptiveAlarm,
} = require('../lib/adaptiveSoilAlarm');

test('disabled threshold keeps alarm off and normal interval', () => {
  const config = deriveAdaptiveAlarmConfig({ alarmThreshold: 0, pollInterval: 600 });
  const next = reconcileAdaptiveAlarm({
    currentState: STATES.ALARM_AGGRESSIVE,
    stateStartedAt: 0,
    previousMoisture: 10,
    currentMoisture: 5,
    currentAlarm: true,
    now: 1000,
    config,
  });

  assert.equal(next.state, STATES.NORMAL);
  assert.equal(next.alarmActive, false);
  assert.equal(next.reportInterval, 600);
});

test('crossing lower threshold enters aggressive alarm mode', () => {
  const config = deriveAdaptiveAlarmConfig({ alarmThreshold: 20, pollInterval: 600 });
  const next = reconcileAdaptiveAlarm({
    currentState: STATES.NORMAL,
    stateStartedAt: 0,
    previousMoisture: 22,
    currentMoisture: 20,
    currentAlarm: false,
    now: 1000,
    config,
  });

  assert.equal(next.state, STATES.ALARM_AGGRESSIVE);
  assert.equal(next.alarmActive, true);
  assert.equal(next.reportInterval, 60);
});

test('alarm stays active until upper threshold is reached', () => {
  const config = deriveAdaptiveAlarmConfig({ alarmThreshold: 20, pollInterval: 600 });
  const next = reconcileAdaptiveAlarm({
    currentState: STATES.ALARM_AGGRESSIVE,
    stateStartedAt: 0,
    previousMoisture: 19,
    currentMoisture: 24,
    currentAlarm: true,
    now: 1000,
    config,
  });

  assert.equal(next.state, STATES.ALARM_AGGRESSIVE);
  assert.equal(next.alarmActive, true);
});

test('alarm clears at upper threshold and enters recovery', () => {
  const config = deriveAdaptiveAlarmConfig({ alarmThreshold: 20, pollInterval: 600 });
  const next = reconcileAdaptiveAlarm({
    currentState: STATES.ALARM_MEDIUM,
    stateStartedAt: 0,
    previousMoisture: 23,
    currentMoisture: 25,
    currentAlarm: true,
    now: 1000,
    config,
  });

  assert.equal(next.state, STATES.RECOVERY_AGGRESSIVE);
  assert.equal(next.alarmActive, false);
  assert.equal(next.reportInterval, 60);
});

test('timed backoff progresses through alarm phases', () => {
  const config = deriveAdaptiveAlarmConfig({ alarmThreshold: 20, pollInterval: 600 });

  const medium = reconcileAdaptiveAlarm({
    currentState: STATES.ALARM_AGGRESSIVE,
    stateStartedAt: 0,
    previousMoisture: 18,
    currentMoisture: 18,
    currentAlarm: true,
    now: config.aggressiveDurationMs + 1,
    config,
  });

  assert.equal(medium.state, STATES.ALARM_MEDIUM);
  assert.equal(medium.reportInterval, 200);

  const backoff = reconcileAdaptiveAlarm({
    currentState: STATES.ALARM_MEDIUM,
    stateStartedAt: 0,
    previousMoisture: 18,
    currentMoisture: 18,
    currentAlarm: true,
    now: config.mediumDurationMs + 1,
    config,
  });

  assert.equal(backoff.state, STATES.ALARM_BACKOFF);
  assert.equal(backoff.reportInterval, 600);
});

test('significant rise during backoff re-enters aggressive alarm mode', () => {
  const config = deriveAdaptiveAlarmConfig({ alarmThreshold: 40, pollInterval: 600 });
  const next = reconcileAdaptiveAlarm({
    currentState: STATES.ALARM_BACKOFF,
    stateStartedAt: 0,
    previousMoisture: 36,
    currentMoisture: 40,
    currentAlarm: true,
    now: 1000,
    config,
  });

  assert.equal(next.state, STATES.ALARM_AGGRESSIVE);
  assert.equal(next.alarmActive, true);
  assert.equal(next.reportInterval, 60);
});
