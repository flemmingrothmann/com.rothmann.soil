"use strict";

function zigbeeAddress(device) {
  const matches = (device.identifiers || [])
    .filter(([domain, id]) => domain === "mqtt" && /^zigbee2mqtt_0x[0-9a-f]{16}$/i.test(id))
    .map(([, id]) => id.slice("zigbee2mqtt_".length).toLowerCase());
  return matches.length === 1 ? matches[0] : null;
}

function registryMetadata({ devices, entities, areas, labels }) {
  const areaById = new Map(areas.map((area) => [area.area_id, area.name]));
  const ignoredLabels = new Set(labels.filter((label) => label.name === "wingman-ignore" || label.label_id === "wingman_ignore").map((label) => label.label_id));
  const ignored = (entry) => (entry.labels || []).some((label) => ignoredLabels.has(label));
  const result = {};
  for (const device of devices) {
    const ieee = zigbeeAddress(device);
    if (!ieee) continue;
    if (result[ieee]) throw new Error(`Ambiguous HA device mapping for ${ieee}`);
    const members = entities.filter((entity) => entity.device_id === device.id);
    const lights = members.filter((entity) => !entity.disabled_by && !entity.entity_category && entity.entity_id.startsWith("light.") && (
      entity.platform === "mqtt" || (entity.platform === "switch_as_x" && members.some((source) =>
        source.entity_id === entity.options?.switch_as_x?.entity_id && source.platform === "mqtt" && !source.entity_category))
    ));
    const light = lights.length === 1 ? lights[0] : null;
    const areaId = light?.area_id || device.area_id;
    result[ieee] = {
      haDeviceId: device.id,
      name: light?.name || device.name_by_user || device.name || ieee,
      zoneId: areaById.has(areaId) ? areaId : "ha_unassigned",
      zoneName: areaById.get(areaId) || "Uplaceret",
      ignored: ignored(device) || Boolean(light && ignored(light)),
      lightEntityId: light?.entity_id || null,
      lightRegistryId: light?.id || null,
      invert: Boolean(light?.options?.switch_as_x?.invert),
      ambiguousLights: lights.length > 1,
      entities: members.map((entity) => ({ id: entity.entity_id, uniqueId: entity.unique_id, ignored: ignored(entity), disabled: Boolean(entity.disabled_by) })),
    };
  }
  return result;
}

function startRegistryObserver({ url, token, onSnapshot, onStatus = () => {} }) {
  let stopped = false;
  let socket;
  let closeCurrent;
  let retryTimer;
  let retryDelay = 15000;
  function connect() {
    if (stopped) return;
    socket = new WebSocket(`${url.replace(/\/$/, "").replace(/^http/, "ws")}/api/websocket`);
    const current = socket;
    let closing = false;
    let disconnected = false;
    const close = () => {
      if (closing) return;
      closing = true;
      try { current.close(); } finally { disconnect(); }
    };
    closeCurrent = close;
    const pending = new Map();
    let nextId = 0;
    let refreshTimer;
    let refreshing = false;
    let dirty = false;
    let lastMessage = Date.now();
    const call = (type, extra = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`HA ${type} timed out`)); close(); }, 15000);
      pending.set(id, { resolve, reject, timeout });
      current.send(JSON.stringify({ id, type, ...extra }));
    });
    async function refresh() {
      if (refreshing) { dirty = true; return; }
      refreshing = true;
      try {
        const [devices, entities, areas, labels, states] = await Promise.all([
          call("config/device_registry/list"), call("config/entity_registry/list"),
          call("config/area_registry/list"), call("config/label_registry/list"),
          call("get_states"),
        ]);
        onSnapshot(registryMetadata({ devices, entities, areas, labels }), { devices, entities, areas, labels, states });
        retryDelay = 15000;
        onStatus(true);
      } catch (error) {
        console.error(`HA metadata: ${error.message}`);
        close();
      } finally {
        refreshing = false;
        if (dirty && current.readyState === WebSocket.OPEN) { dirty = false; scheduleRefresh(); }
      }
    }
    function scheduleRefresh() {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 300);
    }
    const heartbeat = setInterval(() => {
      if (Date.now() - lastMessage > 60000) close();
      else if (current.readyState === WebSocket.OPEN) call("ping").catch(close);
    }, 20000);
    current.addEventListener("message", ({ data }) => {
      lastMessage = Date.now();
      try {
        const message = JSON.parse(data);
        if (message.type === "auth_required") current.send(JSON.stringify({ type: "auth", access_token: token }));
        else if (message.type === "auth_ok") {
          Promise.all(["device", "entity", "area", "label"].map((kind) => call("subscribe_events", { event_type: `${kind}_registry_updated` }))
            .concat(call("subscribe_events", { event_type: "state_changed" })))
            .then(refresh).catch((error) => { console.error(`HA metadata subscription: ${error.message}`); close(); });
        } else if (message.type === "auth_invalid") close();
        else if (message.type === "event") {
          const event = message.event;
          if (event?.event_type !== "state_changed" || (event.data?.entity_id?.startsWith("light.") && (
            !event.data.old_state || !event.data.new_state
            || event.data.old_state.attributes?.friendly_name !== event.data.new_state.attributes?.friendly_name
          ))) scheduleRefresh();
        }
        else if (pending.has(message.id)) {
          const request = pending.get(message.id);
          pending.delete(message.id);
          clearTimeout(request.timeout);
          if (message.success || message.type === "pong") request.resolve(message.result);
          else request.reject(new Error(message.error?.message || "HA request failed"));
        }
      } catch (error) { console.error(`HA metadata message: ${error.message}`); close(); }
    });
    current.addEventListener("error", close);
    function disconnect() {
      if (disconnected) return;
      disconnected = true;
      closing = true;
      clearInterval(heartbeat);
      clearTimeout(refreshTimer);
      for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error("HA disconnected")); }
      pending.clear();
      onStatus(false);
      if (!stopped) {
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 300000);
      }
    }
    current.addEventListener("close", disconnect);
  }
  connect();
  return () => { stopped = true; clearTimeout(retryTimer); closeCurrent?.(); };
}

module.exports = { zigbeeAddress, registryMetadata, startRegistryObserver };
