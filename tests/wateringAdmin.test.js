'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WateringAdmin, ieeeOf } = require('../soil-controller/wateringAdmin');

const copy = (value) => JSON.parse(JSON.stringify(value));
const valveIeee = '0x1111111111111111';
const soilIeee = '0x2222222222222222';
const secondIeee = '0x3333333333333333';
const valveId = `switch.${valveIeee}`;
const soilId = `sensor.${soilIeee}_soil_moisture`;
const secondId = `sensor.${secondIeee}_soil_moisture`;

function fixture() {
  const devices = [valveIeee, soilIeee, secondIeee].map((ieee, index) => ({
    id: `device${index}`, identifiers: [['mqtt', `zigbee2mqtt_${ieee}`]], name: ['Ventil', 'T-1', 'T-2'][index], name_by_user: ['Ventil', 'Efeu - T-1', 'Chilli - T-2'][index], area_id: 'room', labels: ['unrelated'],
  }));
  const entities = [valveId, soilId, secondId].map((entityId, index) => ({
    entity_id: entityId, device_id: devices[index].id, platform: 'mqtt', labels: [], ...(index ? { device_class: 'moisture' } : {}),
  }));
  const profiles = {
    [valveIeee]: { type: 'watering_valve', name: 'Ventil' },
    [soilIeee]: {
      autoManual: true, name: 'Efeu - T-1', haThresholdEntity: 'input_number.t1_threshold', haAlarmEntity: 'input_boolean.t1_alarm',
    },
    [secondIeee]: {
      autoManual: true, name: 'Chilli - T-2', haThresholdEntity: 'input_number.t2_threshold', haAlarmEntity: 'input_boolean.t2_alarm',
    },
  };
  const states = new Map();
  const put = (entityId, state, attributes = {}) => states.set(entityId, { entity_id: entityId, state: String(state), attributes });
  put(valveId, 'off'); put(soilId, 20, { device_class: 'moisture' }); put(secondId, 40, { device_class: 'moisture' });
  for (const n of [1, 2]) {
    put(`input_number.t${n}_threshold`, 25 + n); put(`input_boolean.t${n}_alarm`, n === 1 ? 'on' : 'off');
  }
  put('input_boolean.ha_watering_capacity_busy', 'off'); put('script.ha_watering_capacity_acquire', 'off');
  const automations = [1, 2].map((n) => ({
    id: `manual${n}`,
    alias: `T-${n} alarm`,
    use_blueprint: {
      path: 'wingman/manual-soil-moisture-alarm.yaml',
      input: {
        moisture_sensor: n === 1 ? soilId : secondId, threshold_helper: `input_number.t${n}_threshold`, water_alarm: `input_boolean.t${n}_alarm`, plant_name: '',
      },
    },
  }));
  put('automation.manual1', 'on', { id: 'manual1' }); put('automation.manual2', 'off', { id: 'manual2' });
  for (const state of states.values()) {
    if (!entities.some((entry) => entry.entity_id === state.entity_id)) {
      entities.push({
        entity_id: state.entity_id, platform: state.entity_id.split('.')[0], unique_id: state.attributes?.id || state.entity_id.split('.')[1], labels: [], categories: {},
      });
    }
  }
  const categories = { automation: [], helpers: [], script: [] };
  const labels = [];
  const helpers = new Map();
  const calls = [];
  let failAt = null;
  let backup = null;
  const ws = async (type, fields = {}) => {
    calls.push({ type, fields: copy(fields) });
    if (type === failAt) {
      failAt = null; throw new Error('Simuleret HA-fejl');
    }
    const registries = {
      'config/device_registry/list': devices, 'config/entity_registry/list': entities, 'config/area_registry/list': [{ area_id: 'room', name: 'Stue' }], 'config/label_registry/list': labels,
    };
    if (registries[type]) return copy(registries[type]);
    if (type === 'config/entity_registry/get') {
      const entry = entities.find((e) => e.entity_id === fields.entity_id);
      assert.ok(entry, fields.entity_id); return copy(entry);
    }
    if (type === 'config/category_registry/list') return copy(categories[fields.scope]);
    if (type === 'config/category_registry/create') {
      const entry = { category_id: `${fields.scope}_${categories[fields.scope].length}`, name: fields.name };
      categories[fields.scope].push(entry); return copy(entry);
    }
    if (type === 'config/label_registry/create') {
      const label = { label_id: `label${labels.length}`, name: fields.name }; labels.push(label); return copy(label);
    }
    if (type === 'config/label_registry/delete') {
      labels.splice(labels.findIndex((l) => l.label_id === fields.label_id), 1); return null;
    }
    if (type === 'config/label_registry/update') {
      Object.assign(labels.find((l) => l.label_id === fields.label_id), fields); return {};
    }
    if (type === 'config/device_registry/update' || type === 'config/entity_registry/update') {
      const list = type.includes('device_registry') ? devices : entities;
      const key = type.includes('device_registry') ? 'device_id' : 'entity_id';
      const target = list.find((item) => (key === 'device_id' ? item.id : item.entity_id) === fields[key]);
      assert.ok(target);
      const updates = copy(fields);
      if (updates.categories) {
        for (const [scope, id] of Object.entries(updates.categories)) {
          target.categories ||= {};
          if (id === null) delete target.categories[scope]; else target.categories[scope] = id;
        }
        delete updates.categories;
      }
      Object.assign(target, updates); return copy(target);
    }
    const [domain, action] = type.split('/');
    if (['input_boolean', 'input_number', 'input_select'].includes(domain)) {
      const id = fields[`${domain}_id`] || fields.name;
      if (action === 'create') {
        helpers.set(`${domain}.${id}`, { ...fields, id });
        entities.push({
          entity_id: `${domain}.${id}`, platform: domain, unique_id: id, labels: [], categories: {},
        });
        let initial = fields.min;
        if (domain === 'input_boolean') initial = 'off';
        if (domain === 'input_select') [initial] = fields.options;
        put(`${domain}.${id}`, initial);
        return { id };
      }
      if (action === 'update') {
        Object.assign(helpers.get(`${domain}.${id}`), fields); return {};
      }
      if (action === 'delete') {
        helpers.delete(`${domain}.${id}`); states.delete(`${domain}.${id}`);
        entities.splice(entities.findIndex((e) => e.entity_id === `${domain}.${id}`), 1);
        return {};
      }
    }
    throw new Error(`Unexpected WS ${type}`);
  };
  const request = async (path, options = {}) => {
    calls.push({ path, options: copy(options) });
    if (path === failAt) {
      failAt = null; throw new Error('Simuleret HA-fejl');
    }
    if (path === '/api/states') return copy([...states.values()]);
    if (path.startsWith('/api/config/automation/config/')) {
      const id = decodeURIComponent(path.split('/').pop());
      const index = automations.findIndex((a) => String(a.id) === id);
      if (index >= 0) automations.splice(index, 1);
      if (options.method === 'POST') {
        automations.push(JSON.parse(options.body));
        if (![...states.values()].some((s) => String(s.attributes.id) === id)) put(`automation.${id}`, 'on', { id });
        if (!entities.some((e) => e.entity_id === `automation.${id}`)) {
          entities.push({
            entity_id: `automation.${id}`, platform: 'automation', unique_id: id, labels: [], categories: {},
          });
        }
      } else {
        const state = [...states.values()].find((s) => String(s.attributes.id) === id);
        if (state) states.delete(state.entity_id);
        const entityIndex = entities.findIndex((e) => e.entity_id === `automation.${id}`);
        if (entityIndex >= 0) entities.splice(entityIndex, 1);
      }
      return {};
    }
    if (path.startsWith('/api/services/')) {
      const [, , , domain, action] = path.split('/');
      const body = JSON.parse(options.body);
      if (action === 'reload') return [];
      if (domain === 'automation' && action === 'trigger') return [];
      if (domain === 'input_number') {
        put(body.entity_id, body.value); return [];
      }
      if (['input_boolean', 'automation'].includes(domain)) {
        const previous = states.get(body.entity_id); put(body.entity_id, action === 'turn_on' ? 'on' : 'off', previous?.attributes); return [];
      }
    }
    throw new Error(`Unexpected request ${path}`);
  };
  const admin = new WateringAdmin({
    profiles,
    ws,
    request,
    readAutomations: () => copy(automations),
    persist: async () => {},
    backup: async (data) => {
      backup = copy(data);
    },
    changed: async () => {},
  });
  const draft = { name: 'Terrassepotter', valve: valveId, sensors: [soilId] };
  const save = async (body = draft, deleting = false) => {
    const { plan } = await admin.preview(body, deleting);
    return admin.commit({ ...body, revision: plan.revision, confirm: true }, deleting);
  };
  return {
    admin,
    profiles,
    devices,
    entities,
    categories,
    states,
    put,
    automations,
    labels,
    helpers,
    calls,
    draft,
    save,
    get backup() {
      return backup;
    },
    fail(type) {
      failAt = type;
    },
  };
}

