'use strict';

const fs = require('fs');
const path = require('path');
const { HomeyAPI } = require('homey-api');

let localEnv = {};
try {
  localEnv = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'env.json'), 'utf8'));
} catch (error) {
  localEnv = {};
}

const QUEUE_STORE_KEY = 'wingman_persistent_event_queue';
const DEFAULT_MAX_QUEUE_EVENTS = 600000;
const DEFAULT_MAX_QUEUE_BYTES = 300 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 2000;
const LOG_FIRST_EVENTS = 20;
const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const MIN_RETRY_DELAY_MS = 15000;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;
const CHRONOGRAPH_APP_ID = 'nl.fellownet.chronograph';

function getHomeyEnv(envKey) {
  try {
    // Homey only resolves this module inside the app runtime.
    // eslint-disable-next-line global-require
    return require('homey').env[envKey];
  } catch (error) {
    return undefined;
  }
}

function getSetting(homey, key, envKey) {
  return homey.settings.get(key) || getHomeyEnv(envKey) || process.env[envKey] || localEnv[envKey];
}

function shouldTrackCapability(capability) {
  return capability === 'onoff'
    || capability === 'dim'
    || capability.startsWith('alarm_')
    || capability.startsWith('measure_')
    || capability.startsWith('meter_')
    || capability.startsWith('target_');
}

function getCapabilityValue(device, capability) {
  return device?.capabilitiesObj?.[capability]?.value;
}

class HomeyWingmanBridge {

  constructor(homey, log = () => {}, error = () => {}) {
    this.homey = homey;
    this.log = log;
    this.error = error;
    this.homeyApi = null;
    this.capabilityInstances = [];
    this.lastValues = new Map();
    this.queue = [];
    this.sending = false;
    this.persistTimer = null;
    this.retryTimer = null;
    this.nextRetryAt = 0;
    this.retryDelayMs = MIN_RETRY_DELAY_MS;
    this.acceptedEvents = 0;
    this.droppedEvents = 0;
    this.syncTimer = null;
    this.syncing = false;
  }

  getConfig() {
    return {
      url: getSetting(this.homey, 'wingman_ingest_url', 'INGEST_URL'),
      token: getSetting(this.homey, 'wingman_ingest_token', 'INGEST_TOKEN'),
      syncUrl: getSetting(this.homey, 'wingman_sync_url', 'SYNC_URL'),
      syncIntervalMs: Number(getSetting(this.homey, 'wingman_sync_interval_ms', 'SYNC_INTERVAL_MS') || DEFAULT_SYNC_INTERVAL_MS),
      syncFlows: getSetting(this.homey, 'wingman_sync_flows', 'SYNC_FLOWS') !== 'false',
      syncTimers: getSetting(this.homey, 'wingman_sync_timers', 'SYNC_TIMERS') !== 'false',
      maxQueueEvents: Number(getSetting(this.homey, 'wingman_max_queue_events', 'MAX_QUEUE_EVENTS') || DEFAULT_MAX_QUEUE_EVENTS),
      maxQueueBytes: Number(getSetting(this.homey, 'wingman_max_queue_bytes', 'MAX_QUEUE_BYTES') || DEFAULT_MAX_QUEUE_BYTES),
    };
  }

  async start() {
    const config = this.getConfig();
    if (!config.url || !config.token) {
      this.log('Homey Wingman missing INGEST_URL/INGEST_TOKEN; bridge not started');
      return;
    }

    this.homeyApi = await HomeyAPI.createAppAPI({
      homey: this.homey,
      debug: null,
    });
    this.log('Homey Wingman HomeyAPI app session created');
    this.loadPersistentQueue();
    await this.subscribeDeviceCapabilities();
    await this.syncHomeySnapshot();
    this.startSnapshotSync();
    this.flushQueue().catch((error) => {
      this.error(`Homey Wingman initial queue flush failed: ${error.message || error}`);
    });
    this.log('Homey Wingman bridge started');
  }

  loadPersistentQueue() {
    const storedQueue = this.homey.settings.get(QUEUE_STORE_KEY);
    this.queue = Array.isArray(storedQueue) ? storedQueue.filter(Boolean) : [];
    this.trimQueueToLimits();
    this.log(`Homey Wingman persistent queue loaded events=${this.queue.length}`);
  }

