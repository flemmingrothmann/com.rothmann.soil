"use strict";

/* eslint-disable no-console, no-use-before-define, node/no-unsupported-features/node-builtins */

const http = require("http");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1024 * 1024);
const HOMEY_URL = (process.env.HOMEY_URL || "").replace(/\/$/, "");
const HOMEY_TOKEN = process.env.HOMEY_TOKEN || "";
const HOME_ASSISTANT_URL = (process.env.HOME_ASSISTANT_URL || "").replace(
  /\/$/,
  "",
);
const HOME_ASSISTANT_TOKEN = process.env.HOME_ASSISTANT_TOKEN || "";
const INGEST_TOKEN = process.env.INGEST_TOKEN || "";
const WINGMAN_URL = (
  process.env.WINGMAN_URL || "http://homey-wingman-ingest-service:8788"
).replace(/\/$/, "");
const SOIL_CONTROLLER_URL = (
  process.env.SOIL_CONTROLLER_URL || "http://homey-wingman-soil-controller:8790"
).replace(/\/$/, "");
const REPLAY_URL = (
  process.env.REPLAY_URL || "http://homey-replay-service:8789"
).replace(/\/$/, "");
const REPLAY_TOKEN = process.env.REPLAY_TOKEN || "";
const PEUGEOT_URL = (
  process.env.PEUGEOT_URL || "http://peugeot-car-controller:5000"
).replace(/\/$/, "");
const PEUGEOT_VIN = process.env.PEUGEOT_VIN || "";
const PEUGEOT_MODEL = process.env.PEUGEOT_MODEL || "Peugeot";
const APP_ID = process.env.HOMEY_APP_ID || "com.rothmann.soil";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const COOKIE_SECRET =
  process.env.DASHBOARD_COOKIE_SECRET || `${DASHBOARD_PASSWORD}:${APP_ID}`;
const COOKIE_NAME = "soil_dashboard_session";
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const WATERING_FORBIDDEN_VARIABLE_ID =
  process.env.WATERING_FORBIDDEN_VARIABLE_ID ||
  "5a2a34fd-8d2f-4c7d-b076-b1bb41e3a41f";
const WATERING_HISTORY_DAYS = 14;
const SOIL_HISTORY_DAYS = 7;
const SOIL_WATER_ALARM_TOPSCORER_DAYS = 30;
const ENERGY_MAIN_DEVICE_ID = process.env.ENERGY_MAIN_DEVICE_ID || "";
const ENERGY_MAIN_DEVICE_NAME =
  process.env.ENERGY_MAIN_DEVICE_NAME || "Homey Energy Dongle";
const ENERGY_USAGE_DEVICE_ID = process.env.ENERGY_USAGE_DEVICE_ID || ENERGY_MAIN_DEVICE_ID;
const ENERGY_USAGE_FILTER = ENERGY_USAGE_DEVICE_ID
  ? `&deviceId=${encodeURIComponent(ENERGY_USAGE_DEVICE_ID)}` : "";
const ENERGY_BILLING_PERIOD_START_DAY = Number(
  process.env.ENERGY_BILLING_PERIOD_START_DAY || 1,
);
const ENERGY_PERIODS = ["day", "3days", "week", "month", "billing"];
const ENERGY_PERIOD_DAY_SPANS = {
  day: 1,
  "3days": 3,
  week: 7,
  month: 30,
};

const WATERING_INSIGHTS_RESOLUTION = "last14Days";
const CONTACT_INSIGHTS_RESOLUTION = "last7Days";
const CHRONOGRAPH_APP_ID = "nl.fellownet.chronograph";
const WATERING_VALVE_DRIVER_IDS = ["homey:app:se.styrahem.sonoff.zigbee:SWV"];
const VIRTUAL_DEVICE_DRIVER_IDS = [
  "homey:app:nl.qluster-it.DeviceCapabilities:virtualdevice",
];
const ALWAYS_ON_LIGHT_DEVICE_IDS = ["20a56e23-3720-475f-a197-0cfdfc9fce36"];
const MIN_SOIL_OFFLINE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_SOIL_OFFLINE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SOIL_OFFLINE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const SOIL_MAINTENANCE_UNCHANGED_MS = Number(
  process.env.DASHBOARD_SOIL_MAINTENANCE_UNCHANGED_MS || 22 * 60 * 60 * 1000,
);
const SOIL_ISSUE_COUNTER_TYPES = ["offline", "maintenance"];
const SOIL_WARNING_THRESHOLD_MIN = 0;
const SOIL_WARNING_THRESHOLD_MAX = 90;

const PUBLIC_DIR = path.join(__dirname, "public");
const STATE_FILE = process.env.DASHBOARD_STATE_FILE || "/data/state.json";
const CACHE_TTL_MS = {
  dashboard: Number(process.env.DASHBOARD_SOIL_CACHE_MS || 3000),
  overview: Number(process.env.DASHBOARD_OVERVIEW_CACHE_MS || 3000),
  watering: Number(process.env.DASHBOARD_WATERING_CACHE_MS || 10000),
  contact: Number(process.env.DASHBOARD_CONTACT_CACHE_MS || 3000),
  motion: Number(process.env.DASHBOARD_MOTION_CACHE_MS || 3000),
  lights: Number(process.env.DASHBOARD_LIGHTS_CACHE_MS || 3000),
  energy: Number(process.env.DASHBOARD_ENERGY_CACHE_MS || 5 * 60 * 1000),
  vehicle: Number(process.env.DASHBOARD_VEHICLE_CACHE_MS || 5 * 60 * 1000),
  state: Number(process.env.DASHBOARD_STATE_CACHE_MS || 3000),
  zigbee: Number(process.env.DASHBOARD_ZIGBEE_CACHE_MS || 30000),
};
const ZIGBEE_ROUTE_HISTORY_DAYS = Number(
  process.env.DASHBOARD_ZIGBEE_HISTORY_DAYS || 7,
);
const ZIGBEE_SAMPLING_INTERVAL_MS = Number(
  process.env.DASHBOARD_ZIGBEE_SAMPLING_INTERVAL_MS || 10 * 60 * 1000,
);
const responseCache = new Map();
const wateringVariableOverrides = new Map();
let zigbeeSamplerRunning = false;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function sendJson(response, statusCode, data) {
  const body = JSON.stringify(data);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
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

async function readStateFile() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(error.message || error);
    }

    return {};
  }
}

async function writeStateFile(state) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readState() {
  const [variable, state] = await Promise.all([
    getHomeyApi(`/manager/logic/variable/${WATERING_FORBIDDEN_VARIABLE_ID}`),
    readStateFile(),
  ]);

  return {
    ...state,
    wateringForbidden: variable.value === true,
    updatedAt: state.updatedAt || null,
  };
}

async function writeState(state) {
  const currentState = await readStateFile();
  await writeStateFile({
    ...currentState,
    ...state,
  });
}

function normalizeSoilIssueCounterType(type) {
  if (!SOIL_ISSUE_COUNTER_TYPES.includes(type)) {
    throw new Error("Ukendt sensortæller.");
  }

  return type;
}

function getCounterCountKey(type) {
  return `${type}Count`;
}

function getCounterActiveKey(type) {
  return `${type}Active`;
}

function getCounterLastTriggeredAtKey(type) {
  return `${type}LastTriggeredAt`;
}

function normalizeCounterCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
}

function normalizeSoilIssueCounterRecord(record = {}) {
  return SOIL_ISSUE_COUNTER_TYPES.reduce((result, type) => {
    const countKey = getCounterCountKey(type);
    const activeKey = getCounterActiveKey(type);
    const lastTriggeredAtKey = getCounterLastTriggeredAtKey(type);

    result[countKey] = normalizeCounterCount(record[countKey] ?? record[type]);
    result[activeKey] = record[activeKey] === true;
    result[lastTriggeredAtKey] = record[lastTriggeredAtKey] || null;
    return result;
  }, {});
}

function normalizeSoilIssueCounters(counters = {}) {
  return Object.entries(counters || {}).reduce((result, [deviceId, record]) => {
    if (deviceId) {
      result[deviceId] = normalizeSoilIssueCounterRecord(record);
    }

    return result;
  }, {});
}

function getDeviceIssueActive(device, type) {
  if (type === "offline") return device.offline === true;
  if (type === "maintenance") return device.needsMaintenance === true;
  return false;
}

function attachSoilIssueCounterValues(device, record) {
  device.issueCounters = {
    offline: normalizeCounterCount(record.offlineCount),
    maintenance: normalizeCounterCount(record.maintenanceCount),
  };
}

function updateSoilIssueCounterState(state, devices, now) {
  const counters = normalizeSoilIssueCounters(state?.sensorIssueCounters);
  const triggeredAt = new Date(now).toISOString();
  let changed = false;

  for (const device of devices) {
    const deviceId = device.apiDeviceId;
    if (!deviceId) continue;

    const record = counters[deviceId] || normalizeSoilIssueCounterRecord();

    for (const type of SOIL_ISSUE_COUNTER_TYPES) {
      const active = getDeviceIssueActive(device, type);
      const countKey = getCounterCountKey(type);
      const activeKey = getCounterActiveKey(type);
      const lastTriggeredAtKey = getCounterLastTriggeredAtKey(type);

      if (active && record[activeKey] !== true) {
        record[countKey] += 1;
        record[lastTriggeredAtKey] = triggeredAt;
        changed = true;
      }

      if (record[activeKey] !== active) {
        record[activeKey] = active;
        changed = true;
      }
    }

    counters[deviceId] = record;
    attachSoilIssueCounterValues(device, record);
  }

  return {
    changed,
    state: {
      ...(state || {}),
      sensorIssueCounters: counters,
    },
  };
}

async function applySoilIssueCounters(devices, now) {
  const state = await readStateFile();
  const result = updateSoilIssueCounterState(state, devices, now);

  if (result.changed) {
    await writeStateFile(result.state);
  }
}

async function resetSoilIssueCounter(deviceId, typeValue) {
  const type = normalizeSoilIssueCounterType(typeValue);
  const state = await readStateFile();
  const counters = normalizeSoilIssueCounters(state.sensorIssueCounters);
  const record = counters[deviceId] || normalizeSoilIssueCounterRecord();

  record[getCounterCountKey(type)] = 0;
  counters[deviceId] = record;
  await writeStateFile({
    ...state,
    sensorIssueCounters: counters,
  });
  clearCache(["dashboard", "overview"]);

  return {
    ok: true,
    deviceId,
    type,
    count: 0,
  };
}

async function resetAllSoilIssueCounters() {
  const state = await readStateFile();
  const counters = normalizeSoilIssueCounters(state.sensorIssueCounters);
  let devices = 0;

  Object.values(counters).forEach((record) => {
    devices += 1;
    SOIL_ISSUE_COUNTER_TYPES.forEach((type) => {
      record[getCounterCountKey(type)] = 0;
    });
  });

  await writeStateFile({
    ...state,
    sensorIssueCounters: counters,
  });
  clearCache(["dashboard", "overview"]);

  return { ok: true, devices };
}

async function toggleWateringForbidden() {
  const currentState = await readState();
  const nextValue = !currentState.wateringForbidden;
  await putHomeyApi(
    `/manager/logic/variable/${WATERING_FORBIDDEN_VARIABLE_ID}`,
    { value: nextValue },
  );

  const nextState = {
    wateringForbidden: nextValue,
    updatedAt: new Date().toISOString(),
  };
  await writeState(nextState);
  clearCache(["state", "overview", "watering"]);
  return nextState;
}

function sign(value) {
  return crypto
    .createHmac("sha256", COOKIE_SECRET)
    .update(value)
    .digest("base64url");
}

function getSessionCookieValue() {
  const value = "authenticated";
  return `${value}.${sign(value)}`;
}

function parseCookies(request) {
  return String(request.headers.cookie || "")
    .split(";")
    .reduce((result, cookie) => {
      const separatorIndex = cookie.indexOf("=");
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

  const [value, signature] = cookieValue.split(".");
  if (!value || !signature) return false;

  return signature === sign(value);
}

function sendLogin(response, errorMessage = "") {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
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
      ${errorMessage ? `<p class="error">${errorMessage}</p>` : ""}
    </form>
  </body>
</html>`);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    request.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(new Error("Request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!tooLarge) resolve(body);
    });
    request.on("error", reject);
  });
}

async function handleLogin(request, response) {
  const body = await readRequestBody(request);
  const params = new URLSearchParams(body);

  if (params.get("password") !== DASHBOARD_PASSWORD) {
    sendLogin(response, "Forkert adgangskode.");
    return;
  }

  response.writeHead(303, {
    location: "/",
    "set-cookie": `${COOKIE_NAME}=${encodeURIComponent(getSessionCookieValue())}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax`,
    "cache-control": "no-store",
  });
  response.end();
}

async function getDashboard() {
  const now = Date.now();
  const { devices: apiDevices, zones: apiZones } = await getHomeyInventory();
  const zoneInfo = getZoneInfo(apiZones);
  const soilDevices = Object.values(apiDevices || {}).filter((device) =>
    hasCapability(device, "measure_soil_moisture"),
  );
  const devices = await Promise.all(
    soilDevices.map((device) => toSoilDashboardDevice(device, zoneInfo, now)),
  );

  await applySoilIssueCounters(devices, now);
  devices.sort(compareDashboardDevices);

  const zones = devices.reduce((result, device) => {
    const zoneKey = device.zoneId || "unknown";
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
    source: "wingman-db",
    totals: {
      devices: devices.length,
      alarms: devices.filter((device) => device.needsAction).length,
      waterAlarms: devices.filter((device) => device.values.waterAlarm).length,
      maintenance: devices.filter((device) => device.needsMaintenance).length,
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
      accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Homey returned ${response.status}: ${body || response.statusText}`,
    );
  }

  return response.json();
}

