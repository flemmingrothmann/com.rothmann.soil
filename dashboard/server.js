'use strict';

/* eslint-disable no-console, no-use-before-define, node/no-unsupported-features/node-builtins */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const HOMEY_URL = (process.env.HOMEY_URL || '').replace(/\/$/, '');
const HOMEY_TOKEN = process.env.HOMEY_TOKEN || '';
const WINGMAN_URL = (process.env.WINGMAN_URL || 'http://homey-wingman-ingest-service:8788').replace(/\/$/, '');
const APP_ID = process.env.HOMEY_APP_ID || 'com.rothmann.soil';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'Bogfinkevej11';
const COOKIE_SECRET = process.env.DASHBOARD_COOKIE_SECRET || `${DASHBOARD_PASSWORD}:${APP_ID}`;
const COOKIE_NAME = 'soil_dashboard_session';
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const WATERING_FORBIDDEN_VARIABLE_ID = process.env.WATERING_FORBIDDEN_VARIABLE_ID || '5a2a34fd-8d2f-4c7d-b076-b1bb41e3a41f';
const WATERING_HISTORY_DAYS = 14;
const SOIL_HISTORY_DAYS = 7;
const SOIL_WATER_ALARM_TOPSCORER_DAYS = 30;
const ENERGY_MAIN_DEVICE_ID = process.env.ENERGY_MAIN_DEVICE_ID || '';
const ENERGY_MAIN_DEVICE_NAME = process.env.ENERGY_MAIN_DEVICE_NAME || 'Homey Energy Dongle';
const ENERGY_BILLING_PERIOD_START_DAY = Number(process.env.ENERGY_BILLING_PERIOD_START_DAY || 1);
const WATERING_INSIGHTS_RESOLUTION = 'last14Days';
const CONTACT_INSIGHTS_RESOLUTION = 'last7Days';
const CHRONOGRAPH_APP_ID = 'nl.fellownet.chronograph';
const WATERING_VALVE_DRIVER_IDS = [
  'homey:app:se.styrahem.sonoff.zigbee:SWV',
];
const VIRTUAL_DEVICE_DRIVER_IDS = [
  'homey:app:nl.qluster-it.DeviceCapabilities:virtualdevice',
];
const ALWAYS_ON_LIGHT_DEVICE_IDS = [
  '20a56e23-3720-475f-a197-0cfdfc9fce36',
];
const MIN_SOIL_OFFLINE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_SOIL_OFFLINE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SOIL_OFFLINE_TIMEOUT_MS = 6 * 60 * 60 * 1000;

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = process.env.DASHBOARD_STATE_FILE || '/data/state.json';
const CACHE_TTL_MS = {
  dashboard: Number(process.env.DASHBOARD_SOIL_CACHE_MS || 3000),
  overview: Number(process.env.DASHBOARD_OVERVIEW_CACHE_MS || 3000),
  watering: Number(process.env.DASHBOARD_WATERING_CACHE_MS || 10000),
  contact: Number(process.env.DASHBOARD_CONTACT_CACHE_MS || 3000),
  motion: Number(process.env.DASHBOARD_MOTION_CACHE_MS || 3000),
  lights: Number(process.env.DASHBOARD_LIGHTS_CACHE_MS || 3000),
  energy: Number(process.env.DASHBOARD_ENERGY_CACHE_MS || 5 * 60 * 1000),
  state: Number(process.env.DASHBOARD_STATE_CACHE_MS || 3000),
};
const responseCache = new Map();

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(response, statusCode, data) {
  const body = JSON.stringify(data);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

async function getCachedValue(key, ttlMs, loader) {
  const now = Date.now();
  const cached = responseCache.get(key);

  if (cached?.value && cached.expiresAt > now) {
    return cached.value;
  }

  if (cached?.promise) {
    return cached.promise;
  }

  const promise = Promise.resolve()
    .then(loader)
    .then((value) => {
      responseCache.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
        promise: null,
      });
      return value;
    })
    .catch((error) => {
      responseCache.delete(key);
      throw error;
    });

  responseCache.set(key, {
    value: cached?.value || null,
    expiresAt: cached?.expiresAt || 0,
    promise,
  });
  return promise;
}

function clearCache(keys) {
  keys.forEach((key) => responseCache.delete(key));
}

async function readState() {
  const variable = await getHomeyApi(`/manager/logic/variable/${WATERING_FORBIDDEN_VARIABLE_ID}`);

  try {
    const state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    return {
      wateringForbidden: variable.value === true,
      updatedAt: state.updatedAt || null,
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(error.message || error);
    }

    return {
      wateringForbidden: variable.value === true,
      updatedAt: null,
    };
  }
}

async function writeState(state) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function toggleWateringForbidden() {
  const currentState = await readState();
  const nextValue = !currentState.wateringForbidden;
  await putHomeyApi(`/manager/logic/variable/${WATERING_FORBIDDEN_VARIABLE_ID}`, { value: nextValue });

  const nextState = {
    wateringForbidden: nextValue,
    updatedAt: new Date().toISOString(),
  };
  await writeState(nextState);
  clearCache(['state', 'overview', 'watering']);
  return nextState;
}

function sign(value) {
  return crypto
    .createHmac('sha256', COOKIE_SECRET)
    .update(value)
    .digest('base64url');
}

function getSessionCookieValue() {
  const value = 'authenticated';
  return `${value}.${sign(value)}`;
}

function parseCookies(request) {
  return String(request.headers.cookie || '').split(';').reduce((result, cookie) => {
    const separatorIndex = cookie.indexOf('=');
    if (separatorIndex === -1) return result;

    const name = cookie.slice(0, separatorIndex).trim();
    const value = cookie.slice(separatorIndex + 1).trim();
    result[name] = decodeURIComponent(value);
    return result;
  }, {});
}

function isAuthenticated(request) {
  const cookieValue = parseCookies(request)[COOKIE_NAME];
  if (!cookieValue) return false;

  const [value, signature] = cookieValue.split('.');
  if (!value || !signature) return false;

  return signature === sign(value);
}

