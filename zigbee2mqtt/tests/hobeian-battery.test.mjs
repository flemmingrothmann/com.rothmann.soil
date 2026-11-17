import assert from 'node:assert/strict';
import {test} from 'node:test';
import {definitions} from 'zigbee-herdsman-converters/devices/hobeian';
import definition from '../external_converters/hobeian-zg-303z-battery.mjs';

const base = definitions.find((item) => item.model === 'CS-201Z');

test('matches only the inspected HOBEIAN variant', () => {
    assert.equal(definition.zigbeeModel, undefined);
    assert.equal(definition.whiteLabel, undefined);
    assert.deepEqual(definition.fingerprint, [{modelID: 'ZG-303Z', manufacturerName: 'HOBEIAN'}]);
    assert.equal(definition.version, '1.0.0');
});

test('preserves existing sensor settings and datapoints except Tuya battery', () => {
    const device = {modelID: 'ZG-303Z'};
    assert.deepEqual(definition.exposes(device), base.exposes(device).filter((item) => item.property !== 'battery'));
    assert.deepEqual(definition.meta.tuyaDatapoints, base.meta.tuyaDatapoints.filter(([, property]) => property !== 'battery'));
    assert.deepEqual(definition.extend.slice(0, -1), base.extend);
});

test('converts standard battery reports and supports reading/reporting', async () => {
    const extension = definition.extend.at(-1);
    assert.equal(extension.exposes.filter((item) => item.property === 'battery').length, 1);
    const converter = extension.fromZigbee.find((item) => item.cluster === 'genPowerCfg');
    for (const [raw, percent] of [[200, 100], [146, 73], [0, 0]]) {
        const result = await converter.convert({meta: {}}, {data: {batteryPercentageRemaining: raw}}, () => {}, {}, {});
        assert.equal(result.battery, percent);
    }
    assert.ok(extension.toZigbee.some((item) => item.key.includes('battery') && item.convertGet));
    assert.ok(extension.configure.length > 0);
});