test('physical identity is taken only from an exact MQTT IEEE identifier', () => {
  assert.equal(ieeeOf({ identifiers: [['mqtt', `zigbee2mqtt_${soilIeee}`]] }), soilIeee);
  assert.equal(ieeeOf({ name: 'T-1', identifiers: [['mqtt', 'zigbee2mqtt_T-1']] }), undefined);
});

test('new catalogue contains named/placed sensors and only known physical valve switches', async () => {
  const f = fixture();
  f.entities.push({ entity_id: 'switch.child_lock', device_id: 'device0', entity_category: 'config' });
  const data = await f.admin.list();
  assert.equal(data.circuits.length, 0); assert.equal(data.valves.length, 1);
  assert.equal(data.sensors[0].name, 'Efeu - T-1'); assert.equal(data.sensors[0].area, 'Stue');
});

test('preview is read-only and validates names, duplicates and unknown entities', async () => {
  const f = fixture();
  await f.admin.preview(f.draft);
  assert.equal(f.calls.some((c) => /create|update|delete/.test(c.type || '') || c.options?.method), false);
  await assert.rejects(f.admin.preview({ ...f.draft, sensors: [soilId, soilId] }), /forskellige/);
  await assert.rejects(f.admin.preview({ ...f.draft, sensors: ['sensor.fake'] }), /identificeres/);
  await assert.rejects(f.admin.preview({ ...f.draft, name: '' }), /1-60/);
});

