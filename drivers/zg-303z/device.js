'use strict';

const TuyaSoilSensorDevice = require('../../lib/tuyaSoilSensorDevice');
const {
  clampSamplingSeconds,
  clampHumidityCalibration,
  clampSoilCalibration,
  clampSoilWarning,
  toTemperatureCalibrationTenths,
} = require('../../lib/tuyaSoilMath');

class ZG303ZDevice extends TuyaSoilSensorDevice {}

ZG303ZDevice.CONFIG = {
  logName: 'ZG-303Z',
  defaults: {
    SAMPLING_SECONDS: 1800,
    CALIBRATION: 0,
    SOIL_WARNING_PERCENT: 30,
  },
  pollSettingId: 'soil_sampling',
  adaptiveSamplingDp: 112,
  requiredCapabilities: [
    'measure_soil_moisture',
    'soil_warning_threshold',
    'measure_temperature',
    'measure_humidity',
    'measure_battery',
    'alarm_water',
  ],
  dpHandlers: {
    5: { handler: 'temperature', divideBy: 10 },
    101: { handler: 'temperature', divideBy: 10 },
    3: { handler: 'soilMoisture' },
    107: { handler: 'soilMoisture' },
    15: { handler: 'battery' },
    108: { handler: 'battery' },
    109: { handler: 'humidity' },
    1: { handler: 'waterWarning' },
    14: { handler: 'waterWarning' },
    102: { handler: 'setting' },
    104: { handler: 'setting' },
    105: { handler: 'setting' },
    106: { handler: 'setting' },
    110: { handler: 'setting' },
    111: { handler: 'setting' },
    112: { handler: 'setting' },
  },
  settingWriters: [
    {
      settingId: 'soil_calibration', dp: 102, transform: clampSoilCalibration, defaultValue: 0,
    },
    {
      settingId: 'temperature_calibration', dp: 104, transform: toTemperatureCalibrationTenths, defaultValue: 0,
    },
    {
      settingId: 'humidity_calibration', dp: 105, transform: clampHumidityCalibration, defaultValue: 0,
    },
    {
      settingId: 'soil_warning', dp: 110, transform: clampSoilWarning, defaultValue: 30,
    },
    {
      settingId: 'temperature_sampling', dp: 111, transform: clampSamplingSeconds, defaultValue: 1800,
    },
    {
      settingId: 'soil_sampling', dp: 112, transform: clampSamplingSeconds, defaultValue: 1800,
    },
  ],
};

module.exports = ZG303ZDevice;
