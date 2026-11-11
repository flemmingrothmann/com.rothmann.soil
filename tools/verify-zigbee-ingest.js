"use strict";

// Run inside home-assistant-wingman-ingest-service on hubert. Read-only.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mqtt = require("mqtt");
const { ZigbeeObserver } = require("./zigbee-observer");
const base = process.env.WINGMAN_URL;
const cache = JSON.parse(fs.readFileSync("/data/zigbee-metadata.json", "utf8"));
const profiles = JSON.parse(fs.readFileSync(process.env.SOIL_PROFILES_FILE, "utf8"));

async function get(pathname) {
  const response = await fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Wingman ${pathname}: ${response.status}`);
  return response.json();
}

async function main() {
  assert.ok(cache.syncedAt, "HA metadata must be cached");
  const snapshot = await get("/api/homey/snapshot");
  let directLights = 0;
  for (const [ieee, identity] of Object.entries(cache.identities)) {
    const meta = cache.metadata[ieee];
    if (profiles[ieee] || meta?.ignored) continue;
    const device = snapshot.devices[identity.id];
    assert.ok(device, `Missing Wingman device ${identity.id}`);
    assert.equal(device.physicalDeviceId, ieee);
    assert.equal(device.zoneId, meta?.zoneId || "ha_unassigned");
    assert.equal(device.name, meta?.name || cache.bridges.find((item) => item.ieee_address === ieee).friendly_name);
    if (!identity.target) continue;
    directLights += 1;
    const query = new URLSearchParams({ sourceSystem: "zigbee2mqtt", deviceId: identity.id, at: new Date().toISOString() });
    const { route } = await get(`/api/replay/routes?${query}`);
    assert.equal(route.targetSystem, "home_assistant");
    assert.equal(route.targetDeviceId, identity.target);
    const history = await get(`/api/events?${new URLSearchParams({ deviceId: identity.id, capability: "onoff", since: identity.validFrom })}`);
    assert.equal(history.values.filter((event) => event.sourceSystem === "home_assistant" && Date.parse(event.t) > Date.parse(identity.validFrom) + 5000).length, 0,
      `Duplicate HA light observer for ${identity.id}`);
  }
  assert.ok(directLights > 0, "Expected direct Zigbee lights");

  // Observe a real incoming MQTT value, then confirm the same source timestamp/value in Wingman.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wingman-zigbee-verify-"));
  fs.copyFileSync("/data/zigbee-metadata.json", path.join(temporary, "zigbee-metadata.json"));
  const cachedObservations = [];
  const offline = new ZigbeeObserver({ directory: temporary, profilesFile: process.env.SOIL_PROFILES_FILE, enqueue: (item) => cachedObservations.push(item) });
  // Simulate an unavailable HA connection without stopping the real HA or its automations.
  const stopOffline = offline.start({ url: "http://127.0.0.1:1", token: "unreachable-test" });
  const client = mqtt.connect(process.env.MQTT_URL, { username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD });
  const observation = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { client.end(true); reject(new Error("No live Z2M numeric observation within 90 seconds")); }, 90000);
    client.on("error", reject);
    client.on("connect", () => client.subscribe("zigbee2mqtt/#"));
    client.on("message", (topic, raw, packet) => {
      if (packet.retain) return;
      try {
        const bridge = cache.bridges.find((item) => topic === `zigbee2mqtt/${item.friendly_name}`);
        if (!bridge || profiles[bridge.ieee_address] || cache.metadata[bridge.ieee_address]?.ignored) return;
        const identity = cache.identities[bridge.ieee_address];
        const payload = JSON.parse(raw);
        const fields = { power: "measure_power", energy: "meter_power", temperature: "measure_temperature", battery: "measure_battery" };
        const field = Object.keys(fields).find((key) => typeof payload[key] === "number");
        if (!identity || !field || !payload.last_seen) return;
        offline.message(topic, raw, packet);
        assert.ok(cachedObservations.some((item) => item.events.some((event) => event.capability === fields[field] && event.value === payload[field])), "Cached metadata must support actual MQTT observations while HA is unreachable");
        clearTimeout(deadline);
        resolve({ id: identity.id, capability: fields[field], value: payload[field], time: new Date(payload.last_seen).toISOString() });
      } catch (error) { clearTimeout(deadline); reject(error); }
    });
  }).finally(() => { client.end(true); stopOffline(); fs.rmSync(temporary, { recursive: true, force: true }); });
  let matched = false;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const { values } = await get(`/api/events?${new URLSearchParams({ deviceId: observation.id, capability: observation.capability, since: observation.time })}`);
    matched = values.some((event) => event.sourceSystem === "zigbee2mqtt" && event.t === observation.time && event.v === observation.value);
    if (matched) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(matched, "Actual MQTT observation must arrive in Wingman unchanged");
  const { states } = await get("/api/current-state");
  const energy = states.filter((state) => state.homey_device_id === "home_assistant:energy_main");
  assert.ok(energy.length >= 4 && energy.every((state) => state.source_system === "home_assistant"));
  const pending = JSON.parse(fs.readFileSync("/data/wingman-queue.json", "utf8"));
  assert.ok(pending.length < 10, `Unexpected backlog: ${pending.length}`);
  console.log(JSON.stringify({ ok: true, metadataSyncedAt: cache.syncedAt, directLights, cachedMetadataDuringHaOutage: true, liveObservation: observation, energyCapabilities: energy.length, queued: pending.length }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
