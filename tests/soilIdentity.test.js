'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ZigbeeIdentityRoutes, cachedStateByIeee, profileMatchesDevice, resolveHaDeviceId, observeProfileTopics } = require('../soil-controller/zigbeeIdentity');
const { buildHaDeviceSnapshot, loadHaDeviceSnapshot, persistHaDeviceSnapshot } = require('../soil-controller/haDeviceRegistry');

const citron = '0xa4c138f35b60c6a1';
const other = '0xa4c1389229cda157';
const inventory = (name = 'Citrontræ') => [{ ieee_address: citron, friendly_name: name }];
const profiles = { [citron]: { name: 'Citrontræ', zigbeeTopic: 'Terrasse Vægpotte', alarmTopic: 'homeassistant/soil/original/alarm' } };

test('HA device mapping uses persisted exact MQTT IEEE mappings and fails closed', () => {
  const profile = { haDeviceId: 'stale' };
  const devices = [
    { id: 'current', identifiers: [['mqtt', `zigbee2mqtt_${citron}`]] },
    { id: 'mixed-case', identifiers: [['mqtt', `ZIGBEE2MQTT_${citron.toUpperCase()}`]] },
  ];
  assert.equal(buildHaDeviceSnapshot([devices[0]], [citron]).devices[citron], 'current');
  assert.equal(buildHaDeviceSnapshot([devices[1]], [citron]).devices[citron], 'mixed-case');
  assert.equal(buildHaDeviceSnapshot([devices[0], { ...devices[0], id: 'duplicate' }], [citron]).devices[citron], null);
  assert.equal(resolveHaDeviceId(profile, citron, { devices: { [citron]: null } }), null);
  assert.equal(resolveHaDeviceId(profile, citron, null), undefined);
  assert.equal(resolveHaDeviceId({ type: 'watering_valve', haDeviceId: 'valve' }, citron, { devices: { [citron]: 'current' } }), undefined);
});

