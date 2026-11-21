"use strict";

function lightInventory({ devices, entities, areas, labels, states }, protectedDeviceIds = [], excludedEntityIds = []) {
  if (![devices, entities, areas, labels, states].every(Array.isArray))
    throw new Error("Complete HA registries and states are required for light inventory");
  const protectedIds = new Set(protectedDeviceIds);
  const excludedIds = new Set(excludedEntityIds);
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const entityById = new Map(entities.map((entity) => [entity.entity_id, entity]));
  const areaById = new Map(areas.map((area) => [area.area_id, area.name]));
  const ignoredLabels = new Set(labels.filter((label) => label.name === "wingman-ignore" || label.label_id === "wingman_ignore").map((label) => label.label_id));
  const ignored = (entry) => (entry?.labels || []).some((label) => ignoredLabels.has(label));
  return {
    inventorySource: "home_assistant_lights",
    protectedDeviceIds: [...protectedIds].sort(),
    devices: states.filter((state) => state.entity_id.startsWith("light.") && !protectedIds.has(state.entity_id) && !excludedIds.has(state.entity_id)).flatMap((state) => {
      const entity = entityById.get(state.entity_id);
      const device = deviceById.get(entity?.device_id);
      if (entity?.disabled_by || ignored(entity) || ignored(device)) return [];
      const areaId = entity?.area_id || device?.area_id;
      return [{
        id: state.entity_id,
        name: entity?.name || device?.name_by_user || state.attributes?.friendly_name || device?.name || state.entity_id,
        class: "light", driverId: "home_assistant:light", sourceSystem: "home_assistant",
        inventorySource: "home_assistant_lights",
        haEntityId: state.entity_id,
        zoneId: areaById.has(areaId) ? areaId : "ha_unassigned",
        zoneName: areaById.get(areaId) || "Uplaceret",
        available: ["on", "off"].includes(state.state), capabilities: ["onoff", "dim"],
      }];
    }).sort((left, right) => left.id.localeCompare(right.id)),
    routes: [],
  };
}

module.exports = { lightInventory };
