"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { registryMetadata } = require("../home-assistant-ingest-service/registry");
const { deviceModel, observationBatch } = require("../home-assistant-ingest-service/zigbee");
const { ZigbeeObserver } = require("../home-assistant-ingest-service/zigbee-observer");
const { PersistentQueue, readJson, writeJson } = require("../home-assistant-ingest-service/storage");
const { createDelivery, drainQueue, resolveSoilOwnedInventorySnapshot } = require("../home-assistant-ingest-service/delivery");
const { getHomeAssistantLightTarget } = require("../dashboard/server");
const { validateExternalDeviceInventory, reconcileExternalDeviceInventory } = require("../ingest-service/externalDeviceInventory");
const { activeIdentities } = require("../tools/verify-zigbee-ingest");

const ieee = "0x1234567890abcdef";
const time = "2026-11-11T12:00:00.000Z";
const bridge = { ieee_address: ieee, type: "Router", friendly_name: "MQTT name", definition: {
  vendor: "Test", model: "Light", exposes: [
    { type: "light", features: [
      { name: "state", property: "state", access: 7, value_on: "ON", value_off: "OFF" },
      { name: "brightness", property: "brightness", access: 7, value_max: 254 },
    ] },
    { name: "power", property: "power", access: 5, unit: "W" },
    { name: "energy", property: "energy", access: 5, unit: "kWh" },
    { name: "linkquality", property: "linkquality", access: 1 },
    { name: "power_on_behavior", property: "power_on_behavior", category: "config", access: 7 },
  ],
} };

function registry(overrides = {}) {
  return { devices: [{ id: "ha-device", name: "HA name", name_by_user: "Kontorlys", area_id: "kontor", identifiers: [["mqtt", `zigbee2mqtt_${ieee}`]], labels: [] }],
    entities: [{ id: "registry-light", device_id: "ha-device", platform: "mqtt", entity_id: "light.office", labels: [] }],
    areas: [{ area_id: "kontor", name: "Kontor" }], labels: [{ label_id: "wingman_ignore", name: "wingman-ignore" }], ...overrides };
}

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wingman-zigbee-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function setup(t, profiles) {
  const directory = temporary(t);
  const envelopes = [];
  const profilesFile = profiles ? path.join(directory, "profiles.json") : undefined;
  if (profilesFile) writeJson(profilesFile, profiles);
  const observer = new ZigbeeObserver({ directory, profilesFile, enqueue: (item) => envelopes.push(item), now: () => time });
  observer.snapshot(registryMetadata(registry()));
  observer.message("zigbee2mqtt/bridge/devices", Buffer.from(JSON.stringify([bridge])));
  envelopes.length = 0;
  return { observer, directory, envelopes, profilesFile };
}

test("HA names and entity-area overrides are authoritative, never inferred from MQTT names", () => {
  const data = registry();
  data.entities[0].area_id = "workshop";
  data.areas.push({ area_id: "workshop", name: "Værksted" });
  const meta = registryMetadata(data)[ieee];
  assert.equal(meta.name, "Kontorlys");
  assert.equal(meta.zoneName, "Værksted");
  assert.equal(meta.haDeviceId, "ha-device");
  data.entities[0].area_id = null;
  data.devices[0].area_id = null;
  assert.equal(registryMetadata(data)[ieee].zoneName, "Uplaceret");
});

test("mapping uses exact MQTT IEEE identifier, rejects ambiguous physical identities", () => {
  const data = registry();
  data.devices.push({ ...data.devices[0], id: "another-device" });
  assert.throws(() => registryMetadata(data), /Ambiguous/);
  data.devices = [{ ...data.devices[0], identifiers: [["mqtt", `zigbee2mqtt_bridge_${ieee}`]] }];
  assert.deepEqual(registryMetadata(data), {});
});

