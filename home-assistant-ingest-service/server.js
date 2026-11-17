"use strict";

const mqtt = require("mqtt");
const { ENERGY_ENTITIES, energyObservation, startEnergyObserver } = require("./energy");
const { PersistentQueue, readJson, writeJson } = require("./storage");
const { ZigbeeObserver } = require("./zigbee-observer");
const { createDelivery, drainQueue } = require("./delivery");

const MQTT_URL = process.env.MQTT_URL || "mqtt://mosquitto:1883";
const MQTT_USERNAME = process.env.MQTT_USERNAME || "";
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || "";
const WINGMAN_URL = (process.env.WINGMAN_URL || "").replace(/\/$/, "");
const INGEST_TOKEN = process.env.INGEST_TOKEN || "";
const QUEUE_FILE = process.env.QUEUE_FILE || "/data/wingman-queue.json";
const MIN_RETRY_DELAY_MS = 15000;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

if (!WINGMAN_URL || !INGEST_TOKEN)
  throw new Error("WINGMAN_URL and INGEST_TOKEN must be configured");

const queue = new PersistentQueue(QUEUE_FILE);
let flushing = false;
let retryDelayMs = MIN_RETRY_DELAY_MS;
let retryTimer = null;
const deliver = createDelivery({ url: WINGMAN_URL, token: INGEST_TOKEN,
  shouldSyncDevice: (device) => !(device.sourceSystem === "zigbee2mqtt" && process.env.SOIL_PROFILES_FILE
    && readJson(process.env.SOIL_PROFILES_FILE, {})[device.id]),
});

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
    flushQueue().catch((error) => console.error(error.message || error));
  }, retryDelayMs);
}

async function flushQueue() {
  if (flushing || queue.length === 0 || (zigbee && !zigbee.inventoryFresh)) return;
  flushing = true;
  try {
    await drainQueue(queue, deliver);
    retryDelayMs = MIN_RETRY_DELAY_MS;
  } catch (error) {
    scheduleRetry();
    throw error;
  } finally {
    flushing = false;
  }
}

function enqueue(payload) {
  const timestamp = payload.time || new Date().toISOString();
  const entityId = String(payload.entity_id || "");
  if (!/^light\.[a-z0-9_]+$/i.test(entityId))
    throw new Error("entity_id must be a light entity");
  if (zigbee?.suppressHa(entityId)) return;
  const available = ["on", "off"].includes(payload.state);
  const device = {
    id: entityId,
    name: String(payload.name || entityId),
    zoneId: String(payload.zone_id || "ha_unassigned"),
    zoneName: String(payload.zone_name || "Uplaceret"),
    driverId: "home_assistant:light",
    class: "light",
    available,
    capabilities: ["onoff", "dim"],
    sourceSystem: "home_assistant",
  };
  const eventBase = {
    time: timestamp,
    homey_device_id: entityId,
    homey_zone_id: device.zoneId,
    device_name: device.name,
    driver_id: device.driverId,
    device_class: "light",
    available,
    source_system: "home_assistant",
    source_instance: "hubert-home-assistant",
    author_system: payload.author_system || null,
    event_type: "observation",
  };
  const sourceEventId = `${entityId}:${timestamp}`;
  const events = [
    {
      ...eventBase,
      capability: "onoff",
      value: available ? payload.state === "on" : null,
      source_event_id: `${sourceEventId}:onoff`,
    },
    {
      ...eventBase,
      capability: "dim",
      value: available ? Math.max(0, Math.min(1, Number(payload.brightness || 0) / 255)) : null,
      source_event_id: `${sourceEventId}:dim`,
    },
  ];
  queue.push({ device, events });
  flushQueue().catch((error) => console.error(error.message || error));
}

const zigbee = process.env.ZIGBEE_INGEST_ENABLED === "true" ? new ZigbeeObserver({
  profilesFile: process.env.SOIL_PROFILES_FILE,
  enqueue: (item) => { queue.push(item); flushQueue().catch((error) => console.error(error.message)); },
}) : null;
if (zigbee) {
  if (!process.env.HOME_ASSISTANT_URL || !process.env.HOME_ASSISTANT_TOKEN)
    throw new Error("Zigbee metadata requires HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN");
  zigbee.start({ url: process.env.HOME_ASSISTANT_URL, token: process.env.HOME_ASSISTANT_TOKEN });
  setInterval(() => {
    const status = { ...zigbee.status(), queued: queue.length, recordedAt: new Date().toISOString() };
    writeJson("/data/zigbee-status.json", status);
    console.log(`Zigbee ingest ${JSON.stringify(status)}`);
  }, 60000).unref();
}
if (process.env.HA_ENERGY_ENABLED === "true") {
  const url = process.env.HOME_ASSISTANT_URL;
  const token = process.env.HOME_ASSISTANT_TOKEN;
  if (!url || !token) throw new Error("HA energy requires HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN");
  const options = {
    id: process.env.HA_ENERGY_DEVICE_ID || "home_assistant:energy_main",
    name: "Elmåler (HA)",
    zoneId: process.env.HA_ENERGY_ZONE_ID || "home",
    zoneName: process.env.HA_ENERGY_ZONE_NAME || "Hjem",
  };
  const seen = new Map();
  startEnergyObserver({ url, token, onState: (state) => {
    if (seen.get(state.entity_id) === state.last_updated) return;
    const event = energyObservation(state, options);
    if (!event) return;
    queue.push({ device: {
      id: options.id, name: options.name, zoneId: options.zoneId, zoneName: options.zoneName,
      driverId: event.driver_id, class: "sensor", sourceSystem: "home_assistant",
      available: event.available, capabilities: Object.values(ENERGY_ENTITIES).map(([capability]) => capability),
    }, events: [event] });
    seen.set(state.entity_id, state.last_updated);
    flushQueue().catch((error) => console.error(error.message || error));
  } });
}
const client = mqtt.connect(MQTT_URL, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
});
let inventorySubscribed = false;
client.on("connect", () => {
  if (zigbee) {
    zigbee.invalidateInventory();
    inventorySubscribed = false;
  }
  client.subscribe("homeassistant/wingman/light/state");
  if (zigbee) client.subscribe("zigbee2mqtt/bridge/devices", { qos: 1 });
  flushQueue().catch((error) => console.error(error.message || error));
});
client.on("message", (topic, message, packet) => {
  try {
    if (topic === "homeassistant/wingman/light/state") enqueue(JSON.parse(message.toString()));
    else if (zigbee) {
      zigbee.message(topic, message, packet);
      if (topic === "zigbee2mqtt/bridge/devices" && !inventorySubscribed) {
        inventorySubscribed = true;
        client.subscribe("zigbee2mqtt/#", { qos: 1 });
      }
    }
  } catch (error) {
    console.error(`Ingest message failed (${topic}): ${error.message || error}`);
    if (error.code && error.code !== "ENOENT") process.exit(1);
  }
});
client.on("error", (error) => console.error(`MQTT ingest: ${error.message}`));
flushQueue().catch((error) => console.error(error.message));
