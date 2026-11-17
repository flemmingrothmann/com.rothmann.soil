'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SoilProvisioner, supportsSoilCalibration } = require('../soil-controller/soilProvisioning');

const ieee = '0xa4c138746928b580';
const entityId = 'number.renamed_pot_soil_calibration';

function fixture(value = 'unknown') {
  const profile = { haDeviceId: 'physical-device', soilCalibrationSetup: 'pending' };
  const calls = [];
  let saves = 0;
  const provisioner = new SoilProvisioner({
    profiles: { [ieee]: profile },
    request: async (path, options) => calls.push({ path, body: JSON.parse(options.body) }),
    persist: () => {
      saves += 1;
    },
    log: () => {},
  });
  const snapshot = {
    entities: [{
      platform: 'mqtt', device_id: 'physical-device', entity_id: entityId, unique_id: `${ieee}_soil_calibration_zigbee2mqtt`,
    }],
    states: new Map([[entityId, { state: value }]]),
  };
  return {
    profile, calls, provisioner, snapshot, saves: () => saves,
  };
}

test('detects writable soil calibration, including nested and set-only exposes', () => {
  for (const access of [2, 3, 7]) {
    assert.equal(supportsSoilCalibration({ definition: { exposes: [{ features: [{ property: 'soil_calibration', access }] }] } }), true);
  }
  for (const access of [0, 1, 4, 5]) {
    assert.equal(supportsSoilCalibration({ definition: { exposes: [{ property: 'soil_calibration', access }] } }), false);
  }
  assert.equal(supportsSoilCalibration({}), false);
});

test('sets the initial value to zero via HA once, including an unreported default', async () => {
  for (const value of ['unknown', '12', '-5']) {
    const f = fixture(value);
    await f.provisioner.initializeSoilCalibration(ieee, f.profile, f.snapshot);
    assert.deepEqual(f.calls, [{ path: '/api/services/number/set_value', body: { entity_id: entityId, value: 0 } }]);
    assert.equal(f.profile.soilCalibrationSetup, 'initialized');
    f.snapshot.states.get(entityId).state = '7';
    await f.provisioner.initializeSoilCalibration(ieee, f.profile, f.snapshot);
    assert.equal(f.calls.length, 1, 'a subsequent user change must survive');
    assert.equal(f.saves(), 1);
  }
});

test('does not send unchanged zero or touch preexisting sensors', async () => {
  const f = fixture('0');
  await f.provisioner.initializeSoilCalibration(ieee, f.profile, f.snapshot);
  assert.equal(f.calls.length, 0);
  assert.equal(f.profile.soilCalibrationSetup, 'initialized');
  delete f.profile.soilCalibrationSetup;
  f.snapshot.states.get(entityId).state = '15';
  await f.provisioner.initializeSoilCalibration(ieee, f.profile, f.snapshot);
  assert.equal(f.calls.length, 0);
});

test('waits for HA discovery or availability and resumes from persisted enrollment', async () => {
  const f = fixture('unavailable');
  await f.provisioner.initializeSoilCalibration(ieee, f.profile, f.snapshot);
  assert.equal(f.profile.soilCalibrationSetup, 'pending');
  assert.equal(f.calls.length, 0);
  f.snapshot.states.get(entityId).state = 'unknown';
  const resumed = structuredClone(f.profile);
  await f.provisioner.initializeSoilCalibration(ieee, resumed, { ...f.snapshot, entities: [] });
  assert.equal(resumed.soilCalibrationSetup, 'pending');
  await f.provisioner.initializeSoilCalibration(ieee, resumed, f.snapshot);
  assert.equal(resumed.soilCalibrationSetup, 'initialized');
});

test('never targets a disabled, duplicated or different physical sensor entity', async () => {
  for (const change of [
    (f) => {
      f.snapshot.entities[0].disabled_by = 'user';
    },
    (f) => {
      f.snapshot.entities[0].device_id = 'other-device';
    },
    (f) => {
      f.snapshot.entities[0].unique_id = 'other-ieee_soil_calibration_zigbee2mqtt';
    },
    (f) => {
      f.snapshot.entities.push({ ...f.snapshot.entities[0] });
    },
  ]) {
    const f = fixture(); change(f);
    await f.provisioner.initializeSoilCalibration(ieee, f.profile, f.snapshot);
    assert.equal(f.calls.length, 0);
    assert.equal(f.profile.soilCalibrationSetup, 'pending');
  }
});

test('HA failures preserve pending status for retry', async () => {
  const f = fixture();
  f.provisioner.request = async () => {
    throw new Error('HA rejected set_value');
  };
  await assert.rejects(f.provisioner.initializeSoilCalibration(ieee, f.profile, f.snapshot), /HA rejected/);
  assert.equal(f.profile.soilCalibrationSetup, 'pending');
  assert.equal(f.saves(), 0);
});
