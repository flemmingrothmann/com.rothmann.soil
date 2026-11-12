'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { candidates, softwareControlEvents, SoilProvisioner } = require('../soil-controller/soilProvisioning');
const { canSetSoilAlarmThreshold } = require('../dashboard/server');
const ieee = '0xffffb40e0605b225';
const sensorId = `sensor.${ieee}_soil_moisture`;
const inventory = [{ ieee_address: ieee, friendly_name: 'MQTT name', definition: { vendor: 'Third Reality', model: '3RSM0147Z', exposes: [
  { property: 'soil_moisture', access: 1 }, { property: 'temperature', access: 1 }, { property: 'battery', access: 1 },
] } }];

function fixture({ legacy, disabled = false, existingCooldown = false } = {}) {
  const profiles = {};
  const devices = [{ id: 'ha-device', name: 'Chilli', area_id: 'drivhus', identifiers: [['mqtt', `zigbee2mqtt_${ieee}`]] }];
  const entities = [{ entity_id: sensorId, device_id: 'ha-device', platform: 'mqtt', unique_id: `${ieee}_soil_moisture_zigbee2mqtt` }];
  const states = new Map([[sensorId, { entity_id: sensorId, state: '36.4' }]]);
  const areas = [{ area_id: 'drivhus', name: 'Drivhus inde' }];
  const automations = legacy ? [structuredClone(legacy)] : [];
  if (legacy) states.set('automation.original', { entity_id: 'automation.original', state: disabled ? 'off' : 'on', attributes: { id: legacy.id } });
  const oldKey = sensorId.replaceAll('.', '_');
  const cooldown = `input_datetime.manual_soil_alarm_${oldKey}_last_push`;
  if (existingCooldown) states.set(cooldown, { entity_id: cooldown, state: '2026-11-12 09:00:00' });
  const calls = [];
  const errors = [];
  const events = [];
  const definitions = { input_number: [], input_boolean: [], input_datetime: [] };
  const ws = async (type, fields = {}) => {
    calls.push({ type, fields });
    if (type === 'config/device_registry/list') return structuredClone(devices);
    if (type === 'config/entity_registry/list') return structuredClone(entities);
    if (type === 'config/area_registry/list') return structuredClone(areas);
    if (type === 'persistent_notification/get') return [];
    const [domain, action] = type.split('/');
    if (action === 'list') return definitions[domain];
    if (action === 'create') {
      const id = fields.name;
      definitions[domain].push({ id });
      const entity_id = `${domain}.${id}`;
      entities.push({ entity_id, platform: domain, unique_id: id });
      states.set(entity_id, { entity_id, state: domain === 'input_boolean' ? 'off' : '0' });
      return { id };
    }
    if (action === 'update') {
      if (domain === 'input_number') assert.ok(Number.isFinite(fields.min) && Number.isFinite(fields.max));
      if (domain === 'input_datetime') assert.ok(fields.has_date || fields.has_time);
      return fields;
    }
    throw new Error(`Unexpected WS ${type}`);
  };
  const request = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
    if (path === '/api/states') return structuredClone([...states.values()]);
    if (path.startsWith('/api/states/')) return structuredClone(states.get(path.slice('/api/states/'.length)));
    if (path.startsWith('/api/config/automation/config/')) {
      const config = JSON.parse(options.body);
      const index = automations.findIndex((item) => item.id === config.id);
      if (index < 0) automations.push(config); else automations[index] = config;
      if (!legacy) states.set('automation.new', { entity_id: 'automation.new', state: 'on', attributes: { id: config.id } });
      return { result: 'ok' };
    }
    if (path.startsWith('/api/services/')) {
      const [, , , domain, action] = path.split('/');
      const body = JSON.parse(options.body);
      if (domain === 'automation') {
        if (action === 'turn_off') states.get(body.entity_id).state = 'off';
        return [];
      }
      const state = states.get(body.entity_id);
      if (!state) throw new Error(`Missing ${body.entity_id}`);
      if (action === 'set_value') state.state = String(body.value);
      else if (action === 'set_datetime') state.state = body.datetime;
      else if (action === 'turn_on') state.state = 'on';
      return [];
    }
    throw new Error(`Unexpected REST ${path}`);
  };
  const provisioner = new SoilProvisioner({ profiles, ws, request, readAutomations: () => structuredClone(automations), persist: () => {}, onChanged: async () => {},
    onControl: async (id, profile, payload) => {
      const result = softwareControlEvents(profile, id, payload);
      events.push(...result.events);
      profile.controlState = result.state;
      profile.threshold = result.state.threshold;
    }, log: (message) => errors.push(message) });
  return { profiles, devices, entities, states, areas, automations, calls, errors, events, definitions, provisioner, cooldown };
}

