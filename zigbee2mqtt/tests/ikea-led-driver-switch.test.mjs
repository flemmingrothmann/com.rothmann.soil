import assert from 'node:assert/strict';
import {test} from 'node:test';
import {prepareDefinition} from 'zigbee-herdsman-converters';
import {definitions} from 'zigbee-herdsman-converters/devices/ikea';
import driver from '../external_converters/ikea-led-driver-switch.mjs';

test('IKEA LED driver inherits the current base definition and exposes on/off only', () => {
    const base = definitions.find((definition) => definition.model === driver.model);
    assert.ok(base);
    assert.equal(driver.fingerprint.length, 1);
    assert.deepEqual(driver.fingerprint[0], {
        modelID: 'TRADFRI Driver 30W',
        manufacturerName: 'IKEA of Sweden',
    });
    assert.equal(driver.version, '1.0.0');

    const prepared = prepareDefinition(driver);
    const device = {modelID: 'TRADFRI Driver 30W', manufacturerName: 'IKEA of Sweden'};
    const exposes = typeof prepared.exposes === 'function' ? prepared.exposes(device, {}) : prepared.exposes;

    assert.ok(exposes.some((item) => item.type === 'switch' && item.features?.some((feature) => feature.property === 'state')));
    assert.ok(!exposes.some((item) => ['brightness', 'color_temp', 'color'].includes(item.property)));
    assert.ok(prepared.toZigbee.some((item) => item.key?.includes('state')));
    assert.equal(prepared.version, '1.0.0');
});