function sendLogin(response, errorMessage = '') {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(`<!doctype html>
<html lang="da">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#2e4b2a">
    <title>Jordstatus login</title>
    <style>
      * { box-sizing: border-box; }
      body {
        align-items: center;
        background: radial-gradient(circle at top left, #d9efbd, transparent 38%), linear-gradient(145deg, #f2f5ed, #e7edf4);
        color: #172016;
        display: flex;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        justify-content: center;
        margin: 0;
        min-height: 100vh;
        padding: 24px;
      }
      form {
        background: rgba(255,255,255,0.92);
        border: 1px solid rgba(76,122,69,0.18);
        border-radius: 26px;
        box-shadow: 0 18px 45px rgba(46,75,42,0.14);
        max-width: 380px;
        padding: 24px;
        width: 100%;
      }
      h1 { color: #20371e; font-size: 38px; letter-spacing: -0.06em; line-height: 0.95; margin: 0 0 10px; }
      p { color: #667085; margin: 0 0 18px; }
      label { color: #20371e; display: block; font-weight: 900; margin-bottom: 8px; }
      input {
        border: 1px solid rgba(76,122,69,0.28);
        border-radius: 16px;
        font: inherit;
        font-size: 20px;
        padding: 14px;
        width: 100%;
      }
      button {
        background: #20371e;
        border: 0;
        border-radius: 999px;
        color: #fff;
        font: inherit;
        font-weight: 900;
        margin-top: 16px;
        padding: 14px 18px;
        width: 100%;
      }
      .error { color: #c94b32; font-weight: 800; margin-top: 12px; }
    </style>
  </head>
  <body>
    <form method="post" action="/login">
      <h1>Jordstatus</h1>
      <p>Indtast adgangskoden én gang. Browseren husker login på denne enhed.</p>
      <label for="password">Adgangskode</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
      <button type="submit">Åbn dashboard</button>
      ${errorMessage ? `<p class="error">${errorMessage}</p>` : ''}
    </form>
  </body>
</html>`);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10000) {
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

async function handleLogin(request, response) {
  const body = await readRequestBody(request);
  const params = new URLSearchParams(body);

  if (params.get('password') !== DASHBOARD_PASSWORD) {
    sendLogin(response, 'Forkert adgangskode.');
    return;
  }

  response.writeHead(303, {
    location: '/',
    'set-cookie': `${COOKIE_NAME}=${encodeURIComponent(getSessionCookieValue())}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax`,
    'cache-control': 'no-store',
  });
  response.end();
}

async function getDashboard() {
  const now = Date.now();
  const { devices: apiDevices, zones: apiZones } = await getHomeyInventory();
  const zoneInfo = getZoneInfo(apiZones);
  const soilDevices = Object.values(apiDevices || {}).filter((device) => hasCapability(device, 'measure_soil_moisture'));
  const devices = await Promise.all(soilDevices.map((device) => toSoilDashboardDevice(device, zoneInfo, now)));

  devices.sort(compareDashboardDevices);

  const zones = devices.reduce((result, device) => {
    const zoneKey = device.zoneId || 'unknown';
    let zone = result.find((item) => item.id === zoneKey);
    if (!zone) {
      zone = {
        id: zoneKey,
        name: device.zoneName,
        path: device.zonePath,
        pathText: device.zonePathText,
        devices: [],
      };
      result.push(zone);
    }
    zone.devices.push(device);
    return result;
  }, []);

  zones.forEach((zone) => zone.devices.sort(compareZoneDevices));
  markZoneWaterAlarmTopscorers(zones);

  return {
    generatedAt: new Date(now).toISOString(),
    source: 'wingman-db',
    totals: {
      devices: devices.length,
      alarms: devices.filter((device) => device.needsAction).length,
      waterAlarms: devices.filter((device) => device.values.waterAlarm).length,
      offline: devices.filter((device) => device.offline).length,
      errors: devices.filter((device) => device.error).length,
    },
    zones,
  };
}

async function getHomeyApi(pathname) {
  const response = await fetch(`${HOMEY_URL}/api${pathname}`, {
    headers: {
      authorization: `Bearer ${HOMEY_TOKEN}`,
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Homey returned ${response.status}: ${body || response.statusText}`);
  }

  return response.json();
}

async function getWingmanApi(pathname) {
  if (!WINGMAN_URL) {
    throw new Error('WINGMAN_URL must be configured');
  }

  const response = await fetch(`${WINGMAN_URL}${pathname}`, {
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Wingman returned ${response.status}: ${body || response.statusText}`);
  }

  return response.json();
}

async function getHomeyInventory() {
  const snapshot = await getWingmanApi('/api/homey/snapshot');
  return {
    devices: snapshot.devices || {},
    zones: snapshot.zones || {},
    flows: snapshot.flows || {},
    advancedFlows: snapshot.advancedFlows || {},
    timers: Array.isArray(snapshot.timers) ? snapshot.timers : [],
  };
}

async function putHomeyApi(pathname, body) {
  const response = await fetch(`${HOMEY_URL}/api${pathname}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${HOMEY_TOKEN}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Homey returned ${response.status}: ${responseBody || response.statusText}`);
  }

  return response.json();
}

function hasCapability(device, capability) {
  return Array.isArray(device?.capabilities) && device.capabilities.includes(capability);
}

function isWateringValve(device) {
  return WATERING_VALVE_DRIVER_IDS.includes(device?.driverId)
    && hasCapability(device, 'onoff')
    && hasCapability(device, 'meter_water');
}

function getShortDriverId(device) {
  return String(device?.driverId || '').split(':').pop() || device?.driverId || null;
}

function getSoilOfflineTimeoutMs(device) {
  const settings = device?.settings || {};
  const intervalSeconds = Number(settings.soil_sampling || settings.humidity_report_max_interval);

  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    return DEFAULT_SOIL_OFFLINE_TIMEOUT_MS;
  }

  return Math.max(
    MIN_SOIL_OFFLINE_TIMEOUT_MS,
    Math.min(MAX_SOIL_OFFLINE_TIMEOUT_MS, intervalSeconds * 3 * 1000),
  );
}

function getSoilAlarmThreshold(device) {
  const capabilityValue = getCapabilityValue(device, 'soil_warning_threshold');
  if (typeof capabilityValue === 'number') {
    return capabilityValue;
  }

  const settingValue = Number(device?.settings?.soil_warning);
  return Number.isFinite(settingValue) ? settingValue : null;
}

