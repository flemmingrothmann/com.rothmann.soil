import {definitions} from 'zigbee-herdsman-converters/devices/tuya';
import {battery} from 'zigbee-herdsman-converters/lib/modernExtend';

// Inherit upstream calibration/illuminance fixes instead of copying datapoints.
const base = definitions.find((definition) => definition.model === 'ZS-300Z' && definition.zigbeeModel?.includes('ZS-304Z'));
if (!base) {
    throw new Error('Arteco battery extension: compatible ZS-300Z definition not found');
}

export default {
    ...base,
    zigbeeModel: undefined,
    fingerprint: [{modelID: 'ZS-304Z', manufacturerName: 'Arteco'}],
    whiteLabel: undefined,
    model: 'ZS-304Z',
    vendor: 'Arteco',
    version: '1.0.0',
    description: 'Soil moisture sensor with measured battery percentage',
    extend: [...base.extend, battery()],
};