test("switch-as-light helpers map to their actual MQTT switch, including inversion", () => {
  const data = registry();
  data.entities = [
    { id: "switch", entity_id: "switch.plug", device_id: "ha-device", platform: "mqtt" },
    { id: "helper", entity_id: "light.christmas", device_id: "ha-device", platform: "switch_as_x", options: { switch_as_x: { entity_id: "switch.plug", invert: true } } },
  ];
  const meta = registryMetadata(data)[ieee];
  assert.equal(meta.lightEntityId, "light.christmas");
  const model = deviceModel(bridge, meta);
  const result = observationBatch(model, { state: "ON" }, { receivedAt: time, messageId: "a" });
  assert.equal(result.events[0].value, false);
  data.entities[0].entity_category = "config";
  assert.equal(registryMetadata(data)[ieee].lightEntityId, null);
});

test("ambiguous or disabled light helpers are not silently taken over", () => {
  const data = registry();
  data.entities.push({ ...data.entities[0], id: "other", entity_id: "light.other" });
  assert.equal(registryMetadata(data)[ieee].ambiguousLights, true);
  assert.equal(registryMetadata(data)[ieee].lightEntityId, null);
  data.entities[1].disabled_by = "user";
  assert.equal(registryMetadata(data)[ieee].lightEntityId, "light.office");
});

test("device, light-helper and sensor wingman-ignore labels are respected", () => {
  const data = registry();
  data.devices[0].labels = ["wingman_ignore"];
  assert.equal(registryMetadata(data)[ieee].ignored, true);
  data.devices[0].labels = [];
  data.entities[0].labels = ["wingman_ignore"];
  assert.equal(registryMetadata(data)[ieee].ignored, true);
  data.entities[0].labels = [];
  data.entities.push({ entity_id: "sensor.power", device_id: "ha-device", unique_id: `${ieee}_power_zigbee2mqtt`, labels: ["wingman_ignore"] });
  const model = deviceModel(bridge, registryMetadata(data)[ieee]);
  assert.equal(observationBatch(model, { power: 123 }, { receivedAt: time, messageId: "a" }).events.length, 0);
});

test("direct light observations preserve history identity, correct scale, energy units and uncertain author", () => {
  const model = deviceModel(bridge, registryMetadata(registry())[ieee]);
  const result = observationBatch(model, { state: "ON", brightness: 254, power: 42, energy: 123.456, linkquality: 180, last_seen: time }, { receivedAt: time });
  assert.equal(model.id, "light.office");
  assert.deepEqual(result.events.map((event) => event.capability), ["onoff", "dim", "measure_power", "meter_power", "linkquality"]);
  assert.equal(result.events.find((event) => event.capability === "dim").value, 1);
  assert.equal(result.events.find((event) => event.capability === "meter_power").value, 123.456);
  for (const event of result.events) {
    assert.equal(event.source_system, "zigbee2mqtt");
    assert.equal(event.author_system, null);
    assert.equal(event.homey_device_id, "light.office");
    assert.equal(event.payload.ieee_address, ieee);
  }
});

test("missing, null, non-numeric and unknown on/off states never become zero or false", () => {
  const model = deviceModel(bridge, registryMetadata(registry())[ieee]);
  for (const payload of [{}, { power: null }, { power: "" }, { power: "42" }, { state: "TOGGLE" }, { brightness: "NaN" }]) {
    assert.deepEqual(observationBatch(model, payload, { receivedAt: time, messageId: "a" }).events, []);
  }
});

test("retained readings keep source time, untimestamped cache cannot pretend to be live", () => {
  const model = deviceModel(bridge, registryMetadata(registry())[ieee]);
  assert.equal(observationBatch(model, { state: "ON" }, { receivedAt: time, retained: true }).events.length, 0);
  const old = "2026-11-10T09:00:00.000Z";
  assert.equal(observationBatch(model, { state: "ON", last_seen: old }, { receivedAt: time, retained: true }).events[0].time, old);
});

test("repeated power payloads do not create repeated replay actions or retained duplicates", () => {
  const model = deviceModel(bridge, registryMetadata(registry())[ieee]);
  const first = observationBatch(model, { state: "ON", brightness: 100, power: 1, last_seen: time }, { receivedAt: time });
  const next = observationBatch(model, { state: "ON", brightness: 100, power: 2, last_seen: time }, { receivedAt: time, previous: first.values });
  assert.deepEqual(next.events.map((event) => event.capability), ["measure_power"]);
  assert.equal(observationBatch(model, { state: "ON", brightness: 100, power: 2, last_seen: time }, { receivedAt: time, retained: true, previous: next.values }).events.length, 0);
});

