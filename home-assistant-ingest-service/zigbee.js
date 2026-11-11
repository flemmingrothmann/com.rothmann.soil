"use strict";

const { createHash } = require("crypto");

const NUMERIC = {
  temperature: ["measure_temperature", "°C"], humidity: ["measure_humidity", "%"],
  soil_moisture: ["measure_soil_moisture", "%"], battery: ["measure_battery", "%"],
  illuminance: ["measure_luminance", "lx"], power: ["measure_power", "W"],
  energy: ["meter_power", "kWh"], current: ["measure_current", "A"],
  voltage: ["measure_voltage", "V"], linkquality: ["linkquality", "lqi"],
};
const BINARY = { occupancy: "alarm_motion", contact: "alarm_contact", battery_low: "alarm_battery", tamper: "alarm_tamper" };

function numericMapping(feature) {
  const mapping = NUMERIC[feature.name];
  if (!mapping) return null;
  if (feature.name === "linkquality" && !feature.unit) return mapping;
  if (feature.name === "voltage" && feature.unit === "mV") return mapping;
  return feature.unit === mapping[1] ? mapping : null;
}

function exposedFeatures(device) {
  const features = [];
  function visit(expose) {
    if (expose.property && (expose.access & 1) && expose.category !== "config") features.push(expose);
    if (!expose.property) for (const feature of expose.features || []) visit(feature);
  }
  for (const expose of device.definition?.exposes || []) visit(expose);
  return features;
}

function deviceModel(bridge, metadata, identity, excluded = false) {
  const ieee = bridge.ieee_address?.toLowerCase();
  if (!/^0x[0-9a-f]{16}$/.test(ieee) || bridge.type === "Coordinator" || !bridge.definition) return null;
  const ignoredProperties = (metadata?.entities || []).filter((entity) => entity.ignored && entity.uniqueId?.startsWith(`${ieee}_`) && entity.uniqueId.endsWith("_zigbee2mqtt"))
    .map((entity) => entity.uniqueId.slice(ieee.length + 1, -"_zigbee2mqtt".length));
  const features = exposedFeatures(bridge).filter((feature) => !ignoredProperties.includes(feature.property));
  const singleState = features.filter((feature) => feature.name === "state").length === 1 && features.some((feature) => feature.property === "state");
  const mappedLight = metadata?.lightEntityId && singleState && !metadata.ambiguousLights;
  const id = identity?.id || (mappedLight ? metadata.lightEntityId : ieee);
  const capabilities = features.flatMap((feature) => {
    if (feature.property !== feature.name) return []; // Multi-endpoint devices need an explicit mapping.
    if (numericMapping(feature)) return [numericMapping(feature)[0]];
    if (BINARY[feature.name]) return [BINARY[feature.name]];
    if (feature.name === "state" && singleState) return ["onoff"];
    if (feature.name === "brightness" && singleState) return ["dim"];
    if (feature.name === "action") return ["zigbee_action"];
    return [];
  });
  const isLight = Boolean(mappedLight || id.startsWith("light."));
  return {
    id, ieee, name: metadata?.name || bridge.friendly_name || ieee,
    zoneId: metadata?.zoneId || "ha_unassigned", zoneName: metadata?.zoneName || "Uplaceret",
    driverId: isLight ? "home_assistant:light" : `zigbee2mqtt:${bridge.definition.vendor}:${bridge.definition.model}`,
    class: isLight ? "light" : capabilities.includes("measure_soil_moisture") ? "sensor" : capabilities.includes("onoff") ? "socket" : "sensor",
    sourceSystem: isLight ? "home_assistant" : "zigbee2mqtt",
    available: true, capabilities: [...new Set(capabilities)],
    haDeviceId: metadata?.haDeviceId || null, haEntityId: mappedLight ? metadata.lightEntityId : null,
    physicalDeviceId: ieee, ignored: excluded || Boolean(metadata?.ignored),
    invert: Boolean(metadata?.invert), features,
    ignoredProperties,
  };
}

function observationBatch(device, payload, { receivedAt, retained = false, messageId, previous = {} }) {
  if (device.ignored) return { events: [], values: previous };
  const sourceTime = payload.last_seen;
  const parsedTime = typeof sourceTime === "number" ? sourceTime : Date.parse(sourceTime);
  if (retained && !Number.isFinite(parsedTime)) return { events: [], values: previous };
  const time = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : receivedAt;
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 20);
  const identity = Number.isFinite(parsedTime) ? `${device.ieee}:${time}:${hash}` : messageId;
  const values = { ...previous };
  const events = [];
  for (const feature of device.features) {
    const property = feature.property;
    if (device.ignoredProperties.includes(property) || property !== feature.name || payload[property] === undefined || payload[property] === null) continue;
    const raw = payload[property];
    let capability;
    let value;
    let unit = null;
    if (numericMapping(feature)) {
      [capability, unit] = numericMapping(feature);
      if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
      value = feature.unit === "mV" ? raw / 1000 : raw;
    } else if (BINARY[property] && typeof raw === "boolean") {
      capability = BINARY[property];
      value = property === "contact" ? !raw : raw;
    } else if (property === "state" && device.capabilities.includes("onoff")) {
      if (raw !== feature.value_on && raw !== feature.value_off) continue;
      capability = "onoff";
      value = (raw === feature.value_on) !== device.invert;
    } else if (property === "brightness" && device.capabilities.includes("dim")) {
      if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
      capability = "dim";
      value = Math.max(0, Math.min(1, raw / (feature.value_max || 254)));
    } else if (property === "action" && !retained && typeof raw === "string" && raw && feature.values?.includes(raw)) {
      capability = "zigbee_action";
      value = raw;
    } else continue;
    const signature = JSON.stringify({ value, available: true });
    // Repeated aggregate payloads must not turn power reports into repeated replay actions.
    if (["onoff", "dim"].includes(capability) && values[capability] === signature) continue;
    const deliveryId = `${identity}:${property}`;
    if (values[`${capability}:delivery`] === deliveryId) continue;
    events.push({
      time, homey_device_id: device.id, homey_zone_id: device.zoneId,
      device_name: device.name, driver_id: device.driverId, device_class: device.class,
      capability, value, unit, available: true,
      source_system: "zigbee2mqtt", source_instance: "hubert-zigbee2mqtt",
      source_event_id: deliveryId, event_type: "observation", author_system: null,
      payload: { ieee_address: device.ieee, ha_device_id: device.haDeviceId, entity_id: device.haEntityId, retained, received_at: receivedAt },
    });
    values[capability] = signature;
    values[`${capability}:delivery`] = deliveryId;
  }
  return { events, values };
}

function isDirectLight(entityId, models) {
  return Object.values(models).some((model) => model.haEntityId === entityId && !model.ignored);
}

function unavailableBatch(device, item) {
  return device.capabilities.filter((capability) => capability !== "zigbee_action").map((capability) => ({
    time: item.receivedAt, homey_device_id: device.id, homey_zone_id: device.zoneId,
    device_name: device.name, driver_id: device.driverId, device_class: device.class,
    capability, value: null, available: false, source_system: "zigbee2mqtt",
    source_instance: "hubert-zigbee2mqtt", source_event_id: `${item.messageId}:${capability}`,
    event_type: "observation", author_system: null,
    payload: { ieee_address: device.ieee, kind: "availability", retained: item.retained },
  }));
}

module.exports = { exposedFeatures, deviceModel, observationBatch, isDirectLight, unavailableBatch };
