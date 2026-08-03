'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFixedLoopActions,
  createReplayActions,
  executeReplayActions,
  getReplayCapabilities,
  getReplayDevices,
  getReplayTime,
  mapSourceTime,
  normalizeProfiles,
  normalizeRunInput,
  partitionReplayActions,
} = require('../replay');

const devices = {
  light: {
    id: 'light', name: 'Lampe ', class: 'light', zone: 'living', capabilities: ['onoff', 'dim', 'light_hue'],
  },
  plug: {
    id: 'plug', name: 'Kontakt', class: 'socket', zone: 'office', capabilities: ['onoff', 'measure_power'],
  },
  sensor: {
    id: 'sensor', name: 'Sensor', class: 'sensor', capabilities: ['measure_temperature'],
  },
};

test('offers all lights and other onoff devices with safe capability scope', () => {
  const result = getReplayDevices(devices, { living: { name: 'Stue' }, office: { name: 'Kontor' } });
  assert.deepEqual(result.map((device) => device.id), ['light', 'plug']);
  assert.deepEqual(getReplayCapabilities(devices.light), ['light_hue', 'dim', 'onoff']);
  assert.deepEqual(getReplayCapabilities(devices.plug), ['onoff']);
});

test('creates a default profile containing all lights only', () => {
  const replayDevices = getReplayDevices(devices, {});
  const profiles = normalizeProfiles([], replayDevices);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].isDefault, true);
  assert.deepEqual(profiles[0].deviceIds, ['light']);
});

test('keeps exactly one default profile and removes unknown devices', () => {
  const replayDevices = getReplayDevices(devices, {});
  const profiles = normalizeProfiles([
    {
      id: 'a', name: 'A', isDefault: true, deviceIds: ['light', 'gone'],
    },
    {
      id: 'b', name: 'B', isDefault: true, deviceIds: ['plug'],
    },
  ], replayDevices);
  assert.deepEqual(profiles.map((profile) => profile.isDefault), [true, false]);
  assert.deepEqual(profiles[0].deviceIds, ['light']);
});

test('defaults replay source to exactly seven days ago', () => {
  const now = Date.parse('2026-07-28T12:00:00.000Z');
  const [profile] = normalizeProfiles([], getReplayDevices(devices, {}));
  const run = normalizeRunInput({ profileId: profile.id }, [profile], now);
  assert.equal(run.sourceStart, '2026-07-21T12:00:00.000Z');
  assert.equal(run.targetStart, '2026-07-28T12:00:00.000Z');
  assert.equal(run.sourceCutoff, null);
  assert.equal(run.speed, 1);
  assert.equal(run.durationMinutes, null);
  assert.equal(run.mode, 'rolling');
});

test('normalizes fixed loop days hours and minutes', () => {
  const now = Date.parse('2026-07-28T12:00:00.000Z');
  const [profile] = normalizeProfiles([], getReplayDevices(devices, {}));
  const run = normalizeRunInput({
    profileId: profile.id,
    mode: 'fixed-loop',
    sourceStart: '2026-07-26T00:00:00.000Z',
    loopDays: 1,
    loopHours: 2,
    loopMinutes: 30,
    speed: 10,
  }, [profile], now);
  assert.equal(run.loopDurationMs, 95400000);
  assert.equal(run.sourceCutoff, '2026-07-27T02:30:00.000Z');
  assert.equal(run.speed, 10);
});

test('requires at least one minute for a fixed loop', () => {
  const now = Date.parse('2026-07-28T12:00:00.000Z');
  const [profile] = normalizeProfiles([], getReplayDevices(devices, {}));
  assert.throws(() => normalizeRunInput({
    profileId: profile.id,
    mode: 'fixed-loop',
    sourceStart: '2026-07-26T00:00:00.000Z',
    loopDays: 0,
    loopHours: 0,
    loopMinutes: 0,
  }, [profile], now), /mellem 1 minut og 30 døgn/);
});

test('maps source timestamps using replay speed', () => {
  const run = { sourceStart: '2026-07-21T12:00:00.000Z', targetStart: '2026-07-28T12:00:00.000Z', speed: 10 };
  assert.equal(new Date(mapSourceTime('2026-07-21T12:10:00.000Z', run)).toISOString(), '2026-07-28T12:01:00.000Z');
});