test("contact inversion and explicit millivolt conversion are correct", () => {
  const sensor = { ...bridge, definition: { vendor: "Test", model: "Contact", exposes: [
    { name: "contact", property: "contact", access: 1 }, { name: "voltage", property: "voltage", access: 1, unit: "mV" },
  ] } };
  const model = deviceModel(sensor);
  const result = observationBatch(model, { contact: false, voltage: 3000 }, { receivedAt: time, messageId: "a" });
  assert.equal(model.id, ieee);
  assert.equal(model.zoneName, "Uplaceret");
  assert.deepEqual(result.events.map((event) => [event.capability, event.value]), [["alarm_contact", true], ["measure_voltage", 3]]);
});

test("HA outage and adapter restart preserve metadata, history ids and HA-event suppression", (t) => {
  const { observer, directory, envelopes } = setup(t);
  observer.message("zigbee2mqtt/MQTT name", Buffer.from(JSON.stringify({ state: "ON", last_seen: time })));
  assert.equal(envelopes[0].device.zoneName, "Kontor");
  assert.equal(observer.suppressHa("light.office"), true);
  assert.equal(observer.suppressHa("light.group"), false);
  const restarted = new ZigbeeObserver({ directory, enqueue: (item) => envelopes.push(item), now: () => time });
  restarted.message("zigbee2mqtt/MQTT name", Buffer.from(JSON.stringify({ state: "OFF", last_seen: time })));
  assert.equal(restarted.raw.length, 1);
  restarted.message("zigbee2mqtt/bridge/devices", Buffer.from(JSON.stringify([bridge])));
  assert.equal(envelopes.at(-1).events[0].homey_device_id, "light.office");
  assert.equal(envelopes.at(-1).device.zoneName, "Kontor");
  assert.equal(restarted.suppressHa("light.office"), true);
});

test("HA metadata changes sync without inventing observations; entity rename versions replay target", (t) => {
  const { observer, envelopes } = setup(t);
  const originalRoute = observer.models[ieee].route;
  const data = registry();
  data.devices[0].name_by_user = "Nyt navn";
  data.areas[0].name = "Nyt område";
  data.entities[0].entity_id = "light.renamed";
  observer.now = () => "2026-11-11T13:00:00.000Z";
  observer.snapshot(registryMetadata(data));
  const inventory = envelopes.at(-1).inventorySnapshot;
  assert.equal(inventory.devices[0].name, "Nyt navn");
  assert.equal(inventory.devices[0].zoneName, "Nyt område");
  assert.equal(inventory.devices[0].id, "light.office");
  assert.equal(inventory.devices[0].inventorySource, "zigbee2mqtt");
  assert.equal(inventory.routes[0].targetDeviceId, "light.renamed");
  assert.notEqual(inventory.routes[0].validFrom, originalRoute.validFrom);
  const count = envelopes.length;
  observer.snapshot(registryMetadata(data));
  assert.equal(envelopes.length, count);
});

test("soil ownership excludes direct duplicates, including newly added profiles", (t) => {
  const { observer, envelopes, profilesFile } = setup(t, {});
  writeJson(profilesFile, { [ieee]: { name: "Existing soil controller" } });
  observer.message("zigbee2mqtt/MQTT name", Buffer.from('{"state":"ON"}'));
  assert.equal(envelopes.length, 0);
  assert.equal(observer.raw.length, 0);
});

test("first boot spools observations durably until HA metadata arrives", (t) => {
  const directory = temporary(t);
  const envelopes = [];
  const options = { directory, enqueue: (item) => envelopes.push(item), now: () => time };
  const observer = new ZigbeeObserver(options);
  observer.message("zigbee2mqtt/bridge/devices", Buffer.from(JSON.stringify([bridge])));
  observer.message("zigbee2mqtt/MQTT name", Buffer.from('{"state":"ON"}'));
  assert.equal(observer.raw.length, 1);
  assert.equal(envelopes.length, 0);
  const restarted = new ZigbeeObserver(options);
  restarted.snapshot(registryMetadata(registry()));
  assert.equal(restarted.raw.length, 1);
  restarted.message("zigbee2mqtt/bridge/devices", Buffer.from(JSON.stringify([bridge])));
  assert.equal(restarted.raw.length, 0);
  assert.equal(envelopes.at(-1).events[0].homey_device_id, "light.office");
});