test('confirmation, stale configuration and parallel changes are rejected before writes', async () => {
  const f = fixture();
  await assert.rejects(f.admin.commit(f.draft), /bekræft/);
  const { plan } = await f.admin.preview(f.draft);
  f.automations[0].alias = 'Changed in HA';
  await assert.rejects(f.admin.commit({ ...f.draft, confirm: true, revision: plan.revision }), /ændret siden/);
  f.admin.busy = true;
  await assert.rejects(f.admin.commit({ ...f.draft, confirm: true, revision: plan.revision }), /allerede i gang/);
  assert.equal(f.backup, null);
});

test('creation uses native HA helpers, starts forbidden and pauses only the selected manual alarm', async () => {
  const f = fixture();
  await f.save();
  const circuit = (await f.admin.list()).circuits[0];
  assert.equal(circuit.forbidden, true); assert.equal(circuit.sensors[0].entityId, soilId);
  assert.equal(f.states.get('automation.manual1').state, 'off'); assert.equal(f.states.get('automation.manual2').state, 'off');
  assert.equal(f.states.get('input_number.t1_threshold').state, '26');
  assert.equal(f.profiles[soilIeee].haThresholdEntity, 'input_number.t1_threshold');
  assert.equal(f.helpers.size, 7); assert.ok(f.backup);
  assert.equal(f.calls.some((c) => c.path?.includes('/switch/')), false);
  assert.deepEqual(f.devices[1].labels, ['unrelated']);
  assert.deepEqual(f.entities[1].labels, ['label0']);
});

