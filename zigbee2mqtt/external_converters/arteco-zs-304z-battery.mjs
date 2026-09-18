import {battery} from 'zigbee-herdsman-converters/lib/modernExtend';
import * as fz from 'zigbee-herdsman-converters/converters/fromZigbee';
import * as tz from 'zigbee-herdsman-converters/converters/toZigbee';
import * as exposes from 'zigbee-herdsman-converters/lib/exposes';
import * as tuya from 'zigbee-herdsman-converters/lib/tuya';

const e = exposes.presets;
const ea = exposes.access;

export default {
    zigbeeModel: ['ZS-304Z'],
    fingerprint: [{modelID: 'ZS-304Z', manufacturerName: 'Arteco'}],
    model: 'ZS-304Z',
    vendor: 'Arteco',
    description: 'Soil moisture sensor with measured battery percentage',
    extend: [tuya.modernExtend.tuyaBase({dp: true}), battery()],
    fromZigbee: [fz.battery],
    toZigbee: [tz.battery_percentage_remaining],
    exposes: [
        e.enum('water_warning', ea.STATE, ['none', 'alarm']).withDescription('Water shortage warning'),
        e.enum('battery_state', ea.STATE, ['low', 'middle', 'high'])
            .withDescription('low: 16.67%, middle:16.68-83.33%, high: 83.34-100%')
            .withCategory('diagnostic'),
        e.soil_moisture(),
        e.temperature(),
        e.humidity(),
        e.illuminance(),
        tuya.exposes.soilSampling(),
        tuya.exposes.soilCalibration(),
        tuya.exposes.humidityCalibration(),
        e.numeric('illuminance_calibration', ea.STATE_SET)
            .withValueMin(-1000)
            .withValueMax(1000)
            .withValueStep(1)
            .withUnit('lx')
            .withDescription('Illuminance calibration'),
        tuya.exposes.temperatureCalibration(),
        tuya.exposes.soilWarning(),
    ],
    meta: {
        tuyaDatapoints: [
            [3, 'soil_moisture', tuya.valueConverter.raw],
            [5, 'temperature', tuya.valueConverter.divideBy10],
            [101, 'humidity', tuya.valueConverter.raw],
            [102, 'illuminance', tuya.valueConverter.raw],
            [14, 'battery_state', tuya.valueConverterBasic.lookup({low: tuya.enum(0), middle: tuya.enum(1), high: tuya.enum(2)})],
            [103, 'soil_sampling', tuya.valueConverter.raw],
            [104, 'soil_calibration', tuya.valueConverter.raw],
            [105, 'humidity_calibration', tuya.valueConverter.raw],
            [106, 'illuminance_calibration', tuya.valueConverter.raw],
            [107, 'temperature_calibration', tuya.valueConverter.divideBy10],
            [110, 'soil_warning', tuya.valueConverter.raw],
            [111, 'water_warning', tuya.valueConverterBasic.lookup({none: tuya.enum(0), alarm: tuya.enum(1)})],
        ],
    },
};
