import {definitions} from 'zigbee-herdsman-converters/devices/hobeian';
import {battery} from 'zigbee-herdsman-converters/lib/modernExtend';

// This hardware uses the CS-201Z datapoints, not the TS0601 sold as ZG-303Z.
const base = definitions.find((definition) => definition.model === 'CS-201Z');
if (!base || !base.zigbeeModel?.includes('ZG-303Z')) {
    throw new Error('HOBEIAN battery extension: compatible CS-201Z definition not found');
}

export default {
    ...base,
    zigbeeModel: undefined,
    fingerprint: [{modelID: 'ZG-303Z', manufacturerName: 'HOBEIAN'}],
    whiteLabel: undefined,
    model: 'ZG-303Z',
    version: '1.0.0',
    vendor: 'HOBEIAN',
    description: 'Soil moisture sensor with measured battery percentage',
    extend: [...base.extend, battery()],
    exposes: (device, options) => base.exposes(device, options).filter((expose) => expose.property !== 'battery'),
    meta: {
        ...base.meta,
        // Use genPowerCfg exclusively so Tuya datapoints cannot overwrite it.
        tuyaDatapoints: base.meta.tuyaDatapoints.filter(([, property]) => property !== 'battery'),
    },
};
