"use strict";

function createDelivery({ url, token, fetchImpl = fetch }) {
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
    const { device, events } = envelope;
    const signature = JSON.stringify(device);
    if (devices.get(device.id) !== signature) {
      await request("/api/sync/external-devices", "POST", { devices: [device] }, true);
      devices.set(device.id, signature);
    }
    const route = envelope.route || (device.class === "light" && device.sourceSystem === "home_assistant" ? {
      sourceSystem: "home_assistant", sourceDeviceId: device.id,
      targetSystem: "home_assistant", targetDeviceId: device.id, validFrom: "2026-08-18T00:00:00.000Z",
    } : null);
    if (route && !routes.has(JSON.stringify(route))) {
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

module.exports = { createDelivery, drainQueue };