test("fresh Z2M inventory emits scoped reconciliation and drops removed cached observations", (t) => {
  const protectedIeee = "0xabcdefabcdefabcd";
  const { observer, envelopes } = setup(t, { [protectedIeee]: { name: "Soil-owned" } });
  observer.message("zigbee2mqtt/MQTT name", Buffer.from('{"state":"ON"}'));
  assert.ok(observer.cache.values[ieee]);

  assert.throws(() => observer.message("zigbee2mqtt/bridge/devices", Buffer.from("[]")), /Invalid Z2M device inventory/);
  const replacement = { ...bridge, ieee_address: "0xfedcba0987654321", friendly_name: "Replacement" };
  observer.message("zigbee2mqtt/bridge/devices", Buffer.from(JSON.stringify([replacement])));
  const snapshot = envelopes.at(-1).inventorySnapshot;
  assert.deepEqual(snapshot.devices.map((device) => device.id), [replacement.ieee_address]);
  assert.deepEqual(snapshot.protectedDeviceIds, [protectedIeee]);
  assert.equal(Object.hasOwn(observer.cache.values, ieee), false);
  assert.equal(observer.cache.identities[ieee].id, "light.office");
  const count = envelopes.length;
  observer.message("zigbee2mqtt/bridge/devices", Buffer.from(JSON.stringify([replacement])));
  assert.equal(envelopes.length, count);
});

test("verifier ignores retained identities absent from current bridge inventory", () => {
  const activeIdentity = { id: "active-device" };
  const cache = {
    bridges: [{ ieee_address: ieee }],
    identities: {
      [ieee]: activeIdentity,
      "0xc02cedfffeefc4fd": { id: "removed-device" },
    },
  };
  assert.deepEqual(activeIdentities(cache), [[ieee, activeIdentity]]);
});

test("new unplaced devices retain IEEE identity when HA metadata arrives later", (t) => {
  const directory = temporary(t);
  const envelopes = [];
  const observer = new ZigbeeObserver({ directory, enqueue: (item) => envelopes.push(item), now: () => time });
  observer.snapshot({});
  observer.message("zigbee2mqtt/bridge/devices", Buffer.from(JSON.stringify([bridge])));
  assert.equal(observer.models[ieee].id, ieee);
  assert.equal(observer.models[ieee].zoneName, "Uplaceret");
  observer.snapshot(registryMetadata(registry()));
  assert.equal(observer.models[ieee].id, ieee);
  assert.equal(observer.models[ieee].haEntityId, "light.office");
  assert.equal(observer.models[ieee].route.sourceDeviceId, ieee);
  assert.equal(observer.suppressHa("light.office"), true);
  assert.equal(getHomeAssistantLightTarget(observer.models[ieee]), "light.office");
});

test("only inventory state topics are observations, never commands or config subtopics", (t) => {
  const { observer, envelopes } = setup(t);
  for (const suffix of ["/set", "/get", "/action", "/unrecognized"])
    observer.message(`zigbee2mqtt/MQTT name${suffix}`, Buffer.from('{"state":"ON"}'));
  assert.equal(envelopes.length, 0);
});

test("offline observations are null, and reconnect allows an unchanged state to recover", (t) => {
  const { observer, envelopes } = setup(t);
  observer.message("zigbee2mqtt/MQTT name", Buffer.from('{"state":"ON"}'));
  observer.message("zigbee2mqtt/MQTT name/availability", Buffer.from('{"state":"offline"}'));
  assert.ok(envelopes.at(-1).events.every((event) => event.value === null && event.available === false));
  observer.message("zigbee2mqtt/MQTT name/availability", Buffer.from('online'));
  assert.deepEqual(envelopes.at(-1).events, []);
  observer.message("zigbee2mqtt/MQTT name", Buffer.from('{"state":"ON"}'));
  assert.equal(envelopes.at(-1).events[0].value, true);
});

