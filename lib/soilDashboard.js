'use strict';

/* eslint-disable no-use-before-define */

const HISTORY_DAYS = 7;
const HISTORY_INSIGHTS_RESOLUTION = 'last7Days';
const WATER_ALARM_TOPSCORER_DAYS = 30;
const HISTORY_MAX_POINTS = 1000;
const LAST_REPORTED_AT_STORE_KEY = 'soil_dashboard_last_reported_at';
const HISTORY_STORE_KEY = 'soil_dashboard_history';
const MIN_OFFLINE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_OFFLINE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OFFLINE_TIMEOUT_MS = 6 * 60 * 60 * 1000;

function getOfflineTimeoutMs(device) {
  const settings = typeof device.getSettings === 'function' ? device.getSettings() : {};
  const intervalSeconds = Number(settings.soil_sampling || settings.humidity_report_max_interval);

  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    return DEFAULT_OFFLINE_TIMEOUT_MS;
  }

  return Math.max(
    MIN_OFFLINE_TIMEOUT_MS,
    Math.min(MAX_OFFLINE_TIMEOUT_MS, intervalSeconds * 3 * 1000),
  );
}

function pruneHistory(history, now) {
  const cutoff = now - (HISTORY_DAYS * 24 * 60 * 60 * 1000);
  return history
    .filter((point) => point && Number.isFinite(point.t) && Number.isFinite(point.v) && point.t >= cutoff)
    .slice(-HISTORY_MAX_POINTS);
}

async function recordSoilMoistureReport(device, value, now = Date.now()) {
  if (!Number.isFinite(value)) {
    return;
  }

  const roundedValue = Math.round(value * 10) / 10;
  const history = pruneHistory(device.getStoreValue(HISTORY_STORE_KEY) || [], now);
  history.push({ t: now, v: roundedValue });

  await Promise.all([
    device.setStoreValue(LAST_REPORTED_AT_STORE_KEY, now),
    device.setStoreValue(HISTORY_STORE_KEY, pruneHistory(history, now)),
    typeof device.setLastSeenAt === 'function' ? device.setLastSeenAt().catch(device.error) : Promise.resolve(),
  ]);
}

function getDriverTitle(driver, driverId) {
  const name = driver?.manifest?.name;
  if (typeof name === 'string') {
    return name;
  }

  return name?.da || name?.en || driverId;
}

function getDeviceZoneId(device) {
  if (typeof device.getZone === 'function') {
    return device.getZone();
  }

  return device.zone || device.zoneId || null;
}

function getDeviceMapKey(driverId, data) {
  return `${driverId}:${JSON.stringify(data)}`;
}

function getApiDriverId(driverId) {
  return `homey:app:com.rothmann.soil:${driverId}`;
}

function getInsightLogId(deviceId, capability) {
  return `homey:device:${deviceId}:${capability}`;
}

function getNameMapKey(name) {
  return `name:${name}`;
}

function getDriverNameMapKey(driverId, name) {
  return `driver-name:${driverId}:${name}`;
}

async function getApiDeviceMap(homey) {
  try {
    const apiDevices = await getHomeyApi(homey, '/manager/devices/device');
    const mappedDevices = new Map();

    for (const [id, device] of Object.entries(apiDevices || {})) {
      if (!device?.driverId || !device?.data) {
        continue;
      }

      device.id = device.id || id;

      mappedDevices.set(getDeviceMapKey(device.driverId, device.data), device);

      if (typeof device.driverId === 'string') {
        const shortDriverId = device.driverId.split(':').pop();
        mappedDevices.set(getDeviceMapKey(shortDriverId, device.data), device);
        mappedDevices.set(getDriverNameMapKey(shortDriverId, device.name), device);
      }

      mappedDevices.set(getNameMapKey(device.name), device);
    }

    return mappedDevices;
  } catch (error) {
    homey.app.error('Could not resolve Homey devices for soil dashboard:', error.message || error);
    return new Map();
  }
}

function getZoneParentId(zone) {
  return zone?.parent || zone?.parentId || null;
}

