'use strict';

/* eslint-disable no-console, no-use-before-define, node/no-unsupported-features/node-builtins */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const HOMEY_URL = (process.env.HOMEY_URL || '').replace(/\/$/, '');
const HOMEY_TOKEN = process.env.HOMEY_TOKEN || '';
const APP_ID = process.env.HOMEY_APP_ID || 'com.rothmann.soil';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'Bogfinkevej11';
const COOKIE_SECRET = process.env.DASHBOARD_COOKIE_SECRET || `${DASHBOARD_PASSWORD}:${APP_ID}`;
const COOKIE_NAME = 'soil_dashboard_session';
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const WATERING_FORBIDDEN_VARIABLE_ID = process.env.WATERING_FORBIDDEN_VARIABLE_ID || '5a2a34fd-8d2f-4c7d-b076-b1bb41e3a41f';
const WATERING_HISTORY_DAYS = 14;
const WATERING_INSIGHTS_RESOLUTION = 'last14Days';
const CHRONOGRAPH_APP_ID = 'nl.fellownet.chronograph';
const WATERING_VALVE_DRIVER_IDS = [
  'homey:app:se.styrahem.sonoff.zigbee:SWV',
];

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = process.env.DASHBOARD_STATE_FILE || '/data/state.json';

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
  if (!HOMEY_URL || !HOMEY_TOKEN) {
    throw new Error('HOMEY_URL and HOMEY_TOKEN must be configured');
  }

  const response = await fetch(`${HOMEY_URL}/api/app/${APP_ID}/dashboard`, {
    headers: {
      authorization: `Bearer ${HOMEY_TOKEN}`,
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Homey returned ${response.status}: ${body || response.statusText}`);
  }

  const dashboard = await response.json();
  return enrichDashboardZones(dashboard);
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

function getCapabilityValue(device, capability) {
  return device?.capabilitiesObj?.[capability]?.value ?? null;
}

function getInsightLogId(deviceId, capability) {
  return `homey:device:${deviceId}:${capability}`;
}

async function getInsightEntries(deviceId, capability, resolution = WATERING_INSIGHTS_RESOLUTION) {
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
    valve.wateringActive = valve.on || valve.wateringFlow?.timer?.running === true;
  });
}

async function enrichWateringValveAutomation(valves) {
  try {
    const [flows, advancedFlows, timersResult] = await Promise.all([
      getHomeyApi('/manager/flow/flow'),
      getHomeyApi('/manager/flow/advancedflow'),
      getHomeyApi(`/app/${CHRONOGRAPH_APP_ID}/timers`),
    ]);
    const timers = Array.isArray(timersResult) ? timersResult : [];
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
  if (!HOMEY_URL || !HOMEY_TOKEN) {
    throw new Error('HOMEY_URL and HOMEY_TOKEN must be configured');
  }

  const now = Date.now();
  const cutoff = now - (WATERING_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const [apiDevices, apiZones] = await Promise.all([
    getHomeyApi('/manager/devices/device'),
    getHomeyApi('/manager/zones/zone'),
  ]);
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
    source: 'homey-insights',
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

function getDeviceZoneMap(apiDevices) {
  return Object.values(apiDevices || {}).reduce((result, device) => {
    if (device?.name && device?.zone) {
      result[device.name] = device.zone;
    }
    return result;
  }, {});
}

function regroupDashboardByZone(dashboard) {
  const devices = dashboard.zones.reduce((result, zone) => result.concat(zone.devices), []);
  devices.sort((a, b) => a.zonePathText.localeCompare(b.zonePathText, 'da')
    || Number(b.needsAction) - Number(a.needsAction)
    || a.name.localeCompare(b.name, 'da'));

  dashboard.zones = devices.reduce((result, device) => {
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

  return dashboard;
}

async function enrichDashboardZones(dashboard) {
  const [apiDevices, apiZones] = await Promise.all([
    getHomeyApi('/manager/devices/device'),
    getHomeyApi('/manager/zones/zone'),
  ]);
  const deviceZoneMap = getDeviceZoneMap(apiDevices);
  const zoneInfo = getZoneInfo(apiZones);

  for (const zone of dashboard.zones) {
    for (const device of zone.devices) {
      const zoneId = deviceZoneMap[device.name] || device.zoneId;
      const nextZone = zoneInfo[zoneId];
      if (!nextZone) continue;

      device.zoneId = zoneId;
      device.zoneName = nextZone.name;
      device.zonePath = nextZone.path;
      device.zonePathText = nextZone.pathText;
    }
  }

  return regroupDashboardByZone(dashboard);
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

    if (!isAuthenticated(request)) {
      sendLogin(response);
      return;
    }

    if (request.method === 'GET' && request.url.startsWith('/api/dashboard')) {
      sendJson(response, 200, await getDashboard());
      return;
    }

    if (request.method === 'GET' && request.url.startsWith('/api/watering-dashboard')) {
      sendJson(response, 200, await getWateringDashboard());
      return;
    }

    if (request.method === 'GET' && request.url.startsWith('/api/state')) {
      sendJson(response, 200, await readState());
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
  isWateringValve,
};
