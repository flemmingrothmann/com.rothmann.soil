"use strict";

const fs = require("fs");
const mqtt = require("mqtt");
const { ENERGY_ENTITIES, energyObservation, startEnergyObserver } = require("./energy");

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

let queue = [];
let flushing = false;
let retryDelayMs = MIN_RETRY_DELAY_MS;
let retryTimer = null;

function persistQueue() {
  fs.mkdirSync("/data", { recursive: true });
  fs.writeFileSync(QUEUE_FILE, `${JSON.stringify(queue)}\n`, "utf8");
}

function loadQueue() {
  try {
    const stored = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
    queue = Array.isArray(stored) ? stored : [];
  } catch (error) {
    if (error.code !== "ENOENT")
      console.error(
        `Could not read HA ingest queue: ${error.message || error}`,
      );
  }
}

async function post(pathname, body) {
  const response = await fetch(`${WINGMAN_URL}${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${INGEST_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (response.status !== 202)
    throw new Error(
      `Wingman returned ${response.status}: ${await response.text()}`,
    );
}

async function putRoute(deviceId) {
  const response = await fetch(`${WINGMAN_URL}/api/replay/routes`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${INGEST_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sourceSystem: "home_assistant",
      sourceDeviceId: deviceId,
      targetSystem: "home_assistant",
      targetDeviceId: deviceId,
      validFrom: "2026-08-18T00:00:00.000Z",
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      `Wingman route returned ${response.status}: ${await response.text()}`,
    );
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
    flushQueue().catch((error) => console.error(error.message || error));
  }, retryDelayMs);
}

async function flushQueue() {
  if (flushing || queue.length === 0) return;
  flushing = true;
  try {
    while (queue.length > 0) {
      const event = queue[0];
      await post("/api/sync/external-devices", { devices: [event.device] });
      if (event.device.class === "light") await putRoute(event.device.id);
      await post("/api/ingest", event.events);
      queue.shift();
      persistQueue();
      retryDelayMs = MIN_RETRY_DELAY_MS;
    }
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
  const device = {
    id: entityId,
    name: String(payload.name || entityId),
    zoneId: String(payload.zone_id || "flemmings_vaerelse"),
    zoneName: String(payload.zone_name || "Flemmings værelse"),
    driverId: "home_assistant:light",
    class: "light",
    available: true,
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
    available: true,
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
      value: payload.state === "on",
      source_event_id: `${sourceEventId}:onoff`,
    },
    {
      ...eventBase,
      capability: "dim",
      value: Math.max(0, Math.min(1, Number(payload.brightness || 0) / 255)),
      source_event_id: `${sourceEventId}:dim`,
    },
  ];
  queue.push({ device, events });
  persistQueue();
  flushQueue().catch((error) => console.error(error.message || error));
}

loadQueue();
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
    persistQueue();
    seen.set(state.entity_id, state.last_updated);
    flushQueue().catch((error) => console.error(error.message || error));
  } });
}
const client = mqtt.connect(MQTT_URL, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
});
client.on("connect", () => {
  client.subscribe("homeassistant/wingman/light/state");
  flushQueue().catch((error) => console.error(error.message || error));
});
client.on("message", (_topic, message) => {
  try {
    enqueue(JSON.parse(message.toString()));
  } catch (error) {
    console.error(`Invalid HA light event: ${error.message || error}`);
  }
});
