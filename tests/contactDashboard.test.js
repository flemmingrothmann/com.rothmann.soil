'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

process.env.WINGMAN_URL = 'http://wingman.test';
const { getActiveSince, getContactDashboard } = require('../dashboard/server');

const times = [0, 1, 2, 3].map((minute) => `2026-11-16T10:0${minute}:00.000Z`);
const entries = (values) => values.map((v, index) => ({ t: times[index], v }));

test('open since is the start of the latest uninterrupted true run, not the last report', () => {
  assert.equal(getActiveSince(entries([false, true, true, true]).reverse()), Date.parse(times[1]));
  assert.equal(getActiveSince(entries([true, false, true, true])), Date.parse(times[2]));
  assert.equal(getActiveSince(entries([true, true])), Date.parse(times[0]));
  assert.equal(getActiveSince(entries([true, false])), null);
  assert.equal(getActiveSince([]), null);
  assert.equal(getActiveSince([{ t: 'invalid', v: true }]), null);
});

test('unknown observations break continuity without being interpreted as closed', () => {
  assert.equal(getActiveSince(entries([true, null])), null);
  assert.equal(getActiveSince(entries([true, null, true, true])), Date.parse(times[2]));
  assert.equal(getActiveSince(entries([true, 'true'])), null);
});

function contact(id, value, available = true) {
  return {
    id,
    name: id,
    available,
    capabilities: ['alarm_contact'],
    capabilitiesObj: { alarm_contact: { value } },
  };
}

test('dashboard follows inventory removal despite retained open history and distinguishes offline/unknown', async () => {
  const originalFetch = global.fetch;
  const devices = {
    open: contact('open', true),
    closed: contact('closed', false),
    offline: contact('offline', true, false),
    unknown: contact('unknown', null),
  };
  const history = entries([false, true, true, true]);
  const requestedHistories = [];
  global.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/homey/snapshot') return Response.json({ devices, zones: {} });
    assert.equal(parsed.pathname, '/api/events');
    requestedHistories.push(parsed.searchParams.get('deviceId'));
    return Response.json({ values: history });
  };
  try {
    const before = await getContactDashboard();
    assert.equal(before.totals.active, 1);
    assert.equal(before.totals.errors, 2);
    const sensors = before.zones.flatMap((zone) => zone.sensors);
    assert.equal(sensors.find((sensor) => sensor.id === 'open').openSince, times[1]);
    for (const id of ['offline', 'unknown']) {
      const sensor = sensors.find((item) => item.id === id);
      assert.equal(sensor.open, null);
      assert.equal(sensor.openSince, null);
      assert.equal(sensor.openDurationMs, null);
      assert.ok(sensor.error);
    }
    delete devices.open;
    const after = await getContactDashboard();
    assert.equal(after.totals.active, 0);
    assert.equal(after.totals.sensors, 3);
    assert.ok(after.zones.flatMap((zone) => zone.sensors).every((sensor) => sensor.id !== 'open'));
    assert.deepEqual(requestedHistories, ['open']);
    assert.equal(history.length, 4, 'removal does not modify retained observations');
  } finally {
    global.fetch = originalFetch;
  }
});

test('contact UI never presents unknown/offline as open or all closed', () => {
  const source = fs.readFileSync(require.resolve('../dashboard/public/app.js'), 'utf8');
  const start = source.indexOf('function renderContactSensor(');
  const end = source.indexOf('function renderActiveDevice(', start);
  const elements = new Map();
  const context = {
    document: {
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, {});
        return elements.get(id);
      },
    },
    escapeHtml: String,
    formatContactDuration: () => '10 min',
    formatZonePath: () => 'Hjem',
    renderSignalIndicator: () => '',
    formatTime: String,
    formatValue: String,
    setActiveTab() {},
    setDashboardTitle() {},
    setSummaryThirdCardVisible() {},
    setSummaryLabels() {},
    setUpdatedAt() {},
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const sensor = {
    name: 'Offline vindue', open: null, available: false, error: 'Utilgængelig',
  };
  const html = context.renderContactSensor(sensor);
  assert.match(html, /Ukendt/);
  assert.doesNotMatch(html, /Åben|åben|10 min/);
  context.renderContactDashboard({ totals: { sensors: 1, active: 0, errors: 1 }, zones: [{ sensors: [sensor] }] });
  assert.match(elements.get('content').innerHTML, /Ukendt/);
  assert.doesNotMatch(elements.get('content').innerHTML, /Ingen åbne/);
});

test('Wingman snapshot does not resurrect a deleted Homey contact from retained current state', async () => {
  const source = fs.readFileSync(require.resolve('../ingest-service/server.js'), 'utf8');
  const start = source.indexOf('async function getHomeySnapshot(');
  const end = source.indexOf('async function getEvents(', start);
  let snapshot;
  const context = {
    pool: {
      query: async (sql) => ({
        rows: sql.includes('from state_current') ? [{
          homey_device_id: 'deleted-open-window', capability: 'alarm_contact', value_json: true,
        }] : [],
      }),
    },
    sendJson: (_response, status, body) => {
      assert.equal(status, 200); snapshot = body;
    },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  await context.getHomeySnapshot({});
  assert.deepEqual(Object.keys(snapshot.devices), []);
});