test('sensor measurements can change after preview without invalidating configuration confirmation', async () => {
  const f = fixture();
  const { plan } = await f.admin.preview(f.draft);
  f.put(soilId, 21, { device_class: 'moisture' });
  await f.admin.commit({ ...f.draft, confirm: true, revision: plan.revision });
});

test('editing preserves all watering settings, releases removed sensor and retains disabled manual preference', async () => {
  const f = fixture(); await f.save();
  let circuit = (await f.admin.list()).circuits[0];
  const originalInputs = copy(f.automations.find((a) => a.id === circuit.id).use_blueprint.input);
  f.put(originalInputs.cycle_duration, 7); f.put(originalInputs.watering_forbidden, 'off');
  await f.save({
    id: circuit.id, name: circuit.name, valve: valveId, sensors: [secondId],
  });
  circuit = (await f.admin.list()).circuits[0];
  assert.equal(circuit.forbidden, false);
  assert.equal(f.states.get(originalInputs.cycle_duration).state, '7');
  assert.equal(f.states.get('automation.manual1').state, 'on');
  assert.equal(f.states.get('automation.manual2').state, 'off');
  assert.equal(f.profiles[soilIeee].autoManual, true); assert.equal(f.profiles[soilIeee].wateringCircuit, undefined);
  assert.deepEqual(f.entities[1].labels, []); assert.deepEqual(f.entities[2].labels, ['label0']);
  assert.equal(f.automations.filter((a) => a.use_blueprint?.path === 'wingman/soil-moisture-alarm.yaml').length, 1);
});

test('removal preserves helpers, thresholds and labels and restores the original manual alarm state', async () => {
  const f = fixture(); await f.save();
  const circuit = (await f.admin.list()).circuits[0];
  const count = f.helpers.size;
  await f.save({ id: circuit.id }, true);
  assert.equal((await f.admin.list()).circuits.length, 0);
  assert.equal(f.helpers.size, count); assert.equal(f.labels.length, 1);
  assert.equal(f.states.get('input_number.t1_threshold').state, '26');
  assert.equal(f.states.get('automation.manual1').state, 'on');
  assert.equal(f.profiles[valveIeee].wateringCircuit, undefined);
});

test('a running or unavailable valve blocks editing/removal and no actuators are written', async () => {
  const f = fixture(); await f.save();
  const circuit = (await f.admin.list()).circuits[0];
  f.put(valveId, 'on');
  await assert.rejects(f.save({ id: circuit.id }, true), /mens.*vander/);
  f.put(valveId, 'unavailable');
  await assert.rejects(f.save({ id: circuit.id }, true), /mens.*vander/);
  assert.equal(f.calls.some((c) => c.path?.includes('/switch/')), false);
});

test('duplicate valve ownership and disabled sensor selection are rejected', async () => {
  const f = fixture(); await f.save();
  await assert.rejects(f.admin.preview({ ...f.draft, name: 'Other circuit', sensors: [secondId] }), /tilhører allerede/);
  f.entities[2].disabled_by = 'user';
  const circuit = (await f.admin.list()).circuits[0];
  await assert.rejects(f.admin.preview({
    id: circuit.id, name: circuit.name, valve: valveId, sensors: [secondId],
  }), /identificeres/);
});

test('HA failure rolls back automation configs, memberships, profiles and manual alarm enabled state', async () => {
  const f = fixture();
  const originalProfiles = copy(f.profiles); const originalAutomations = copy(f.automations);
  f.fail('config/entity_registry/update');
  await assert.rejects(f.save(), /Simuleret HA-fejl/);
  assert.deepEqual(f.profiles, originalProfiles);
  assert.deepEqual(f.automations.sort((a, b) => a.id.localeCompare(b.id)), originalAutomations);
  assert.equal(f.helpers.size, 0); assert.equal(f.labels.length, 0);
  assert.equal(f.states.get('automation.manual1').state, 'on');
  assert.equal(f.admin.busy, false);
});

