'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyCircuitMode, generatedHelperEntities } = require('../soil-controller/wateringCircuitMode');

test('classifies watering circuit ownership for CRUD actions', () => {
  assert.equal(classifyCircuitMode([]), 'create');
  assert.equal(classifyCircuitMode([['valve', { wateringCircuit: 'Terrasse' }]]), 'legacy');
  assert.equal(classifyCircuitMode([['valve', { generatedWatering: { packageFile: 'wingman.yaml' } }]]), 'managed');
});

test('uses separate generated helper entity ids during migration', () => {
  const entities = generatedHelperEntities('vanding_terasse_potter', [{ key: 'myggeplante' }]);
  assert.equal(entities.thresholds[0], 'input_number.wingman_vanding_terasse_potter_myggeplante_threshold');
  assert.equal(entities.waterAlarmEntities[0], 'input_boolean.wingman_vanding_terasse_potter_myggeplante_water_alarm');
  assert.equal(entities.cycleDurationEntity, 'input_number.wingman_vanding_terasse_potter_cycle_duration');
});
