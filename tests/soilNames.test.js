'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { soilDisplayName, syncSoilNames } = require('../soil-controller/soilNames');

const ieee = '0xa4c138746928b580';

function fixture() {
  const profile = {
    name: 'Elefantfod - Z-3',
    haThresholdEntity: `input_number.soil_${ieee}_threshold`,
    haAlarmEntity: `input_boolean.soil_${ieee}_water_alarm`,
    notificationKey: `ieee_${ieee.slice(2)}`,
    automationId: `manual_soil_${ieee}`,
  };
  const cooldown = `input_datetime.manual_soil_alarm_${profile.notificationKey}_last_push`;
  const automationId = `automation.${ieee}_jordfugt_alarm`;
  const roleRows = [[profile.haThresholdEntity, 'jordfugtgrænse'], [profile.haAlarmEntity, 'vandalarm'], [cooldown, 'seneste vandingspush'], [automationId, 'jordfugt alarm']];
  const entities = roleRows.map(([id, suffix]) => ({
    entity_id: id,
    platform: id.split('.')[0],
    unique_id: id === automationId ? profile.automationId : id.split('.')[1],
    original_name: `${ieee} ${suffix}`,
    name: null,
  }));
  const calls = [];
  const fields = {
    ieee,
    profile,
    device: { friendly_name: 'Z-3' },
    haDevice: { name: 'Z-3', name_by_user: 'Elefantfod - Z-3' },
    automation: { id: profile.automationId, alias: `${ieee} jordfugt alarm`, use_blueprint: { input: {} } },
    snapshot: { entities, states: new Map() },
    ws: async (type, body) => {
      calls.push({ type, body });
      const entity = entities.find((entry) => entry.entity_id === body.entity_id);
      assert.ok(entity);
      if (type === 'config/entity_registry/get') return structuredClone(entity);
      assert.equal(type, 'config/entity_registry/update');
      assert.deepEqual(Object.keys(body).sort(), ['entity_id', 'name']);
      entity.name = body.name;
      return structuredClone(entity);
    },
  };
  return {
    fields, profile, entities, calls, cooldown, automationId,
  };
}

test('uses the HA MQTT-device user name, then the current Z2M name', () => {
  assert.equal(soilDisplayName({ friendly_name: 'Z-3' }, { name_by_user: 'Elefantfod - Z-3' }, ieee), 'Elefantfod - Z-3');
  assert.equal(soilDisplayName({ friendly_name: 'New MQTT name' }, { name: 'Old default' }, ieee), 'New MQTT name');
});

test('migrates IEEE helper and automation display names without changing source configuration or IDs', async () => {
  const f = fixture(); const before = structuredClone(f.entities);
  assert.equal(await syncSoilNames(f.fields), true);
  for (let index = 0; index < before.length; index += 1) {
    assert.equal(f.entities[index].name, before[index].original_name.replace(ieee, 'Elefantfod - Z-3'));
    assert.equal(f.entities[index].entity_id, before[index].entity_id);
    assert.equal(f.entities[index].original_name, before[index].original_name);
  }
  assert.equal(f.fields.automation.alias, `${ieee} jordfugt alarm`);
  assert.equal(f.calls.filter((call) => call.type.endsWith('/update')).length, 4);
  const count = f.calls.length;
  assert.equal(await syncSoilNames(f.fields), false);
  assert.equal(f.calls.length, count, 'unchanged names cause no API calls');
});

test('future renames and adapter restarts preserve the generated-name ownership', async () => {
  const f = fixture(); await syncSoilNames(f.fields);
  f.fields.profile = JSON.parse(JSON.stringify(f.profile));
  f.fields.haDevice.name_by_user = 'Ny potte - Z-3';
  assert.equal(await syncSoilNames(f.fields), true);
  assert.ok(f.entities.every((entity) => entity.name.startsWith('Ny potte - Z-3 ')));
  f.fields.haDevice.name_by_user = null;
  f.fields.device.friendly_name = 'Sensor ved vinduet';
  await syncSoilNames(f.fields);
  assert.ok(f.entities.every((entity) => entity.name.startsWith('Sensor ved vinduet ')));
});

test('preserves custom entity names both before migration and after automatic naming', async () => {
  const f = fixture();
  f.entities[0].name = 'Min særlige grænse';
  f.entities[3].original_name = 'Min egen regel';
  await syncSoilNames(f.fields);
  assert.equal(f.entities[0].name, 'Min særlige grænse');
  assert.equal(f.entities[3].name, null);
  f.entities[1].name = 'Min egen alarm';
  f.fields.haDevice.name_by_user = 'Ny plante';
  await syncSoilNames(f.fields);
  assert.equal(f.entities[1].name, 'Min egen alarm');
});

test('a custom rename in the helper/automation editor supersedes our display override', async () => {
  const f = fixture(); await syncSoilNames(f.fields);
  for (const entity of f.entities) entity.original_name = `Mit eget navn til ${entity.platform}`;
  await syncSoilNames(f.fields);
  assert.ok(f.entities.every((entity) => entity.name === null));
  f.calls.splice(0); f.fields.haDevice.name_by_user = 'Endnu en plante';
  await syncSoilNames(f.fields);
  assert.equal(f.calls.length, 0);
});

test('does not rename foreign/shared helpers, missing helpers or a deleted automation', async () => {
  const f = fixture();
  f.entities[0].unique_id = 'shared_threshold';
  f.entities.splice(f.entities.findIndex((entity) => entity.entity_id === f.cooldown), 1);
  f.fields.automation = null;
  await syncSoilNames(f.fields);
  assert.equal(f.entities[0].name, null);
  assert.equal(f.entities.find((entity) => entity.entity_id === f.automationId).name, null);
  assert.equal(f.calls.filter((call) => call.type.endsWith('/update')).length, 1);
});

test('a concurrent user rename wins over a stale snapshot', async () => {
  const f = fixture(); const originalWs = f.fields.ws;
  f.fields.ws = async (type, fields) => {
    if (type.endsWith('/get')) return { ...f.entities.find((entity) => entity.entity_id === fields.entity_id), name: 'User renamed meanwhile' };
    return originalWs(type, fields);
  };
  await syncSoilNames(f.fields);
  assert.equal(f.calls.length, 0);
});

test('an incomplete old profile can name its IEEE-bound helpers without repairing deleted artifacts', async () => {
  const f = fixture();
  f.fields.profile = { autoManual: true };
  f.fields.automation = null;
  f.entities.splice(f.entities.findIndex((entity) => entity.entity_id === f.cooldown), 1);
  await syncSoilNames(f.fields);
  assert.equal(f.entities.filter((entity) => entity.name === 'Elefantfod - Z-3 jordfugtgrænse' || entity.name === 'Elefantfod - Z-3 vandalarm').length, 2);
  assert.equal(f.calls.filter((call) => call.type.endsWith('/update')).length, 2);
});
