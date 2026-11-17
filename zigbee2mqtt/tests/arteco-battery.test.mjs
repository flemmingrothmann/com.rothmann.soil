import assert from 'node:assert/strict';
import {test} from 'node:test';
import {definitions} from 'zigbee-herdsman-converters/devices/tuya';
import definition from '../external_converters/arteco-zs-304z-battery.mjs';

const base = definitions.find((item) => item.model === 'ZS-300Z' && item.zigbeeModel?.includes('ZS-304Z'));

test('Arteco extension is scoped to inspected hardware and versions its configure behavior', () => {
    assert.equal(definition.zigbeeModel, undefined);
    assert.equal(definition.whiteLabel, undefined);
    assert.deepEqual(definition.fingerprint, [{modelID: 'ZS-304Z', manufacturerName: 'Arteco'}]);
    assert.equal(definition.model, 'ZS-304Z');
    assert.equal(definition.version, '1.0.0');
});

test('Arteco inherits upstream calibration and warning fixes without an obsolete copy', () => {
    assert.equal(definition.meta, base.meta);
    assert.equal(definition.exposes, base.exposes);
    assert.deepEqual(definition.extend.slice(0, -1), base.extend);
    const datapoints = definition.meta.tuyaDatapoints;
    const soilCalibration = datapoints.find(([id, property]) => id === 104 && property === 'soil_calibration')[2];
    assert.equal(soilCalibration.from(255), -1);
    assert.equal(soilCalibration.to(-1), 255);
    const warning = datapoints.filter(([id]) => id === 110);
    assert.deepEqual(warning.map(([, property]) => property), ['soil_moisture_warning', 'soil_moisture_warning_threshold']);
    assert.equal(warning[0][2].to, undefined);
    assert.equal(warning[1][2].from, undefined);
});

test('Arteco standard battery reports retain percent scaling and read/report support', async () => {
    const extension = definition.extend.at(-1);
    const converter = extension.fromZigbee.find((item) => item.cluster === 'genPowerCfg');
    for (const [raw, percent] of [[200, 100], [146, 73], [0, 0]]) {
        const result = await converter.convert({meta: {}}, {data: {batteryPercentageRemaining: raw}}, () => {}, {}, {});
        assert.equal(result.battery, percent);
    }
    assert.ok(extension.toZigbee.some((item) => item.key.includes('battery') && item.convertGet));
    assert.ok(extension.configure.length > 0);
});