function getZonePath(zoneId, zones, seen = []) {
  const zone = zones[zoneId];
  if (!zone) {
    return zoneId ? [zoneId] : ['Ukendt zone'];
  }

  if (seen.includes(zoneId)) {
    return [zone.name || zoneId];
  }

  const parentId = getZoneParentId(zone);
  const ownName = zone.name || zoneId;
  if (!parentId) {
    return [ownName];
  }

  return getZonePath(parentId, zones, seen.concat(zoneId)).concat(ownName);
}

async function getZoneInfo(homey) {
  try {
    const zones = await getHomeyApi(homey, '/manager/zones/zone');
    return Object.entries(zones || {}).reduce((result, [id, zone]) => {
      const path = getZonePath(id, zones || {});
      result[id] = {
        name: zone.name || id,
        path,
        pathText: path.join(' / '),
      };
      return result;
    }, {});
  } catch (error) {
    homey.app.error('Could not resolve Homey zone names for soil dashboard:', error.message || error);
    return {};
  }
}

async function getHomeyApi(homey, pathName) {
  const apiResult = await homey.api.get(pathName).catch(() => null);
  if (apiResult && Object.keys(apiResult).length > 0) {
    return apiResult;
  }

  const [localUrl, token] = await Promise.all([
    homey.api.getLocalUrl(),
    homey.api.getOwnerApiToken(),
  ]);
  const response = await fetch(`${localUrl.replace(/\/$/, '')}/api${pathName}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Homey Web API returned ${response.status}: ${body || response.statusText}`);
  }

  return response.json();
}

async function getInsightEntries(homey, deviceId, capability, resolution = null) {
  const ownerUri = `homey:device:${deviceId}`;
  const logId = getInsightLogId(deviceId, capability);
  const query = resolution ? `?resolution=${encodeURIComponent(resolution)}` : '';
  const result = await getHomeyApi(homey, `/manager/insights/log/${ownerUri}/${logId}/entry${query}`);
  return Array.isArray(result?.values) ? result.values : [];
}

function normalizeSoilMoistureInsightHistory(entries, now) {
  return pruneHistory(entries.map((entry) => ({
    t: Date.parse(entry?.t),
    v: Number(entry?.v),
  })), now);
}

async function getSoilMoistureInsightHistory(homey, device, now) {
  if (!device.apiDeviceId) return device.history;

  try {
    const entries = await getInsightEntries(homey, device.apiDeviceId, 'measure_soil_moisture', HISTORY_INSIGHTS_RESOLUTION);
    const history = normalizeSoilMoistureInsightHistory(entries, now);
    return history.length >= 2 ? history : device.history;
  } catch (error) {
    homey.app.error(`Could not load soil moisture history for ${device.name}:`, error.message || error);
    return device.history;
  }
}

function countWaterAlarmActivations(entries, cutoff) {
  return entries.reduce((count, entry) => {
    const timestamp = Date.parse(entry?.t);
    return count + (entry?.v === true && Number.isFinite(timestamp) && timestamp >= cutoff ? 1 : 0);
  }, 0);
}

async function getWaterAlarmActivationCount(homey, device, cutoff) {
  if (!device.apiDeviceId) return 0;

  try {
    const entries = await getInsightEntries(homey, device.apiDeviceId, 'alarm_water');
    return countWaterAlarmActivations(entries, cutoff);
  } catch (error) {
    homey.app.error(`Could not load water alarm history for ${device.name}:`, error.message || error);
    return 0;
  }
}