test('initializes an active light before applying actual post-start events', () => {
  const run = {
    sourceStart: '2026-07-21T12:00:00.000Z',
    targetStart: '2026-07-28T12:00:00.000Z',
    speed: 1,
  };
  const selected = [{ id: 'light', name: 'Lampe', capabilities: ['light_hue', 'dim', 'onoff'] }];
  const entries = {
    'light:light_hue': [{ t: '2026-07-21T11:00:00.000Z', v: 0.2 }],
    'light:dim': [{ t: '2026-07-21T11:00:00.000Z', v: 0.5 }],
    'light:onoff': [
      { t: '2026-07-21T11:00:00.000Z', v: true },
      { t: '2026-07-21T12:03:00.000Z', v: false },
      { t: '2026-07-21T12:05:00.000Z', v: true },
      { t: '2026-07-21T12:05:01.000Z', v: true },
    ],
  };
  const actions = createReplayActions(entries, selected, run, Date.parse('2026-07-28T12:06:00.000Z'));
  assert.deepEqual(actions.map((action) => action.capability), ['light_hue', 'dim', 'onoff', 'onoff', 'onoff']);
  assert.equal(actions[4].targetTime, '2026-07-28T12:05:00.000Z');
});

test('initializes an inactive light with onoff only to avoid dim and color flashes', () => {
  const run = {
    sourceStart: '2026-07-21T12:00:00.000Z',
    targetStart: '2026-07-28T12:00:00.000Z',
    speed: 1,
  };
  const actions = createReplayActions({
    'light:light_hue': [{ t: '2026-07-21T11:00:00.000Z', v: 0.2 }],
    'light:dim': [{ t: '2026-07-21T11:00:00.000Z', v: 0.5 }],
    'light:onoff': [{ t: '2026-07-21T11:00:00.000Z', v: false }],
  }, [{ id: 'light', name: 'Lampe', capabilities: ['light_hue', 'dim', 'onoff'] }], run, Date.parse('2026-07-28T12:00:01.000Z'));
  assert.deepEqual(actions.map((action) => [action.capability, action.value]), [['onoff', false]]);
});

test('maps recorded events shortly after source start into the target queue', () => {
  const run = {
    sourceStart: '2026-07-28T09:27:00.000Z',
    targetStart: '2026-07-28T12:00:00.000Z',
    speed: 10,
  };
  const actions = createReplayActions({
    'kitchen:onoff': [
      { t: '2026-07-28T09:27:28.218Z', v: true },
      { t: '2026-07-28T09:27:29.724Z', v: false },
      { t: '2026-07-28T09:29:22.741Z', v: true },
    ],
  }, [{ id: 'kitchen', name: 'Køkken', capabilities: ['onoff'] }], run, Date.parse('2026-07-28T12:01:00.000Z'));
  assert.deepEqual(actions.map((action) => action.targetTime), [
    '2026-07-28T12:00:02.821Z',
    '2026-07-28T12:00:02.972Z',
    '2026-07-28T12:00:14.274Z',
  ]);
});

test('preserves the source event id for replay command provenance', () => {
  const run = {
    sourceStart: '2026-07-28T09:00:00.000Z',
    targetStart: '2026-07-28T12:00:00.000Z',
    speed: 1,
  };
  const actions = createReplayActions({
    'light:onoff': [{ id: 'event-42', t: '2026-07-28T09:01:00.000Z', v: true }],
  }, [{ id: 'light', name: 'Lampe', capabilities: ['onoff'] }], run, Date.parse('2026-07-28T12:02:00.000Z'));
  assert.equal(actions[0].sourceEventId, 'event-42');
});

test('preserves the originating system for route resolution', () => {
  const run = {
    sourceStart: '2026-07-28T09:00:00.000Z',
    targetStart: '2026-07-28T12:00:00.000Z',
    speed: 1,
  };
  const actions = createReplayActions({
    'light:onoff': [{ id: 'ha-event-42', sourceSystem: 'home_assistant', t: '2026-07-28T09:01:00.000Z', v: true }],
  }, [{ id: 'light', name: 'Lampe', sourceSystem: 'home_assistant', capabilities: ['onoff'] }], run, Date.parse('2026-07-28T12:02:00.000Z'));
  assert.equal(actions[0].sourceSystem, 'home_assistant');
});