test('future soil sensors are discovered by capability and IEEE without model-specific alarm support', () => {
  const f = fixture();
  assert.equal(candidates(inventory, f.devices, f.entities, f.profiles).length, 1);
  const otherVendor = structuredClone(inventory);
  otherVendor[0].definition.vendor = 'Future vendor';
  otherVendor[0].definition.model = 'Soil-only sensor';
  assert.equal(candidates(otherVendor, f.devices, f.entities, {}).length, 1);
  assert.equal(candidates([{ ...inventory[0], definition: { exposes: [] } }], f.devices, f.entities, {}).length, 0);
});

test('explicit watering profiles and ignored sensors are never automatically taken over', () => {
  const f = fixture();
  assert.equal(candidates(inventory, f.devices, f.entities, { [ieee]: { wateringCircuit: 'existing' } }).length, 0);
  f.devices[0].labels = ['wingman_ignore'];
  assert.equal(candidates(inventory, f.devices, f.entities, {}).length, 0);
});

test('a new sensor gets UI helpers, 25% software threshold, one automation and independent cooldown', async () => {
  const f = fixture();
  await f.provisioner.reconcile(inventory);
  assert.deepEqual(f.errors, []);
  const profile = f.profiles[ieee];
  assert.equal(profile.threshold, 25);
  assert.equal(profile.zoneName, 'Drivhus inde');
  assert.equal(profile.driverId, 'zigbee2mqtt:Third Reality:3RSM0147Z');
  assert.equal(profile.autoManual, true);
  assert.ok(profile.capabilities.includes('soil_warning_threshold'));
  assert.ok(profile.capabilities.includes('alarm_water'));
  assert.equal(f.automations.length, 1);
  assert.equal(f.definitions.input_number.length, 1);
  assert.equal(f.definitions.input_boolean.length, 1);
  assert.equal(f.definitions.input_datetime.length, 1);
  assert.ok(f.events.every((event) => event.source_system === 'home_assistant'));
  assert.ok(!f.calls.some((call) => /switch|valve|zigbee2mqtt.*set/.test(call.path || '')));
});

test('reconciliation is idempotent and never resets a user threshold, including zero', async () => {
  const f = fixture();
  await f.provisioner.reconcile(inventory);
  const count = f.calls.filter((call) => call.type?.endsWith('/create') || call.path?.startsWith('/api/config/automation/config/')).length;
  f.states.get(f.profiles[ieee].haThresholdEntity).state = '0';
  await f.provisioner.reconcile(inventory);
  assert.deepEqual(f.errors, []);
  assert.equal(f.profiles[ieee].threshold, 0);
  assert.equal(f.calls.filter((call) => call.type?.endsWith('/create') || call.path?.startsWith('/api/config/automation/config/')).length, count);
});

test('existing manual automation is extended, not duplicated; threshold and cooldown are preserved', async () => {
  const legacy = { id: 'original', alias: 'My custom title', use_blueprint: { path: 'wingman/manual-soil-moisture-alarm.yaml', input: { moisture_sensor: sensorId, plant_name: 'My plant', threshold: 32 } } };
  const f = fixture({ legacy, existingCooldown: true });
  await f.provisioner.reconcile(inventory);
  assert.deepEqual(f.errors, []);
  assert.equal(f.automations.length, 1);
  assert.equal(f.automations[0].id, 'original');
  assert.equal(f.automations[0].alias, 'My custom title');
  assert.equal(f.automations[0].use_blueprint.input.plant_name, 'My plant');
  assert.equal(f.profiles[ieee].threshold, 32);
  assert.equal(f.states.get(f.cooldown).state, '2026-11-12 09:00:00');
  assert.ok(!f.calls.some((call) => call.body?.entity_id === f.cooldown));
});