function getAlarmThreshold(device) {
  if (device.hasCapability('soil_warning_threshold')) {
    const capabilityValue = device.getCapabilityValue('soil_warning_threshold');
    if (typeof capabilityValue === 'number') {
      return capabilityValue;
    }
  }

  const settingValue = Number(device.getSetting('soil_warning'));
  return Number.isFinite(settingValue) ? settingValue : null;
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

function toDashboardDevice(device, driver, driverId, zoneInfo, apiDeviceMap, now) {
  const data = device.getData();
  const apiDevice = apiDeviceMap.get(getDeviceMapKey(driverId, data))
    || apiDeviceMap.get(getDeviceMapKey(getApiDriverId(driverId), data))
    || apiDeviceMap.get(getDriverNameMapKey(driverId, device.getName()))
    || apiDeviceMap.get(getNameMapKey(device.getName()));
  const lastReportedAt = Number(device.getStoreValue(LAST_REPORTED_AT_STORE_KEY));
  const offlineTimeoutMs = getOfflineTimeoutMs(device);
  const hasLastReport = Number.isFinite(lastReportedAt);
  const isLive = hasLastReport && now - lastReportedAt <= offlineTimeoutMs;
  const waterAlarm = device.hasCapability('alarm_water') ? device.getCapabilityValue('alarm_water') === true : false;
  const zoneId = apiDevice?.zone || getDeviceZoneId(device);
  const zone = zoneInfo[zoneId] || {
    name: zoneId || 'Ukendt zone',
    path: [zoneId || 'Ukendt zone'],
    pathText: zoneId || 'Ukendt zone',
  };
  const history = pruneHistory(device.getStoreValue(HISTORY_STORE_KEY) || [], now);

  return {
    id: getDeviceMapKey(driverId, data),
    apiDeviceId: apiDevice?.id || null,
    name: device.getName(),
    driverId,
    driverName: getDriverTitle(driver, driverId),
    zoneId,
    zoneName: zone.name,
    zonePath: zone.path,
    zonePathText: zone.pathText,
    available: device.getAvailable(),
    live: isLive,
    needsAction: waterAlarm || !isLive,
    lastReportedAt: hasLastReport ? new Date(lastReportedAt).toISOString() : null,
    offlineAfterMinutes: Math.round(offlineTimeoutMs / 60000),
    values: {
      soilMoisture: device.getCapabilityValue('measure_soil_moisture'),
      alarmThreshold: getAlarmThreshold(device),
      waterAlarm,
      battery: device.hasCapability('measure_battery') ? device.getCapabilityValue('measure_battery') : null,
      temperature: device.hasCapability('measure_temperature') ? device.getCapabilityValue('measure_temperature') : null,
      airHumidity: device.hasCapability('measure_humidity') ? device.getCapabilityValue('measure_humidity') : null,
      luminance: device.hasCapability('measure_luminance') ? device.getCapabilityValue('measure_luminance') : null,
      fertility: device.hasCapability('measure_soil_fertility') ? device.getCapabilityValue('measure_soil_fertility') : null,
    },
    waterAlarmStats: {
      periodDays: WATER_ALARM_TOPSCORER_DAYS,
      monthlyActivations: 0,
      zoneTopScorer: false,
    },
    history,
  };
}

async function getDashboard(homey) {
  const now = Date.now();
  const [zoneInfo, apiDeviceMap] = await Promise.all([
    getZoneInfo(homey),
    getApiDeviceMap(homey),
  ]);
  const drivers = homey.drivers.getDrivers();
  const devices = [];
  const waterAlarmCutoff = now - (WATER_ALARM_TOPSCORER_DAYS * 24 * 60 * 60 * 1000);

  for (const [driverId, driver] of Object.entries(drivers)) {
    for (const device of driver.getDevices()) {
      if (device.hasCapability('measure_soil_moisture')) {
        devices.push(toDashboardDevice(device, driver, driverId, zoneInfo, apiDeviceMap, now));
      }
    }
  }

  devices.sort(compareDashboardDevices);

  await Promise.all(devices.map(async (device) => {
    const [monthlyActivations, history] = await Promise.all([
      getWaterAlarmActivationCount(homey, device, waterAlarmCutoff),
      getSoilMoistureInsightHistory(homey, device, now),
    ]);

    device.waterAlarmStats.monthlyActivations = monthlyActivations;
    device.history = history;
  }));

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
    totals: {
      devices: devices.length,
      alarms: devices.filter((device) => device.needsAction).length,
      waterAlarms: devices.filter((device) => device.values.waterAlarm).length,
      offline: devices.filter((device) => !device.live).length,
    },
    zones,
  };
}

module.exports = {
  HISTORY_STORE_KEY,
  LAST_REPORTED_AT_STORE_KEY,
  countWaterAlarmActivations,
  getDashboard,
  markZoneWaterAlarmTopscorers,
  normalizeSoilMoistureInsightHistory,
  recordSoilMoistureReport,
};