test('missing capacity setup rolls back the newly created label without changing history or thresholds', async () => {
  const f = fixture(); f.states.delete('script.ha_watering_capacity_acquire');
  await assert.rejects(f.save(), /kapacitet mangler/);
  assert.equal(f.labels.length, 0); assert.equal(f.helpers.size, 0);
  assert.equal(f.states.get('input_number.t1_threshold').state, '26');
  assert.equal(f.states.get('automation.manual1').state, 'on');
});

test('renaming a circuit preserves its HA label id, helper values and automation identity', async () => {
  const f = fixture(); await f.save();
  const circuit = (await f.admin.list()).circuits[0];
  const oldRouting = copy(f.profiles[valveIeee].haWatering);
  await f.save({
    id: circuit.id, name: 'Nyt kredsnavn', valve: valveId, sensors: [soilId],
  });
  const after = (await f.admin.list()).circuits[0];
  assert.equal(after.id, circuit.id); assert.equal(after.labelId, circuit.labelId);
  assert.equal(after.name, 'Nyt kredsnavn');
  assert.deepEqual(f.profiles[valveIeee].haWatering, oldRouting);
});

test('switching a circuit valve detaches the old profile without resetting watering settings', async () => {
  const f = fixture(); await f.save();
  const circuit = (await f.admin.list()).circuits[0];
  const ieee = '0x4444444444444444'; const entityId = `switch.${ieee}`;
  f.devices.push({
    id: 'otherValve', identifiers: [['mqtt', `zigbee2mqtt_${ieee}`]], name: 'Other valve', labels: [],
  });
  f.entities.push({ entity_id: entityId, device_id: 'otherValve', labels: [] });
  f.profiles[ieee] = { type: 'watering_valve' }; f.put(entityId, 'off');
  const oldRouting = copy(f.profiles[valveIeee].haWatering);
  await f.save({
    id: circuit.id, name: circuit.name, valve: entityId, sensors: [soilId],
  });
  assert.equal(f.profiles[valveIeee].wateringCircuit, undefined);
  assert.deepEqual(f.profiles[ieee].haWatering, oldRouting);
  assert.equal((await f.admin.list()).circuits[0].valve.entityId, entityId);
});

test('busy capacity and an active automation block changes even when lifecycle says idle', async () => {
  const f = fixture(); await f.save();
  const circuit = (await f.admin.list()).circuits[0];
  f.put('input_boolean.ha_watering_capacity_busy', 'on');
  await assert.rejects(f.save({ id: circuit.id }, true), /kapacitet er optaget/);
  f.put('input_boolean.ha_watering_capacity_busy', 'off');
  f.put(`automation.${circuit.id}`, 'on', { id: circuit.id, current: 1 });
  await assert.rejects(f.save({ id: circuit.id }, true), /kører stadig/);
});

test('ambiguous measurement entities for one physical sensor cannot cross-wire helpers', async () => {
  const f = fixture();
  f.entities.push({
    entity_id: 'sensor.duplicate', device_id: 'device1', device_class: 'moisture', labels: [],
  });
  f.put('sensor.duplicate', 10, { device_class: 'moisture' });
  assert.equal((await f.admin.list()).sensors.some((s) => s.ieee === soilIeee), false);
  await assert.rejects(f.admin.preview(f.draft), /identificeres/);
});

test('lost automation ownership is shown as an orphan, not offered as a new empty slot', async () => {
  const f = fixture(); f.profiles[valveIeee].wateringCircuit = 'Lost circuit';
  const circuit = (await f.admin.list()).circuits[0];
  assert.equal(circuit.editable, false); assert.match(circuit.warnings[0], /mangler/);
  await assert.rejects(f.admin.preview({ ...f.draft, id: circuit.id }), /afklares/);
});