test('does not recreate actions at or before a persisted capability cursor', () => {
  const run = {
    sourceStart: '2026-07-21T12:00:00.000Z',
    targetStart: '2026-07-28T12:00:00.000Z',
    speed: 1,
    cursors: { 'light:onoff': '2026-07-21T12:05:00.000Z' },
  };
  const actions = createReplayActions({
    'light:onoff': [
      { t: '2026-07-21T11:00:00.000Z', v: false },
      { t: '2026-07-21T12:05:00.000Z', v: true },
      { t: '2026-07-21T12:06:00.000Z', v: false },
    ],
  }, [{ id: 'light', name: 'Lampe', capabilities: ['onoff'] }], run, Date.parse('2026-07-28T12:07:00.000Z'));
  assert.deepEqual(actions.map((action) => action.sourceTime), ['2026-07-21T12:06:00.000Z']);
});

test('keeps future actions queued until their mapped target timestamp', () => {
  const actions = [
    { key: 'due', targetTime: '2026-07-28T12:00:00.000Z' },
    { key: 'future', targetTime: '2026-07-28T12:00:01.000Z' },
  ];
  const result = partitionReplayActions(actions, Date.parse('2026-07-28T12:00:00.500Z'));
  assert.deepEqual(result.due.map((action) => action.key), ['due']);
  assert.deepEqual(result.queued.map((action) => action.key), ['future']);
});

test('continues queued actions after one device action fails', async () => {
  const attempted = [];
  const results = await executeReplayActions([{ key: 'offline' }, { key: 'available' }], async (action) => {
    attempted.push(action.key);
    if (action.key === 'offline') throw new Error('Enheden er ikke tilgængelig');
  });
  assert.deepEqual(attempted, ['offline', 'available']);
  assert.deepEqual(results.map((result) => result.applied), [false, true]);
});

test('paces Homey writes between queued actions', async () => {
  const delays = [];
  await executeReplayActions([{ key: 'one' }, { key: 'two' }, { key: 'three' }], async () => {}, {
    delayMs: 300,
    sleep: async (milliseconds) => delays.push(milliseconds),
  });
  assert.deepEqual(delays, [300, 300]);
});

test('stops an in-flight action batch when replay is cancelled', async () => {
  const attempted = [];
  let running = true;
  await executeReplayActions([{ key: 'one' }, { key: 'two' }, { key: 'three' }], async (action) => {
    attempted.push(action.key);
    running = false;
  }, { shouldContinue: () => running });
  assert.deepEqual(attempted, ['one']);
});

test('does not ingest events created after the replay run started', () => {
  const run = {
    sourceStart: '2026-07-28T09:26:00.000Z',
    targetStart: '2026-07-28T09:43:25.000Z',
    sourceCutoff: '2026-07-28T09:43:25.000Z',
    loopDurationMs: 1045000,
    speed: 10,
  };
  const actions = createReplayActions({
    'light:onoff': [
      { t: '2026-07-28T09:29:20.000Z', v: true },
      { t: '2026-07-28T09:31:12.000Z', v: false },
      { t: '2026-07-28T09:43:26.000Z', v: true },
    ],
  }, [{ id: 'light', name: 'Lampe', capabilities: ['onoff'] }], run, Date.parse('2026-07-28T10:00:00.000Z'));
  assert.deepEqual(actions.map((action) => action.sourceTime), [
    '2026-07-28T09:29:20.000Z',
    '2026-07-28T09:31:12.000Z',
  ]);
});

test('repeats a fixed loop at the configured accelerated interval', () => {
  const run = {
    mode: 'fixed-loop',
    sourceStart: '2026-07-28T09:00:00.000Z',
    sourceCutoff: '2026-07-28T09:10:00.000Z',
    targetStart: '2026-07-28T12:00:00.000Z',
    loopDurationMs: 10 * 60 * 1000,
    speed: 10,
    cursors: {},
  };
  const actions = createFixedLoopActions({
    'light:onoff': [
      { t: '2026-07-28T08:59:00.000Z', v: false },
      { t: '2026-07-28T09:05:00.000Z', v: true },
    ],
  }, [{ id: 'light', name: 'Lampe', capabilities: ['onoff'] }], run, Date.parse('2026-07-28T12:01:31.000Z'));
  assert.deepEqual(actions.filter((action) => action.value === true).map((action) => action.targetTime), [
    '2026-07-28T12:00:30.000Z',
    '2026-07-28T12:01:30.000Z',
  ]);
});

test('reports how far source time replay has reached', () => {
  const run = {
    sourceStart: '2026-07-21T12:00:00.000Z',
    targetStart: '2026-07-28T12:00:00.000Z',
    speed: 10,
  };
  assert.equal(getReplayTime(run, Date.parse('2026-07-28T12:01:00.000Z')), '2026-07-21T12:10:00.000Z');
});
