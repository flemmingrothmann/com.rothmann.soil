"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { lightInventory } = require("../home-assistant-ingest-service/ha-light-inventory");
const { validateExternalDeviceInventory, reconcileExternalDeviceInventory } = require("../ingest-service/externalDeviceInventory");
const { createDelivery } = require("../home-assistant-ingest-service/delivery");
const os = require("node:os");
const { registryMetadata } = require("../home-assistant-ingest-service/registry");
const { ZigbeeObserver } = require("../home-assistant-ingest-service/zigbee-observer");
const { deviceModel } = require("../home-assistant-ingest-service/zigbee");

function registry() {
  return {
    devices: [{ id: "physical", name_by_user: "Current HA name", area_id: "office" }],
    entities: [{ entity_id: "light.current", device_id: "physical" }],
    areas: [{ area_id: "office", name: "Kontor" }], labels: [],
    states: [{ entity_id: "light.current", state: "on", attributes: { friendly_name: "Old MQTT name" } }],
  };
}

test("HA light inventory follows current names and areas without a physical observation", () => {
  const data = registry();
  const first = lightInventory(data);
  assert.equal(first.devices[0].name, "Current HA name");
  assert.equal(first.devices[0].zoneName, "Kontor");
  data.devices[0].name_by_user = "Renamed in HA";
  data.areas[0].name = "Nyt område";
  const next = lightInventory(data);
  assert.equal(next.devices[0].name, "Renamed in HA");
  assert.equal(next.devices[0].zoneName, "Nyt område");
  assert.equal(next.devices[0].id, first.devices[0].id);
  assert.equal(Object.hasOwn(next, "events"), false);
  data.entities[0].name = "Explicit entity name";
  assert.equal(lightInventory(data).devices[0].name, "Explicit entity name");
});

test("removed HA lights disappear; unavailable existing lights remain visible", () => {
  const data = registry();
  data.states[0].state = "unavailable";
  assert.equal(lightInventory(data).devices[0].available, false);
  data.states = [];
  assert.deepEqual(lightInventory(data).devices, []);
  assert.throws(() => lightInventory({ ...data, states: undefined }), /Complete/);
});

test("HA inventory protects direct Z2M history ids and excludes ignored/disabled lights", () => {
  const data = registry();
  const protectedInventory = lightInventory(data, ["light.current", "soil-ieee"]);
  assert.deepEqual(protectedInventory.devices, []);
  assert.deepEqual(protectedInventory.protectedDeviceIds, ["light.current", "soil-ieee"]);
  data.entities[0].disabled_by = "user";
  assert.deepEqual(lightInventory(data).devices, []);
  data.entities[0].disabled_by = null;
  data.labels = [{ label_id: "ignore", name: "wingman-ignore" }];
  data.devices[0].labels = ["ignore"];
  assert.deepEqual(lightInventory(data).devices, []);
});