test('disabled existing manual alarms remain disabled after adding the helper binding', async () => {
  const f = fixture({ legacy: { id: 'original', use_blueprint: { path: 'wingman/manual-soil-moisture-alarm.yaml', input: { moisture_sensor: sensorId } } }, disabled: true });
  await f.provisioner.reconcile(inventory);
  assert.deepEqual(f.errors, []);
  assert.equal(f.states.get('automation.original').state, 'off');
  assert.ok(!f.calls.some((call) => call.path === '/api/services/automation/trigger'));
});

test('visual moves and sensor entity renames preserve controls, notification key and history identity', async () => {
  const f = fixture();
  await f.provisioner.reconcile(inventory);
  const before = structuredClone(f.profiles[ieee]);
  f.devices[0].name_by_user = 'New pot';
  f.devices[0].area_id = null;
  const sensor = f.entities.find((entity) => entity.entity_id === sensorId);
  sensor.entity_id = 'sensor.new_pot_moisture';
  await f.provisioner.reconcile(inventory);
  assert.deepEqual(f.errors, []);
  const after = f.profiles[ieee];
  for (const key of ['haThresholdEntity', 'haAlarmEntity', 'notificationKey', 'automationId']) assert.equal(after[key], before[key]);
  assert.equal(after.haMoistureEntity, 'sensor.new_pot_moisture');
  assert.equal(after.name, 'New pot');
  assert.equal(after.zoneName, 'Uplaceret');
  assert.equal(Object.keys(f.profiles).length, 1);
});

test('a missing existing helper fails visibly instead of creating a replacement with defaults', async () => {
  const f = fixture();
  await f.provisioner.reconcile(inventory);
  const key = f.profiles[ieee].haThresholdEntity;
  f.states.delete(key);
  await f.provisioner.reconcile(inventory);
  assert.ok(f.errors.some((message) => message.includes('nulstilles ikke')));
  assert.equal(f.definitions.input_number.length, 1);
});

test('recovering a missing local profile reuses HA helpers and their user values', async () => {
  const f = fixture();
  await f.provisioner.reconcile(inventory);
  const before = structuredClone(f.profiles[ieee]);
  f.states.get(before.haThresholdEntity).state = '42';
  f.states.get(before.haAlarmEntity).state = 'on';
  delete f.profiles[ieee];
  await f.provisioner.reconcile(inventory);
  assert.deepEqual(f.errors, []);
  assert.equal(f.profiles[ieee].threshold, 42);
  assert.equal(f.profiles[ieee].controlState.alarm, true);
  assert.equal(f.profiles[ieee].notificationKey, before.notificationKey);
  assert.equal(f.definitions.input_number.length, 1);
  assert.equal(f.automations.length, 1);
});

test('software control observations are validated and emit only changed fields with HA provenance', () => {
  const profile = { name: 'Chilli', zoneId: 'greenhouse', driverId: 'zigbee2mqtt:Third Reality:3RSM0147Z', controlState: { threshold: 25, alarm: false } };
  assert.equal(softwareControlEvents(profile, ieee, { threshold: 25, alarm: false, time: '2026-11-12T12:00:00Z' }).events.length, 0);
  const changed = softwareControlEvents(profile, ieee, { threshold: 35, alarm: true, time: '2026-11-12T12:00:00Z' });
  assert.equal(changed.events.length, 2);
  assert.ok(changed.events.every((event) => event.homey_device_id === ieee && event.source_system === 'home_assistant'));
  for (const threshold of [null, '', '25', -1, 91, 2.5]) assert.throws(() => softwareControlEvents(profile, ieee, { threshold, alarm: false, time: '2026-11-12T12:00:00Z' }));
});

test('changing an HA software threshold cannot make a physically offline soil sensor appear live', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  const device = { available: true, capabilities: ['measure_soil_moisture', 'soil_warning_threshold', 'alarm_water'], settings: { soil_warning: 25 }, capabilitiesObj: {
    measure_soil_moisture: { value: 30, lastUpdated: '2026-11-11T12:00:00Z' },
    soil_warning_threshold: { value: 25, lastUpdated: '2026-11-12T12:00:00Z' },
    alarm_water: { value: false, lastUpdated: '2026-11-12T12:00:00Z' },
  } };
  assert.equal(canSetSoilAlarmThreshold(device, now), false);
});
