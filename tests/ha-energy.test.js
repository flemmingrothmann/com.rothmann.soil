"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { energyObservation } = require("../home-assistant-ingest-service/energy");
const options = { id: "ha-meter", name: "Elmåler", zoneId: "utility" };
const state = { entity_id: "sensor.electricity_meter_power_consumption", state: "632",
  last_updated: "2026-10-13T10:00:00Z", attributes: { unit_of_measurement: "W" } };
test("power is preserved in watts with HA provenance and deterministic delivery identity", () => {
  const event = energyObservation(state, options);
  assert.equal(event.value, 632);
  assert.equal(event.unit, "W");
  assert.equal(event.homey_device_id, "ha-meter");
  assert.equal(event.source_system, "home_assistant");
  assert.equal(event.event_type, "observation");
  assert.equal(event.time, state.last_updated);
  assert.equal(event.source_event_id, energyObservation({ ...state }, options).source_event_id);
});
test("unavailable is a null observation, never zero consumption", () => {
  const event = energyObservation({ ...state, state: "unavailable" }, options);
  assert.equal(event.value, null);
  assert.equal(event.available, false);
});
test("invalid units and readings cannot corrupt energy accounting", () => {
  assert.throws(() => energyObservation({ ...state, attributes: { unit_of_measurement: "kW" } }, options));
  assert.throws(() => energyObservation({ ...state, state: "-10" }, options));
  assert.throws(() => energyObservation({ ...state, state: "NaN" }, options));
});
test("import and export energy stay separate and unscaled", () => {
  const event = energyObservation({ ...state, entity_id: "sensor.electricity_meter_energy_export_total",
    state: "908.718", attributes: { unit_of_measurement: "kWh" } }, options);
  assert.equal(event.capability, "meter_power.exported");
  assert.equal(event.value, 908.718);
  assert.equal(event.unit, "kWh");
  assert.equal(energyObservation({ ...state, entity_id: "sensor.unrelated" }, options), null);
});
