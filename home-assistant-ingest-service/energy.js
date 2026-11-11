"use strict";

const ENERGY_ENTITIES = {
  "sensor.electricity_meter_power_consumption": ["measure_power.imported", "W"],
  "sensor.electricity_meter_power_production": ["measure_power.exported", "W"],
  "sensor.electricity_meter_energy_import_total": ["meter_power.imported", "kWh"],
  "sensor.electricity_meter_energy_export_total": ["meter_power.exported", "kWh"],
};

function energyObservation(state, options) {
  const mapping = ENERGY_ENTITIES[state?.entity_id];
  if (!mapping) return null;
  const [capability, unit] = mapping;
  const available = !["unknown", "unavailable", ""].includes(state.state);
  const value = available ? Number(state.state) : null;
  if (available && (!Number.isFinite(value) || value < 0 || state.attributes?.unit_of_measurement !== unit))
    throw new Error(`Invalid energy reading or unit for ${state.entity_id}`);
  return {
    time: state.last_updated,
    homey_device_id: options.id,
    homey_zone_id: options.zoneId,
    device_name: options.name,
    driver_id: "home_assistant:homey_p1",
    device_class: "sensor",
    capability,
    value,
    unit,
    available,
    source_system: "home_assistant",
    source_instance: "hubert-home-assistant",
    source_event_id: `${state.entity_id}:${state.last_updated}`,
    event_type: "observation",
    payload: { entity_id: state.entity_id },
  };
}

function startEnergyObserver({ url, token, onState }) {
  let retryDelay = 15000;
  function connect() {
    const socket = new WebSocket(`${url.replace(/\/$/, "").replace(/^http/, "ws")}/api/websocket`);
    let closing = false;
    let disconnected = false;
    const close = () => {
      if (closing) return;
      closing = true;
      try { socket.close(); } finally { disconnect(); }
    };
    let lastMessage = Date.now();
    let nextId = 3;
    const heartbeat = setInterval(() => {
      if (Date.now() - lastMessage > 60000) close();
      else if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ id: nextId++, type: "ping" }));
    }, 20000);
    socket.addEventListener("message", ({ data }) => {
      lastMessage = Date.now();
      try {
        const message = JSON.parse(data);
        if (message.type === "auth_required")
          socket.send(JSON.stringify({ type: "auth", access_token: token }));
        else if (message.type === "auth_ok") {
          socket.send(JSON.stringify({ id: 1, type: "subscribe_trigger", trigger: {
            platform: "state", entity_id: Object.keys(ENERGY_ENTITIES),
          } }));
        } else if (message.type === "auth_invalid" || (message.type === "result" && !message.success)) {
          console.error(`HA energy subscription failed: ${message.error?.message || message.message || message.type}`);
          close();
        } else if (message.type === "result" && message.id === 1) {
          socket.send(JSON.stringify({ id: 2, type: "get_states" }));
          retryDelay = 15000;
          console.log("HA energy observation connected");
        } else if (message.type === "result" && message.id === 2) {
          for (const state of message.result) if (ENERGY_ENTITIES[state.entity_id]) onState(state);
        } else if (message.type === "event") {
          const state = message.event.variables?.trigger?.to_state;
          if (state) onState(state);
        }
      } catch (error) {
        console.error(`HA energy observation failed: ${error.message}`);
      }
    });
    socket.addEventListener("error", close);
    function disconnect() {
      if (disconnected) return;
      disconnected = true;
      closing = true;
      clearInterval(heartbeat);
      console.warn(`HA energy disconnected; retry in ${retryDelay / 1000}s`);
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 300000);
    }
    socket.addEventListener("close", disconnect);
  }
  connect();
}

module.exports = { ENERGY_ENTITIES, energyObservation, startEnergyObserver };