test("queue survives restart, rejects corrupt storage and never evicts unacknowledged events", (t) => {
  const directory = temporary(t);
  const filename = path.join(directory, "queue.json");
  const queue = new PersistentQueue(filename);
  queue.push({ events: [1] });
  assert.deepEqual(new PersistentQueue(filename).first, { events: [1] });
  queue.shift();
  assert.deepEqual(readJson(filename), []);
  fs.writeFileSync(filename, '{"damaged":');
  assert.throws(() => new PersistentQueue(filename));
});

test("failed delivery retains durable queue, only 202 acknowledges ingestion", async (t) => {
  const filename = path.join(temporary(t), "queue.json");
  const queue = new PersistentQueue(filename);
  const device = deviceModel(bridge, registryMetadata(registry())[ieee]);
  queue.push({ device, events: [{ capability: "onoff", value: true }] });
  let status = 500;
  const calls = [];
  const deliver = createDelivery({ url: "http://wingman", token: "test", fetchImpl: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const code = url.endsWith("/api/ingest") ? status : 202;
    return { status: code, ok: code < 300, text: async () => "failure details" };
  } });
  await assert.rejects(drainQueue(queue, deliver), /500: failure details/);
  assert.equal(new PersistentQueue(filename).length, 1);
  status = 200;
  await assert.rejects(drainQueue(queue, deliver), /200/);
  assert.equal(queue.length, 1);
  status = 202;
  await drainQueue(queue, deliver);
  assert.equal(queue.length, 0);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/sync/external-devices")).length, 1);
});

test("inventory delivery is retained until reconciliation returns 202", async (t) => {
  const queue = new PersistentQueue(path.join(temporary(t), "inventory-queue.json"));
  queue.push({ inventorySnapshot: { inventorySource: "zigbee2mqtt", devices: [], protectedDeviceIds: [], routes: [] } });
  let status = 503;
  const calls = [];
  const deliver = createDelivery({ url: "http://wingman", token: "test", fetchImpl: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { status, ok: status < 300, text: async () => "unavailable" };
  } });
  await assert.rejects(drainQueue(queue, deliver), /503: unavailable/);
  assert.equal(queue.length, 1);
  status = 202;
  await drainQueue(queue, deliver);
  assert.equal(queue.length, 0);
  assert.equal(calls[0].url, "http://wingman/api/sync/external-device-inventory");
});

test("queued Z2M inventory excludes newly profile-owned soil rows at delivery time", async () => {
  const oldSnapshot = { inventorySource: "zigbee2mqtt", devices: [
    { id: "legacy-history-id", physicalDeviceId: ieee, inventorySource: "zigbee2mqtt" },
    { id: "watering-ieee", ieee: "watering-ieee", capabilities: ["measure_soil_moisture"], inventorySource: "zigbee2mqtt" },
    { id: "unowned-ieee", ieee: "unowned-ieee", capabilities: ["measure_soil_moisture"], inventorySource: "zigbee2mqtt" },
  ], protectedDeviceIds: ["already-protected"], routes: [
    { sourceDeviceId: "legacy-history-id", targetDeviceId: "target-soil" },
    { sourceDeviceId: "watering-ieee", targetDeviceId: "target-valve" },
    { sourceDeviceId: "unowned-ieee", targetDeviceId: "target-unowned" },
  ] };
  const originalSnapshot = structuredClone(oldSnapshot);
  const profiles = {
    [ieee.toUpperCase()]: { id: "soil-profile-id" },
    "watering-ieee": { id: "watering-profile-id", type: "watering_valve" },
  };
  const result = resolveSoilOwnedInventorySnapshot(oldSnapshot, profiles);
  assert.deepEqual(result.devices.map((device) => device.id), ["unowned-ieee"]);
  assert.deepEqual(result.protectedDeviceIds, [
    "already-protected", ieee, "legacy-history-id", "soil-profile-id",
    "watering-ieee", "watering-profile-id",
  ]);
  assert.deepEqual(result.routes, [{ sourceDeviceId: "unowned-ieee", targetDeviceId: "target-unowned" }]);
  assert.deepEqual(oldSnapshot, originalSnapshot);
  assert.deepEqual(resolveSoilOwnedInventorySnapshot(
    { inventorySource: "home_assistant_lights", devices: [{ id: "light.test" }] },
    { [ieee]: { id: "soil-profile-id" } },
  ), { inventorySource: "home_assistant_lights", devices: [{ id: "light.test" }] });

  const calls = [];
  const deliver = createDelivery({ url: "http://wingman", token: "test",
    resolveInventorySnapshot: (snapshot) => resolveSoilOwnedInventorySnapshot(snapshot, profiles),
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { status: 202, ok: true, text: async () => "" };
    } });
  await deliver({ inventorySnapshot: oldSnapshot });
  assert.deepEqual(calls[0].body.devices.map((device) => device.id), ["unowned-ieee"]);
  assert.deepEqual(calls[0].body.protectedDeviceIds, [
    "already-protected", ieee, "legacy-history-id", "soil-profile-id",
    "watering-ieee", "watering-profile-id",
  ]);
  assert.deepEqual(calls[0].body.routes, [{ sourceDeviceId: "unowned-ieee", targetDeviceId: "target-unowned" }]);
  assert.deepEqual(oldSnapshot, originalSnapshot);
  assert.equal(calls.some((call) => call.url.endsWith("/api/ingest")), false);
  assert.equal(calls.some((call) => call.url.endsWith("/api/sync/external-devices")), false);
});

