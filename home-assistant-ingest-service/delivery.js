"use strict";

function resolveSoilOwnedInventorySnapshot(snapshot, profiles = {}) {
  if (snapshot?.inventorySource !== "zigbee2mqtt") return snapshot;
  const owned = new Set();
  const ownedIeee = new Set();
  for (const device of snapshot.devices || []) {
    const ieee = device.ieee || device.physicalDeviceId || device.id;
    const profile = profiles[ieee] || Object.entries(profiles).find(([key]) =>
      key.toLowerCase() === String(ieee).toLowerCase())?.[1];
    if (!profile) continue;
    ownedIeee.add(ieee);
    owned.add(ieee);
    owned.add(device.id);
    if (profile.id) owned.add(profile.id);
  }
  return {
    ...snapshot,
    devices: (snapshot.devices || []).filter((device) =>
      !ownedIeee.has(device.ieee || device.physicalDeviceId || device.id)),
    routes: (snapshot.routes || []).filter((route) => !owned.has(route.sourceDeviceId)),
    protectedDeviceIds: [...new Set([...(snapshot.protectedDeviceIds || []), ...owned])],
  };
}

function createDelivery({ url, token, fetchImpl = fetch, shouldSyncDevice = () => true, resolveDevice = (device) => device, resolveInventorySnapshot = (snapshot) => snapshot }) {
  const devices = new Map();
  const routes = new Set();
  async function request(pathname, method, body, accepted) {
    const response = await fetchImpl(`${url}${pathname}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    if (accepted ? response.status !== 202 : !response.ok)
      throw new Error(`Wingman ${pathname} returned ${response.status}: ${await response.text()}`);
  }
  return async function deliver(envelope) {
    if (envelope.inventorySnapshot) {
      const snapshot = await resolveInventorySnapshot(envelope.inventorySnapshot);
      await request("/api/sync/external-device-inventory", "POST", snapshot, true);
      devices.clear();
      for (const route of snapshot.routes || []) {
        const signature = JSON.stringify(route);
        if (routes.has(signature)) continue;
        await request("/api/replay/routes", "PUT", route, false);
        routes.add(signature);
      }
      return;
    }

    const { events } = envelope;
    const device = resolveDevice(envelope.device);
    const syncDevice = shouldSyncDevice(device);
    const signature = JSON.stringify(device);
    if (syncDevice && devices.get(device.id) !== signature) {
      await request("/api/sync/external-devices", "POST", { devices: [device] }, true);
      devices.set(device.id, signature);
    }
    const route = envelope.route || (device.class === "light" && device.sourceSystem === "home_assistant" ? {
      sourceSystem: "home_assistant", sourceDeviceId: device.id,
      targetSystem: "home_assistant", targetDeviceId: device.id, validFrom: "2026-08-18T00:00:00.000Z",
    } : null);
    if (syncDevice && route && !routes.has(JSON.stringify(route))) {
      await request("/api/replay/routes", "PUT", route, false);
      routes.add(JSON.stringify(route));
    }
    if (events.length) await request("/api/ingest", "POST", events, true);
  };
}

async function drainQueue(queue, deliver) {
  while (queue.length) {
    await deliver(queue.first);
    queue.shift();
  }
}

module.exports = { createDelivery, drainQueue, resolveSoilOwnedInventorySnapshot };