test('HA registry snapshot persists explicit null across restart without resurrecting profile id', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soil-ha-registry-'));
  const file = path.join(directory, 'registry.json');
  try {
    const firstProcessSnapshot = buildHaDeviceSnapshot([], [citron], '2026-11-21T10:00:00.000Z');
    persistHaDeviceSnapshot(file, firstProcessSnapshot);
    const restartedSnapshot = loadHaDeviceSnapshot(file);
    assert.equal(restartedSnapshot.devices[citron], null);
    assert.equal(resolveHaDeviceId({ haDeviceId: 'stale' }, citron, restartedSnapshot), null);
    assert.equal(restartedSnapshot.syncedAt, firstProcessSnapshot.syncedAt);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('corrupt persisted HA registry snapshot fails visibly instead of becoming empty', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soil-ha-registry-corrupt-'));
  const file = path.join(directory, 'registry.json');
  try {
    fs.writeFileSync(file, '{"version":1,"devices":{}');
    assert.throws(() => loadHaDeviceSnapshot(file), /JSON|persisted Home Assistant/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('sensor history identity follows IEEE, not its current or previous display name', () => {
  const routes = new ZigbeeIdentityRoutes(inventory());
  assert.equal(routes.resolve('zigbee2mqtt/Citrontræ', profiles)[0], citron);
  assert.equal(routes.resolve(`zigbee2mqtt/${citron}`, profiles)[0], citron);
  assert.equal(routes.resolve('zigbee2mqtt/Terrasse Vægpotte', profiles), null);
  routes.replace(inventory('Ny potte / Atelier'));
  assert.equal(routes.resolve('zigbee2mqtt/Ny potte / Atelier', profiles)[0], citron);
  assert.equal(routes.resolve('zigbee2mqtt/Citrontræ', profiles), null);
  assert.equal(profiles[citron].zigbeeTopic, 'Terrasse Vægpotte');
});

test('a reused visual name never adopts another physical sensor or its history', () => {
  const routes = new ZigbeeIdentityRoutes([...inventory('Ny potte'), { ieee_address: other, friendly_name: 'Citrontræ' }]);
  assert.equal(routes.resolve('zigbee2mqtt/Citrontræ', profiles), null);
  const both = { ...profiles, [other]: { name: 'Anden sensor' } };
  assert.equal(routes.resolve('zigbee2mqtt/Citrontræ', both)[0], other);
  assert.equal(routes.resolve('zigbee2mqtt/Ny potte', both)[0], citron);
});

test('duplicate names and names colliding with another IEEE alias fail closed', () => {
  const routes = new ZigbeeIdentityRoutes([...inventory(), { ieee_address: other, friendly_name: 'Citrontræ' }]);
  assert.equal(routes.resolve('zigbee2mqtt/Citrontræ', profiles), null);
  routes.replace([...inventory(other), { ieee_address: other, friendly_name: 'Anden sensor' }]);
  assert.equal(routes.resolve(`zigbee2mqtt/${other}`, profiles), null);
});

test('removed devices, commands, bridge messages and unconfigured sensors are not observations', () => {
  const routes = new ZigbeeIdentityRoutes(inventory());
  for (const topic of ['zigbee2mqtt/Citrontræ/set', 'zigbee2mqtt/Citrontræ/get', 'zigbee2mqtt/bridge/state', 'zigbee2mqtt/Unknown'])
    assert.equal(routes.resolve(topic, profiles), null);
  routes.replace([]);
  assert.equal(routes.resolve('zigbee2mqtt/Citrontræ', profiles), null);
});

test('invalid inventory cannot silently replace an existing identity map', () => {
  const routes = new ZigbeeIdentityRoutes(inventory());
  for (const input of [{}, [...inventory(), ...inventory()], inventory('Bad/#')]) assert.throws(() => routes.replace(input));
  assert.equal(routes.resolve('zigbee2mqtt/Citrontræ', profiles)[0], citron);
});

test('persisted routing round-trips without any dependency on HA names or availability', () => {
  const routes = new ZigbeeIdentityRoutes(inventory('Ny potte'));
  const restored = new ZigbeeIdentityRoutes(JSON.parse(JSON.stringify(routes.snapshot())));
  assert.equal(restored.resolve('zigbee2mqtt/Ny potte', profiles)[0], citron);
});

test('IEEE matching preserves existing profile ids and refuses ambiguous normalized keys', () => {
  const routes = new ZigbeeIdentityRoutes(inventory());
  const upper = citron.toUpperCase().replace('0X', '0x');
  assert.equal(routes.resolve('zigbee2mqtt/Citrontræ', { [upper]: profiles[citron] })[0], upper);
  assert.throws(() => routes.resolve('zigbee2mqtt/Citrontræ', { ...profiles, [upper]: profiles[citron] }), /Ambiguous/);
});

test('cached state is matched only by IEEE, never a reused old pot name', () => {
  const own = { soil_moisture: 72 };
  const wrong = { soil_moisture: 5 };
  assert.equal(cachedStateByIeee({ [citron]: own, 'Terrasse Vægpotte': wrong }, citron), own);
  assert.equal(cachedStateByIeee({ 'Terrasse Vægpotte': wrong, 'Citrontræ': wrong }, citron), null);
});

test('watering profile matching uses IEEE before registry ids and never display names', () => {
  const profile = { haDeviceId: 'old-registry', zigbeeTopic: 'Citrontræ' };
  assert.equal(profileMatchesDevice(citron, profile, { device_id: 'new-registry', device_keys: [`zigbee2mqtt_${citron}`] }), true);
  assert.equal(profileMatchesDevice(citron, profile, { device_id: 'old-registry', device_keys: [`zigbee2mqtt_${other}`] }), false);
  assert.equal(profileMatchesDevice(citron, profile, { name: 'Citrontræ', device_keys: [] }), false);
  assert.equal(profileMatchesDevice(citron, profile, { device_id: 'old-registry', device_keys: [] }), true);
});

function subscriber(routes) {
  const client = new EventEmitter();
  const subscriptions = [];
  const observations = [];
  const alarms = [];
  const errors = [];
  const saved = [];
  client.subscribe = (topic) => subscriptions.push(topic);
  const activeProfiles = structuredClone(profiles);
  observeProfileTopics(client, { profiles: activeProfiles, routes,
    onInventory: (devices) => saved.push(devices),
    onObservation: (id, profile, payload) => observations.push({ id, profile, payload: JSON.parse(payload.toString()) }),
    onAlarm: (id) => alarms.push(id), onError: (error) => errors.push(error) });
  const send = (topic, payload) => client.emit('message', topic, Buffer.from(JSON.stringify(payload)));
  return { client, subscriptions, observations, alarms, errors, saved, activeProfiles, send };
}

test('actual MQTT subscription follows renames without restart and preserves alarm ownership', () => {
  const s = subscriber();
  s.client.emit('connect');
  s.send('zigbee2mqtt/bridge/devices', inventory());
  s.send('zigbee2mqtt/Citrontræ', { soil_moisture: 72 });
  s.send('zigbee2mqtt/bridge/devices', inventory('Ny potte'));
  s.send('zigbee2mqtt/Ny potte', { soil_moisture: 73 });
  s.send('zigbee2mqtt/Citrontræ', { soil_moisture: 2 });
  s.client.emit('message', 'zigbee2mqtt/Ny potte', Buffer.alloc(0));
  s.client.emit('message', profiles[citron].alarmTopic, Buffer.alloc(0));
  s.client.emit('message', profiles[citron].alarmTopic, Buffer.from('on'));
  assert.deepEqual(s.observations.map((entry) => [entry.id, entry.payload.soil_moisture]), [[citron, 72], [citron, 73]]);
  assert.deepEqual(s.alarms, [citron]);
  assert.equal(s.subscriptions.filter((topic) => topic === 'zigbee2mqtt/#').length, 1);
  assert.deepEqual(s.errors, []);
});

test('reconnection requires fresh inventory before using even a persisted name mapping', () => {
  const s = subscriber(new ZigbeeIdentityRoutes(inventory()));
  s.client.emit('connect');
  s.send('zigbee2mqtt/Citrontræ', { soil_moisture: 1 });
  assert.equal(s.observations.length, 0);
  s.send('zigbee2mqtt/bridge/devices', inventory());
  s.send('zigbee2mqtt/Citrontræ', { soil_moisture: 72 });
  s.client.emit('close');
  s.client.emit('connect');
  s.send('zigbee2mqtt/Citrontræ', { soil_moisture: 2 });
  s.send('zigbee2mqtt/bridge/devices', [{ ieee_address: other, friendly_name: 'Citrontræ' }]);
  s.send('zigbee2mqtt/Citrontræ', { soil_moisture: 3 });
  assert.equal(s.observations.length, 1);
});

test('unchanged inventory does not rewrite cache; invalid inventory blocks stale routing', () => {
  const s = subscriber();
  s.client.emit('connect');
  s.send('zigbee2mqtt/bridge/devices', inventory());
  s.send('zigbee2mqtt/bridge/devices', inventory());
  assert.equal(s.saved.length, 1);
  s.send('zigbee2mqtt/bridge/devices', {});
  s.send('zigbee2mqtt/Citrontræ', { soil_moisture: 1 });
  assert.equal(s.observations.length, 0);
  assert.equal(s.errors.length, 1);
});

test('new soil profiles use existing wildcard subscription without reconnecting', () => {
  const s = subscriber();
  s.client.emit('connect');
  s.send('zigbee2mqtt/bridge/devices', [...inventory(), { ieee_address: other, friendly_name: 'Ny sensor' }]);
  s.activeProfiles[other] = { name: 'Ny sensor', alarmTopic: 'homeassistant/soil/new/alarm' };
  s.send('zigbee2mqtt/Ny sensor', { soil_moisture: 50 });
  s.client.emit('message', s.activeProfiles[other].alarmTopic, Buffer.from('off'));
  assert.equal(s.observations[0].id, other);
  assert.deepEqual(s.alarms, [other]);
});

test('HA software control topics remain separate from physical observations and watering alarm topics', () => {
  const client = new EventEmitter();
  client.subscribe = () => {};
  const physical = [];
  const control = [];
  const errors = [];
  const configured = { [citron]: { controlTopic: `homeassistant/soil/${citron}/control` } };
  observeProfileTopics(client, { profiles: configured, onInventory: () => {}, onObservation: (id) => physical.push(id),
    onAlarm: () => assert.fail('not a legacy alarm'), onControl: (id, profile, payload) => control.push([id, JSON.parse(payload)]), onError: (error) => errors.push(error) });
  client.emit('message', configured[citron].controlTopic, Buffer.from('{"threshold":25,"alarm":false}'));
  assert.equal(control.length, 1);
  assert.equal(control[0][0], citron);
  assert.equal(physical.length, 0);
  assert.deepEqual(errors, []);
});
