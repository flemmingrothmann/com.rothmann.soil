import {definitions} from 'zigbee-herdsman-converters/devices/ikea';
import * as m from 'zigbee-herdsman-converters/lib/modernExtend';

const base = definitions.find((definition) => definition.model === 'ICPSHC24-30EU-IL-1/ICPSHC24-10EU-IL-2');
if (!base || base.extend?.length !== 3) {
    throw new Error('IKEA LED driver switch extension: expected built-in definition structure was not found');
}

export default {
    ...base,
    zigbeeModel: undefined,
    fingerprint: [{modelID: 'TRADFRI Driver 30W', manufacturerName: 'IKEA of Sweden'}],
    whiteLabel: undefined,
    version: '1.0.0',
    description: 'TRADFRI LED driver, 30 w',
    extend: [base.extend[0], m.onOff(), base.extend[2]],
};
