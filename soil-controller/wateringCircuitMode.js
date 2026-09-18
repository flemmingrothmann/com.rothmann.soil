'use strict';

function classifyCircuitMode(existingProfiles) {
  if (existingProfiles.some(([, profile]) => profile.generatedWatering?.packageFile)) return 'managed';
  return existingProfiles.length > 0 ? 'legacy' : 'create';
}

function generatedHelperEntities(slug, sensors) {
  const helper = `wingman_${slug}`;
  return {
    thresholds: sensors.map((sensor) => `input_number.${helper}_${sensor.key}_threshold`),
    waterAlarmEntities: sensors.map((sensor) => `input_boolean.${helper}_${sensor.key}_water_alarm`),
    cycleDurationEntity: `input_number.${helper}_cycle_duration`,
    pauseDurationEntity: `input_number.${helper}_pause_duration`,
    maximumCyclesEntity: `input_number.${helper}_maximum_cycles`,
    cycleNumberEntity: `input_number.${helper}_cycle_number`,
    statusEntity: `input_select.${helper}_watering_status`,
    errorEntity: `input_boolean.${helper}_watering_error`,
    forbiddenEntity: `input_boolean.${helper}_watering_forbidden`,
  };
}

module.exports = { classifyCircuitMode, generatedHelperEntities };
