'use strict';

const { configureWateringMode, getWateringMode, toggleWateringMode } = require('./lib/wateringMode');

const APP_ID = 'com.rothmann.soil';
const SOIL_WARNING_MIN = 0;
const SOIL_WARNING_MAX = 90;

function normalizeSoilWarningThreshold(value) {
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue)) {
    throw new Error('Jordfugtgrænsen skal være et tal.');
  }

  const threshold = Math.round(parsedValue);
  if (threshold < SOIL_WARNING_MIN || threshold > SOIL_WARNING_MAX) {
    throw new Error(`Jordfugtgrænsen skal være mellem ${SOIL_WARNING_MIN} og ${SOIL_WARNING_MAX} %.`);
  }

  return threshold;
}

function getShortDriverId(driverId) {
  return String(driverId || '').split(':').pop();
}

async function getDeviceInstance(homey, driverId, deviceData) {
  const shortDriverId = getShortDriverId(driverId);
  if (!shortDriverId || !deviceData) {
    throw new Error('Sensoren kunne ikke matches til en Homey-driver.');
  }

  const driver = await homey.drivers.getDriver(shortDriverId);
  await driver.ready();
  return driver.getDevice(deviceData);
}

async function setSoilWarningThreshold(homey, body) {
  const deviceId = String(body?.deviceId || '').trim();
  const driverId = String(body?.driverId || '').trim();
  if (!deviceId) {
    throw new Error('deviceId er påkrævet.');
  }

  const value = normalizeSoilWarningThreshold(body?.value);
  if (!driverId.startsWith(`homey:app:${APP_ID}:`)) {
    throw new Error('Jordfugtsensoren blev ikke fundet i Rothmann Soil-appen.');
  }

  const device = await getDeviceInstance(homey, driverId, body?.deviceData);
  if (!device.hasCapability('measure_soil_moisture') || !device.hasCapability('soil_warning_threshold')) {
    throw new Error('Sensoren understøtter ikke jordfugtgrænse.');
  }

  if (device.getAvailable() === false) {
    throw new Error('Sensoren melder fejl og kan ikke ændres fra dashboardet.');
  }

  if (!Object.prototype.hasOwnProperty.call(device.getSettings() || {}, 'soil_warning')) {
    throw new Error('Sensoren har ingen jordfugtgrænse-indstilling.');
  }

  if (typeof device.setSoilWarningThreshold !== 'function') {
    throw new Error('Sensor-driveren understøtter ikke ændring af jordfugtgrænse fra dashboardet.');
  }

  const threshold = await device.setSoilWarningThreshold(value);
  return { ok: true, deviceId, value: threshold };
}

module.exports = {
  async wateringMode({ homey }) {
    return getWateringMode(homey);
  },

  async toggleWateringMode({ homey }) {
    return toggleWateringMode(homey);
  },

  async configureWateringMode({ homey, body }) {
    return configureWateringMode(homey, body);
  },

  async setSoilWarningThreshold({ homey, body }) {
    return setSoilWarningThreshold(homey, body);
  },
};
