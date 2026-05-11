'use strict';

const TuyaSoilSensorDevice = require('../../lib/tuyaSoilSensorDevice');
const {
  clampSamplingSeconds,
  clampHumidityCalibration,
  clampSoilCalibration,
  clampSoilWarning,
  toTemperatureCalibrationTenths,
} = require('../../lib/tuyaSoilMath');

class ZS301ZDevice extends TuyaSoilSensorDevice {}

ZS301ZDevice.CONFIG = {
  logName: 'ZS-301Z',
  defaults: {
    SAMPLING_SECONDS: 600,
    CALIBRATION: 0,
    SOIL_WARNING_PERCENT: 30,
  },
  pollSettingId: 'soil_sampling',
  adaptiveSamplingDp: 103,
  requiredCapabilities: [
    'measure_soil_moisture',
    'measure_soil_fertility',
    'soil_warning_threshold',
    'measure_temperature',
    'measure_humidity',
    'measure_luminance',
    'measure_battery',
    'alarm_water',
  ],
  dpHandlers: {
    3: { handler: 'soilMoisture' },
    5: { handler: 'temperature', divideBy: 10 },
    14: { handler: 'battery' },
    101: { handler: 'humidity' },
    102: { handler: 'illuminance' },
    103: { handler: 'setting' },
    104: { handler: 'setting' },
    105: { handler: 'setting' },
    106: { handler: 'setting' },
    107: { handler: 'setting' },
    110: { handler: 'setting' },
    111: { handler: 'waterWarning' },
    112: { handler: 'soilFertility' },
    114: { handler: 'setting' },
    115: { handler: 'setting' },
  },
  settingWriters: [
    {
      settingId: 'soil_sampling', dp: 103, transform: clampSamplingSeconds, defaultValue: 600,
    },
    {
      settingId: 'soil_calibration', dp: 104, transform: clampSoilCalibration, defaultValue: 0,
    },
    {
      settingId: 'humidity_calibration', dp: 105, transform: clampHumidityCalibration, defaultValue: 0,
    },
    {
      settingId: 'temperature_calibration', dp: 107, transform: toTemperatureCalibrationTenths, defaultValue: 0,
    },
    {
      settingId: 'soil_warning', dp: 110, transform: clampSoilWarning, defaultValue: 30,
    },
  ],
};

module.exports = ZS301ZDevice;