  getQueueLimits() {
    const config = this.getConfig();
    return {
      maxEvents: Number.isFinite(config.maxQueueEvents) && config.maxQueueEvents > 0
        ? config.maxQueueEvents
        : DEFAULT_MAX_QUEUE_EVENTS,
      maxBytes: Number.isFinite(config.maxQueueBytes) && config.maxQueueBytes > 0
        ? config.maxQueueBytes
        : DEFAULT_MAX_QUEUE_BYTES,
    };
  }

  getQueueBytes() {
    return Buffer.byteLength(JSON.stringify(this.queue), 'utf8');
  }

  trimQueueToLimits() {
    const limits = this.getQueueLimits();
    let dropped = 0;

    while (this.queue.length > limits.maxEvents) {
      this.queue.shift();
      dropped += 1;
    }

    while (this.queue.length > 0 && this.getQueueBytes() > limits.maxBytes) {
      this.queue.shift();
      dropped += 1;
    }

    if (dropped > 0) {
      this.droppedEvents += dropped;
      this.error(`Homey Wingman persistent queue dropped oldest events count=${dropped} remaining=${this.queue.length} bytes=${this.getQueueBytes()}`);
    }
  }

  persistQueue() {
    this.trimQueueToLimits();
    this.homey.settings.set(QUEUE_STORE_KEY, this.queue);
  }

  schedulePersistQueue() {
    if (this.persistTimer) return;

    this.persistTimer = this.homey.setTimeout(() => {
      this.persistTimer = null;
      try {
        this.persistQueue();
      } catch (error) {
        this.error(`Homey Wingman persistent queue save failed: ${error.message || error}`);
      }
    }, 500);
  }

