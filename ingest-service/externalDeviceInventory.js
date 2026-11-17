'use strict';

const INVENTORY_SOURCES = new Set(['zigbee2mqtt']);

function validateExternalDeviceInventory(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('External device inventory must be an object.');
  }

  const { inventorySource } = body;
  if (!INVENTORY_SOURCES.has(inventorySource)) {
    throw new Error('Unsupported external device inventory source.');
  }
  if (!Array.isArray(body.devices) || !Array.isArray(body.protectedDeviceIds)) {
    throw new Error('External device inventory requires devices and protectedDeviceIds arrays.');
  }
  if (body.devices.length > 5000 || body.protectedDeviceIds.length > 5000) {
    throw new Error('External device inventory is too large.');
  }

  const ids = new Set();
  for (const device of body.devices) {
    if (!device || typeof device !== 'object' || Array.isArray(device)
      || typeof device.id !== 'string' || !device.id.trim()
      || typeof device.name !== 'string' || !device.name.trim()
      || device.inventorySource !== inventorySource) {
      throw new Error('Every inventory device must have an id, name and matching inventorySource.');
    }
    if (ids.has(device.id)) throw new Error(`Duplicate external inventory device id: ${device.id}`);
    ids.add(device.id);
  }

  const protectedIds = new Set();
  for (const id of body.protectedDeviceIds) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error('Protected external device ids must be non-empty strings.');
    }
    if (protectedIds.has(id)) throw new Error(`Duplicate protected external device id: ${id}`);
    protectedIds.add(id);
  }

  const routes = body.routes || [];
  if (!Array.isArray(routes)) throw new Error('External device inventory routes must be an array.');
  for (const route of routes) {
    if (!route || route.sourceSystem !== inventorySource
      || !ids.has(route.sourceDeviceId)
      || typeof route.targetSystem !== 'string' || !route.targetSystem
      || typeof route.targetDeviceId !== 'string' || !route.targetDeviceId
      || (route.validFrom && !Number.isFinite(Date.parse(route.validFrom)))) {
      throw new Error('Invalid route in external device inventory.');
    }
  }

  return {
    inventorySource,
    devices: body.devices,
    deviceIds: [...ids],
    protectedDeviceIds: [...protectedIds],
    routes,
  };
}

async function reconcileExternalDeviceInventory(client, inventory, upsertDevice) {
  const {
    inventorySource, devices, deviceIds, protectedDeviceIds,
  } = inventory;
  const stale = await client.query(
    `
      select distinct external.id
      from external_device external
      where not (external.id = any($2::text[]))
        and not (external.id = any($3::text[]))
        and (
          external.payload->>'inventorySource' = $1
          or (
            external.payload->>'inventorySource' is null
            and (
              external.payload->>'sourceSystem' = $1
              or external.driver_id like 'zigbee2mqtt:%'
              or exists (
                select 1
                from device_route route
                where route.source_system = $1
                  and route.source_device_id = external.id
              )
            )
          )
        )
    `,
    [inventorySource, deviceIds, protectedDeviceIds],
  );
  const removedDeviceIds = stale.rows.map((row) => row.id);

  for (const device of devices) await upsertDevice(client, device);

  let routesClosed = 0;
  let currentStatesRemoved = 0;
  if (removedDeviceIds.length) {
    const closed = await client.query(
      `
        update device_route
        set valid_to = greatest(now(), valid_from + interval '1 microsecond')
        where source_system = $1
          and source_device_id = any($2::text[])
          and valid_to is null
      `,
      [inventorySource, removedDeviceIds],
    );
    routesClosed = closed.rowCount;

    const states = await client.query(
      `
        delete from state_current current
        where current.homey_device_id = any($1::text[])
          and current.source_system = $2
          and not exists (
            select 1 from homey_device homey
            where homey.id = current.homey_device_id
          )
      `,
      [removedDeviceIds, inventorySource],
    );
    currentStatesRemoved = states.rowCount;

    await client.query(
      'delete from external_device where id = any($1::text[])',
      [removedDeviceIds],
    );
  }

  return {
    devices: devices.length,
    removed: removedDeviceIds.length,
    currentStatesRemoved,
    routesClosed,
  };
}

module.exports = { validateExternalDeviceInventory, reconcileExternalDeviceInventory };