test("Z2M light aliases are excluded from HA inventory without protecting alias history ids", (t) => {
  const ieee = "0x842712fffeb4a2a8";
  const bridge = { ieee_address: ieee, type: "Router", friendly_name: "Desk lamp", definition: {
    vendor: "Test", model: "Lamp", exposes: [{ type: "light", features: [
      { name: "state", property: "state", access: 7, value_on: "ON", value_off: "OFF" },
    ] }],
  } };
  const legacyIeee = "0x1234567890abcdef";
  const ha = {
    devices: [
      { id: "z2m-device", identifiers: [["mqtt", `zigbee2mqtt_${ieee}`]] },
      { id: "legacy-device", identifiers: [["mqtt", `zigbee2mqtt_${legacyIeee}`]] },
    ],
    entities: [
      { entity_id: "light.0x842712fffeb4a2a8", device_id: "z2m-device", platform: "mqtt" },
      { entity_id: "light.legacy", device_id: "legacy-device", platform: "mqtt" },
      { entity_id: "light.unrelated", device_id: "other", platform: "hue" },
    ],
    areas: [], labels: [],
    states: [
      { entity_id: "light.0x842712fffeb4a2a8", state: "on" },
      { entity_id: "light.legacy", state: "off" },
      { entity_id: "light.unrelated", state: "on" },
    ],
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ha-light-inventory-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const enqueued = [];
  const observer = new ZigbeeObserver({ directory, enqueue: (item) => enqueued.push(item) });
  observer.cache.identities[ieee] = { id: ieee, target: "light.0x842712fffeb4a2a8" };
  observer.cache.identities[legacyIeee] = { id: "light.legacy", target: "light.legacy" };
  observer.snapshot(registryMetadata(ha), ha);
  observer.message("zigbee2mqtt/bridge/devices", Buffer.from(JSON.stringify([
    bridge, { ...bridge, ieee_address: legacyIeee, friendly_name: "Legacy lamp" },
  ])));

  const snapshot = enqueued.map((item) => item.inventorySnapshot).find((item) => item?.inventorySource === "home_assistant_lights");
  assert.equal(observer.models[ieee].id, ieee);
  assert.equal(observer.models[ieee].haEntityId, "light.0x842712fffeb4a2a8");
  assert.deepEqual(snapshot.devices.map((device) => device.id), ["light.unrelated"]);
  assert.deepEqual(snapshot.protectedDeviceIds, [ieee, "light.legacy"]);
  assert.equal(snapshot.protectedDeviceIds.includes("light.0x842712fffeb4a2a8"), false);
  assert.equal(snapshot.protectedDeviceIds.includes("light.unrelated"), false);
  assert.equal(observer.haLights.has("light.0x842712fffeb4a2a8"), false);
});

test("legacy direct-light history id remains protected", () => {
  const snapshot = lightInventory(registry(), ["light.current"]);
  assert.deepEqual(snapshot.devices, []);
  assert.deepEqual(snapshot.protectedDeviceIds, ["light.current"]);
});

test("HA-light contract excludes energy and uses HA provenance for scoped cleanup", async () => {
  const snapshot = lightInventory(registry());
  const inventory = validateExternalDeviceInventory(snapshot);
  assert.throws(() => validateExternalDeviceInventory({ ...snapshot, devices: [{
    ...snapshot.devices[0], id: "home_assistant:energy_main", driverId: "home_assistant:energy",
  }] }), /only contain/);
  const queries = [];
  const client = { query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: sql.includes("select distinct external.id") ? [{ id: "light.deleted" }] : [], rowCount: 1 };
  } };
  await reconcileExternalDeviceInventory(client, inventory, async () => {});
  assert.match(queries[0].sql, /external.driver_id = 'home_assistant:light'/);
  assert.equal(queries.find((query) => query.sql.includes("update device_route")).params[0], "home_assistant");
  assert.equal(queries.find((query) => query.sql.includes("delete from state_current")).params[1], "home_assistant");
  assert.equal(queries.some((query) => /delete from ingest_event/.test(query.sql)), false);
});

test("old queued HA observations cannot overwrite current names or reopen removed routes", async () => {
  const snapshot = lightInventory(registry());
  const calls = [];
  const current = snapshot.devices[0];
  const deliver = createDelivery({ url: "http://wingman", token: "test",
    resolveDevice: (device) => device.id === current.id ? current : device,
    shouldSyncDevice: (device) => device.id === current.id,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { status: 202, ok: true };
    },
  });
  await deliver({ device: { ...current, name: "Old name" }, events: [{ value: true }] });
  assert.equal(calls[0].body.devices[0].name, "Current HA name");
  calls.length = 0;
  await deliver({ device: { ...current, id: "light.deleted" }, events: [{ value: false }] });
  assert.deepEqual(calls.map((call) => call.url), ["http://wingman/api/ingest"]);
});

test("dashboard errors never falsely attribute HA/Z2M failures to Homey", () => {
  for (const file of ["dashboard/public/app.js", "dashboard/server.js"]) {
    const content = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.doesNotMatch(content, /Sensorfejl i Homey|Sensoren melder fejl i Homey|utilgængelig i Homey/);
  }
});
