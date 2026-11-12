'use strict';

function normalizeIeee(value) {
  const ieee = String(value || '').toLowerCase();
  return /^0x[0-9a-f]{16}$/.test(ieee) ? ieee : null;
}

function profileMatchesDevice(id, profile, device) {
  const ieee = normalizeIeee(id);
  const deviceIeees = (device.device_keys || []).map((key) => normalizeIeee(String(key).replace(/^zigbee2mqtt_/i, ''))).filter(Boolean);
  if (deviceIeees.length) return deviceIeees.includes(ieee);
  return Boolean(profile.haDeviceId && device.device_id && profile.haDeviceId === device.device_id);
}

class ZigbeeIdentityRoutes {
  constructor(devices = []) {
    this.replace(devices);
  }

  replace(devices) {
    if (!Array.isArray(devices)) throw new Error('Zigbee inventory must be an array');
    const records = new Map();
    for (const device of devices) {
      const ieee = normalizeIeee(device.ieee_address);
      if (!ieee || device.type === 'Coordinator') continue;
      if (records.has(ieee)) throw new Error(`Duplicate Zigbee IEEE address: ${ieee}`);
      if (typeof device.friendly_name !== 'string' || !device.friendly_name || /[+#\u0000]/.test(device.friendly_name))
        throw new Error(`Invalid Zigbee topic for ${ieee}`);
      records.set(ieee, { ieee_address: ieee, friendly_name: device.friendly_name });
    }
    const topics = new Map();
    for (const { ieee_address: ieee, friendly_name: name } of records.values()) {
      for (const topic of new Set([`zigbee2mqtt/${name}`, `zigbee2mqtt/${ieee}`])) {
        const owners = topics.get(topic) || new Set();
        owners.add(ieee);
        topics.set(topic, owners);
      }
    }
    this.records = records;
    this.topics = topics;
  }

  snapshot() {
    return [...this.records.values()].sort((left, right) => left.ieee_address.localeCompare(right.ieee_address));
  }

  resolve(topic, profiles) {
    const owners = this.topics.get(topic);
    if (!owners || owners.size !== 1) return null;
    const [ieee] = owners;
    const matches = Object.entries(profiles).filter(([id]) => normalizeIeee(id) === ieee);
    if (matches.length > 1) throw new Error(`Ambiguous soil profile identity: ${ieee}`);
    return matches[0] || null;
  }
}

function cachedStateByIeee(states, id) {
  const ieee = normalizeIeee(id);
  if (!ieee) return null;
  const matches = Object.entries(states).filter(([key]) => normalizeIeee(key) === ieee);
  return matches.length === 1 ? matches[0][1] : null;
}

function observeProfileTopics(client, { profiles, routes = new ZigbeeIdentityRoutes(), onInventory, onDevices = () => {}, onObservation, onAlarm, onControl, onError }) {
  let ready = false;
  let stateSubscribed = false;
  client.on('connect', () => {
    ready = false;
    client.subscribe(['zigbee2mqtt/bridge/devices', 'homeassistant/soil/#'], { qos: 1 });
  });
  client.on('close', () => { ready = false; });
  client.on('message', (topic, payload) => {
    try {
      if (topic === 'zigbee2mqtt/bridge/devices') {
        ready = false;
        const devices = JSON.parse(payload.toString());
        const next = new ZigbeeIdentityRoutes(devices);
        if (JSON.stringify(next.snapshot()) !== JSON.stringify(routes.snapshot())) onInventory(next.snapshot());
        routes = next;
        ready = true;
        if (!stateSubscribed) {
          stateSubscribed = true;
          client.subscribe('zigbee2mqtt/#', { qos: 1 });
        }
        onDevices(devices);
        return;
      }
      if (!payload.length) return; // MQTT clears retained topics during a rename; this is not a reading/alarm.
      const alarms = Object.entries(profiles).filter(([, profile]) => topic === profile.alarmTopic);
      const controls = Object.entries(profiles).filter(([, profile]) => topic === profile.controlTopic);
      if (alarms.length + controls.length > 1) throw new Error(`Ambiguous soil alarm topic: ${topic}`);
      const entry = controls[0] || alarms[0] || (ready ? routes.resolve(topic, profiles) : null);
      if (!entry) return;
      const [id, profile] = entry;
      const work = controls.length ? onControl(id, profile, payload) : alarms.length ? onAlarm(id, profile, payload) : onObservation(id, profile, payload);
      Promise.resolve(work).catch(onError);
    } catch (error) { onError(error); }
  });
}

module.exports = { normalizeIeee, profileMatchesDevice, ZigbeeIdentityRoutes, cachedStateByIeee, observeProfileTopics };