test('legacy HA references win over stale Wingman profiles and missing old sensors can be replaced', async () => {
  const f = fixture(); await f.save();
  const circuit = (await f.admin.list()).circuits[0];
  delete f.profiles[valveIeee].wateringAdmin;
  f.profiles[valveIeee].generatedWatering.sensorEntities = [secondId];
  f.entities.splice(f.entities.findIndex((e) => e.entity_id === soilId), 1);
  f.profiles[soilIeee].haThresholdEntity = 'input_number.old_stale_helper';
  const current = (await f.admin.list()).circuits[0];
  assert.equal(current.editable, true); assert.ok(current.warnings.length);
  await f.save({
    id: circuit.id, name: circuit.name, valve: valveId, sensors: [secondId],
  });
  assert.equal(f.profiles[soilIeee].haThresholdEntity, 'input_number.t1_threshold');
  assert.equal(f.profiles[soilIeee].autoManual, true);
});

test('confirmation is bound to the operation; a save preview cannot authorize removal', async () => {
  const f = fixture(); await f.save();
  const circuit = (await f.admin.list()).circuits[0];
  const draft = {
    id: circuit.id, name: circuit.name, valve: valveId, sensors: [soilId],
  };
  const { plan } = await f.admin.preview(draft);
  await assert.rejects(f.admin.commit({ ...draft, confirm: true, revision: plan.revision }, true), /ændret siden/);
  assert.equal((await f.admin.list()).circuits.length, 1);
});

test('a run starting during gate acquisition is detected before any automation reload', async () => {
  const f = fixture(); await f.save();
  const circuit = (await f.admin.list()).circuits[0];
  const { request } = f.admin;
  const initialReloads = f.calls.filter((c) => c.path === '/api/services/automation/reload').length;
  let raced = false;
  f.admin.request = async (path, options) => {
    const result = await request(path, options);
    if (!raced && path === '/api/services/input_boolean/turn_on') {
      raced = true; f.put(valveId, 'on');
    }
    return result;
  };
  await assert.rejects(f.save({ id: circuit.id }, true), /mens.*vander/);
  assert.equal(f.calls.filter((c) => c.path === '/api/services/automation/reload').length, initialReloads);
});

test('a gate-release error after commit never rolls the now-live configuration back', async () => {
  const f = fixture(); await f.save();
  const circuit = (await f.admin.list()).circuits[0];
  const gate = f.profiles[valveIeee].haWatering.forbiddenEntity; f.put(gate, 'off');
  const { request } = f.admin;
  f.admin.request = async (path, options) => {
    if (path === '/api/services/input_boolean/turn_off' && JSON.parse(options.body).entity_id === gate) throw new Error('Lost gate response');
    return request(path, options);
  };
  await assert.rejects(f.save({
    id: circuit.id, name: 'Saved name', valve: valveId, sensors: [secondId],
  }), /er gemt.*kunne ikke gendannes/);
  const after = (await f.admin.list()).circuits[0];
  assert.equal(after.name, 'Saved name'); assert.equal(after.sensors[0].entityId, secondId);
  assert.equal(after.forbidden, true);
});

test('disabled watering, automatic alarms and manual preferences survive a reload that re-enables entities', async () => {
  const f = fixture(); await f.save();
  const circuit = (await f.admin.list()).circuits[0];
  f.put(`automation.${circuit.id}`, 'off', { id: circuit.id });
  const alarmId = circuit.automaticAlarmIds[0]; f.put(`automation.${alarmId}`, 'off', { id: alarmId });
  const { request } = f.admin;
  f.admin.request = async (path, options) => {
    const result = await request(path, options);
    if (path === '/api/services/automation/reload') {
      for (const state of [...f.states.values()].filter((state) => state.entity_id.startsWith('automation.'))) f.put(state.entity_id, 'on', state.attributes);
    }
    return result;
  };
  await f.save({
    id: circuit.id, name: circuit.name, valve: valveId, sensors: [soilId],
  });
  assert.equal(f.states.get(`automation.${circuit.id}`).state, 'off');
  assert.equal(f.states.get(`automation.${alarmId}`).state, 'off');
  assert.equal(f.states.get('automation.manual1').state, 'off');
});

