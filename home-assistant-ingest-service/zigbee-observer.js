"use strict";

const { randomUUID } = require("crypto");
const { readJson, writeJson, PersistentQueue } = require("./storage");
const { startRegistryObserver } = require("./registry");
const { deviceModel, observationBatch, isDirectLight, unavailableBatch } = require("./zigbee");

class ZigbeeObserver {
  constructor({ directory = "/data", profilesFile, enqueue, now = () => new Date().toISOString() }) {
    this.filename = `${directory}/zigbee-metadata.json`;
    this.cache = readJson(this.filename, { metadata: {}, bridges: [], identities: {}, values: {}, syncedAt: null });
    this.raw = new PersistentQueue(`${directory}/zigbee-pending.json`);
    this.profilesFile = profilesFile;
    this.enqueue = enqueue;
    this.now = now;
    this.models = {};
    this.cache.availability ||= {};
    this.syncSignatures = new Map();
    this.stats = { received: 0, emitted: 0, suppressedHa: 0, haConnected: false };
    this.rebuild();
  }

  save() { writeJson(this.filename, this.cache); }

  profiles() {
    return this.profilesFile ? readJson(this.profilesFile, {}) : {};
  }

  rebuild() {
    if (!this.cache.syncedAt) return;
    const excluded = this.profiles();
    const models = {};
    for (const bridge of this.cache.bridges) {
      const ieee = bridge.ieee_address?.toLowerCase();
      const metadata = this.cache.metadata[ieee];
      const previous = this.cache.identities[ieee];
      const model = deviceModel(bridge, metadata, previous, Boolean(excluded[ieee]));
      if (!model) continue;
      model.available = this.cache.availability[ieee] !== "offline";
      // Do not silently move a previously mapped light to a different physical/history identity.
      if (model.id.startsWith("light.") && !model.haEntityId) model.ignored = true;
      const target = model.haEntityId;
      const validFrom = previous?.target === target ? previous.validFrom : this.now();
      this.cache.identities[ieee] = { id: model.id, target, validFrom };
      if (target) model.route = {
        sourceSystem: "zigbee2mqtt", sourceDeviceId: model.id,
        targetSystem: "home_assistant", targetDeviceId: target, validFrom,
        payload: { physicalDeviceId: ieee, observer: "zigbee2mqtt", controller: "home_assistant" },
      };
      models[ieee] = model;
    }
    this.models = models;
    this.save();
  }

  snapshot(metadata) {
    this.cache.metadata = metadata;
    this.cache.syncedAt = this.now();
    this.rebuild();
    this.syncMetadata();
    this.drain();
  }

  syncMetadata() {
    for (const model of Object.values(this.models)) {
      if (model.ignored) continue;
      const device = this.publicDevice(model);
      const signature = JSON.stringify({ device, route: model.route });
      if (this.syncSignatures.get(model.ieee) === signature) continue;
      this.enqueue({ device, events: [], route: model.route });
      this.syncSignatures.set(model.ieee, signature);
    }
  }

  publicDevice(model) {
    const { features, ignoredProperties, ignored, invert, route, ...device } = model;
    return device;
  }

  suppressHa(entityId) {
    const suppress = isDirectLight(entityId, this.models);
    if (suppress) this.stats.suppressedHa += 1;
    return suppress;
  }

  message(topic, raw, packet = {}) {
    if (topic === "zigbee2mqtt/bridge/devices") {
      const bridges = JSON.parse(raw.toString());
      if (!Array.isArray(bridges)) throw new Error("Invalid Z2M device inventory");
      this.cache.bridges = bridges;
      this.rebuild();
      this.save();
      this.syncMetadata();
      this.drain();
      return;
    }
    if (!topic.startsWith("zigbee2mqtt/") || topic.startsWith("zigbee2mqtt/bridge/")) return;
    // Exact inventory-topic match excludes /set, /get, /action and configuration messages.
    const availability = topic.endsWith("/availability");
    const stateTopic = availability ? topic.slice(0, -"/availability".length) : topic;
    const bridge = this.cache.bridges.find((device) => stateTopic === `zigbee2mqtt/${device.friendly_name}` || stateTopic === `zigbee2mqtt/${device.ieee_address}`);
    if (!bridge) return;
    let payload;
    if (availability && ["online", "offline"].includes(raw.toString())) payload = { state: raw.toString() };
    else payload = JSON.parse(raw.toString());
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Z2M observation");
    const ieee = bridge.ieee_address.toLowerCase();
    if (this.profiles()[ieee]) return;
    this.raw.push({ ieee, payload, availability, receivedAt: this.now(), retained: Boolean(packet.retain), messageId: randomUUID() });
    this.stats.received += 1;
    this.drain();
  }

  drain() {
    if (!this.cache.syncedAt) return; // First boot waits for HA once; restarts use the durable cache.
    while (this.raw.length) {
      const item = this.raw.first;
      const model = this.models[item.ieee];
      if (model && !model.ignored && !this.profiles()[item.ieee] && item.availability) {
        const state = item.payload.state;
        if (["online", "offline"].includes(state) && this.cache.availability[item.ieee] !== state) {
          const events = state === "offline" ? unavailableBatch(model, item) : [];
          model.available = state !== "offline";
          this.enqueue({ device: this.publicDevice(model), events, route: model.route });
          this.cache.availability[item.ieee] = state;
          // A fresh observation after reconnect must be able to restore unchanged values.
          if (state === "offline") this.cache.values[item.ieee] = {};
          this.save();
        }
      } else if (model && !model.ignored && !this.profiles()[item.ieee]) {
        if (!item.retained) {
          model.available = true;
          this.cache.availability[item.ieee] = "online";
        }
        const { events, values } = observationBatch(model, item.payload, { ...item, previous: this.cache.values[item.ieee] });
        if (events.length) this.enqueue({ device: this.publicDevice(model), events, route: model.route });
        this.cache.values[item.ieee] = values;
        this.save();
        this.stats.emitted += events.length;
      }
      this.raw.shift();
    }
  }

  start({ url, token }) {
    return startRegistryObserver({ url, token, onSnapshot: (metadata) => this.snapshot(metadata), onStatus: (connected) => { this.stats.haConnected = connected; } });
  }

  status() {
    return { ...this.stats, metadataSyncedAt: this.cache.syncedAt, devices: Object.keys(this.models).length,
      directLights: Object.values(this.models).filter((model) => model.haEntityId && !model.ignored).map((model) => model.haEntityId), pending: this.raw.length };
  }
}

module.exports = { ZigbeeObserver };