function normalizeSoilHistory(entries, now) {
  const cutoff = now - (SOIL_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  return entries
    .map((entry) => ({
      t: Date.parse(entry?.t),
      v: Number(entry?.v),
    }))
    .filter((entry) => Number.isFinite(entry.t) && Number.isFinite(entry.v) && entry.t >= cutoff)
    .sort((a, b) => a.t - b.t)
    .slice(-7500);
}

function countWaterAlarmActivations(entries, cutoff) {
  return entries.reduce((count, entry) => {
    const timestamp = Date.parse(entry?.t);
    return count + (entry?.v === true && Number.isFinite(timestamp) && timestamp >= cutoff ? 1 : 0);
  }, 0);
}

function getLatestCapabilityUpdatedAt(device) {
  return Object.values(device?.capabilitiesObj || {}).reduce((latest, capabilityInfo) => {
    const timestamp = Date.parse(capabilityInfo?.lastUpdated);
    if (!Number.isFinite(timestamp)) return latest;

    return Number.isFinite(latest) ? Math.max(latest, timestamp) : timestamp;
  }, NaN);
}

function getSoilLastReportedAtMs(device, fallbackUpdatedAt, history) {
  const latestCapabilityUpdatedAt = getLatestCapabilityUpdatedAt(device);
  if (Number.isFinite(latestCapabilityUpdatedAt)) {
    return latestCapabilityUpdatedAt;
  }

  if (Array.isArray(history) && history.length > 0) {
    return history[history.length - 1].t;
  }

  return Date.parse(fallbackUpdatedAt);
}

function isSoilDeviceLive(device, now, fallbackUpdatedAt, history) {
  const lastReportedAtMs = getSoilLastReportedAtMs(device, fallbackUpdatedAt, history);
  return isAvailable(device)
    && Number.isFinite(lastReportedAtMs)
    && now - lastReportedAtMs <= getSoilOfflineTimeoutMs(device);
}

function compareDashboardDevices(a, b) {
  return a.zonePathText.localeCompare(b.zonePathText, 'da')
    || Number(b.needsAction) - Number(a.needsAction)
    || Number(b.values.waterAlarm) - Number(a.values.waterAlarm)
    || a.name.localeCompare(b.name, 'da');
}

function compareZoneDevices(a, b) {
  return Number(b.needsAction) - Number(a.needsAction)
    || Number(b.values.waterAlarm) - Number(a.values.waterAlarm)
    || a.name.localeCompare(b.name, 'da');
}

function markZoneWaterAlarmTopscorers(zones) {
  for (const zone of zones) {
    const topCount = zone.devices.reduce((count, device) => Math.max(count, device.waterAlarmStats.monthlyActivations), 0);

    if (topCount > 0) {
      zone.devices.forEach((device) => {
        device.waterAlarmStats.zoneTopScorer = device.waterAlarmStats.monthlyActivations === topCount;
      });
    }
  }
}

async function getWingmanEventEntries(deviceId, capability, sinceMs) {
  const result = await getWingmanApi(`/api/events?deviceId=${encodeURIComponent(deviceId)}&capability=${encodeURIComponent(capability)}&since=${encodeURIComponent(String(sinceMs))}`);
  return Array.isArray(result?.values) ? result.values : [];
}

async function toSoilDashboardDevice(device, zoneInfo, now) {
  const zone = zoneInfo[device.zone] || {
    name: device.zone || 'Ukendt zone',
    path: [device.zone || 'Ukendt zone'],
    pathText: device.zone || 'Ukendt zone',
  };
  const historyCutoff = now - (SOIL_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const alarmCutoff = now - (SOIL_WATER_ALARM_TOPSCORER_DAYS * 24 * 60 * 60 * 1000);
  const [moistureEntries, alarmEntries] = await Promise.all([
    getWingmanEventEntries(device.id, 'measure_soil_moisture', historyCutoff),
    getWingmanEventEntries(device.id, 'alarm_water', alarmCutoff),
  ]);
  const currentMoisture = getCapabilityValue(device, 'measure_soil_moisture');
  const currentMoistureUpdated = device.capabilitiesObj?.measure_soil_moisture?.lastUpdated;
  const history = normalizeSoilHistory(moistureEntries.concat(
    currentMoistureUpdated ? [{ t: currentMoistureUpdated, v: currentMoisture }] : [],
  ), now);
  const lastReportedAtMs = getSoilLastReportedAtMs(device, currentMoistureUpdated, history);
  const hasLastReport = Number.isFinite(lastReportedAtMs);
  const offlineTimeoutMs = getSoilOfflineTimeoutMs(device);
  const available = isAvailable(device);
  const live = isSoilDeviceLive(device, now, currentMoistureUpdated, history);
  const waterAlarm = getCapabilityValue(device, 'alarm_water') === true;
  const waterAlarmActivations = countWaterAlarmActivations(alarmEntries, alarmCutoff);
  const driverId = getShortDriverId(device);
  const hasError = !available;
  const offline = available && !live;

  return {
    id: `${driverId || device.driverId || 'device'}:${device.id}`,
    apiDeviceId: device.id,
    name: String(device.name || '').trim(),
    driverId,
    driverName: device.driverId || driverId || 'Ukendt driver',
    zoneId: device.zone || null,
    zoneName: zone.name,
    zonePath: zone.path,
    zonePathText: zone.pathText,
    available,
    live,
    offline,
    error: hasError,
    needsAction: waterAlarm || offline || hasError,
    lastReportedAt: hasLastReport ? new Date(lastReportedAtMs).toISOString() : null,
    offlineAfterMinutes: Math.round(offlineTimeoutMs / 60000),
    values: {
      soilMoisture: currentMoisture,
      alarmThreshold: getSoilAlarmThreshold(device),
      waterAlarm,
      battery: getCapabilityValue(device, 'measure_battery'),
      temperature: getCapabilityValue(device, 'measure_temperature'),
      airHumidity: getCapabilityValue(device, 'measure_humidity'),
      luminance: getCapabilityValue(device, 'measure_luminance'),
      fertility: getCapabilityValue(device, 'measure_soil_fertility'),
    },
    waterAlarmStats: {
      periodDays: SOIL_WATER_ALARM_TOPSCORER_DAYS,
      monthlyActivations: waterAlarm ? Math.max(1, waterAlarmActivations) : waterAlarmActivations,
      zoneTopScorer: false,
    },
    history,
  };
}

function getCapabilityValue(device, capability) {
  return device?.capabilitiesObj?.[capability]?.value ?? null;
}

function isAvailable(device) {
  return device?.available !== false;
}

function isActiveCapability(device, capability) {
  return isAvailable(device) && getCapabilityValue(device, capability) === true;
}

function isMissingInsightsLogError(error) {
  return /Not Found|404|LogLocal with ID/i.test(error?.message || String(error));
}

function isContactSensor(device) {
  return hasCapability(device, 'alarm_contact')
    && !VIRTUAL_DEVICE_DRIVER_IDS.includes(device?.driverId);
}

function isMotionSensor(device) {
  return hasCapability(device, 'alarm_motion')
    && !VIRTUAL_DEVICE_DRIVER_IDS.includes(device?.driverId);
}

function isLightDevice(device) {
  return device?.class === 'light'
    && hasCapability(device, 'onoff')
    && !ALWAYS_ON_LIGHT_DEVICE_IDS.includes(device?.id);
}

function getInsightLogId(deviceId, capability) {
  return `homey:device:${deviceId}:${capability}`;
}

async function getInsightEntries(deviceId, capability, resolution = WATERING_INSIGHTS_RESOLUTION) {
  if (WINGMAN_URL) {
    const since = resolution === CONTACT_INSIGHTS_RESOLUTION
      ? Date.now() - (7 * 24 * 60 * 60 * 1000)
      : Date.now() - (WATERING_HISTORY_DAYS * 24 * 60 * 60 * 1000);
    const result = await getWingmanApi(`/api/events?deviceId=${encodeURIComponent(deviceId)}&capability=${encodeURIComponent(capability)}&since=${encodeURIComponent(String(since))}`);
    return Array.isArray(result?.values) ? result.values : [];
  }

  const ownerUri = `homey:device:${deviceId}`;
  const logId = getInsightLogId(deviceId, capability);
  const result = await getHomeyApi(`/manager/insights/log/${ownerUri}/${logId}/entry?resolution=${resolution}`);
  return Array.isArray(result?.values) ? result.values : [];
}

function toDateKey(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toDayLabel(dateKey) {
  const date = new Date(`${dateKey}T12:00:00`);
  return date.toLocaleDateString('da-DK', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

function getHistoryDays(now) {
  const days = [];
  const date = new Date(now - ((WATERING_HISTORY_DAYS - 1) * 24 * 60 * 60 * 1000));
  date.setHours(12, 0, 0, 0);

  for (let index = 0; index < WATERING_HISTORY_DAYS; index += 1) {
    const key = toDateKey(date.getTime());
    days.push({
      key,
      label: toDayLabel(key),
      waterLiters: 0,
      minutes: 0,
    });
    date.setDate(date.getDate() + 1);
  }

  return days;
}

function normalizeNumericEntries(entries, cutoff) {
  return entries
    .map((entry) => ({
      t: Date.parse(entry.t),
      v: Number(entry.v),
    }))
    .filter((entry) => Number.isFinite(entry.t) && Number.isFinite(entry.v) && entry.t >= cutoff)
    .sort((a, b) => a.t - b.t);
}

function normalizeBooleanEntries(entries) {
  return entries
    .map((entry) => ({
      t: Date.parse(entry.t),
      v: entry.v === true,
      originName: entry.originName || null,
      originUri: entry.originUri || null,
    }))
    .filter((entry) => Number.isFinite(entry.t))
    .sort((a, b) => a.t - b.t);
}

function getActiveSince(entries) {
  const normalizedEntries = normalizeBooleanEntries(entries);

  for (let index = normalizedEntries.length - 1; index >= 0; index -= 1) {
    if (normalizedEntries[index].v === true) {
      return normalizedEntries[index].t;
    }

    if (normalizedEntries[index].v === false) {
      return null;
    }
  }

  return null;
}

async function toActiveContactSensor(device, zoneInfo) {
  const zone = zoneInfo[device.zone] || {
    name: device.zone || 'Ukendt zone',
    path: [device.zone || 'Ukendt zone'],
    pathText: device.zone || 'Ukendt zone',
  };
  let openSince = null;
  let error = null;

  try {
    const entries = await getInsightEntries(device.id, 'alarm_contact', CONTACT_INSIGHTS_RESOLUTION);
    const activeSince = getActiveSince(entries);
    openSince = activeSince === null ? null : new Date(activeSince).toISOString();
  } catch (insightsError) {
    if (!isMissingInsightsLogError(insightsError)) {
      error = insightsError.message || String(insightsError);
    }
  }

  const openSinceMs = openSince ? Date.parse(openSince) : null;

  return {
    id: device.id,
    name: device.name.trim(),
    zoneId: device.zone || null,
    zoneName: zone.name,
    zonePath: zone.path,
    zonePathText: zone.pathText,
    available: isAvailable(device),
    open: getCapabilityValue(device, 'alarm_contact') === true,
    openSince,
    openDurationMs: Number.isFinite(openSinceMs) ? Math.max(0, Date.now() - openSinceMs) : null,
    battery: getCapabilityValue(device, 'measure_battery'),
    error,
  };
}

async function toActiveBinaryDevice(device, zoneInfo, capability) {
  const zone = zoneInfo[device.zone] || {
    name: device.zone || 'Ukendt zone',
    path: [device.zone || 'Ukendt zone'],
    pathText: device.zone || 'Ukendt zone',
  };
  return {
    id: device.id,
    name: device.name.trim(),
    zoneId: device.zone || null,
    zoneName: zone.name,
    zonePath: zone.path,
    zonePathText: zone.pathText,
    available: isAvailable(device),
    active: isActiveCapability(device, capability),
    activeSince: null,
    activeDurationMs: null,
    battery: getCapabilityValue(device, 'measure_battery'),
    error: isAvailable(device) ? null : 'Enheden melder fejl eller er utilgængelig i Homey.',
  };
}

function compareContactSensors(a, b) {
  return a.zonePathText.localeCompare(b.zonePathText, 'da')
    || (b.openDurationMs || 0) - (a.openDurationMs || 0)
    || a.name.localeCompare(b.name, 'da');
}

async function getContactDashboard() {
  const now = Date.now();
  const { devices: apiDevices, zones: apiZones } = await getHomeyInventory();
  const zoneInfo = getZoneInfo(apiZones);
  const contactDevices = Object.values(apiDevices || {}).filter(isContactSensor);
  const activeSensors = await Promise.all(
    contactDevices
      .filter((device) => getCapabilityValue(device, 'alarm_contact') === true)
      .map((device) => toActiveContactSensor(device, zoneInfo)),
  );

  activeSensors.sort(compareContactSensors);

  const zones = activeSensors.reduce((result, sensor) => {
    const zoneKey = sensor.zoneId || 'unknown';
    let zone = result.find((item) => item.id === zoneKey);
    if (!zone) {
      zone = {
        id: zoneKey,
        name: sensor.zoneName,
        path: sensor.zonePath,
        pathText: sensor.zonePathText,
        sensors: [],
      };
      result.push(zone);
    }
    zone.sensors.push(sensor);
    return result;
  }, []);

  return {
    generatedAt: new Date(now).toISOString(),
    source: 'wingman-db',
    totals: {
      sensors: contactDevices.length,
      active: activeSensors.length,
      zones: zones.length,
      errors: activeSensors.filter((sensor) => sensor.error).length,
    },
    zones,
  };
}

function compareActiveDevices(a, b) {
  return Number(b.active) - Number(a.active)
    || Number(!b.available) - Number(!a.available)
    || a.zonePathText.localeCompare(b.zonePathText, 'da')
    || (b.activeDurationMs || 0) - (a.activeDurationMs || 0)
    || a.name.localeCompare(b.name, 'da');
}

function shouldShowActiveDevice(device, capability) {
  return isActiveCapability(device, capability) || !isAvailable(device);
}

function groupActiveDevices(activeDevices) {
  return activeDevices.reduce((result, device) => {
    const zoneKey = device.zoneId || 'unknown';
    let zone = result.find((item) => item.id === zoneKey);
    if (!zone) {
      zone = {
        id: zoneKey,
        name: device.zoneName,
        path: device.zonePath,
        pathText: device.zonePathText,
        devices: [],
      };
      result.push(zone);
    }
    zone.devices.push(device);
    return result;
  }, []);
}

async function getActiveDeviceDashboard({ capability, isDevice, totalName }) {
  const now = Date.now();
  const { devices: apiDevices, zones: apiZones } = await getHomeyInventory();
  const zoneInfo = getZoneInfo(apiZones);
  const devices = Object.values(apiDevices || {}).filter(isDevice);
  const visibleDevices = await Promise.all(
    devices
      .filter((device) => shouldShowActiveDevice(device, capability))
      .map((device) => toActiveBinaryDevice(device, zoneInfo, capability)),
  );

  visibleDevices.sort(compareActiveDevices);
  const zones = groupActiveDevices(visibleDevices);

  return {
    generatedAt: new Date(now).toISOString(),
    source: 'wingman-db',
    totals: {
      [totalName]: devices.length,
      active: devices.filter((device) => isActiveCapability(device, capability)).length,
      zones: zones.length,
      errors: devices.filter((device) => !isAvailable(device)).length,
    },
    zones,
  };
}

function getMotionDashboard() {
  return getActiveDeviceDashboard({
    capability: 'alarm_motion',
    isDevice: isMotionSensor,
    totalName: 'sensors',
  });
}

function getLightsDashboard() {
  return getActiveDeviceDashboard({
    capability: 'onoff',
    isDevice: isLightDevice,
    totalName: 'lights',
  });
}

async function setLightOnOff(deviceId, value) {
  if (!HOMEY_URL || !HOMEY_TOKEN) {
    throw new Error('HOMEY_URL and HOMEY_TOKEN must be configured');
  }

  if (typeof value !== 'boolean') {
    throw new Error('Lys-status skal være true eller false.');
  }

  const { devices: apiDevices } = await getHomeyInventory();
  const device = apiDevices?.[deviceId];

  if (!device || !isLightDevice(device)) {
    throw new Error('Lampen blev ikke fundet.');
  }

  if (!isAvailable(device)) {
    throw new Error('Lampen melder fejl og kan ikke styres fra dashboardet.');
  }

  await putHomeyApi(`/manager/devices/device/${encodeURIComponent(deviceId)}/capability/onoff`, { value });
  return { ok: true, value };
}

function getDashboardCard(id, title, subtitle, target, totals, statusItems) {
  return {
    id,
    title,
    subtitle,
    target,
    totals,
    statusItems,
  };
}

function getDanishDateKey(date, offsetDays = 0) {
  const shifted = new Date(date.getTime());
  shifted.setUTCDate(shifted.getUTCDate() + offsetDays);
  return shifted.toLocaleDateString('en-CA', { timeZone: 'Europe/Copenhagen' });
}

function getDanishDayStartUtc(dateKey) {
  const approximateUtc = new Date(`${dateKey}T12:00:00.000Z`);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Copenhagen',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(approximateUtc);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  const offsetMinutes = ((hour * 60) + minute) - 720;
  return new Date(Date.parse(`${dateKey}T00:00:00.000Z`) - (offsetMinutes * 60000));
}

function addUtcDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function getDanishPeriodRange(period, now) {
  const nowDate = new Date(now);
  const todayKey = getDanishDateKey(nowDate);
  const todayStart = getDanishDayStartUtc(todayKey);
  if (period === 'day') return { period, from: todayStart, to: nowDate, label: 'I dag' };
  if (period === '3days') return { period, from: addUtcDays(todayStart, -2), to: nowDate, label: 'Seneste 3 dage' };

  if (period === 'week') return { period, from: addUtcDays(todayStart, -6), to: nowDate, label: 'Seneste 7 dage' };

  if (period === 'month') {
    return { period, from: addUtcDays(todayStart, -29), to: nowDate, label: 'Seneste 30 dage' };
  }

  const startDay = Math.max(1, Math.min(28, ENERGY_BILLING_PERIOD_START_DAY));
  const year = Number(todayKey.slice(0, 4));
  const month = Number(todayKey.slice(5, 7));
  const day = Number(todayKey.slice(8, 10));
  const startMonth = day >= startDay ? month : month - 1;
  const startYear = startMonth >= 1 ? year : year - 1;
  const normalizedMonth = startMonth >= 1 ? startMonth : 12;
  const billingKey = `${startYear}-${String(normalizedMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
  return { period: 'billing', from: getDanishDayStartUtc(billingKey), to: nowDate, label: 'Fakturaperiode' };
}

function sumEnergyBuckets(buckets) {
  return buckets.reduce((result, bucket) => ({
    kwh: result.kwh + (Number(bucket.kwh) || 0),
    costDkk: result.costDkk + (Number(bucket.cost_dkk) || 0),
  }), { kwh: 0, costDkk: 0 });
}

function findEnergyState(states, capability) {
  return states.find((state) => state.capability === capability
    && ((ENERGY_MAIN_DEVICE_ID && state.homey_device_id === ENERGY_MAIN_DEVICE_ID)
      || (!ENERGY_MAIN_DEVICE_ID && state.device_name === ENERGY_MAIN_DEVICE_NAME)));
}

function getPriceForBucket(prices, bucket) {
  const start = Date.parse(bucket.bucket_start);
  return prices.find((price) => start >= Date.parse(price.starts_at) && start < Date.parse(price.ends_at));
}

function getNeutralPrice(prices) {
  const values = prices.map((price) => Number(price.total_dkk_per_kwh)).filter(Number.isFinite);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getRedistributedCost(kwhValues, prices, cheapestFirst) {
  const sortedKwh = kwhValues.slice().sort((a, b) => b - a);
  const sortedPrices = prices
    .map((price) => Number(price.total_dkk_per_kwh))
    .filter(Number.isFinite)
    .sort((a, b) => (cheapestFirst ? a - b : b - a));
  return sortedKwh.reduce((sum, kwh, index) => sum + kwh * (sortedPrices[index] ?? sortedPrices[sortedPrices.length - 1] ?? 0), 0);
}

function getDanishHourKey(value) {
  return new Intl.DateTimeFormat('da-DK', {
    timeZone: 'Europe/Copenhagen',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
}

function getDailyMinimumPrices(prices) {
  return prices.reduce((result, price) => {
    const value = Number(price.total_dkk_per_kwh);
    if (!Number.isFinite(value)) return result;

    const dayKey = getDanishDateKey(new Date(price.starts_at));
    result[dayKey] = Math.min(result[dayKey] ?? Number.POSITIVE_INFINITY, value);
    return result;
  }, {});
}

function getHourPatterns(buckets, prices) {
  const dailyMinimumPrices = getDailyMinimumPrices(prices);
  const groups = new Map();

  for (const bucket of buckets) {
    if (bucket.priceDkkPerKwh === null) continue;

    const hour = getDanishHourKey(bucket.startsAt);
    const dayKey = getDanishDateKey(new Date(bucket.startsAt));
    const key = `${hour}:00`;
    const group = groups.get(key) || {
      hour,
      label: `kl. ${hour}`,
      kwh: 0,
      costDkk: 0,
      priceSum: 0,
      priceCount: 0,
      days: new Set(),
      cheapestDays: new Set(),
    };

    group.kwh += bucket.kwh;
    group.costDkk += bucket.costDkk || 0;
    group.priceSum += bucket.priceDkkPerKwh;
    group.priceCount += 1;
    group.days.add(dayKey);
    if (Math.abs(bucket.priceDkkPerKwh - dailyMinimumPrices[dayKey]) < 0.000001) {
      group.cheapestDays.add(dayKey);
    }
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => ({
    hour: group.hour,
    label: group.label,
    kwh: group.kwh,
    costDkk: group.costDkk,
    averageDkkPerKwh: group.priceCount > 0 ? group.priceSum / group.priceCount : null,
    days: group.days.size,
    cheapestDays: group.cheapestDays.size,
  })).sort((a, b) => Number(a.hour) - Number(b.hour));
}

async function getEnergyDetailDashboard(periodValue = 'day') {
  const period = ['day', '3days', 'week', 'month', 'billing'].includes(periodValue) ? periodValue : 'day';
  const now = Date.now();
  const range = getDanishPeriodRange(period, now);
  const from = encodeURIComponent(range.from.toISOString());
  const to = encodeURIComponent(range.to.toISOString());
  const [usage, pricesResult] = await Promise.all([
    getWingmanApi(`/api/energy/usage?interval=hour&from=${from}&to=${to}`),
    getWingmanApi(`/api/energy/prices?from=${from}&to=${to}`),
  ]);
  const prices = Array.isArray(pricesResult.prices) ? pricesResult.prices : [];
  const buckets = (Array.isArray(usage.buckets) ? usage.buckets : []).map((bucket) => {
    const price = getPriceForBucket(prices, bucket);
    const priceDkkPerKwh = Number(price?.total_dkk_per_kwh ?? bucket.effective_dkk_per_kwh);
    const kwh = Number(bucket.kwh) || 0;
    const costDkk = bucket.cost_dkk !== null && Number.isFinite(Number(bucket.cost_dkk))
      ? Number(bucket.cost_dkk)
      : (Number.isFinite(priceDkkPerKwh) ? kwh * priceDkkPerKwh : null);
    return {
      startsAt: bucket.bucket_start,
      endsAt: bucket.bucket_end,
      timeLabel: new Date(bucket.bucket_start).toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen', weekday: period === 'day' ? undefined : 'short', day: period === 'day' ? undefined : '2-digit', hour: '2-digit' }),
      chartLabel: new Date(bucket.bucket_start).toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen', day: period === 'day' ? undefined : '2-digit', month: period === 'day' ? undefined : '2-digit', hour: '2-digit' }),
      kwh,
      costDkk,
      priceDkkPerKwh: Number.isFinite(priceDkkPerKwh) ? priceDkkPerKwh : null,
      sourceBuckets: Number(bucket.source_buckets) || 0,
    };
  });
  const pricedBuckets = buckets.filter((bucket) => bucket.priceDkkPerKwh !== null && bucket.costDkk !== null);
  const totals = sumEnergyBuckets(pricedBuckets.map((bucket) => ({ kwh: bucket.kwh, cost_dkk: bucket.costDkk })));
  const neutralPrice = getNeutralPrice(prices);
  const actualPrice = totals.kwh > 0 ? totals.costDkk / totals.kwh : null;
  const neutralCost = neutralPrice === null ? null : totals.kwh * neutralPrice;
  const timingEffectDkk = neutralCost === null ? null : neutralCost - totals.costDkk;
  const kwhValues = pricedBuckets.map((bucket) => bucket.kwh).filter((kwh) => kwh > 0);
  const bestCost = getRedistributedCost(kwhValues, prices, true);
  const worstCost = getRedistributedCost(kwhValues, prices, false);
  const maxKwh = Math.max(0, ...buckets.map((bucket) => bucket.kwh));
  const maxPrice = Math.max(0, ...prices.map((price) => Number(price.total_dkk_per_kwh) || 0));
  const hourPatterns = getHourPatterns(pricedBuckets, prices);

  return {
    generatedAt: new Date(now).toISOString(),
    source: 'wingman-db',
    period: range.period,
    label: range.label,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    note: 'Nettoforbrug fra hovedmåleren. Solceller og elbil kan påvirke billedet.',
    totals: {
      kwh: totals.kwh,
      costDkk: totals.costDkk,
      actualDkkPerKwh: actualPrice,
      neutralDkkPerKwh: neutralPrice,
      neutralCostDkk: neutralCost,
      timingEffectDkk,
      bestPossibleCostDkk: bestCost,
      worstPossibleCostDkk: worstCost,
      bestPossibleEffectDkk: neutralCost === null ? null : neutralCost - bestCost,
      worstPossibleEffectDkk: neutralCost === null ? null : neutralCost - worstCost,
    },
    scale: { maxKwh, maxPrice },
    buckets,
    hourPatterns,
    hourPatternScale: {
      maxKwh: Math.max(0, ...hourPatterns.map((pattern) => pattern.kwh)),
      maxPrice: Math.max(0, ...hourPatterns.map((pattern) => pattern.averageDkkPerKwh || 0)),
      maxDays: Math.max(0, ...hourPatterns.map((pattern) => pattern.days)),
    },
    cheapestHourPatterns: hourPatterns.slice().sort((a, b) => a.averageDkkPerKwh - b.averageDkkPerKwh).slice(0, 5),
    expensiveHourPatterns: hourPatterns.filter((pattern) => pattern.kwh > 0).slice().sort((a, b) => b.costDkk - a.costDkk).slice(0, 5),
  };
}

async function getElectricityOverviewCard(now) {
  const nowDate = new Date(now);
  const yesterdayKey = getDanishDateKey(nowDate, -1);
  const todayKey = getDanishDateKey(nowDate);
  const usageFrom = encodeURIComponent(getDanishDayStartUtc(yesterdayKey).toISOString());
  const usageTo = encodeURIComponent(nowDate.toISOString());
  const [usage, prices, currentState] = await Promise.all([
    getWingmanApi(`/api/energy/usage?interval=hour&from=${usageFrom}&to=${usageTo}`),
    getWingmanApi('/api/energy/prices'),
    getWingmanApi('/api/current-state'),
  ]);
  const buckets = Array.isArray(usage.buckets) ? usage.buckets : [];
  const yesterdayBuckets = buckets.filter((bucket) => getDanishDateKey(new Date(bucket.bucket_start)) === yesterdayKey);
  const todayBuckets = buckets.filter((bucket) => getDanishDateKey(new Date(bucket.bucket_start)) === todayKey);
  const completedBuckets = todayBuckets.filter((bucket) => Date.parse(bucket.bucket_end) <= now);
  const latestBucket = completedBuckets[completedBuckets.length - 1] || null;
  const yesterday = sumEnergyBuckets(yesterdayBuckets);
  const today = sumEnergyBuckets(todayBuckets);
  const latestHour = latestBucket ? sumEnergyBuckets([latestBucket]) : { kwh: 0, costDkk: 0 };
  const price = (prices.prices || []).find((item) => {
    const startsAt = Date.parse(item.starts_at);
    const endsAt = Date.parse(item.ends_at);
    return Number.isFinite(startsAt) && Number.isFinite(endsAt) && now >= startsAt && now < endsAt;
  });
  const powerState = findEnergyState(currentState.states || [], 'measure_power');
  const powerKw = Number(powerState?.value_number) / 1000;
  const currentPrice = Number(price?.total_dkk_per_kwh);
  const currentCostPerHour = Number.isFinite(powerKw) && Number.isFinite(currentPrice)
    ? Math.max(0, powerKw) * currentPrice
    : null;

  return {
    id: 'electricity',
    title: 'Elpriser',
    subtitle: 'Forbrug og pris',
    target: 'energy',
    electricity: {
      yesterday,
      today,
      latestHour,
      now: {
        kw: Number.isFinite(powerKw) ? powerKw : null,
        dkkPerHour: currentCostPerHour,
        dkkPerKwh: Number.isFinite(currentPrice) ? currentPrice : null,
        updatedAt: powerState?.event_time || null,
      },
    },
    totals: [],
    statusItems: [],
  };
}

async function getOverviewDashboard() {
  const now = Date.now();
  const {
    devices: apiDevices,
    flows,
    advancedFlows,
    timers,
  } = await getHomeyInventory();
  const devices = Object.values(apiDevices || {});
  const soilDevices = devices.filter((device) => hasCapability(device, 'measure_soil_moisture'));
  const valves = devices.filter(isWateringValve);
  const valveStates = valves.map((device) => ({
    id: device.id,
    name: device.name,
    on: isActiveCapability(device, 'onoff'),
  }));
  const contacts = devices.filter(isContactSensor);
  const motionSensors = devices.filter(isMotionSensor);
  const lights = devices.filter(isLightDevice);
  const activeContacts = contacts.filter((device) => isActiveCapability(device, 'alarm_contact'));
  const activeMotion = motionSensors.filter((device) => isActiveCapability(device, 'alarm_motion'));
  const activeLights = lights.filter((device) => isActiveCapability(device, 'onoff'));
  enrichWateringValveFlows(valveStates, flows, advancedFlows, timers);
  const activeValves = valveStates.filter((valve) => valve.wateringActive);
  const soilAlarms = soilDevices.filter((device) => getCapabilityValue(device, 'alarm_water') === true);
  const soilOffline = soilDevices.filter((device) => isAvailable(device) && !isSoilDeviceLive(device, now, device.capabilitiesObj?.measure_soil_moisture?.lastUpdated));
  const soilErrors = soilDevices.filter((device) => !isAvailable(device));
  const soilIssues = soilAlarms
    .concat(soilOffline.filter((device) => !soilAlarms.includes(device)))
    .concat(soilErrors.filter((device) => !soilAlarms.includes(device) && !soilOffline.includes(device)));

  const currentStatusItems = (items, detail, emptyText) => {
    if (items.length === 0) {
      return [emptyText];
    }

    return items.slice(0, 2).map((device) => `${device.name.trim()} · ${detail}`);
  };

  const cards = [
    await getElectricityOverviewCard(now),
    getDashboardCard('soil', 'Jordstatus', 'Jordfugt og vandalarmer', 'soil', [
      { label: 'Sensorer', value: soilDevices.length },
      { label: 'Alarm', value: soilAlarms.length },
      { label: 'Fejl', value: soilErrors.length },
      { label: 'Offline', value: soilOffline.length },
    ], currentStatusItems(soilIssues, 'Kræver kig', 'Ingen jordalarmer, offline eller fejl')),
    getDashboardCard('watering', 'Vanding', 'Ventiler og vanding', 'watering', [
      { label: 'Ventiler', value: valves.length },
      { label: 'Aktive', value: activeValves.length },
      { label: 'Fejl', value: valves.filter((device) => !isAvailable(device)).length },
    ], currentStatusItems(activeValves, 'Ventil åben', 'Ingen ventiler åbne')),
    getDashboardCard('contact', 'Åbne døre og vinduer', 'Døre, vinduer, køleskab og frysere', 'contact', [
      { label: 'Sensorer', value: contacts.length },
      { label: 'Åbne', value: activeContacts.length },
      { label: 'Fejl', value: contacts.filter((device) => !isAvailable(device)).length },
    ], currentStatusItems(activeContacts, 'Åben', 'Ingen åbne døre/vinduer')),
    getDashboardCard('motion', 'Bevægelse', 'Aktive motionssensorer', 'motion', [
      { label: 'Sensorer', value: motionSensors.length },
      { label: 'Aktive', value: activeMotion.length },
      { label: 'Fejl', value: motionSensors.filter((device) => !isAvailable(device)).length },
    ], currentStatusItems(activeMotion, 'Aktiv', 'Ingen aktiv bevægelse')),
    getDashboardCard('lights', 'Tændte lys', 'Lys der står tændt', 'lights', [
      { label: 'Lys', value: lights.length },
      { label: 'Tændt', value: activeLights.length },
      { label: 'Fejl', value: lights.filter((device) => !isAvailable(device)).length },
    ], currentStatusItems(activeLights, 'Tændt', 'Ingen lys tændt')),
  ];

  return {
    generatedAt: new Date().toISOString(),
    source: 'wingman-db',
    totals: {
      cards: cards.length,
      attention: soilIssues.length + activeContacts.length + activeMotion.length + activeLights.length + activeValves.length,
      active: activeContacts.length + activeMotion.length + activeLights.length + activeValves.length,
    },
    cards,
  };
}

function addToDay(days, key, property, value) {
  const day = days.find((item) => item.key === key);
  if (day) {
    day[property] += value;
  }
}

function getWaterSummary(meterEntries, days) {
  let totalLiters = 0;
  let previousValue = null;

  for (const entry of meterEntries) {
    if (previousValue !== null) {
      const delta = entry.v - previousValue;
      if (delta > 0) {
        const liters = delta * 1000;
        totalLiters += liters;
        addToDay(days, toDateKey(entry.t), 'waterLiters', liters);
      }
    }
    previousValue = entry.v;
  }

  return {
    totalLiters: Math.round(totalLiters * 10) / 10,
    firstMeterM3: meterEntries[0]?.v ?? null,
    lastMeterM3: meterEntries[meterEntries.length - 1]?.v ?? null,
    points: meterEntries.length,
  };
}

function getWateringSessions(onoffEntries, cutoff, now, days) {
  const sessions = [];
  let openSession = null;

  for (const entry of onoffEntries) {
    if (entry.v === true && !openSession) {
      openSession = entry;
    } else if (entry.v === false && openSession) {
      const start = Math.max(openSession.t, cutoff);
      const end = Math.min(entry.t, now);
      if (end >= cutoff && entry.t >= cutoff && end > start) {
        sessions.push(toSession(openSession, start, end, false));
        addToDay(days, toDateKey(start), 'minutes', (end - start) / 60000);
      }
      openSession = null;
    }
  }

  if (openSession) {
    const start = Math.max(openSession.t, cutoff);
    if (now > start) {
      sessions.push(toSession(openSession, start, now, true));
      addToDay(days, toDateKey(start), 'minutes', (now - start) / 60000);
    }
  }

  return sessions;
}

function toSession(entry, start, end, active) {
  return {
    startedAt: new Date(start).toISOString(),
    endedAt: active ? null : new Date(end).toISOString(),
    durationMinutes: Math.round(((end - start) / 60000) * 10) / 10,
    active,
    originName: entry.originName,
    originUri: entry.originUri,
  };
}

function getObjectValues(value) {
  return Object.values(value || {});
}

function getFlowCards(flow, type) {
  if (type === 'advanced') {
    return getObjectValues(flow.cards);
  }

  return [flow.trigger]
    .concat(Array.isArray(flow.conditions) ? flow.conditions : getObjectValues(flow.conditions))
    .concat(Array.isArray(flow.actions) ? flow.actions : getObjectValues(flow.actions))
    .filter(Boolean);
}

function getFlowDeviceIds(cards) {
  return cards.reduce((result, card) => {
    const match = String(card.ownerUri || card.id || '').match(/homey:device:([^:]+)/);
    if (match && !result.includes(match[1])) {
      result.push(match[1]);
    }
    return result;
  }, []);
}

function getTimerName(card) {
  return card?.args?.namedd?.name || card?.args?.name || null;
}

function getFlowTimerNames(cards) {
  return cards
    .filter((card) => card.ownerUri === `homey:app:${CHRONOGRAPH_APP_ID}` || String(card.id || '').includes(CHRONOGRAPH_APP_ID))
    .filter((card) => String(card.id || '').includes('timer_'))
    .map(getTimerName)
    .filter(Boolean)
    .filter((name, index, names) => names.indexOf(name) === index);
}

function getPrimaryTimerName(timerNames) {
  return timerNames.find((name) => !/lukning/i.test(name)) || timerNames[0] || null;
}

function summarizeTimer(timer) {
  if (!timer) return null;

  const targetDuration = Number(timer.targetDuration);
  const duration = Number(timer.duration);
  const remainingMs = Number.isFinite(targetDuration) && Number.isFinite(duration)
    ? Math.max(0, targetDuration - duration)
    : null;

  return {
    name: timer.name,
    running: timer.running === true,
    durationMs: Number.isFinite(duration) ? duration : null,
    targetDurationMs: Number.isFinite(targetDuration) ? targetDuration : null,
    remainingMs,
  };
}

function getWateringFlowInfos(flows, type, valveIds, timersByName) {
  return getObjectValues(flows).reduce((result, flow) => {
    if (flow.enabled === false) return result;

    const cards = getFlowCards(flow, type);
    const flowDeviceIds = getFlowDeviceIds(cards).filter((id) => valveIds.includes(id));
    if (flowDeviceIds.length === 0) return result;

    const timerNames = getFlowTimerNames(cards);
    const primaryTimerName = getPrimaryTimerName(timerNames);
    const timer = summarizeTimer(timersByName[primaryTimerName]);

    flowDeviceIds.forEach((deviceId) => {
      result[deviceId] = {
        type,
        id: flow.id || null,
        name: flow.name || 'Ukendt flow',
        timerName: primaryTimerName,
        timer,
      };
    });

    return result;
  }, {});
}

function enrichWateringValveFlows(valves, flows, advancedFlows, timers) {
  const valveIds = valves.map((valve) => valve.id);
  const timersByName = timers.reduce((result, timer) => {
    if (timer?.name) {
      result[timer.name] = timer;
    }
    return result;
  }, {});
  const normalFlowInfos = getWateringFlowInfos(flows, 'normal', valveIds, timersByName);
  const advancedFlowInfos = getWateringFlowInfos(advancedFlows, 'advanced', valveIds, timersByName);

  valves.forEach((valve) => {
    valve.wateringFlow = advancedFlowInfos[valve.id] || normalFlowInfos[valve.id] || null;
    valve.wateringActive = valve.wateringFlow?.timer
      ? valve.wateringFlow.timer.running === true
      : valve.on;
  });
}

async function enrichWateringValveAutomation(valves) {
  try {
    const { flows, advancedFlows, timers } = await getHomeyInventory();
    enrichWateringValveFlows(valves, flows, advancedFlows, timers);
  } catch (error) {
    valves.forEach((valve) => {
      valve.wateringFlow = null;
      valve.wateringActive = valve.on;
      valve.automationError = error.message || String(error);
    });
  }
}

function summarizeWateringValve(device, zoneInfo, meterEntries, onoffEntries, now, cutoff) {
  const zone = zoneInfo[device.zone] || {
    name: device.zone || 'Ukendt zone',
    path: [device.zone || 'Ukendt zone'],
    pathText: device.zone || 'Ukendt zone',
  };
  const days = getHistoryDays(now);
  const water = getWaterSummary(meterEntries, days);
  const sessions = getWateringSessions(onoffEntries, cutoff, now, days);
  const totalMinutes = sessions.reduce((sum, session) => sum + session.durationMinutes, 0);

  return {
    id: device.id,
    name: device.name.trim(),
    zoneId: device.zone || null,
    zoneName: zone.name,
    zonePath: zone.path,
    zonePathText: zone.pathText,
    available: device.available !== false,
    on: getCapabilityValue(device, 'onoff') === true,
    currentFlowLitersPerMinute: getCapabilityValue(device, 'measure_water'),
    currentMeterM3: getCapabilityValue(device, 'meter_water'),
    battery: getCapabilityValue(device, 'measure_battery'),
    totals: {
      sessions: sessions.length,
      minutes: Math.round(totalMinutes * 10) / 10,
      waterLiters: water.totalLiters,
    },
    history: {
      days: days.map((day) => ({
        key: day.key,
        label: day.label,
        waterLiters: Math.round(day.waterLiters * 10) / 10,
        minutes: Math.round(day.minutes * 10) / 10,
      })),
      firstMeterM3: water.firstMeterM3,
      lastMeterM3: water.lastMeterM3,
      meterPoints: water.points,
      onoffPoints: onoffEntries.filter((entry) => entry.t >= cutoff).length,
    },
    lastSession: sessions[sessions.length - 1] || null,
    recentSessions: sessions.slice(-6).reverse(),
  };
}

function compareWateringValves(a, b) {
  return Number(b.wateringActive) - Number(a.wateringActive)
    || a.zonePathText.localeCompare(b.zonePathText, 'da')
    || a.name.localeCompare(b.name, 'da');
}

async function toWateringValve(device, zoneInfo, now, cutoff) {
  try {
    const [meterEntries, onoffEntries] = await Promise.all([
      getInsightEntries(device.id, 'meter_water'),
      getInsightEntries(device.id, 'onoff'),
    ]);

    return summarizeWateringValve(
      device,
      zoneInfo,
      normalizeNumericEntries(meterEntries, cutoff),
      normalizeBooleanEntries(onoffEntries),
      now,
      cutoff,
    );
  } catch (error) {
    const zone = zoneInfo[device.zone] || {
      name: device.zone || 'Ukendt zone',
      path: [device.zone || 'Ukendt zone'],
      pathText: device.zone || 'Ukendt zone',
    };
    return {
      id: device.id,
      name: device.name.trim(),
      zoneId: device.zone || null,
      zoneName: zone.name,
      zonePath: zone.path,
      zonePathText: zone.pathText,
      available: device.available !== false,
      on: getCapabilityValue(device, 'onoff') === true,
      currentFlowLitersPerMinute: getCapabilityValue(device, 'measure_water'),
      currentMeterM3: getCapabilityValue(device, 'meter_water'),
      battery: getCapabilityValue(device, 'measure_battery'),
      totals: { sessions: 0, minutes: 0, waterLiters: 0 },
      history: {
        days: getHistoryDays(now),
        firstMeterM3: null,
        lastMeterM3: null,
        meterPoints: 0,
        onoffPoints: 0,
      },
      lastSession: null,
      recentSessions: [],
      error: error.message || String(error),
    };
  }
}

async function getWateringDashboard() {
  const now = Date.now();
  const cutoff = now - (WATERING_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const { devices: apiDevices, zones: apiZones } = await getHomeyInventory();
  const zoneInfo = getZoneInfo(apiZones);
  const valves = await Promise.all(
    Object.values(apiDevices || {})
      .filter(isWateringValve)
      .map((device) => toWateringValve(device, zoneInfo, now, cutoff)),
  );

  await enrichWateringValveAutomation(valves);
  valves.sort(compareWateringValves);

  return {
    generatedAt: new Date(now).toISOString(),
    historyDays: WATERING_HISTORY_DAYS,
    source: 'wingman-db',
    totals: {
      valves: valves.length,
      active: valves.filter((valve) => valve.wateringActive).length,
      sessions: valves.reduce((sum, valve) => sum + valve.totals.sessions, 0),
      minutes: Math.round(valves.reduce((sum, valve) => sum + valve.totals.minutes, 0) * 10) / 10,
      waterLiters: Math.round(valves.reduce((sum, valve) => sum + valve.totals.waterLiters, 0) * 10) / 10,
      errors: valves.filter((valve) => valve.error).length,
    },
    valves,
  };
}

function getZoneParentId(zone) {
  return zone?.parent || zone?.parentId || null;
}

function getZonePath(zoneId, zones, seen = []) {
  const zone = zones[zoneId];
  if (!zone) return zoneId ? [zoneId] : ['Ukendt zone'];
  if (seen.includes(zoneId)) return [zone.name || zoneId];

  const parentId = getZoneParentId(zone);
  const ownName = zone.name || zoneId;
  if (!parentId) return [ownName];

  return getZonePath(parentId, zones, seen.concat(zoneId)).concat(ownName);
}

function getZoneInfo(zones) {
  return Object.entries(zones || {}).reduce((result, [id, zone]) => {
    const pathParts = getZonePath(id, zones || {});
    result[id] = {
      id,
      name: zone.name || id,
      path: pathParts,
      pathText: pathParts.join(' / '),
    };
    return result;
  }, {});
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendError(response, 403, 'Forbidden');
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      sendError(response, 404, 'Not found');
      return;
    }
    throw error;
  }
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url.startsWith('/login')) {
      sendLogin(response);
      return;
    }

    if (request.method === 'POST' && request.url.startsWith('/login')) {
      await handleLogin(request, response);
      return;
    }

    if (request.method === 'GET' && request.url.startsWith('/manifest.json')) {
      await serveStatic(request, response);
      return;
    }

    if (!isAuthenticated(request)) {
      sendLogin(response);
      return;
    }

    if (request.method === 'GET' && request.url.startsWith('/api/dashboard')) {
      sendJson(response, 200, await getCachedValue('dashboard', CACHE_TTL_MS.dashboard, getDashboard));
      return;
    }

    if (request.method === 'GET' && request.url.startsWith('/api/overview-dashboard')) {
      sendJson(response, 200, await getCachedValue('overview', CACHE_TTL_MS.overview, getOverviewDashboard));
      return;
    }

    if (request.method === 'GET' && request.url.startsWith('/api/watering-dashboard')) {
      sendJson(response, 200, await getCachedValue('watering', CACHE_TTL_MS.watering, getWateringDashboard));
      return;
    }

    if (request.method === 'GET' && request.url.startsWith('/api/contact-dashboard')) {
      sendJson(response, 200, await getCachedValue('contact', CACHE_TTL_MS.contact, getContactDashboard));
      return;
    }

    if (request.method === 'GET' && request.url.startsWith('/api/motion-dashboard')) {
      sendJson(response, 200, await getCachedValue('motion', CACHE_TTL_MS.motion, getMotionDashboard));
      return;
    }

    if (request.method === 'GET' && request.url.startsWith('/api/lights-dashboard')) {
      sendJson(response, 200, await getCachedValue('lights', CACHE_TTL_MS.lights, getLightsDashboard));
      return;
    }

    if (request.method === 'GET' && request.url.startsWith('/api/energy-dashboard')) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const period = url.searchParams.get('period') || 'day';
      sendJson(response, 200, await getCachedValue(`energy:${period}`, CACHE_TTL_MS.energy, () => getEnergyDetailDashboard(period)));
      return;
    }

    if (request.method === 'POST' && request.url.startsWith('/api/lights/')) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const match = url.pathname.match(/^\/api\/lights\/([^/]+)\/onoff$/);
      if (!match) {
        sendError(response, 404, 'Not found');
        return;
      }

      const body = JSON.parse(await readRequestBody(request) || '{}');
      const result = await setLightOnOff(decodeURIComponent(match[1]), body.value);
      clearCache(['overview', 'lights']);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === 'GET' && request.url.startsWith('/api/state')) {
      sendJson(response, 200, await getCachedValue('state', CACHE_TTL_MS.state, readState));
      return;
    }

    if (request.method === 'POST' && request.url.startsWith('/api/state/toggle-watering-forbidden')) {
      sendJson(response, 200, await toggleWateringForbidden());
      return;
    }

    if (request.method === 'GET') {
      await serveStatic(request, response);
      return;
    }

    sendError(response, 405, 'Method not allowed');
  } catch (error) {
    console.error(error.message || error);
    sendError(response, 500, error.message || 'Internal server error');
  }
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Soil dashboard listening on http://0.0.0.0:${PORT}`);
  });
}

module.exports = {
  getActiveSince,
  countWaterAlarmActivations,
  enrichWateringValveFlows,
  getLatestCapabilityUpdatedAt,
  isActiveCapability,
  isLightDevice,
  isMotionSensor,
  isWateringValve,
  markZoneWaterAlarmTopscorers,
  normalizeSoilHistory,
  isContactSensor,
  shouldShowActiveDevice,
};