test("configured missing soil profiles fail delivery without sending or acknowledging inventory", async (t) => {
  const queue = new PersistentQueue(path.join(temporary(t), "missing-profiles-queue.json"));
  const snapshot = { inventorySnapshot: { inventorySource: "zigbee2mqtt", devices: [], protectedDeviceIds: [], routes: [] } };
  queue.push(snapshot);
  const calls = [];
  const deliver = createDelivery({ url: "http://wingman", token: "test",
    resolveInventorySnapshot: () => { throw new Error("Configured soil profiles file is missing"); },
    fetchImpl: async (url) => {
      calls.push(url);
      return { status: 202, ok: true };
    } });
  await assert.rejects(drainQueue(queue, deliver), /Configured soil profiles file is missing/);
  assert.equal(queue.length, 1);
  assert.deepEqual(new PersistentQueue(queue.filename).first, snapshot);
  assert.deepEqual(calls, []);
});

test("external inventory validation rejects unsafe or ambiguous snapshots", () => {
  const base = { inventorySource: "zigbee2mqtt", devices: [], protectedDeviceIds: [], routes: [] };
  assert.deepEqual(validateExternalDeviceInventory(base).deviceIds, []);
  assert.throws(() => validateExternalDeviceInventory({ ...base, inventorySource: "soil-controller" }), /Unsupported/);
  assert.throws(() => validateExternalDeviceInventory({ ...base, devices: [{ id: "a", name: "A" }] }), /matching inventorySource/);
  assert.throws(() => validateExternalDeviceInventory({ ...base, devices: [
    { id: "a", name: "A", inventorySource: "zigbee2mqtt" },
    { id: "a", name: "Again", inventorySource: "zigbee2mqtt" },
  ] }), /Duplicate/);
  assert.throws(() => validateExternalDeviceInventory({ ...base, routes: [{
    sourceSystem: "zigbee2mqtt", sourceDeviceId: "missing", targetSystem: "home_assistant", targetDeviceId: "light.x",
  }] }), /Invalid route/);
});