async function getWingmanApi(pathname) {
  if (!WINGMAN_URL) {
    throw new Error("WINGMAN_URL must be configured");
  }

  let response;
  try {
    response = await fetch(`${WINGMAN_URL}${pathname}`, {
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new Error(
      `Wingman fetch ${pathname} failed: ${error.message || error}`,
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Wingman returned ${response.status}: ${body || response.statusText}`,
    );
  }

  return response.json();
}

async function writeWingmanApi(method, pathname, body) {
  if (!WINGMAN_URL) {
    throw new Error("WINGMAN_URL must be configured");
  }
  if (!INGEST_TOKEN) {
    throw new Error("INGEST_TOKEN must be configured for Wingman writes");
  }

  const response = await fetch(`${WINGMAN_URL}${pathname}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Wingman returned ${response.status}: ${responseBody || response.statusText}`,
    );
  }

  return response.json();
}

async function requestReplayApi(method, pathname, body) {
  if (!REPLAY_URL || !REPLAY_TOKEN) {
    throw new Error("REPLAY_URL and REPLAY_TOKEN must be configured");
  }

  const response = await fetch(`${REPLAY_URL}${pathname}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${REPLAY_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const responseBody = await response.text();
  let result;
  try {
    result = responseBody ? JSON.parse(responseBody) : {};
  } catch {
    result = { error: responseBody || response.statusText };
  }

  if (!response.ok) {
    const error = new Error(
      result.error || `Replay-service returnerede ${response.status}.`,
    );
    error.statusCode = response.status;
    throw error;
  }
  return result;
}

function firstNumber(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") {
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
  }
  return null;
}

function formatPeugeotAge(ageMs) {
  if (!Number.isFinite(ageMs)) return "alder ukendt";
  const minutes = Math.max(0, Math.floor(ageMs / 60000));
  if (minutes < 1) return "under 1 min.";
  if (minutes < 60) return `${minutes} min.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} t`;
  const days = Math.floor(hours / 24);
  return `${days} dage`;
}

function findElectricEnergy(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    return (
      value.find((item) =>
        /electric/i.test(String(item?.type || item?.energyType || "")),
      ) ||
      value.map(findElectricEnergy).find(Boolean) ||
      null
    );
  }

  if (
    /electric/i.test(String(value.type || value.energyType || "")) &&
    (value.level !== undefined ||
      value.autonomy !== undefined ||
      value.charging)
  ) {
    return value;
  }

  for (const child of Object.values(value)) {
    const match = findElectricEnergy(child);
    if (match) return match;
  }
  return null;
}

function findTimestamp(value) {
  if (!value || typeof value !== "object") return null;
  const candidate =
    value.updatedAt ||
    value.updated_at ||
    value.timestamp ||
    value.lastUpdated ||
    value.createdAt;
  if (candidate && Number.isFinite(Date.parse(candidate)))
    return new Date(candidate).toISOString();
  for (const child of Object.values(value)) {
    const match = findTimestamp(child);
    if (match) return match;
  }
  return null;
}

function findVehicleModel(value) {
  if (!value || typeof value !== "object") return null;
  const candidates = [value.model, value.modelName, value.label, value.name];
  const candidate = candidates.find(
    (item) =>
      item &&
      !["unknown", "peugeot"].includes(String(item).trim().toLowerCase()),
  );
  if (candidate) return String(candidate).trim();
  for (const child of Object.values(value)) {
    const match = findVehicleModel(child);
    if (match) return match;
  }
  return null;
}

function normalizePeugeotVehicle(
  payload,
  now = Date.now(),
  fallbackModel = "Peugeot",
) {
  const energy = findElectricEnergy(payload) || {};
  const charging = energy.charging || payload?.charging || {};
  const updatedAt = findTimestamp(payload);
  const updatedAtMs = Date.parse(updatedAt);
  const level = firstNumber(
    energy.level,
    energy.batteryLevel,
    energy.stateOfCharge,
    payload?.batteryLevel,
  );
  const rangeKm = firstNumber(
    energy.autonomy,
    energy.range,
    energy.rangeKm,
    payload?.autonomy,
  );
  const chargingStatus =
    charging.status || charging.chargingStatus || energy.chargingStatus || null;
  const ageMs = Number.isFinite(updatedAtMs)
    ? Math.max(0, now - updatedAtMs)
    : null;
  let freshness = "old";
  if (ageMs !== null && ageMs < 60 * 60 * 1000) freshness = "fresh";
  else if (ageMs !== null && ageMs < 6 * 60 * 60 * 1000) freshness = "aging";

  return {
    generatedAt: new Date(now).toISOString(),
    source: "MyPeugeot via psa_car_controller",
    configured: true,
    vehicle: {
      name: findVehicleModel(payload) || fallbackModel,
      batteryLevel: level,
      rangeKm,
      charging: /progress|charging|incharge/i.test(
        String(chargingStatus || ""),
      ),
      chargingStatus,
      plugged:
        charging.plugged === true ||
        charging.pluggedState === true ||
        /connected|plugged/i.test(String(charging.pluggedState || "")),
      remainingMinutes: firstNumber(
        charging.remainingTime,
        charging.remainingMinutes,
      ),
      updatedAt,
      fetchedAt: new Date(now).toISOString(),
      ageMs,
      freshness,
      stale: freshness === "old",
    },
  };
}

async function getPeugeotDashboard() {
  if (!PEUGEOT_VIN) {
    return {
      generatedAt: new Date().toISOString(),
      source: "MyPeugeot via psa_car_controller",
      configured: false,
      vehicle: null,
    };
  }

  const response = await fetch(
    `${PEUGEOT_URL}/get_vehicleinfo/${encodeURIComponent(PEUGEOT_VIN)}?from_cache=1`,
    {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Peugeot-service returnerede ${response.status}: ${body || response.statusText}`,
    );
  }

  try {
    return normalizePeugeotVehicle(JSON.parse(body), Date.now(), PEUGEOT_MODEL);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("Peugeot-service returnerede et ugyldigt svar.");
    throw error;
  }
}

async function getHomeyInventory() {
  const snapshot = await getWingmanApi("/api/homey/snapshot");
  const logicVariables = snapshot.logicVariables || {};

  for (const [id, value] of wateringVariableOverrides) {
    const variable = logicVariables[id];
    if (variable?.value === value) {
      wateringVariableOverrides.delete(id);
      continue;
    }

    if (variable) {
      logicVariables[id] = { ...variable, value };
    }
  }

  return {
    devices: snapshot.devices || {},
    zones: snapshot.zones || {},
    flows: snapshot.flows || {},
    advancedFlows: snapshot.advancedFlows || {},
    timers: Array.isArray(snapshot.timers) ? snapshot.timers : [],
    logicVariables,
  };
}

async function putHomeyApi(pathname, body) {
  const response = await fetch(`${HOMEY_URL}/api${pathname}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${HOMEY_TOKEN}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Homey returned ${response.status}: ${responseBody || response.statusText}`,
    );
  }

  return response.json();
}

async function postHomeyAppApi(pathname, body) {
  if (!HOMEY_URL || !HOMEY_TOKEN) {
    throw new Error("HOMEY_URL and HOMEY_TOKEN must be configured");
  }

  const response = await fetch(`${HOMEY_URL}/api/app/${APP_ID}${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${HOMEY_TOKEN}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Homey returned ${response.status}: ${responseBody || response.statusText}`,
    );
  }

  return response.json();
}

async function requestSoilController(method, pathname, body) {
  if (!SOIL_CONTROLLER_URL || !INGEST_TOKEN) {
    throw new Error("SOIL_CONTROLLER_URL and INGEST_TOKEN must be configured");
  }

  const response = await fetch(`${SOIL_CONTROLLER_URL}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${INGEST_TOKEN}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const responseBody = await response.text();
  let result;
  try {
    result = responseBody ? JSON.parse(responseBody) : {};
  } catch {
    result = { error: responseBody || response.statusText };
  }
  if (!response.ok)
    throw new Error(
      result.error || `Jord-controller returnerede ${response.status}.`,
    );
  return result;
}

async function getHaWateringStatus(valveId) {
  return requestSoilController(
    "GET",
    `/api/watering/${encodeURIComponent(valveId)}/status`,
  );
}

async function restartHaWateringAfterError(valveId) {
  return requestSoilController(
    "POST",
    `/api/watering/${encodeURIComponent(valveId)}/restart`,
  );
}

async function setHaWateringForbidden(valveId, value) {
  return requestSoilController(
    "POST",
    `/api/watering/${encodeURIComponent(valveId)}/forbidden`,
    { value },
  );
}

async function configureHaWateringCircuit(action, body) {
  return requestSoilController(
    "POST",
    `/api/watering-circuits/${action}`,
    body,
  );
}

function hasCapability(device, capability) {
  return (
    Array.isArray(device?.capabilities) &&
    device.capabilities.includes(capability)
  );
}

function hasOwnSetting(device, setting) {
  return Object.prototype.hasOwnProperty.call(device?.settings || {}, setting);
}

function hasSoilAlarmThresholdControl(device) {
  return (
    hasCapability(device, "soil_warning_threshold") &&
    hasOwnSetting(device, "soil_warning")
  );
}

function isHomeAssistantSoilDevice(device) {
  return String(device?.driverId || "").startsWith("zigbee2mqtt:");
}

function isWateringValve(device) {
  return (
    (WATERING_VALVE_DRIVER_IDS.includes(device?.driverId) ||
      String(device?.driverId || "").startsWith("zigbee2mqtt:SONOFF:SWV")) &&
    hasCapability(device, "onoff")
  );
}

function getShortDriverId(device) {
  return (
    String(device?.driverId || "")
      .split(":")
      .pop() ||
    device?.driverId ||
    null
  );
}

function getSoilOfflineTimeoutMs(device) {
  const settings = device?.settings || {};
  const intervalSeconds = Number(
    settings.soil_sampling || settings.humidity_report_max_interval,
  );

  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    return DEFAULT_SOIL_OFFLINE_TIMEOUT_MS;
  }

  return Math.max(
    MIN_SOIL_OFFLINE_TIMEOUT_MS,
    Math.min(MAX_SOIL_OFFLINE_TIMEOUT_MS, intervalSeconds * 3 * 1000),
  );
}

function getSoilAlarmThreshold(device) {
  const capabilityValue = getCapabilityValue(device, "soil_warning_threshold");
  if (typeof capabilityValue === "number") {
    return capabilityValue;
  }

  const settingValue = Number(device?.settings?.soil_warning);
  return Number.isFinite(settingValue) ? settingValue : null;
}

function normalizeSoilHistory(entries, now) {
  const cutoff = now - SOIL_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  return entries
    .map((entry) => ({
      t: Date.parse(entry?.t),
      v: Number(entry?.v),
    }))
    .filter(
      (entry) =>
        Number.isFinite(entry.t) &&
        Number.isFinite(entry.v) &&
        entry.t >= cutoff,
    )
    .sort((a, b) => a.t - b.t)
    .slice(-7500);
}

function countWaterAlarmActivations(entries, cutoff) {
  return entries.reduce((count, entry) => {
    const timestamp = Date.parse(entry?.t);
    return (
      count +
      (entry?.v === true && Number.isFinite(timestamp) && timestamp >= cutoff
        ? 1
        : 0)
    );
  }, 0);
}

function getLatestCapabilityUpdatedAt(device) {
  return Object.values(device?.capabilitiesObj || {}).reduce(
    (latest, capabilityInfo) => {
      const timestamp = Date.parse(capabilityInfo?.lastUpdated);
      if (!Number.isFinite(timestamp)) return latest;

      return Number.isFinite(latest) ? Math.max(latest, timestamp) : timestamp;
    },
    NaN,
  );
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

function getSoilMoistureLastChangedAtMs(device, history) {
  const capabilityUpdatedAt = Date.parse(
    device?.capabilitiesObj?.measure_soil_moisture?.lastUpdated,
  );
  const historyUpdatedAt =
    Array.isArray(history) && history.length > 0
      ? history[history.length - 1].t
      : NaN;
  const candidates = [capabilityUpdatedAt, historyUpdatedAt].filter(
    Number.isFinite,
  );

  return candidates.length > 0 ? Math.max(...candidates) : NaN;
}

function getSoilMaintenanceStatus(device, now, live, history = []) {
  const rawSoilMoisture = getCapabilityValue(device, "measure_soil_moisture");
  const soilMoisture =
    rawSoilMoisture === null ||
    rawSoilMoisture === undefined ||
    rawSoilMoisture === ""
      ? NaN
      : Number(rawSoilMoisture);
  const lastChangedAtMs = getSoilMoistureLastChangedAtMs(device, history);
  const unchangedMs = Number.isFinite(lastChangedAtMs)
    ? Math.max(0, now - lastChangedAtMs)
    : null;
  const needed =
    isAvailable(device) &&
    live === true &&
    Number.isFinite(soilMoisture) &&
    typeof unchangedMs === "number" &&
    unchangedMs >= SOIL_MAINTENANCE_UNCHANGED_MS;

  return {
    needed,
    lastChangedAt: Number.isFinite(lastChangedAtMs)
      ? new Date(lastChangedAtMs).toISOString()
      : null,
    unchangedMinutes:
      typeof unchangedMs === "number" ? Math.round(unchangedMs / 60000) : null,
    thresholdHours: Math.round(
      SOIL_MAINTENANCE_UNCHANGED_MS / (60 * 60 * 1000),
    ),
  };
}

function isSoilDeviceLive(device, now, fallbackUpdatedAt, history) {
  const lastReportedAtMs = getSoilLastReportedAtMs(
    device,
    fallbackUpdatedAt,
    history,
  );
  return (
    isAvailable(device) &&
    Number.isFinite(lastReportedAtMs) &&
    now - lastReportedAtMs <= getSoilOfflineTimeoutMs(device)
  );
}

function canSetSoilAlarmThreshold(device, now, live) {
  const deviceLive =
    typeof live === "boolean"
      ? live
      : isSoilDeviceLive(
          device,
          now,
          device?.capabilitiesObj?.measure_soil_moisture?.lastUpdated,
        );
  return (
    isAvailable(device) && deviceLive && hasSoilAlarmThresholdControl(device)
  );
}

function normalizeSoilWarningThresholdInput(value) {
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue)) {
    throw new Error("Jordfugtgrænsen skal være et tal.");
  }

  const threshold = Math.round(parsedValue);
  if (
    threshold < SOIL_WARNING_THRESHOLD_MIN ||
    threshold > SOIL_WARNING_THRESHOLD_MAX
  ) {
    throw new Error(
      `Jordfugtgrænsen skal være mellem ${SOIL_WARNING_THRESHOLD_MIN} og ${SOIL_WARNING_THRESHOLD_MAX} %.`,
    );
  }

  return threshold;
}

async function setSoilAlarmThreshold(deviceId, value) {
  const threshold = normalizeSoilWarningThresholdInput(value);
  const { devices: apiDevices } = await getHomeyInventory();
  const device = apiDevices?.[deviceId];
  const now = Date.now();
  const live = device
    ? isSoilDeviceLive(
        device,
        now,
        device.capabilitiesObj?.measure_soil_moisture?.lastUpdated,
      )
    : false;

  if (!device || !hasCapability(device, "measure_soil_moisture")) {
    throw new Error("Jordfugtsensoren blev ikke fundet.");
  }

  if (!isAvailable(device)) {
    throw new Error("Sensoren melder fejl og kan ikke ændres fra dashboardet.");
  }

  if (!live) {
    throw new Error("Sensoren er offline og jordfugtgrænsen kan ikke ændres.");
  }

  if (!hasSoilAlarmThresholdControl(device)) {
    throw new Error(
      "Sensoren understøtter ikke jordfugtgrænse fra dashboardet.",
    );
  }

  if (isHomeAssistantSoilDevice(device)) {
    const result = await requestSoilController(
      "POST",
      `/api/soil-sensors/${encodeURIComponent(deviceId)}/threshold`,
      { value: threshold },
    );
    clearCache(["dashboard", "overview", "watering"]);
    return { ok: true, deviceId, value: result.value ?? threshold };
  }

  if (!device.data) {
    throw new Error("Sensoren kunne ikke matches til Homey-appen.");
  }

  const result = await postHomeyAppApi("/soil-warning-threshold", {
    deviceId,
    driverId: device.driverId,
    deviceData: device.data,
    value: threshold,
  });
  clearCache(["dashboard", "overview"]);
  return { ok: true, deviceId, value: result.value ?? threshold };
}

function compareDashboardDevices(a, b) {
  return (
    a.zonePathText.localeCompare(b.zonePathText, "da") ||
    Number(b.needsAction) - Number(a.needsAction) ||
    Number(b.values.waterAlarm) - Number(a.values.waterAlarm) ||
    Number(b.needsMaintenance) - Number(a.needsMaintenance) ||
    a.name.localeCompare(b.name, "da")
  );
}

function compareZoneDevices(a, b) {
  return a.name.localeCompare(b.name, "da");
}

function markZoneWaterAlarmTopscorers(zones) {
  for (const zone of zones) {
    const topCount = zone.devices.reduce(
      (count, device) =>
        Math.max(count, device.waterAlarmStats.monthlyActivations),
      0,
    );

    if (topCount > 0) {
      zone.devices.forEach((device) => {
        device.waterAlarmStats.zoneTopScorer =
          device.waterAlarmStats.monthlyActivations === topCount;
      });
    }
  }
}

async function getWingmanEventEntries(deviceId, capability, sinceMs) {
  const result = await getWingmanApi(
    `/api/events?deviceId=${encodeURIComponent(deviceId)}&capability=${encodeURIComponent(capability)}&since=${encodeURIComponent(String(sinceMs))}`,
  );
  return Array.isArray(result?.values) ? result.values : [];
}

async function toSoilDashboardDevice(device, zoneInfo, now) {
  const zone = zoneInfo[device.zone] || {
    name: device.zone || "Ukendt zone",
    path: [device.zone || "Ukendt zone"],
    pathText: device.zone || "Ukendt zone",
  };
  const historyCutoff = now - SOIL_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const alarmCutoff =
    now - SOIL_WATER_ALARM_TOPSCORER_DAYS * 24 * 60 * 60 * 1000;
  const [moistureEntries, alarmEntries] = await Promise.all([
    getWingmanEventEntries(device.id, "measure_soil_moisture", historyCutoff),
    getWingmanEventEntries(device.id, "alarm_water", alarmCutoff),
  ]);
  const currentMoisture = getCapabilityValue(device, "measure_soil_moisture");
  const currentMoistureUpdated =
    device.capabilitiesObj?.measure_soil_moisture?.lastUpdated;
  const history = normalizeSoilHistory(
    moistureEntries.concat(
      currentMoistureUpdated
        ? [{ t: currentMoistureUpdated, v: currentMoisture }]
        : [],
    ),
    now,
  );
  const lastReportedAtMs = getSoilLastReportedAtMs(
    device,
    currentMoistureUpdated,
    history,
  );
  const hasLastReport = Number.isFinite(lastReportedAtMs);
  const offlineTimeoutMs = getSoilOfflineTimeoutMs(device);
  const available = isAvailable(device);
  const live = isSoilDeviceLive(device, now, currentMoistureUpdated, history);
  const waterAlarm = getCapabilityValue(device, "alarm_water") === true;
  const waterAlarmActivations = countWaterAlarmActivations(
    alarmEntries,
    alarmCutoff,
  );
  const driverId = getShortDriverId(device);
  const hasError = !available;
  const offline = available && !live;
  const maintenance = getSoilMaintenanceStatus(device, now, live, history);

  return {
    id: `${driverId || device.driverId || "device"}:${device.id}`,
    apiDeviceId: device.id,
    name: String(device.name || "").trim(),
    driverId,
    driverName: device.driverId || driverId || "Ukendt driver",
    zoneId: device.zone || null,
    zoneName: zone.name,
    zonePath: zone.path,
    zonePathText: zone.pathText,
    available,
    live,
    offline,
    error: hasError,
    needsMaintenance: maintenance.needed,
    needsAction: waterAlarm || offline || hasError || maintenance.needed,
    maintenance,
    lastReportedAt: hasLastReport
      ? new Date(lastReportedAtMs).toISOString()
      : null,
    offlineAfterMinutes: Math.round(offlineTimeoutMs / 60000),
    values: {
      soilMoisture: currentMoisture,
      alarmThreshold: getSoilAlarmThreshold(device),
      waterAlarm,
      battery: getCapabilityValue(device, "measure_battery"),
      temperature: getCapabilityValue(device, "measure_temperature"),
      airHumidity: getCapabilityValue(device, "measure_humidity"),
      luminance: getCapabilityValue(device, "measure_luminance"),
      fertility: getCapabilityValue(device, "measure_soil_fertility"),
      linkQuality: getCapabilityValue(device, "linkquality"),
    },
    controls: {
      canSetAlarmThreshold: canSetSoilAlarmThreshold(device, now, live),
      thresholdController: isHomeAssistantSoilDevice(device)
        ? "home_assistant"
        : "homey",
    },
    waterAlarmStats: {
      periodDays: SOIL_WATER_ALARM_TOPSCORER_DAYS,
      monthlyActivations: waterAlarm
        ? Math.max(1, waterAlarmActivations)
        : waterAlarmActivations,
      zoneTopScorer: false,
    },
    history,
  };
}

function getCapabilityValue(device, capability) {
  return device?.capabilitiesObj?.[capability]?.value ?? null;
}

function hasIngestedCapability(device, capability) {
  return device?.capabilitiesObj?.[capability]?.ingested === true;
}

function isAvailable(device) {
  return device?.available !== false;
}

function isActiveCapability(device, capability) {
  return isAvailable(device) && getCapabilityValue(device, capability) === true;
}

function isMissingInsightsLogError(error) {
  return /Not Found|404|LogLocal with ID/i.test(
    error?.message || String(error),
  );
}

function isContactSensor(device) {
  return (
    hasCapability(device, "alarm_contact") &&
    !VIRTUAL_DEVICE_DRIVER_IDS.includes(device?.driverId)
  );
}

function isMotionSensor(device) {
  return (
    hasCapability(device, "alarm_motion") &&
    !VIRTUAL_DEVICE_DRIVER_IDS.includes(device?.driverId)
  );
}

function isLightDevice(device) {
  return (
    device?.class === "light" &&
    hasCapability(device, "onoff") &&
    !ALWAYS_ON_LIGHT_DEVICE_IDS.includes(device?.id)
  );
}

function getInsightLogId(deviceId, capability) {
  return `homey:device:${deviceId}:${capability}`;
}

async function getInsightEntries(
  deviceId,
  capability,
  resolution = WATERING_INSIGHTS_RESOLUTION,
) {
  if (WINGMAN_URL) {
    const since =
      resolution === CONTACT_INSIGHTS_RESOLUTION
        ? Date.now() - 7 * 24 * 60 * 60 * 1000
        : Date.now() - WATERING_HISTORY_DAYS * 24 * 60 * 60 * 1000;
    const result = await getWingmanApi(
      `/api/events?deviceId=${encodeURIComponent(deviceId)}&capability=${encodeURIComponent(capability)}&since=${encodeURIComponent(String(since))}`,
    );
    return Array.isArray(result?.values) ? result.values : [];
  }

  const ownerUri = `homey:device:${deviceId}`;
  const logId = getInsightLogId(deviceId, capability);
  const result = await getHomeyApi(
    `/manager/insights/log/${ownerUri}/${logId}/entry?resolution=${resolution}`,
  );
  return Array.isArray(result?.values) ? result.values : [];
}

function toDateKey(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toDayLabel(dateKey) {
  const date = new Date(`${dateKey}T12:00:00`);
  return date.toLocaleDateString("da-DK", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
}

function getHistoryDays(now) {
  const days = [];
  const date = new Date(
    now - (WATERING_HISTORY_DAYS - 1) * 24 * 60 * 60 * 1000,
  );
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
    .filter(
      (entry) =>
        Number.isFinite(entry.t) &&
        Number.isFinite(entry.v) &&
        entry.t >= cutoff,
    )
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
    name: device.zone || "Ukendt zone",
    path: [device.zone || "Ukendt zone"],
    pathText: device.zone || "Ukendt zone",
  };
  let openSince = null;
  let error = null;

  try {
    const entries = await getInsightEntries(
      device.id,
      "alarm_contact",
      CONTACT_INSIGHTS_RESOLUTION,
    );
    const activeSince = getActiveSince(entries);
    openSince =
      activeSince === null ? null : new Date(activeSince).toISOString();
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
    open: getCapabilityValue(device, "alarm_contact") === true,
    openSince,
    openDurationMs: Number.isFinite(openSinceMs)
      ? Math.max(0, Date.now() - openSinceMs)
      : null,
    battery: getCapabilityValue(device, "measure_battery"),
    linkQuality: getCapabilityValue(device, "linkquality"),
    linkQualityIngested: hasIngestedCapability(device, "linkquality"),
    error,
  };
}

async function toActiveBinaryDevice(device, zoneInfo, capability) {
  const zone = zoneInfo[device.zone] || {
    name: device.zone || "Ukendt zone",
    path: [device.zone || "Ukendt zone"],
    pathText: device.zone || "Ukendt zone",
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
    battery: getCapabilityValue(device, "measure_battery"),
    linkQuality: getCapabilityValue(device, "linkquality"),
    error: isAvailable(device)
      ? null
      : "Enheden melder fejl eller er utilgængelig i Homey.",
  };
}

function compareContactSensors(a, b) {
  return (
    a.zonePathText.localeCompare(b.zonePathText, "da") ||
    (b.openDurationMs || 0) - (a.openDurationMs || 0) ||
    a.name.localeCompare(b.name, "da")
  );
}

async function getContactDashboard() {
  const now = Date.now();
  const { devices: apiDevices, zones: apiZones } = await getHomeyInventory();
  const zoneInfo = getZoneInfo(apiZones);
  const contactDevices = Object.values(apiDevices || {}).filter(
    isContactSensor,
  );
  const activeSensors = await Promise.all(
    contactDevices
      .filter((device) => getCapabilityValue(device, "alarm_contact") === true)
      .map((device) => toActiveContactSensor(device, zoneInfo)),
  );

  activeSensors.sort(compareContactSensors);

  const zones = activeSensors.reduce((result, sensor) => {
    const zoneKey = sensor.zoneId || "unknown";
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
    source: "wingman-db",
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
  return (
    Number(b.active) - Number(a.active) ||
    Number(!b.available) - Number(!a.available) ||
    a.zonePathText.localeCompare(b.zonePathText, "da") ||
    (b.activeDurationMs || 0) - (a.activeDurationMs || 0) ||
    a.name.localeCompare(b.name, "da")
  );
}

function shouldShowActiveDevice(device, capability) {
  return isActiveCapability(device, capability) || !isAvailable(device);
}

function groupActiveDevices(activeDevices) {
  return activeDevices.reduce((result, device) => {
    const zoneKey = device.zoneId || "unknown";
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
    source: "wingman-db",
    totals: {
      [totalName]: devices.length,
      active: devices.filter((device) => isActiveCapability(device, capability))
        .length,
      zones: zones.length,
      errors: devices.filter((device) => !isAvailable(device)).length,
    },
    zones,
  };
}

function getMotionDashboard() {
  return getActiveDeviceDashboard({
    capability: "alarm_motion",
    isDevice: isMotionSensor,
    totalName: "sensors",
  });
}

function getLightsDashboard() {
  return getActiveDeviceDashboard({
    capability: "onoff",
    isDevice: isLightDevice,
    totalName: "lights",
  });
}

async function setLightOnOff(deviceId, value) {
  if (typeof value !== "boolean") {
    throw new Error("Lys-status skal være true eller false.");
  }

  const { devices: apiDevices } = await getHomeyInventory();
  const device = apiDevices?.[deviceId];

  if (!device || !isLightDevice(device)) {
    throw new Error("Lampen blev ikke fundet.");
  }

  if (!isAvailable(device)) {
    throw new Error("Lampen melder fejl og kan ikke styres fra dashboardet.");
  }

  if (device.sourceSystem === "home_assistant") {
    if (!HOME_ASSISTANT_URL || !HOME_ASSISTANT_TOKEN)
      throw new Error("Home Assistant er ikke konfigureret til lysstyring.");
    const response = await fetch(
      `${HOME_ASSISTANT_URL}/api/services/light/${value ? "turn_on" : "turn_off"}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ entity_id: getHomeAssistantLightTarget(device) }),
      },
    );
    if (!response.ok)
      throw new Error(
        `Home Assistant returnerede ${response.status}: ${(await response.text()) || response.statusText}`,
      );
  } else {
    if (!HOMEY_URL || !HOMEY_TOKEN)
      throw new Error("HOMEY_URL and HOMEY_TOKEN must be configured");
    await putHomeyApi(
      `/manager/devices/device/${encodeURIComponent(deviceId)}/capability/onoff`,
      { value },
    );
  }
  return { ok: true, value };
}

function getHomeAssistantLightTarget(device) {
  const entityId = device.haEntityId || device.id;
  if (!/^light\.[a-z0-9_]+$/.test(entityId || ""))
    throw new Error("Lampen mangler en entydig Home Assistant-lysreference.");
  return entityId;
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
  return shifted.toLocaleDateString("en-CA", { timeZone: "Europe/Copenhagen" });
}

function getDanishDayStartUtc(dateKey) {
  const approximateUtc = new Date(`${dateKey}T12:00:00.000Z`);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Copenhagen",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(approximateUtc);
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(
    parts.find((part) => part.type === "minute")?.value || 0,
  );
  const offsetMinutes = hour * 60 + minute - 720;
  return new Date(
    Date.parse(`${dateKey}T00:00:00.000Z`) - offsetMinutes * 60000,
  );
}

function addUtcDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function normalizeEnergyPeriodOffset(value) {
  const offset = Number(value);
  if (!Number.isFinite(offset)) return 0;
  return Math.max(-120, Math.min(0, Math.trunc(offset)));
}

function getShiftedMonthDateKey(year, month, day, monthOffset) {
  const shifted = new Date(Date.UTC(year, month - 1 + monthOffset, day));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getEnergyPeriodLabel(period, offset) {
  if (offset === 0) {
    return (
      {
        day: "I dag",
        "3days": "Seneste 3 dage",
        week: "Seneste 7 dage",
        month: "Seneste 30 dage",
        billing: "Fakturaperiode",
      }[period] || "I dag"
    );
  }

  return (
    {
      day: "Dag",
      "3days": "3 dage",
      week: "Uge",
      month: "30 dage",
      billing: "Fakturaperiode",
    }[period] || "Dag"
  );
}

function getDanishPeriodRange(period, now, offsetValue = 0) {
  const offset = normalizeEnergyPeriodOffset(offsetValue);
  const nowDate = new Date(now);
  const todayKey = getDanishDateKey(nowDate);
  const todayStart = getDanishDayStartUtc(todayKey);

  if (ENERGY_PERIOD_DAY_SPANS[period]) {
    const spanDays = ENERGY_PERIOD_DAY_SPANS[period];
    const currentPeriodStart = addUtcDays(todayStart, -(spanDays - 1));
    const from = addUtcDays(currentPeriodStart, offset * spanDays);
    const to = offset === 0 ? nowDate : addUtcDays(from, spanDays);
    return {
      period,
      offset,
      from,
      to,
      label: getEnergyPeriodLabel(period, offset),
    };
  }

  const startDay = Math.max(1, Math.min(28, ENERGY_BILLING_PERIOD_START_DAY));
  const year = Number(todayKey.slice(0, 4));
  const month = Number(todayKey.slice(5, 7));
  const day = Number(todayKey.slice(8, 10));
  const startMonth = day >= startDay ? month : month - 1;
  const startYear = startMonth >= 1 ? year : year - 1;
  const normalizedMonth = startMonth >= 1 ? startMonth : 12;
  const billingKey = getShiftedMonthDateKey(
    startYear,
    normalizedMonth,
    startDay,
    offset,
  );
  const nextBillingKey = getShiftedMonthDateKey(
    startYear,
    normalizedMonth,
    startDay,
    offset + 1,
  );
  return {
    period: "billing",
    offset,
    from: getDanishDayStartUtc(billingKey),
    to: offset === 0 ? nowDate : getDanishDayStartUtc(nextBillingKey),
    label: getEnergyPeriodLabel("billing", offset),
  };
}

function sumEnergyBuckets(buckets) {
  return buckets.reduce(
    (result, bucket) => ({
      kwh: result.kwh + (Number(bucket.kwh) || 0),
      costDkk: result.costDkk + (Number(bucket.cost_dkk) || 0),
    }),
    { kwh: 0, costDkk: 0 },
  );
}

function findEnergyState(states, capability) {
  return states.find(
    (state) =>
      state.capability === capability &&
      ((ENERGY_MAIN_DEVICE_ID &&
        state.homey_device_id === ENERGY_MAIN_DEVICE_ID) ||
        (!ENERGY_MAIN_DEVICE_ID &&
          state.device_name === ENERGY_MAIN_DEVICE_NAME)),
  );
}

function getPriceForBucket(prices, bucket) {
  const start = Date.parse(bucket.bucket_start);
  return prices.find(
    (price) =>
      start >= Date.parse(price.starts_at) && start < Date.parse(price.ends_at),
  );
}

function getNeutralPrice(prices) {
  const values = prices
    .map((price) => Number(price.total_dkk_per_kwh))
    .filter(Number.isFinite);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getRedistributedCost(kwhValues, prices, cheapestFirst) {
  const sortedKwh = kwhValues.slice().sort((a, b) => b - a);
  const sortedPrices = prices
    .map((price) => Number(price.total_dkk_per_kwh))
    .filter(Number.isFinite)
    .sort((a, b) => (cheapestFirst ? a - b : b - a));
  return sortedKwh.reduce(
    (sum, kwh, index) =>
      sum +
      kwh * (sortedPrices[index] ?? sortedPrices[sortedPrices.length - 1] ?? 0),
    0,
  );
}

function getDanishHourKey(value) {
  return new Intl.DateTimeFormat("da-DK", {
    timeZone: "Europe/Copenhagen",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function getDailyMinimumPrices(prices) {
  return prices.reduce((result, price) => {
    const value = Number(price.total_dkk_per_kwh);
    if (!Number.isFinite(value)) return result;

    const dayKey = getDanishDateKey(new Date(price.starts_at));
    result[dayKey] = Math.min(
      result[dayKey] ?? Number.POSITIVE_INFINITY,
      value,
    );
    return result;
  }, {});
}

function getDanishDateKeyForBucket(bucket) {
  return getDanishDateKey(new Date(bucket.startsAt));
}

/**
 * Simuler batteri-lagring for en enkelt dag.
 *
 * Algoritme (per dag, time for time):
 * 1. Solcelleoverskud (negativt kwh) lader batteriet til cost=0
 * 2. Restkapacitet lades fra nettet i de billigste timer (max 11 kW/t, max 16 kWh)
 * 3. Batteriet aflades i de dyreste timer for at undgå net-indkøb
 *
 * Parametre: capacity=16 kWh, maxRate=11 kW/t, efficiency=0.9 (round-trip)
 */
/**
 * Simuler batteri på tværs af alle dage i data-sættet.
 *
 * Ladestanden (SoC) starter på 50% af kapacitet og spores kontinuerligt
 * på tværs af alle dage – den nulstilles aldrig til nul.
 *
 * Parametre: capacity=16 kWh, maxRate=11 kW/t, efficiency=0.9 (round-trip)
 */
let batteryRevision = 0;

function simulateBattery(buckets, prices, params) {
  batteryRevision += 1;
  const { capacity, maxRate, efficiency } = params;

  const days = new Map();
  for (const bucket of buckets) {
    if (!bucket.priceDkkPerKwh || !Number.isFinite(bucket.kwh)) continue;
    const dayKey = getDanishDateKeyForBucket(bucket);
    if (!days.has(dayKey)) days.set(dayKey, []);
    days.get(dayKey).push(bucket);
  }

  // Start SoC på 50% af kapacitet (8 kWh for 16 kWh batteri)
  let soc = capacity * 0.5;
  const initialSoc = soc;

  let totalActual = 0;
  let totalSimulated = 0;
  let totalSolar = 0;
  let totalGrid = 0;
  let totalDischarge = 0;
  const dayResults = [];

  for (const [dayKey, dayBuckets] of days) {
    const dayBucketsSorted = dayBuckets.slice().sort(
      (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt),
    );

    const hours = dayBucketsSorted
      .filter((b) => Number.isFinite(b.priceDkkPerKwh))
      .map((b) => ({
        kwh: Number(b.kwh) || 0,
        price: Number(b.priceDkkPerKwh),
        startsAt: b.startsAt,
      }));

    // Faktisk kost uden batteri: betal for alt positivt forbrug
    const actualCost = hours.reduce(
      (sum, h) => sum + Math.max(0, h.kwh) * h.price,
      0,
    );

    let solarChargeKwh = 0;
    let gridChargeKwh = 0;
    let dischargeKwh = 0;

    // Spor pr. time hvor meget der lades fra nettet og aflades til forbrug
    const chargeGridByHour = new Map();
    const dischargeByHour = new Map();

    const dayStartSoc = soc;
    // --- Step 1: Lad fra solcelleoverskud (gratis), kronologisk ---
    for (const h of hours) {
      if (h.kwh < 0 && soc < capacity) {
        const exportKwh = Math.abs(h.kwh);
        const chargeSpace = capacity - soc;
        const charge = Math.min(exportKwh, chargeSpace, maxRate);
        soc += charge * efficiency;
        solarChargeKwh += charge;
      }
    }

    // --- Step 2: Lad fra nettet i de billigste timer ---
    const cheapHours = [...hours]
      .filter((h) => h.kwh > 0)
      .sort((a, b) => a.price - b.price);
    for (const h of cheapHours) {
      if (soc >= capacity) break;
      const chargeSpace = capacity - soc;
      const charge = Math.min(chargeSpace, maxRate);
      soc += charge * efficiency;
      gridChargeKwh += charge;
      chargeGridByHour.set(h.startsAt, (chargeGridByHour.get(h.startsAt) || 0) + charge);
    }

    // --- Step 3: Aflad i de dyreste timer ---
    const expensiveHours = [...hours]
      .filter((h) => h.kwh > 0)
      .sort((a, b) => b.price - a.price);
    for (const h of expensiveHours) {
      if (soc <= 0) break;
      // Max afladning begrænses af hvad batteriet kan levere (soc * effektivitet)
      const maxDischarge = soc * efficiency;
      const discharge = Math.min(h.kwh, maxDischarge, maxRate);
      soc -= discharge / efficiency;
      dischargeKwh += discharge;
      dischargeByHour.set(h.startsAt, (dischargeByHour.get(h.startsAt) || 0) + discharge);
    }

    // --- Step 4: Beregn simuleret kost time for time ---
    // Net import = forbrug - batteridækning + netladning
    // Solcelleladning koster 0 (allerede taget højde for via negativt kwh i forbrug)
    let simulatedCost = 0;
    for (const h of hours) {
      const consumption = Math.max(0, h.kwh);
      if (consumption <= 0 && (chargeGridByHour.get(h.startsAt) || 0) <= 0) continue;
      const coveredByBattery = dischargeByHour.get(h.startsAt) || 0;
      const chargedFromGrid = chargeGridByHour.get(h.startsAt) || 0;
      const netImport = Math.max(0, consumption - coveredByBattery + chargedFromGrid);
      simulatedCost += netImport * h.price;
    }

    totalActual += actualCost;
    totalSimulated += simulatedCost;
    totalSolar += solarChargeKwh;
    totalGrid += gridChargeKwh;
    totalDischarge += dischargeKwh;

    dayResults.push({
      dayKey,
      actualCost,
      simulatedCost: Math.max(0, simulatedCost),
      savings: actualCost - Math.max(0, simulatedCost),
      solarChargeKwh,
      gridChargeKwh,
      dischargeKwh,
      startSoc: dayStartSoc,
      endSoc: soc,
    });
  }

  return {
    actualCost: totalActual,
    simulatedCost: totalSimulated,
    savingsDkk: totalActual - totalSimulated,
    savingsPercent:
      totalActual > 0 ? ((totalActual - totalSimulated) / totalActual) * 100 : 0,
    solarChargeKwh: totalSolar,
    gridChargeKwh: totalGrid,
    dischargeKwh: totalDischarge,
    days: days.size,
    revision: batteryRevision,
    initialSoc,
    finalSoc: soc,
    dayResults,
  };
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
    if (
      Math.abs(bucket.priceDkkPerKwh - dailyMinimumPrices[dayKey]) < 0.000001
    ) {
      group.cheapestDays.add(dayKey);
    }
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      hour: group.hour,
      label: group.label,
      kwh: group.kwh,
      costDkk: group.costDkk,
      averageDkkPerKwh:
        group.priceCount > 0 ? group.priceSum / group.priceCount : null,
      days: group.days.size,
      cheapestDays: group.cheapestDays.size,
    }))
    .sort((a, b) => Number(a.hour) - Number(b.hour));
}

async function getEnergyDetailDashboard(periodValue = "day", offsetValue = 0) {
  const period = ENERGY_PERIODS.includes(periodValue) ? periodValue : "day";
  const offset = normalizeEnergyPeriodOffset(offsetValue);
  const now = Date.now();
  const range = getDanishPeriodRange(period, now, offset);
  const from = encodeURIComponent(range.from.toISOString());
  const to = encodeURIComponent(range.to.toISOString());
  const [usage, pricesResult] = await Promise.all([
    getWingmanApi(`/api/energy/usage?interval=hour&from=${from}&to=${to}${ENERGY_USAGE_FILTER}`),
    getWingmanApi(`/api/energy/prices?from=${from}&to=${to}`),
  ]);
  const prices = Array.isArray(pricesResult.prices) ? pricesResult.prices : [];
  const buckets = (Array.isArray(usage.buckets) ? usage.buckets : []).map(
    (bucket) => {
      const price = getPriceForBucket(prices, bucket);
      const priceDkkPerKwh = Number(
        price?.total_dkk_per_kwh ?? bucket.effective_dkk_per_kwh,
      );
      const kwh = Number(bucket.kwh) || 0;
      let costDkk = null;
      if (
        bucket.cost_dkk !== null &&
        Number.isFinite(Number(bucket.cost_dkk))
      ) {
        costDkk = Number(bucket.cost_dkk);
      } else if (Number.isFinite(priceDkkPerKwh)) {
        costDkk = kwh * priceDkkPerKwh;
      }

      const bucketStart = new Date(bucket.bucket_start);
      const timeLabelOptions = {
        timeZone: "Europe/Copenhagen",
        weekday: period === "day" ? undefined : "short",
        day: period === "day" ? undefined : "2-digit",
        hour: "2-digit",
      };
      const chartLabelOptions = {
        timeZone: "Europe/Copenhagen",
        day: period === "day" ? undefined : "2-digit",
        month: period === "day" ? undefined : "2-digit",
        hour: "2-digit",
      };
      return {
        startsAt: bucket.bucket_start,
        endsAt: bucket.bucket_end,
        timeLabel: bucketStart.toLocaleString("da-DK", timeLabelOptions),
        chartLabel: bucketStart.toLocaleString("da-DK", chartLabelOptions),
        kwh,
        costDkk,
        priceDkkPerKwh: Number.isFinite(priceDkkPerKwh) ? priceDkkPerKwh : null,
        sourceBuckets: Number(bucket.source_buckets) || 0,
      };
    },
  );
  const pricedBuckets = buckets.filter(
    (bucket) => bucket.priceDkkPerKwh !== null && bucket.costDkk !== null,
  );
  const totals = sumEnergyBuckets(
    pricedBuckets.map((bucket) => ({
      kwh: bucket.kwh,
      cost_dkk: bucket.costDkk,
    })),
  );
  const neutralPrice = getNeutralPrice(prices);
  const actualPrice = totals.kwh > 0 ? totals.costDkk / totals.kwh : null;
  const neutralCost = neutralPrice === null ? null : totals.kwh * neutralPrice;
  const timingEffectDkk =
    neutralCost === null ? null : neutralCost - totals.costDkk;
  const kwhValues = pricedBuckets
    .map((bucket) => bucket.kwh)
    .filter((kwh) => kwh > 0);
  const bestCost = getRedistributedCost(kwhValues, prices, true);
  const worstCost = getRedistributedCost(kwhValues, prices, false);
  const maxKwh = Math.max(0, ...buckets.map((bucket) => bucket.kwh));
  const maxPrice = Math.max(
    0,
    ...prices.map((price) => Number(price.total_dkk_per_kwh) || 0),
  );
  const hourPatterns = getHourPatterns(pricedBuckets, prices);

  return {
    generatedAt: new Date(now).toISOString(),
    source: "wingman-db",
    period: range.period,
    offset: range.offset,
    label: range.label,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    navigation: {
      canNavigatePrevious: true,
      canNavigateNext: range.offset < 0,
      previousOffset: range.offset - 1,
      nextOffset: Math.min(0, range.offset + 1),
    },
    note: "Nettoforbrug fra hovedmåleren. Solceller og elbil kan påvirke billedet.",
    totals: {
      kwh: totals.kwh,
      costDkk: totals.costDkk,
      actualDkkPerKwh: actualPrice,
      neutralDkkPerKwh: neutralPrice,
      neutralCostDkk: neutralCost,
      timingEffectDkk,
      bestPossibleCostDkk: bestCost,
      worstPossibleCostDkk: worstCost,
      bestPossibleEffectDkk:
        neutralCost === null ? null : neutralCost - bestCost,
      worstPossibleEffectDkk:
        neutralCost === null ? null : neutralCost - worstCost,
    },
    scale: { maxKwh, maxPrice },
    buckets,
    hourPatterns,
    hourPatternScale: {
      maxKwh: Math.max(0, ...hourPatterns.map((pattern) => pattern.kwh)),
      maxPrice: Math.max(
        0,
        ...hourPatterns.map((pattern) => pattern.averageDkkPerKwh || 0),
      ),
      maxDays: Math.max(0, ...hourPatterns.map((pattern) => pattern.days)),
    },
    cheapestHourPatterns: hourPatterns
      .slice()
      .sort((a, b) => a.averageDkkPerKwh - b.averageDkkPerKwh)
      .slice(0, 5),
    expensiveHourPatterns: hourPatterns
      .filter((pattern) => pattern.kwh > 0)
      .slice()
      .sort((a, b) => b.costDkk - a.costDkk)
      .slice(0, 5),
    battery: simulateBattery(pricedBuckets, prices, {
      capacity: Number(process.env.BATTERY_CAPACITY_KWH || 16),
      maxRate: Number(process.env.BATTERY_MAX_RATE_KW || 11),
      efficiency: Number(process.env.BATTERY_EFFICIENCY || 0.9),
    }),
  };
}

async function getElectricityOverviewCard(now) {
  const nowDate = new Date(now);
  const yesterdayKey = getDanishDateKey(nowDate, -1);
  const todayKey = getDanishDateKey(nowDate);
  const usageFrom = encodeURIComponent(
    getDanishDayStartUtc(yesterdayKey).toISOString(),
  );
  const usageTo = encodeURIComponent(nowDate.toISOString());
  const [usage, prices, currentState] = await Promise.all([
    getWingmanApi(
      `/api/energy/usage?interval=hour&from=${usageFrom}&to=${usageTo}${ENERGY_USAGE_FILTER}`,
    ),
    getWingmanApi("/api/energy/prices"),
    getWingmanApi("/api/current-state"),
  ]);
  const buckets = Array.isArray(usage.buckets) ? usage.buckets : [];
  const yesterdayBuckets = buckets.filter(
    (bucket) =>
      getDanishDateKey(new Date(bucket.bucket_start)) === yesterdayKey,
  );
  const todayBuckets = buckets.filter(
    (bucket) => getDanishDateKey(new Date(bucket.bucket_start)) === todayKey,
  );
  const completedBuckets = todayBuckets.filter(
    (bucket) => Date.parse(bucket.bucket_end) <= now,
  );
  const latestBucket = completedBuckets[completedBuckets.length - 1] || null;
  const yesterday = sumEnergyBuckets(yesterdayBuckets);
  const today = sumEnergyBuckets(todayBuckets);
  const latestHour = latestBucket
    ? sumEnergyBuckets([latestBucket])
    : { kwh: 0, costDkk: 0 };
  const price = (prices.prices || []).find((item) => {
    const startsAt = Date.parse(item.starts_at);
    const endsAt = Date.parse(item.ends_at);
    return (
      Number.isFinite(startsAt) &&
      Number.isFinite(endsAt) &&
      now >= startsAt &&
      now < endsAt
    );
  });
  const states = currentState.states || [];
  const powerState = findEnergyState(states, "measure_power.imported") || findEnergyState(states, "measure_power");
  const exportState = findEnergyState(states, "measure_power.exported");
  const powerAvailable = powerState?.available !== false && powerState?.value_number != null;
  const powerKw = powerAvailable
    ? (Number(powerState.value_number) - Number(exportState?.value_number || 0)) / 1000 : NaN;
  const currentPrice = Number(price?.total_dkk_per_kwh);
  const currentCostPerHour =
    Number.isFinite(powerKw) && Number.isFinite(currentPrice)
      ? Math.max(0, powerKw) * currentPrice
      : null;

  return {
    id: "electricity",
    title: "Elpriser",
    subtitle: "Forbrug og pris",
    target: "energy",
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
    logicVariables,
  } = await getHomeyInventory();
  const devices = Object.values(apiDevices || {});
  const soilDevices = devices.filter((device) =>
    hasCapability(device, "measure_soil_moisture"),
  );
  const valves = devices.filter(isWateringValve);
  const valveStates = valves.map((device) => ({
    id: device.id,
    name: device.name,
    on: isActiveCapability(device, "onoff"),
  }));
  const contacts = devices.filter(isContactSensor);
  const motionSensors = devices.filter(isMotionSensor);
  const lights = devices.filter(isLightDevice);
  const activeContacts = contacts.filter((device) =>
    isActiveCapability(device, "alarm_contact"),
  );
  const activeMotion = motionSensors.filter((device) =>
    isActiveCapability(device, "alarm_motion"),
  );
  const activeLights = lights.filter((device) =>
    isActiveCapability(device, "onoff"),
  );
  enrichWateringValveFlows(
    valveStates,
    flows,
    advancedFlows,
    timers,
    logicVariables,
  );
  const activeValves = valveStates.filter((valve) => valve.wateringActive);
  const soilAlarms = soilDevices.filter(
    (device) => getCapabilityValue(device, "alarm_water") === true,
  );
  const soilOffline = soilDevices.filter(
    (device) =>
      isAvailable(device) &&
      !isSoilDeviceLive(
        device,
        now,
        device.capabilitiesObj?.measure_soil_moisture?.lastUpdated,
      ),
  );
  const soilErrors = soilDevices.filter((device) => !isAvailable(device));
  const soilMaintenance = soilDevices.filter((device) => {
    const live = isSoilDeviceLive(
      device,
      now,
      device.capabilitiesObj?.measure_soil_moisture?.lastUpdated,
    );
    return (
      !soilAlarms.includes(device) &&
      !soilOffline.includes(device) &&
      !soilErrors.includes(device) &&
      getSoilMaintenanceStatus(device, now, live).needed
    );
  });
  const soilIssues = soilAlarms
    .concat(soilMaintenance.filter((device) => !soilAlarms.includes(device)))
    .concat(soilOffline.filter((device) => !soilAlarms.includes(device)))
    .concat(
      soilErrors.filter(
        (device) =>
          !soilAlarms.includes(device) &&
          !soilMaintenance.includes(device) &&
          !soilOffline.includes(device),
      ),
    );

  const currentStatusItems = (items, detail, emptyText) => {
    if (items.length === 0) {
      return [emptyText];
    }

    return items
      .slice(0, 2)
      .map((device) => `${device.name.trim()} · ${detail}`);
  };

  let vehicleCard;
  try {
    const peugeot = await getCachedValue(
      "vehicle",
      CACHE_TTL_MS.vehicle,
      getPeugeotDashboard,
    );
    const { vehicle } = peugeot;
    let vehicleStatus = "MyPeugeot mangler opsætning";
    if (peugeot.configured) {
      vehicleStatus =
        {
          fresh: "Friske data",
          aging: "Ikke helt friske data",
          old: "Gamle data",
        }[vehicle?.freshness] || "Ukendt dataalder";
      vehicleStatus += ` · ${formatPeugeotAge(vehicle?.ageMs)}`;
    }
    vehicleCard = getDashboardCard(
      "vehicle",
      "Peugeot",
      "Batteri og rækkevidde",
      "vehicle",
      [
        { label: "SOC", value: vehicle?.batteryLevel ?? 0 },
        { label: "km", value: vehicle?.rangeKm ?? 0 },
      ],
      [vehicleStatus],
    );
    vehicleCard.vehicle = {
      name: vehicle?.name || "Peugeot",
      freshness: vehicle?.freshness || "old",
      ageMs: vehicle?.ageMs,
    };
  } catch {
    vehicleCard = getDashboardCard(
      "vehicle",
      "Peugeot",
      "Batteri og rækkevidde",
      "vehicle",
      [],
      ["MyPeugeot kan ikke nås"],
    );
  }

  const cards = [
    await getElectricityOverviewCard(now),
    getDashboardCard(
      "soil",
      "Jordstatus",
      "Jordfugt og vandalarmer",
      "soil",
      [
        { label: "Sensorer", value: soilDevices.length },
        { label: "Alarm", value: soilAlarms.length },
        { label: "Tjek", value: soilMaintenance.length },
        { label: "Fejl", value: soilErrors.length },
        { label: "Offline", value: soilOffline.length },
      ],
      currentStatusItems(
        soilIssues,
        "Kræver kig",
        "Ingen jordalarmer, sensor-tjek, offline eller fejl",
      ),
    ),
    getDashboardCard(
      "watering",
      "Vanding",
      "Ventiler og vanding",
      "watering",
      [
        { label: "Ventiler", value: valves.length },
        { label: "Aktive", value: activeValves.length },
        {
          label: "Fejl",
          value: valves.filter((device) => !isAvailable(device)).length,
        },
      ],
      currentStatusItems(activeValves, "Ventil åben", "Ingen ventiler åbne"),
    ),
    getDashboardCard(
      "contact",
      "Åbne døre og vinduer",
      "Døre, vinduer, køleskab og frysere",
      "contact",
      [
        { label: "Sensorer", value: contacts.length },
        { label: "Åbne", value: activeContacts.length },
        {
          label: "Fejl",
          value: contacts.filter((device) => !isAvailable(device)).length,
        },
      ],
      currentStatusItems(activeContacts, "Åben", "Ingen åbne døre/vinduer"),
    ),
    getDashboardCard(
      "motion",
      "Bevægelse",
      "Aktive motionssensorer",
      "motion",
      [
        { label: "Sensorer", value: motionSensors.length },
        { label: "Aktive", value: activeMotion.length },
        {
          label: "Fejl",
          value: motionSensors.filter((device) => !isAvailable(device)).length,
        },
      ],
      currentStatusItems(activeMotion, "Aktiv", "Ingen aktiv bevægelse"),
    ),
    getDashboardCard(
      "lights",
      "Tændte lys",
      "Lys der står tændt",
      "lights",
      [
        { label: "Lys", value: lights.length },
        { label: "Tændt", value: activeLights.length },
        {
          label: "Fejl",
          value: lights.filter((device) => !isAvailable(device)).length,
        },
      ],
      currentStatusItems(activeLights, "Tændt", "Ingen lys tændt"),
    ),
    vehicleCard,
  ];

  return {
    generatedAt: new Date().toISOString(),
    source: "wingman-db",
    totals: {
      cards: cards.length,
      attention:
        soilIssues.length +
        activeContacts.length +
        activeMotion.length +
        activeLights.length +
        activeValves.length,
      active:
        activeContacts.length +
        activeMotion.length +
        activeLights.length +
        activeValves.length,
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
        addToDay(days, toDateKey(entry.t), "waterLiters", liters);
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
        addToDay(days, toDateKey(start), "minutes", (end - start) / 60000);
      }
      openSession = null;
    }
  }

  if (openSession) {
    const start = Math.max(openSession.t, cutoff);
    if (now > start) {
      sessions.push(toSession(openSession, start, now, true));
      addToDay(days, toDateKey(start), "minutes", (now - start) / 60000);
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
  if (type === "advanced") {
    return getObjectValues(flow.cards);
  }

  return [flow.trigger]
    .concat(
      Array.isArray(flow.conditions)
        ? flow.conditions
        : getObjectValues(flow.conditions),
    )
    .concat(
      Array.isArray(flow.actions)
        ? flow.actions
        : getObjectValues(flow.actions),
    )
    .filter(Boolean);
}

function getFlowDeviceIds(cards) {
  return cards.reduce((result, card) => {
    const match = String(card.ownerUri || card.id || "").match(
      /homey:device:([^:]+)/,
    );
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
    .filter(
      (card) =>
        card.ownerUri === `homey:app:${CHRONOGRAPH_APP_ID}` ||
        String(card.id || "").includes(CHRONOGRAPH_APP_ID),
    )
    .filter((card) => String(card.id || "").includes("timer_"))
    .map(getTimerName)
    .filter(Boolean)
    .filter((name, index, names) => names.indexOf(name) === index);
}

function getPrimaryTimerName(timerNames) {
  return (
    timerNames.find((name) => !/lukning/i.test(name)) || timerNames[0] || null
  );
}

function getFlowTimer(timerNames, timersByName) {
  const runningTimerName = timerNames.find(
    (name) => timersByName[name]?.running === true,
  );
  const timerName = runningTimerName || getPrimaryTimerName(timerNames);

  return {
    timerName,
    timer: summarizeTimer(timersByName[timerName]),
  };
}

function getLogicVariableId(value) {
  const match = String(value || "").match(
    /^\[\[homey:manager:logic\|([^\]]+)\]\]$/,
  );
  return match?.[1] || null;
}

function getLogicVariableType(variable) {
  if (variable?.type) return String(variable.type).toLowerCase();
  return typeof variable?.value;
}

function findFlowLogicVariable(
  cards,
  logicVariablesById,
  suffix,
  type,
  prefix = null,
) {
  const serializedCards = JSON.stringify(cards);
  const normalizedSuffix = suffix.toLocaleLowerCase("da-DK");
  const normalizedPrefix = prefix?.toLocaleLowerCase("da-DK") || null;

  return (
    getObjectValues(logicVariablesById).find((variable) => {
      const name = String(variable?.name || "")
        .trim()
        .toLocaleLowerCase("da-DK");
      return (
        variable?.id &&
        serializedCards.includes(variable.id) &&
        getLogicVariableType(variable) === type &&
        name.endsWith(` ${normalizedSuffix}`) &&
        (!normalizedPrefix ||
          name === `${normalizedPrefix} ${normalizedSuffix}`)
      );
    }) || null
  );
}

function summarizeTimer(timer) {
  if (!timer) return null;

  const targetDuration = Number(timer.targetDuration);
  const duration = Number(timer.duration);
  const remainingMs =
    Number.isFinite(targetDuration) && Number.isFinite(duration)
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

function getWateringFlowInfos(
  flows,
  type,
  valveIds,
  timersByName,
  logicVariablesById,
) {
  return getObjectValues(flows).reduce((result, flow) => {
    if (flow.enabled === false) return result;

    const cards = getFlowCards(flow, type);
    const flowDeviceIds = getFlowDeviceIds(cards).filter((id) =>
      valveIds.includes(id),
    );
    if (flowDeviceIds.length === 0) return result;

    const timerNames = getFlowTimerNames(cards);
    const { timerName, timer } = getFlowTimer(timerNames, timersByName);
    const durationVariableId = cards
      .filter(
        (card) =>
          card.id === "homey:app:nl.fellownet.chronograph:timer_start_v2",
      )
      .map((card) => getLogicVariableId(card.args?.time))
      .find(Boolean);
    const durationVariable = durationVariableId
      ? logicVariablesById[durationVariableId] || { id: durationVariableId }
      : null;
    const variablePrefix =
      String(durationVariable?.name || "").replace(
        /\s+cyklus varighed$/i,
        "",
      ) || null;
    const statusVariableId = cards.find(
      (card) => card.id === "homey:manager:logic:variable_set_string",
    )?.args?.variable?.id;
    const statusVariable =
      findFlowLogicVariable(
        cards,
        logicVariablesById,
        "status",
        "string",
        variablePrefix,
      ) ||
      logicVariablesById[statusVariableId] ||
      null;
    const maxCycleVariable = findFlowLogicVariable(
      cards,
      logicVariablesById,
      "max cyklusser",
      "number",
      variablePrefix,
    );
    const errorVariable = findFlowLogicVariable(
      cards,
      logicVariablesById,
      "vandingsfejl",
      "boolean",
      variablePrefix,
    );

    flowDeviceIds.forEach((deviceId) => {
      result[deviceId] = {
        type,
        id: flow.id || null,
        name: flow.name || "Ukendt flow",
        timerName,
        timerNames,
        timer,
        status: statusVariable?.value || null,
        durationVariable,
        maxCycleVariable,
        errorVariable,
      };
    });

    return result;
  }, {});
}

function enrichWateringValveFlows(
  valves,
  flows,
  advancedFlows,
  timers,
  logicVariables = {},
) {
  const valveIds = valves.map((valve) => valve.id);
  const timersByName = timers.reduce((result, timer) => {
    if (timer?.name) {
      result[timer.name] = timer;
    }
    return result;
  }, {});
  const normalFlowInfos = getWateringFlowInfos(
    flows,
    "normal",
    valveIds,
    timersByName,
    logicVariables,
  );
  const advancedFlowInfos = getWateringFlowInfos(
    advancedFlows,
    "advanced",
    valveIds,
    timersByName,
    logicVariables,
  );

  valves.forEach((valve) => {
    valve.wateringFlow =
      advancedFlowInfos[valve.id] || normalFlowInfos[valve.id] || null;
    const status = valve.wateringFlow?.status;
    valve.wateringActive =
      valve.on ||
      (status
        ? ["watering", "closing", "waiting_result", "closing_error"].includes(
            status,
          )
        : valve.wateringFlow?.timer?.running === true);
    valve.wateringNeedsAttention =
      valve.wateringFlow?.errorVariable?.value === true ||
      ["closing_error", "cycle_limit"].includes(status);
  });
}

async function enrichWateringValveAutomation(valves) {
  try {
    const { flows, advancedFlows, timers, logicVariables } =
      await getHomeyInventory();
    enrichWateringValveFlows(
      valves,
      flows,
      advancedFlows,
      timers,
      logicVariables,
    );
  } catch (error) {
    valves.forEach((valve) => {
      valve.wateringFlow = null;
      valve.wateringActive = valve.on;
      valve.automationError = error.message || String(error);
    });
  }
}

async function setWateringCycleDuration(valveId, value) {
  if (!Number.isInteger(value) || value < 1 || value > 30) {
    throw new Error(
      "Intervallet skal være et helt antal minutter fra 1 til 30.",
    );
  }

  const { devices, flows, advancedFlows, timers, logicVariables } =
    await getHomeyInventory();
  const device = devices[valveId];

  if (!device || !isWateringValve(device)) {
    throw new Error("Vandingsventilen blev ikke fundet.");
  }

  const valve = {
    id: device.id,
    on: getCapabilityValue(device, "onoff") === true,
  };
  enrichWateringValveFlows(
    [valve],
    flows,
    advancedFlows,
    timers,
    logicVariables,
  );
  const variableId = valve.wateringFlow?.durationVariable?.id;

  if (!variableId) {
    throw new Error("Vandingsflowet har ikke en justerbar intervalvariabel.");
  }

  await putHomeyApi(
    `/manager/logic/variable/${encodeURIComponent(variableId)}`,
    { value },
  );
  wateringVariableOverrides.set(variableId, value);
  clearCache(["overview", "watering"]);
  return { ok: true, value };
}

function normalizeWateringMaxCycles(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("Maks. cyklusser skal være et helt tal fra 1 til 100.");
  }
  return value;
}

async function getManagedWateringValve(valveId) {
  const { devices, flows, advancedFlows, timers, logicVariables } =
    await getHomeyInventory();
  const device = devices[valveId];

  if (!device || !isWateringValve(device)) {
    throw new Error("Vandingsventilen blev ikke fundet.");
  }

  const valve = {
    id: device.id,
    on: getCapabilityValue(device, "onoff") === true,
  };
  enrichWateringValveFlows(
    [valve],
    flows,
    advancedFlows,
    timers,
    logicVariables,
  );
  return valve;
}

async function setWateringMaxCycles(valveId, input) {
  const value = normalizeWateringMaxCycles(input);
  const valve = await getManagedWateringValve(valveId);
  const variableId = valve.wateringFlow?.maxCycleVariable?.id;

  if (!variableId) {
    throw new Error("Vandingsflowet har ikke en variabel for maks. cyklusser.");
  }

  await putHomeyApi(
    `/manager/logic/variable/${encodeURIComponent(variableId)}`,
    { value },
  );
  wateringVariableOverrides.set(variableId, value);
  clearCache(["overview", "watering"]);
  return { ok: true, value };
}

async function restartWateringAfterError(valveId) {
  const { devices } = await getHomeyInventory();
  if (isHomeAssistantSoilDevice(devices[valveId])) {
    const result = await restartHaWateringAfterError(valveId);
    clearCache(["overview", "watering"]);
    return { ok: true, value: result.error === false };
  }
  const valve = await getManagedWateringValve(valveId);
  const variableId = valve.wateringFlow?.errorVariable?.id;

  if (!variableId) {
    throw new Error("Vandingsflowet har ikke en nulstilbar fejlvariabel.");
  }

  await putHomeyApi(
    `/manager/logic/variable/${encodeURIComponent(variableId)}`,
    { value: false },
  );
  wateringVariableOverrides.set(variableId, false);
  clearCache(["overview", "watering"]);
  return { ok: true, value: false };
}

async function setWateringForbiddenForValve(valveId, value) {
  const { devices } = await getHomeyInventory();
  if (!isHomeAssistantSoilDevice(devices[valveId])) {
    throw new Error("Lokalt vandingsforbud understøttes kun for HA-ventiler.");
  }
  const result = await setHaWateringForbidden(valveId, value === true);
  clearCache(["overview", "watering"]);
  return { ok: true, value: result.forbidden === true };
}

function summarizeWateringValve(
  device,
  zoneInfo,
  meterEntries,
  onoffEntries,
  now,
  cutoff,
) {
  const zone = zoneInfo[device.zone] || {
    name: device.zone || "Ukendt zone",
    path: [device.zone || "Ukendt zone"],
    pathText: device.zone || "Ukendt zone",
  };
  const days = getHistoryDays(now);
  const water = getWaterSummary(meterEntries, days);
  const sessions = getWateringSessions(onoffEntries, cutoff, now, days);
  const totalMinutes = sessions.reduce(
    (sum, session) => sum + session.durationMinutes,
    0,
  );

  return {
    id: device.id,
    name: device.name.trim(),
    zoneId: device.zone || null,
    zoneName: zone.name,
    zonePath: zone.path,
    zonePathText: zone.pathText,
    available: device.available !== false,
    on: getCapabilityValue(device, "onoff") === true,
    currentFlowLitersPerMinute: getCapabilityValue(device, "measure_water"),
    currentMeterM3: getCapabilityValue(device, "meter_water"),
    battery: getCapabilityValue(device, "measure_battery"),
    linkQuality: getCapabilityValue(device, "linkquality"),
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
  return (
    Number(b.wateringActive) - Number(a.wateringActive) ||
    a.zonePathText.localeCompare(b.zonePathText, "da") ||
    a.name.localeCompare(b.name, "da")
  );
}

async function toWateringValve(device, zoneInfo, now, cutoff) {
  try {
    const [meterEntries, onoffEntries] = isHomeAssistantSoilDevice(device)
      ? await Promise.all([
          getWingmanEventEntries(device.id, "meter_water", cutoff),
          getWingmanEventEntries(device.id, "onoff", cutoff),
        ])
      : await Promise.all([
          getInsightEntries(device.id, "meter_water"),
          getInsightEntries(device.id, "onoff"),
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
      name: device.zone || "Ukendt zone",
      path: [device.zone || "Ukendt zone"],
      pathText: device.zone || "Ukendt zone",
    };
    return {
      id: device.id,
      name: device.name.trim(),
      zoneId: device.zone || null,
      zoneName: zone.name,
      zonePath: zone.path,
      zonePathText: zone.pathText,
      available: device.available !== false,
      on: getCapabilityValue(device, "onoff") === true,
      currentFlowLitersPerMinute: getCapabilityValue(device, "measure_water"),
      currentMeterM3: getCapabilityValue(device, "meter_water"),
      battery: getCapabilityValue(device, "measure_battery"),
      linkQuality: getCapabilityValue(device, "linkquality"),
      linkQualityIngested: hasIngestedCapability(device, "linkquality"),
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
  const cutoff = now - WATERING_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const { devices: apiDevices, zones: apiZones } = await getHomeyInventory();
  const zoneInfo = getZoneInfo(apiZones);
  const valves = await Promise.all(
    Object.values(apiDevices || {})
      .filter(isWateringValve)
      .map((device) => toWateringValve(device, zoneInfo, now, cutoff)),
  );

  const haValves = valves.filter((valve) =>
    String(apiDevices[valve.id]?.driverId || "").startsWith("zigbee2mqtt:"),
  );
  await enrichWateringValveAutomation(
    valves.filter((valve) => !haValves.includes(valve)),
  );
  await Promise.all(
    haValves.map(async (valve) => {
      try {
        valve.haWatering = await getHaWateringStatus(valve.id);
        valve.wateringActive = ["watering", "waiting_result"].includes(
          valve.haWatering.status,
        );
        valve.wateringNeedsAttention =
          valve.haWatering.error || valve.haWatering.status === "cycle_limit";
      } catch (error) {
        valve.automationError = error.message || String(error);
        valve.wateringActive = valve.on;
      }
    }),
  );
  valves.sort(compareWateringValves);

  return {
    generatedAt: new Date(now).toISOString(),
    historyDays: WATERING_HISTORY_DAYS,
    source: "wingman-db",
    totals: {
      valves: valves.length,
      active: valves.filter((valve) => valve.wateringActive).length,
      sessions: valves.reduce((sum, valve) => sum + valve.totals.sessions, 0),
      minutes:
        Math.round(
          valves.reduce((sum, valve) => sum + valve.totals.minutes, 0) * 10,
        ) / 10,
      waterLiters:
        Math.round(
          valves.reduce((sum, valve) => sum + valve.totals.waterLiters, 0) * 10,
        ) / 10,
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
  if (!zone) return zoneId ? [zoneId] : ["Ukendt zone"];
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
      pathText: pathParts.join(" / "),
    };
    return result;
  }, {});
}

function normalizeIeee(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function shortAddress(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? `0x${number.toString(16).padStart(4, "0")}`
    : String(value || "");
}

function shortIeee(value) {
  const ieee = normalizeIeee(value);
  return ieee ? ieee.split(":").slice(-4).join(":") : null;
}

function getZigbeeNodeAddress(node) {
  return node?.networkAddress ?? node?.nwkAddr ?? node?.address ?? null;
}

function getZigbeeNodeType(node, device) {
  const type = String(
    node?.deviceType || node?.type || device?.settings?.zb_device_type || "",
  ).toLowerCase();
  if (type.includes("router")) return "router";
  if (type.includes("end")) return "enddevice";
  if (type.includes("coordinator")) return "coordinator";
  return device?.settings?.zb_receive_when_idle === "✓"
    ? "router"
    : "enddevice";
}

function getRouteNodes(rawNodes) {
  return Array.isArray(rawNodes) ? rawNodes : Object.values(rawNodes || {});
}

function getChildCounts(links) {
  return links.reduce((result, link) => {
    result[link.target] = (result[link.target] || 0) + 1;
    return result;
  }, {});
}

function addUnknownZigbeeNode(nodesById, id) {
  if (nodesById.has(id) || id === "homey") return;
  nodesById.set(id, {
    id,
    address: Number(id),
    addressLabel: shortAddress(id),
    label: `Ukendt ${shortAddress(id)}`,
    category: "unknown",
    type: "unknown",
    zone: "Ukendt zone",
    zoneShort: "Ukendt zone",
    available: null,
    manufacturer: null,
    product: null,
    shortIeee: null,
    lastSeen: null,
    stats: null,
  });
}

function createZigbeeRouteMapModel({ zigbeeState, devices, zones }) {
  const controllerState = zigbeeState.controllerState || {};
  const zoneInfo = getZoneInfo(zones);
  const devicesByIeee = Object.values(devices || {}).reduce(
    (result, device) => {
      const ieee = normalizeIeee(device?.settings?.zb_ieee_address);
      if (ieee) result[ieee] = device;
      return result;
    },
    {},
  );
  const nodesById = new Map();

  nodesById.set("homey", {
    id: "homey",
    address: 0,
    addressLabel: "Homey",
    label: "Homey Zigbee",
    category: "coordinator",
    type: "coordinator",
    zone: "Controller",
    zoneShort: "Controller",
    available: true,
    manufacturer: "Athom",
    product: `Channel ${controllerState.channel || "-"}`,
    shortIeee: shortIeee(controllerState.IEEEAddress),
    lastSeen: null,
    stats: null,
  });

  getRouteNodes(zigbeeState.nodes).forEach((node, index) => {
    const address = getZigbeeNodeAddress(node);
    if (!Number.isFinite(Number(address)) || Number(address) === 0) return;

    const ieee = normalizeIeee(node.ieeeAddress || node.ieeeAddr);
    const device = devicesByIeee[ieee];
    const zone = zoneInfo[device?.zone] || null;
    const type = getZigbeeNodeType(node, device);
    nodesById.set(String(address), {
      id: String(address),
      nodeId: index,
      address: Number(address),
      addressLabel: shortAddress(address),
      label: String(
        device?.name || node.name || node.modelId || shortAddress(address),
      ).trim(),
      category: type === "coordinator" ? "coordinator" : type,
      type,
      zone: zone?.pathText || "Ukendt zone",
      zoneShort: zone?.path?.slice(-2).join(" / ") || "Ukendt zone",
      available: device ? device.available !== false : null,
      manufacturer:
        device?.settings?.zb_manufacturer_name || node.manufacturerName || null,
      product: device?.settings?.zb_product_id || node.modelId || null,
      shortIeee: shortIeee(ieee),
      lastSeen: Number.isFinite(Number(node.lastSeen))
        ? new Date(Number(node.lastSeen)).toISOString()
        : null,
      stats: node.stats
        ? {
            tx: Number(node.stats.tx) || 0,
            txSuccess: Number(node.stats.txSuccess) || 0,
            txError: Number(node.stats.txError) || 0,
            rx: Number(node.stats.rx) || 0,
          }
        : null,
    });
  });

  const routes = controllerState.routes || {};
  const links = Object.entries(routes).map(([source, route]) => {
    addUnknownZigbeeNode(nodesById, String(source));
    const routeParts = (Array.isArray(route) ? route : []).map(String);
    routeParts.forEach((routeNode) =>
      addUnknownZigbeeNode(nodesById, routeNode),
    );
    const target = routeParts[routeParts.length - 1] || "homey";
    addUnknownZigbeeNode(nodesById, target);
    return {
      id: `parent:${source}`,
      source: String(source),
      target,
      route: routeParts,
      depth: routeParts.length + 1,
    };
  });

  const childCounts = getChildCounts(links);
  const nodes = [...nodesById.values()].map((node) => {
    const link = links.find((item) => item.source === node.id);
    return {
      ...node,
      parentId: link?.target || null,
      routeDepth: link?.depth || null,
      childCount: childCounts[node.id] || 0,
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  links.forEach((link) => {
    link.sourceCategory = nodeById.get(link.source)?.category || "unknown";
    link.routeLabels = link.route.map(
      (address) => nodeById.get(address)?.label || shortAddress(address),
    );
  });

  return {
    generatedAt: new Date().toISOString(),
    source: "Homey local /api/manager/zigbee/state controllerState.routes",
    controller: {
      channel: controllerState.channel || null,
      panId: controllerState.panId || null,
      extendedPanId: controllerState.extendedPanId || null,
      softwareVersion: controllerState.softwareVersion || null,
      shortIeee: shortIeee(controllerState.IEEEAddress),
    },
    totals: {
      nodes: nodes.length,
      devices: nodes.filter(
        (node) => !["coordinator", "unknown"].includes(node.category),
      ).length,
      routers: nodes.filter((node) => node.category === "router").length,
      enddevices: nodes.filter((node) => node.category === "enddevice").length,
      unknown: nodes.filter((node) => node.category === "unknown").length,
      links: links.length,
      routeEntries: Object.keys(routes).length,
      unavailable: nodes.filter((node) => node.available === false).length,
    },
    nodes,
    links,
  };
}

async function getZigbeeRouteMap() {
  const [zigbeeState, inventory] = await Promise.all([
    getHomeyApi("/manager/zigbee/state"),
    getHomeyInventory(),
  ]);
  const current = createZigbeeRouteMapModel({
    zigbeeState,
    devices: inventory.devices,
    zones: inventory.zones,
  });

  try {
    await writeWingmanApi("POST", "/api/zigbee/routes/snapshot", current);
  } catch (error) {
    console.warn(
      `Could not persist Zigbee route snapshot: ${error.message || error}`,
    );
  }

  let history = null;
  try {
    history = await getWingmanApi(
      `/api/zigbee/routes/history?days=${ZIGBEE_ROUTE_HISTORY_DAYS}`,
    );
  } catch (error) {
    console.warn(
      `Could not fetch Zigbee route history: ${error.message || error}`,
    );
  }

  return {
    ...current,
    history: history || {
      generatedAt: new Date().toISOString(),
      days: ZIGBEE_ROUTE_HISTORY_DAYS,
      nodes: [],
      edges: [],
      layout: [],
    },
  };
}

async function sampleZigbeeRouteMap() {
  if (zigbeeSamplerRunning) return;
  zigbeeSamplerRunning = true;
  try {
    const value = await getZigbeeRouteMap();
    responseCache.set("zigbee", {
      value,
      expiresAt: Date.now() + CACHE_TTL_MS.zigbee,
    });
    console.log(
      `Sampled Zigbee route map with ${value.totals.routeEntries} route entries`,
    );
  } catch (error) {
    console.warn(
      `Could not sample Zigbee route map: ${error.message || error}`,
    );
  } finally {
    zigbeeSamplerRunning = false;
  }
}

function startZigbeeSampler() {
  if (!ZIGBEE_SAMPLING_INTERVAL_MS) return;
  setTimeout(sampleZigbeeRouteMap, 15000);
  setInterval(sampleZigbeeRouteMap, ZIGBEE_SAMPLING_INTERVAL_MS);
  console.log(
    `Zigbee route sampler interval ${Math.round(ZIGBEE_SAMPLING_INTERVAL_MS / 1000)}s`,
  );
}

async function getZigbeeLayout(response) {
  sendJson(response, 200, await getWingmanApi("/api/zigbee/layout"));
}

async function putZigbeeLayout(request, response) {
  const body = await readRequestBody(request);
  const payload = body ? JSON.parse(body) : {};
  sendJson(
    response,
    202,
    await writeWingmanApi("PUT", "/api/zigbee/layout", payload),
  );
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname =
    url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendError(response, 403, "Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      "content-type":
        CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendError(response, 404, "Not found");
      return;
    }
    throw error;
  }
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url.startsWith("/login")) {
      sendLogin(response);
      return;
    }

    if (request.method === "POST" && request.url.startsWith("/login")) {
      await handleLogin(request, response);
      return;
    }

    if (request.method === "GET" && request.url.startsWith("/manifest.json")) {
      await serveStatic(request, response);
      return;
    }

    if (!isAuthenticated(request)) {
      sendLogin(response);
      return;
    }

    if (request.method === "GET" && request.url.startsWith("/zigbee")) {
      request.url = "/zigbee.html";
      await serveStatic(request, response);
      return;
    }

    if (request.method === "GET" && request.url.startsWith("/api/dashboard")) {
      sendJson(
        response,
        200,
        await getCachedValue("dashboard", CACHE_TTL_MS.dashboard, getDashboard),
      );
      return;
    }

    if (request.method === "GET" && request.url.startsWith("/api/zigbee-map")) {
      sendJson(
        response,
        200,
        await getCachedValue("zigbee", CACHE_TTL_MS.zigbee, getZigbeeRouteMap),
      );
      return;
    }

    if (
      request.method === "GET" &&
      request.url.startsWith("/api/zigbee-layout")
    ) {
      await getZigbeeLayout(response);
      return;
    }

    if (
      request.method === "PUT" &&
      request.url.startsWith("/api/zigbee-layout")
    ) {
      await putZigbeeLayout(request, response);
      return;
    }

    if (
      request.method === "GET" &&
      request.url.startsWith("/api/overview-dashboard")
    ) {
      sendJson(
        response,
        200,
        await getCachedValue(
          "overview",
          CACHE_TTL_MS.overview,
          getOverviewDashboard,
        ),
      );
      return;
    }

    if (
      request.method === "GET" &&
      request.url.startsWith("/api/watering-dashboard")
    ) {
      sendJson(
        response,
        200,
        await getCachedValue(
          "watering",
          CACHE_TTL_MS.watering,
          getWateringDashboard,
        ),
      );
      return;
    }

    if (
      request.method === "POST" &&
      request.url.startsWith("/api/watering-circuits/")
    ) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const action = url.pathname.match(
        /^\/api\/watering-circuits\/(plan|apply|migrate|remove)$/,
      )?.[1];
      if (!action) {
        sendError(response, 404, "Ukendt vandingskreds-handling.");
        return;
      }
      const result = await configureHaWateringCircuit(
        action,
        JSON.parse((await readRequestBody(request)) || "{}"),
      );
      clearCache(["overview", "watering"]);
      sendJson(response, 200, result);
      return;
    }

    if (
      request.method === "GET" &&
      request.url.startsWith("/api/contact-dashboard")
    ) {
      sendJson(
        response,
        200,
        await getCachedValue(
          "contact",
          CACHE_TTL_MS.contact,
          getContactDashboard,
        ),
      );
      return;
    }

    if (
      request.method === "GET" &&
      request.url.startsWith("/api/motion-dashboard")
    ) {
      sendJson(
        response,
        200,
        await getCachedValue("motion", CACHE_TTL_MS.motion, getMotionDashboard),
      );
      return;
    }

    if (
      request.method === "GET" &&
      request.url.startsWith("/api/lights-dashboard")
    ) {
      sendJson(
        response,
        200,
        await getCachedValue("lights", CACHE_TTL_MS.lights, getLightsDashboard),
      );
      return;
    }

    if (request.method === "GET" && request.url === "/api/replay") {
      sendJson(response, 200, await requestReplayApi("GET", "/api/replay"));
      return;
    }

    if (request.method === "PUT" && request.url === "/api/replay/profiles") {
      sendJson(
        response,
        200,
        await requestReplayApi(
          "PUT",
          "/api/replay/profiles",
          JSON.parse((await readRequestBody(request)) || "{}"),
        ),
      );
      return;
    }

    if (request.method === "POST" && request.url === "/api/replay/runs") {
      sendJson(
        response,
        202,
        await requestReplayApi(
          "POST",
          "/api/replay/runs",
          JSON.parse((await readRequestBody(request)) || "{}"),
        ),
      );
      return;
    }

    if (request.method === "POST" && request.url === "/api/replay/runs/stop") {
      sendJson(
        response,
        200,
        await requestReplayApi("POST", "/api/replay/runs/stop", {}),
      );
      return;
    }

    if (
      request.method === "GET" &&
      request.url.startsWith("/api/energy-dashboard")
    ) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const periodValue = url.searchParams.get("period") || "day";
      const period = ENERGY_PERIODS.includes(periodValue) ? periodValue : "day";
      const offset = normalizeEnergyPeriodOffset(
        url.searchParams.get("offset") || 0,
      );
      sendJson(
        response,
        200,
        await getCachedValue(
          `energy:${period}:${offset}`,
          CACHE_TTL_MS.energy,
          () => getEnergyDetailDashboard(period, offset),
        ),
      );
      return;
    }

    if (
      request.method === "GET" &&
      request.url.startsWith("/api/vehicle-dashboard")
    ) {
      sendJson(
        response,
        200,
        await getCachedValue(
          "vehicle",
          CACHE_TTL_MS.vehicle,
          getPeugeotDashboard,
        ),
      );
      return;
    }

    if (request.method === "POST" && request.url.startsWith("/api/lights/")) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const match = url.pathname.match(/^\/api\/lights\/([^/]+)\/onoff$/);
      if (!match) {
        sendError(response, 404, "Not found");
        return;
      }

      const body = JSON.parse((await readRequestBody(request)) || "{}");
      const result = await setLightOnOff(
        decodeURIComponent(match[1]),
        body.value,
      );
      clearCache(["overview", "lights"]);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && request.url.startsWith("/api/watering/")) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const match = url.pathname.match(
        /^\/api\/watering\/([^/]+)\/(cycle-duration|max-cycles|restart|forbidden)$/,
      );
      if (!match) {
        sendError(response, 404, "Not found");
        return;
      }

      const body = JSON.parse((await readRequestBody(request)) || "{}");
      const valveId = decodeURIComponent(match[1]);
      if (match[2] === "cycle-duration") {
        sendJson(
          response,
          200,
          await setWateringCycleDuration(valveId, body.value),
        );
      } else if (match[2] === "max-cycles") {
        sendJson(
          response,
          200,
          await setWateringMaxCycles(valveId, body.value),
        );
      } else if (match[2] === "restart") {
        sendJson(response, 200, await restartWateringAfterError(valveId));
      } else {
        sendJson(
          response,
          200,
          await setWateringForbiddenForValve(valveId, body.value),
        );
      }
      return;
    }

    if (
      request.method === "POST" &&
      request.url.startsWith("/api/soil-sensors/")
    ) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname === "/api/soil-sensors/counters/reset") {
        sendJson(response, 200, await resetAllSoilIssueCounters());
        return;
      }

      const counterMatch = url.pathname.match(
        /^\/api\/soil-sensors\/([^/]+)\/counters\/([^/]+)\/reset$/,
      );
      if (counterMatch) {
        sendJson(
          response,
          200,
          await resetSoilIssueCounter(
            decodeURIComponent(counterMatch[1]),
            decodeURIComponent(counterMatch[2]),
          ),
        );
        return;
      }

      const match = url.pathname.match(
        /^\/api\/soil-sensors\/([^/]+)\/threshold$/,
      );
      if (!match) {
        sendError(response, 404, "Not found");
        return;
      }

      const body = JSON.parse((await readRequestBody(request)) || "{}");
      sendJson(
        response,
        200,
        await setSoilAlarmThreshold(decodeURIComponent(match[1]), body.value),
      );
      return;
    }

    if (request.method === "GET" && request.url.startsWith("/api/state")) {
      sendJson(
        response,
        200,
        await getCachedValue("state", CACHE_TTL_MS.state, readState),
      );
      return;
    }

    if (
      request.method === "POST" &&
      request.url.startsWith("/api/state/toggle-watering-forbidden")
    ) {
      sendJson(response, 200, await toggleWateringForbidden());
      return;
    }

    if (request.method === "GET") {
      await serveStatic(request, response);
      return;
    }

    sendError(response, 405, "Method not allowed");
  } catch (error) {
    console.error(error.message || error);
    sendError(
      response,
      error.statusCode || 500,
      error.message || "Internal server error",
    );
  }
});

if (require.main === module) {
  if (!DASHBOARD_PASSWORD) {
    throw new Error("DASHBOARD_PASSWORD must be configured");
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Soil dashboard listening on http://0.0.0.0:${PORT}`);
    startZigbeeSampler();
  });
}

module.exports = {
  getActiveSince,
  countWaterAlarmActivations,
  canSetSoilAlarmThreshold,
  compareZoneDevices,
  enrichWateringValveFlows,
  getDanishPeriodRange,
  getHomeAssistantLightTarget,
  getLatestCapabilityUpdatedAt,
  hasIngestedCapability,
  getSoilMaintenanceStatus,
  isActiveCapability,
  isLightDevice,
  isMotionSensor,
  isWateringValve,
  markZoneWaterAlarmTopscorers,
  normalizeSoilHistory,
  normalizeSoilWarningThresholdInput,
  normalizeEnergyPeriodOffset,
  normalizeWateringMaxCycles,
  normalizePeugeotVehicle,
  isContactSensor,
  shouldShowActiveDevice,
  updateSoilIssueCounterState,
};