  scheduleRetryFlush() {
    if (this.retryTimer) return;

    this.nextRetryAt = Date.now() + this.retryDelayMs;
    this.retryTimer = this.homey.setTimeout(() => {
      this.retryTimer = null;
      this.flushQueue().catch((error) => {
        this.error(`Homey Wingman retry flush failed: ${error.message || error}`);
      });
    }, this.retryDelayMs);
    this.retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, Math.round(this.retryDelayMs * 1.6));
  }

  resetRetryBackoff() {
    this.nextRetryAt = 0;
    this.retryDelayMs = MIN_RETRY_DELAY_MS;
  }

  startSnapshotSync() {
    const config = this.getConfig();
    const intervalMs = Number.isFinite(config.syncIntervalMs) && config.syncIntervalMs >= 60000
      ? config.syncIntervalMs
      : DEFAULT_SYNC_INTERVAL_MS;

    this.syncTimer = this.homey.setInterval(() => {
      this.syncHomeySnapshot().catch((error) => {
        this.error(`Homey Wingman snapshot sync failed: ${error.message || error}`);
      });
    }, intervalMs);
    this.log(`Homey Wingman snapshot sync interval ${Math.round(intervalMs / 1000)}s`);
  }

  toPlain(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }

  async getTimers(config) {
    if (!config.syncTimers) return null;

    try {
      const chronograph = await this.homeyApi.apps.getApp({ id: CHRONOGRAPH_APP_ID });
      const timers = await chronograph.get({ path: '/timers' });
      return Array.isArray(timers) ? timers : [];
    } catch (error) {
      this.error(`Homey Wingman timer sync skipped: ${error.message || error}`);
      return null;
    }
  }

  async syncHomeySnapshot() {
    if (this.syncing || !this.homeyApi) return;

    const config = this.getConfig();
    const syncUrl = config.syncUrl || String(config.url || '').replace('/api/ingest/homey', '/api/sync/homey');
    if (!syncUrl || !config.token) return;

    this.syncing = true;
    try {
      const [devices, zones, flows, advancedFlows, timers] = await Promise.all([
        this.homeyApi.devices.getDevices({ $cache: false }),
        this.homeyApi.zones.getZones({ $cache: false }),
        config.syncFlows ? this.homeyApi.flow.getFlows({ $cache: false }).catch((error) => {
          this.error(`Homey Wingman flow sync skipped: ${error.message || error}`);
          return {};
        }) : {},
        config.syncFlows ? this.homeyApi.flow.getAdvancedFlows({ $cache: false }).catch((error) => {
          this.error(`Homey Wingman advanced flow sync skipped: ${error.message || error}`);
          return {};
        }) : {},
        this.getTimers(config),
      ]);

      const response = await fetch(syncUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          syncedAt: new Date().toISOString(),
          devices: this.toPlain(devices),
          zones: this.toPlain(zones),
          flows: this.toPlain(flows),
          advancedFlows: this.toPlain(advancedFlows),
          timers: this.toPlain(timers),
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Sync returned ${response.status}: ${body || response.statusText}`);
      }

      const result = await response.json().catch(() => ({}));
      this.log(`Homey Wingman snapshot synced devices=${result.devices || 0} zones=${result.zones || 0} flows=${result.flows || 0} advancedFlows=${result.advancedFlows || 0}`);
      this.log(`Homey Wingman snapshot synced timers=${result.timers || 0}`);
    } finally {
      this.syncing = false;
    }
  }

  async subscribeDeviceCapabilities() {
    const devices = await this.homeyApi.devices.getDevices();
    let tracked = 0;

    for (const device of Object.values(devices || {})) {
      for (const capability of device.capabilities || []) {
        if (!shouldTrackCapability(capability)) {
          continue;
        }

        this.lastValues.set(`${device.id}:${capability}`, getCapabilityValue(device, capability));
        const capabilityInstance = device.makeCapabilityInstance(capability, (value) => {
          this.handleCapabilityValue(device, capability, value).catch((error) => {
            this.error(`Homey Wingman capability handler failed: ${error.message || error}`);
          });
        });
        this.capabilityInstances.push(capabilityInstance);
        tracked += 1;
      }
    }

    this.log(`Homey Wingman subscribed capability instances devices=${Object.keys(devices || {}).length} tracked=${tracked}`);
  }

  async handleCapabilityValue(device, capability, value) {
    const key = `${device.id}:${capability}`;
    const previousValue = this.lastValues.get(key);
    this.lastValues.set(key, value);

    if (previousValue === value) {
      return;
    }

    this.acceptedEvents += 1;
    if (this.acceptedEvents <= LOG_FIRST_EVENTS || capability === 'onoff' || capability === 'dim' || capability.startsWith('alarm_')) {
      this.log(`Homey Wingman event device=${device.name} capability=${capability} value=${JSON.stringify(value)} previous=${JSON.stringify(previousValue)}`);
    }

    this.enqueueEvent(this.createEventPayload(device, capability, value));
  }

  createEventPayload(device, capability, value) {
    const capabilityInfo = device.capabilitiesObj?.[capability] || {};
    return {
      time: new Date().toISOString(),
      homey_device_id: device.id,
      homey_zone_id: device.zone || null,
      device_name: device.name || null,
      driver_id: device.driverId || null,
      device_class: device.class || null,
      capability,
      value,
      unit: capabilityInfo.units || capabilityInfo.unit || null,
      available: device.available !== false,
    };
  }

  enqueueEvent(payload) {
    this.queue.push(payload);
    this.trimQueueToLimits();
    this.schedulePersistQueue();
    this.flushQueue().catch((error) => {
      this.error(`Homey Wingman flush failed: ${error.message || error}`);
    });
  }

  async flushQueue() {
    if (this.sending) {
      return;
    }
    if (this.nextRetryAt > Date.now()) {
      return;
    }

    this.sending = true;
    let sentSincePersist = 0;
    try {
      while (this.queue.length > 0) {
        const payload = this.queue[0];
        try {
          await this.sendEvent(payload);
          this.queue.shift();
          sentSincePersist += 1;
          this.resetRetryBackoff();

          if (sentSincePersist >= 50) {
            this.persistQueue();
            sentSincePersist = 0;
          }
        } catch (error) {
          this.error(`Homey Wingman keeping event queued device=${payload.device_name} capability=${payload.capability}: ${error.message || error}`);
          this.persistQueue();
          this.scheduleRetryFlush();
          return;
        }
      }

      if (sentSincePersist > 0) {
        this.persistQueue();
      }
    } finally {
      this.sending = false;
    }
  }

  async sendEvent(payload) {
    const config = this.getConfig();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(config.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Ingest returned ${response.status}: ${body || response.statusText}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

}

module.exports = {
  HomeyWingmanBridge,
  shouldTrackCapability,
};