test('a physically dismantled offline circuit can be removed only after its automation is disabled', async () => {
  const f = fixture(); await f.save();
  const circuit = (await f.admin.list()).circuits[0]; f.put(valveId, 'unavailable');
  const draft = { id: circuit.id, decommissioned: true };
  await assert.rejects(f.save(draft, true), /Slå kredsens vandingsautomation fra/);
  f.put(`automation.${circuit.id}`, 'off', { id: circuit.id, current: 0 });
  assert.deepEqual((await f.admin.preview(draft, true)).plan.blockers, []);
  const before = f.calls.length;
  await f.save(draft, true);
  assert.equal((await f.admin.list()).circuits.length, 0);
  assert.equal(f.states.get('automation.manual1').state, 'on');
  assert.equal(f.states.get('input_number.t1_threshold').state, '26');
  assert.equal(f.calls.slice(before).some((c) => c.path?.includes('/switch/') || c.path?.includes('/input_boolean/')), false);
});

test('the dismantling assertion is bound to the preview and cannot authorize editing', async () => {
  const f = fixture(); await f.save();
  const circuit = (await f.admin.list()).circuits[0]; f.put(valveId, 'unavailable');
  f.put(`automation.${circuit.id}`, 'off', { id: circuit.id });
  const { plan } = await f.admin.preview({ id: circuit.id }, true);
  await assert.rejects(f.admin.commit({
    id: circuit.id, decommissioned: true, revision: plan.revision, confirm: true,
  }, true), /ændret siden/);
  await assert.rejects(f.admin.preview({ ...f.draft, decommissioned: true }), /kun bekræftes ved fjernelse/);
});

test('dismantling cannot override a reporting open valve or an unknown/active automation', async () => {
  const f = fixture(); await f.save();
  const circuit = (await f.admin.list()).circuits[0];
  const draft = { id: circuit.id, decommissioned: true };
  f.put(`automation.${circuit.id}`, 'off', { id: circuit.id }); f.put(valveId, 'on');
  await assert.rejects(f.save(draft, true), /melder stadig åben/);
  f.put(valveId, 'unavailable'); f.states.delete(`automation.${circuit.id}`);
  await assert.rejects(f.save(draft, true), /Slå kredsens vandingsautomation fra/);
  f.put(`automation.${circuit.id}`, 'off', { id: circuit.id, current: 1 });
  await assert.rejects(f.save(draft, true), /Slå kredsens vandingsautomation fra/);
});

test('dismantling needs no stale lifecycle/gate helpers but never clears shared busy capacity', async () => {
  const f = fixture(); await f.save();
  const circuit = (await f.admin.list()).circuits[0];
  f.put(`automation.${circuit.id}`, 'off', { id: circuit.id }); f.put(valveId, 'unavailable');
  f.states.delete(f.profiles[valveIeee].haWatering.forbiddenEntity);
  f.states.delete(f.profiles[valveIeee].haWatering.statusEntity);
  const draft = { id: circuit.id, decommissioned: true };
  f.put('input_boolean.ha_watering_capacity_busy', 'on');
  await assert.rejects(f.save(draft, true), /kapacitet er optaget/);
  f.put('input_boolean.ha_watering_capacity_busy', 'off');
  await f.save(draft, true);
  assert.equal((await f.admin.list()).circuits.length, 0);
});