test("external inventory cleanup is source-scoped, closes routes and preserves events", async () => {
  const inventory = validateExternalDeviceInventory({
    inventorySource: "zigbee2mqtt",
    devices: [{ id: "active", name: "Active Z2M", inventorySource: "zigbee2mqtt" }],
    protectedDeviceIds: ["soil-id"],
    routes: [],
  });
  const queries = [];
  const client = { query: async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes("select distinct external.id")) return { rows: [{ id: "removed-z2m" }] };
    return { rowCount: sql.includes("update device_route") ? 1 : sql.includes("delete from state_current") ? 3 : 1, rows: [] };
  } };
  const upserts = [];
  const result = await reconcileExternalDeviceInventory(client, inventory, async (_client, device) => upserts.push(device.id));
  assert.deepEqual(upserts, ["active"]);
  assert.deepEqual(result, { devices: 1, removed: 1, currentStatesRemoved: 3, routesClosed: 1 });
  const staleQuery = queries.find((query) => query.sql.includes("select distinct external.id"));
  assert.match(staleQuery.sql, /external\.payload->>'inventorySource' = \$1/);
  assert.deepEqual(staleQuery.params.slice(1), [["active"], ["soil-id"]]);
  assert.match(queries.find((query) => query.sql.includes("update device_route")).sql, /valid_to = greatest/);
  const stateCleanup = queries.find((query) => query.sql.includes("delete from state_current"));
  assert.match(stateCleanup.sql, /current\.source_system = \$2/);
  assert.match(stateCleanup.sql, /from homey_device homey/);
  assert.ok(queries.some((query) => query.sql.includes("delete from external_device")));
  assert.equal(queries.some((query) => query.sql.includes("delete from ingest_event")), false);
});

test("a queued generic observation cannot overwrite metadata after the soil adapter takes ownership", async () => {
  const calls = [];
  const deliver = createDelivery({ url: "http://wingman", token: "test", shouldSyncDevice: () => false,
    fetchImpl: async (url) => { calls.push(url); return { status: 202, ok: true }; } });
  await deliver({ device: { id: ieee, sourceSystem: "zigbee2mqtt", class: "sensor" }, events: [{ capability: "measure_soil_moisture", value: 30 }] });
  assert.deepEqual(calls, ["http://wingman/api/ingest"]);
});

test("observation routes are explicit Z2M-to-HA routes, never new hardware writers", async (t) => {
  const { observer } = setup(t);
  const model = observer.models[ieee];
  assert.equal(model.route.sourceSystem, "zigbee2mqtt");
  assert.equal(model.route.targetSystem, "home_assistant");
  assert.equal(model.route.targetDeviceId, "light.office");
  const sensor = deviceModel({ ...bridge, definition: { ...bridge.definition, exposes: [] } });
  assert.equal(sensor.haEntityId, null);
  assert.equal(sensor.route, undefined);
});

test("dashboard writes use current HA light reference, not the persistent history id", () => {
  assert.equal(getHomeAssistantLightTarget({ id: "light.office", haEntityId: "light.renamed" }), "light.renamed");
  assert.equal(getHomeAssistantLightTarget({ id: ieee, haEntityId: "light.new_helper" }), "light.new_helper");
  assert.equal(getHomeAssistantLightTarget({ id: "light.existing" }), "light.existing");
  assert.throws(() => getHomeAssistantLightTarget({ id: ieee }), /entydig/);
  assert.throws(() => getHomeAssistantLightTarget({ id: ieee, haEntityId: "switch.settings" }), /entydig/);
});

test("HA connection failures cannot recursively close either WebSocket observer", () => {
  for (const filename of ["energy.js", "registry.js"]) {
    const sockets = [];
    class FailingSocket {
      constructor() { this.listeners = {}; this.closes = 0; sockets.push(this); }
      addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
      emit(type) { for (const listener of this.listeners[type] || []) listener({}); }
      close() { this.closes += 1; this.emit("error"); } // Node can omit close after a failed handshake.
    }
    const intervals = new Set();
    let retries = 0;
    const context = { module: { exports: {} }, WebSocket: FailingSocket, console: { warn() {}, error() {} },
      setInterval() { intervals.add(1); return 1; }, clearInterval(id) { intervals.delete(id); },
      setTimeout() { retries += 1; return 1; }, clearTimeout() {}, Date, Map, Promise, Error, JSON };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../home-assistant-ingest-service", filename), "utf8"), context);
    const start = context.module.exports.startEnergyObserver || context.module.exports.startRegistryObserver;
    start({ url: "http://unreachable", token: "test", onState() {}, onSnapshot() {} });
    sockets[0].emit("error");
    assert.equal(sockets[0].closes, 1, filename);
    assert.equal(intervals.size, 0, `${filename} must clean up even without a close event`);
    assert.equal(retries, 1, `${filename} must schedule exactly one reconnect`);
  }
});
