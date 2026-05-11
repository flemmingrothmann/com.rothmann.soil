'use strict';

function clampNumber(value, min, max) {
  if (Number.isNaN(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

function clampInt(value, min, max) {
  return Math.round(clampNumber(value, min, max));
}

function clampPercent(value) {
  return clampNumber(value, 0, 100);
}

function rawTemperatureTimes10ToCelsius(rawTimes10) {
  return rawTimes10 / 10;
}

function clampSamplingSeconds(seconds) {
  return clampInt(seconds, 5, 3600);
}

function clampHumidityCalibration(offset) {
  return clampInt(offset, -30, 30);
}

function clampSoilCalibration(offset) {
  return clampInt(offset, -30, 30);
}

function clampSoilWarning(percent) {
  return clampInt(percent, 0, 100);
}

function toTemperatureCalibrationTenths(offsetC) {
  return clampInt(offsetC * 10, -20, 20);
}

function clampIlluminanceCalibration(offset) {
  return clampInt(offset, -1000, 1000);
}

module.exports = {
  clampNumber,
  clampInt,
  clampPercent,
  rawTemperatureTimes10ToCelsius,
  clampSamplingSeconds,
  clampHumidityCalibration,
  clampSoilCalibration,
  clampSoilWarning,
  toTemperatureCalibrationTenths,
  clampIlluminanceCalibration,
};
