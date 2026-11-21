'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'homey-wingman-app/lib/homeyWingmanBridge.js'), 'utf8');

function loadBridge(fetchImpl = async () => ({ ok: true, json: async () => ({}) })) {
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    require(id) {
      if (id === 'homey-api') return { HomeyAPI: { createAppAPI: async () => ({}) } };
      if (id === 'fs') return fs;
      if (id === 'path') return path;
      throw new Error(`Unexpected dependency: ${id}`);
    },
    __dirname: path.join(__dirname, '..', 'homey-wingman-app', 'lib'),
    process,
    Buffer,
    Date,
    Map,
    Object,
    JSON,
    Number,
    String,
    Math,
    AbortController,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(source, sandbox, { filename: 'homeyWingmanBridge.js' });
  return module.exports.HomeyWingmanBridge;
}

function createHomey() {
  const intervals = [];
  return {
    id: 'synthetic-homey',
    settings: {
      get(key) {
        return {
          wingman_ingest_url: 'http://example.test/api/ingest/homey',
          wingman_ingest_token: 'synthetic',
          wingman_sync_url: 'http://example.test/api/sync/homey',
          wingman_sync_flows: 'false',
          wingman_sync_timers: 'false',
        }[key];
      },
      set() {},
    },
    setTimeout,
    setInterval(callback, interval) {
      intervals.push({ callback, interval });
      return intervals.length;
    },
    intervals,
  };
}

test('initial snapshot failure is contained and periodic snapshot retries', async () => {
  const Bridge = loadBridge();
  const homey = createHomey();
  const errors = [];
  const bridge = new Bridge(homey, () => {}, (message) => errors.push(message));
  let attempts = 0;
  bridge.syncHomeySnapshot = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary inventory failure');
  };
  bridge.subscribeDeviceCapabilities = async () => {};
  bridge.flushQueue = async () => {};

  await bridge.start();
  assert.equal(homey.intervals.length, 1);
  assert.match(errors[0], /initial snapshot sync failed/);
  await homey.intervals[0].callback();
  assert.equal(attempts, 2);
});

test('one capability subscription failure does not prevent remaining subscriptions', async () => {
  const Bridge = loadBridge();
  const homey = createHomey();
  const errors = [];
  const bridge = new Bridge(homey, () => {}, (message) => errors.push(message));
  const subscribed = [];
  bridge.homeyApi = {
    devices: {
      getDevices: async () => ({
        bad: {
          id: 'bad',
          name: 'Bad device',
          capabilities: ['onoff'],
          capabilitiesObj: { onoff: { value: false } },
          makeCapabilityInstance() {
            throw new Error('unsupported capability');
          },
        },
        good: {
          id: 'good',
          name: 'Good device',
          capabilities: ['onoff'],
          capabilitiesObj: { onoff: { value: true } },
          makeCapabilityInstance(capability) {
            subscribed.push(capability); return {};
          },
        },
      }),
    },
  };

  await bridge.subscribeDeviceCapabilities();
  assert.deepEqual(subscribed, ['onoff']);
  assert.equal(bridge.capabilityInstances.length, 1);
  assert.match(errors[0], /capability subscription skipped/);
});

test('failed required inventory reads never post an empty or partial snapshot', async () => {
  let posts = 0;
  const Bridge = loadBridge(async () => {
    posts += 1; return { ok: true, json: async () => ({}) };
  });
  const bridge = new Bridge(createHomey(), () => {}, () => {});
  bridge.homeyApi = {
    devices: {
      getDevices: async () => {
        throw new Error('devices unavailable');
      },
    },
    zones: { getZones: async () => ({}) },
    flow: {},
    logic: { getVariables: async () => ({}) },
  };

  await assert.rejects(bridge.syncHomeySnapshot(), /devices unavailable/);
  assert.equal(posts, 0);
});

test('empty Homey device inventory does not post a destructive snapshot', async () => {
  let posts = 0;
  const Bridge = loadBridge(async () => {
    posts += 1; return { ok: true, json: async () => ({}) };
  });
  const bridge = new Bridge(createHomey(), () => {}, () => {});
  bridge.homeyApi = {
    devices: { getDevices: async () => ({}) },
    zones: { getZones: async () => ({}) },
    flow: {},
    logic: { getVariables: async () => ({}) },
  };

  await assert.rejects(bridge.syncHomeySnapshot(), /device inventory must not be empty/);
  assert.equal(posts, 0);
});

test('inventory containing only Home Assistant proxy devices does not post', async () => {
  let posts = 0;
  const Bridge = loadBridge(async () => {
    posts += 1; return { ok: true, json: async () => ({}) };
  });
  const bridge = new Bridge(createHomey(), () => {}, () => {});
  bridge.homeyApi = {
    devices: {
      getDevices: async () => ({
        proxy: {
          id: 'proxy',
          name: 'HA proxy device',
          driverId: 'homey:app:io.home-assistant.community:light',
        },
      }),
    },
    zones: { getZones: async () => ({ living: { id: 'living' } }) },
    flow: {},
    logic: { getVariables: async () => ({}) },
  };

  await assert.rejects(bridge.syncHomeySnapshot(), /tracked device inventory must not be empty/);
  assert.equal(posts, 0);
});

test('null or undefined device inventory is rejected without a request', async (t) => {
  for (const devices of [null, undefined]) {
    await t.test(`devices=${String(devices)}`, async () => {
      let requests = 0;
      const Bridge = loadBridge(async () => {
        requests += 1;
        return { ok: true, json: async () => ({}) };
      });
      const bridge = new Bridge(createHomey(), () => {}, () => {});
      bridge.homeyApi = {
        devices: { getDevices: async () => devices },
        zones: { getZones: async () => ({ living: { id: 'living' } }) },
        flow: {},
        logic: { getVariables: async () => ({}) },
      };

      await assert.rejects(bridge.syncHomeySnapshot());
      assert.equal(requests, 0);
    });
  }
});

test('complete inventory posts one full snapshot to the Homey sync endpoint only', async () => {
  const expectedDevices = {
    deviceA: {
      id: 'deviceA', name: 'Synthetic light', driverId: 'test:light', capabilities: ['onoff'],
    },
    deviceB: {
      id: 'deviceB', name: 'Synthetic sensor', driverId: 'test:sensor', capabilities: ['measure_temperature'],
    },
  };
  const expectedZones = { living: { id: 'living', name: 'Living room' } };
  const requests = [];
  const Bridge = loadBridge(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ devices: 2, zones: 1 }) };
  });
  const bridge = new Bridge(createHomey(), () => {}, () => {});
  bridge.homeyApi = {
    devices: { getDevices: async () => expectedDevices },
    zones: { getZones: async () => expectedZones },
    flow: {},
    logic: { getVariables: async () => ({ humidity: { value: 45 } }) },
  };

  await bridge.syncHomeySnapshot();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://example.test/api/sync/homey');
  assert.equal(requests[0].options.method, 'POST');
  const payload = JSON.parse(requests[0].options.body);
  assert.deepEqual(payload.devices, expectedDevices);
  assert.deepEqual(payload.zones, expectedZones);
  assert.equal(typeof payload.syncedAt, 'string');
  assert.deepEqual(Object.keys(payload).sort(), [
    'advancedFlows', 'devices', 'flows', 'logicVariables', 'syncedAt', 'timers', 'zones',
  ]);
  assert.equal('event_type' in payload, false);
  assert.equal('command' in payload, false);
  assert.equal(requests.every(({ url, options }) => url.endsWith('/api/sync/homey') && options.method === 'POST'), true);
});