test('dismantling does not exempt another active watering circuit from the global reload guard', async () => {
  const f = fixture(); await f.save();
  const first = (await f.admin.list()).circuits[0];
  const ieee = '0x4444444444444444'; const secondValve = `switch.${ieee}`;
  f.devices.push({
    id: 'secondValve', identifiers: [['mqtt', `zigbee2mqtt_${ieee}`]], name: 'Other valve', labels: [],
  });
  f.entities.push({ entity_id: secondValve, device_id: 'secondValve', labels: [] });
  f.profiles[ieee] = { type: 'watering_valve' }; f.put(secondValve, 'off');
  await f.save({ name: 'Other circuit', valve: secondValve, sensors: [secondId] });
  f.put(`automation.${first.id}`, 'off', { id: first.id }); f.put(valveId, 'unavailable');
  f.put(secondValve, 'on');
  await assert.rejects(f.save({ id: first.id, decommissioned: true }, true), /Other circuit.*vander/);
  assert.equal((await f.admin.list()).circuits.length, 2);
});

test('failed dismantling restores the disabled circuit without contacting its offline valve', async () => {
  const f = fixture(); await f.save();
  const circuit = (await f.admin.list()).circuits[0];
  f.put(`automation.${circuit.id}`, 'off', { id: circuit.id }); f.put(valveId, 'unavailable');
  const originalProfiles = copy(f.profiles); const before = f.calls.length;
  f.fail('config/entity_registry/update');
  await assert.rejects(f.save({ id: circuit.id, decommissioned: true }, true), /Simuleret HA-fejl/);
  assert.equal((await f.admin.list()).circuits.length, 1);
  assert.equal(f.states.get(`automation.${circuit.id}`).state, 'off');
  assert.deepEqual(f.profiles, originalProfiles);
  assert.equal(f.calls.slice(before).some((c) => c.path?.includes('/switch/')), false);
});

test('circuit automations, helpers and the shared script get scoped HA categories without duplicates', async () => {
  const f = fixture(); await f.save();
  const circuit = (await f.admin.list()).circuits[0];
  for (const scope of ['automation', 'helpers', 'script']) {
    assert.equal(f.categories[scope].length, 1);
    assert.equal(f.categories[scope][0].name, 'Vandingskredse');
  }
  for (const id of [circuit.id, ...circuit.automaticAlarmIds]) {
    assert.equal(f.entities.find((e) => e.entity_id === `automation.${id}`).categories.automation, f.categories.automation[0].category_id);
  }
  for (const eid of f.helpers.keys()) assert.equal(f.entities.find((e) => e.entity_id === eid).categories.helpers, f.categories.helpers[0].category_id);
  assert.equal(f.entities.find((e) => e.entity_id === 'script.ha_watering_capacity_acquire').categories.script, f.categories.script[0].category_id);
  await f.save({
    id: circuit.id, name: circuit.name, valve: valveId, sensors: [soilId],
  });
  assert.equal(f.categories.automation.length, 1); assert.equal(f.categories.helpers.length, 1);
});

test('a category chosen by the user is preserved when a helper is reused', async () => {
  const f = fixture();
  f.entities.find((e) => e.entity_id === 'input_number.t1_threshold').categories = { helpers: 'user-category', unrelated_scope: 'unrelated-category' };
  await f.save();
  assert.deepEqual(f.entities.find((e) => e.entity_id === 'input_number.t1_threshold').categories, { helpers: 'user-category', unrelated_scope: 'unrelated-category' });
});

test('category assignments roll back with a later failed circuit transaction', async () => {
  const f = fixture();
  const originalWs = f.admin.ws; let failed = false;
  f.admin.ws = async (type, fields) => {
    if (!failed && type === 'config/entity_registry/update' && fields.labels) {
      failed = true; throw new Error('Late registry failure');
    }
    return originalWs(type, fields);
  };
  await assert.rejects(f.save(), /Late registry failure/);
  for (const entry of f.entities) assert.equal(Object.values(entry.categories || {}).length, 0);
  assert.equal(f.helpers.size, 0);
  assert.equal(f.automations.length, 2);
});
