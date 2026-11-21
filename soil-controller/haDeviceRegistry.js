'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeIeee } = require('./zigbeeIdentity');

function buildHaDeviceSnapshot(registryDevices, profileIeees, syncedAt = new Date().toISOString()) {
  if (!Array.isArray(registryDevices) || !Array.isArray(profileIeees)) throw new Error('Invalid Home Assistant device registry snapshot');
  const matches = new Map();
  for (const device of registryDevices) {
    const identifiers = new Set();
    for (const [domain, value] of device.identifiers || []) {
      const match = domain === 'mqtt' && /^zigbee2mqtt_0x[0-9a-f]{16}$/i.exec(String(value));
      if (!match) continue;
      const ieee = normalizeIeee(match[0].slice('zigbee2mqtt_'.length));
      if (ieee) identifiers.add(ieee);
    }
    for (const ieee of identifiers) {
      const ids = matches.get(ieee) || [];
      ids.push(typeof device.id === 'string' && device.id ? device.id : null);
      matches.set(ieee, ids);
    }
  }
  const devices = {};
  for (const value of profileIeees) {
    const ieee = normalizeIeee(value);
    if (!ieee) throw new Error('Invalid soil profile IEEE in Home Assistant mapping');
    const ids = matches.get(ieee) || [];
    devices[ieee] = ids.length === 1 && ids[0] ? ids[0] : null;
  }
  return { version: 1, syncedAt, devices };
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1 || typeof snapshot.syncedAt !== 'string'
    || !Number.isFinite(Date.parse(snapshot.syncedAt)) || !snapshot.devices
    || typeof snapshot.devices !== 'object' || Array.isArray(snapshot.devices)) {
    throw new Error('Invalid persisted Home Assistant device registry snapshot');
  }
  for (const [ieee, id] of Object.entries(snapshot.devices)) {
    if (normalizeIeee(ieee) !== ieee || !(id === null || (typeof id === 'string' && id))) {
      throw new Error('Invalid persisted Home Assistant device registry mapping');
    }
  }
  return snapshot;
}

function loadHaDeviceSnapshot(filePath) {
  try {
    return validateSnapshot(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function persistHaDeviceSnapshot(filePath, snapshot) {
  validateSnapshot(snapshot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

module.exports = { buildHaDeviceSnapshot, validateSnapshot, loadHaDeviceSnapshot, persistHaDeviceSnapshot };
