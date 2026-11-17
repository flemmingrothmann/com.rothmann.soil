import assert from 'node:assert/strict';
import {test} from 'node:test';
import {prepareDefinition} from 'zigbee-herdsman-converters';
import arteco from '../external_converters/arteco-zs-304z-battery.mjs';
import hobeian from '../external_converters/hobeian-zg-303z-battery.mjs';

for (const definition of [arteco, hobeian]) {
    test(`${definition.vendor} compiles all extensions with one readable battery expose`, () => {
        const prepared = prepareDefinition(definition);
        const device = {modelID: definition.model};
        const exposes = typeof prepared.exposes === 'function' ? prepared.exposes(device, {}) : prepared.exposes;
        const batteries = exposes.filter((item) => item.property === 'battery');
        assert.equal(batteries.length, 1);
        assert.ok(batteries[0].access & 4);
        assert.ok(exposes.some((item) => item.property === 'soil_moisture'));
        assert.ok(prepared.fromZigbee.some((item) => item.cluster === 'genPowerCfg'));
        assert.ok(prepared.toZigbee.some((item) => item.key?.includes('battery') && item.convertGet));
        assert.equal(typeof prepared.configure, 'function');
        assert.equal(prepared.version, '1.0.0');
    });
}
