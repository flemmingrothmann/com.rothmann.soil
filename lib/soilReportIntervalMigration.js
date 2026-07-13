'use strict';

const MAX_SOIL_REPORT_INTERVAL_SECONDS = 240;
const REPORT_INTERVAL_SETTING_GROUPS = [
  { maxId: 'temperature_report_max_interval', minId: 'temperature_report_min_interval' },
  { maxId: 'humidity_report_max_interval', minId: 'humidity_report_min_interval' },
  { maxId: 'temperature_sampling' },
  { maxId: 'soil_sampling' },
];

function hasOwnSetting(settings, settingId) {
  return Object.prototype.hasOwnProperty.call(settings || {}, settingId);
}

function getReducedSoilReportIntervalSettings(settings, maxSeconds = MAX_SOIL_REPORT_INTERVAL_SECONDS) {
  return REPORT_INTERVAL_SETTING_GROUPS.reduce((result, group) => {
    if (hasOwnSetting(settings, group.maxId) && Number(settings[group.maxId]) > maxSeconds) {
      result[group.maxId] = maxSeconds;
    }

    if (group.minId && hasOwnSetting(settings, group.minId) && Number(settings[group.minId]) > maxSeconds) {
      result[group.minId] = maxSeconds;
    }

    return result;
  }, {});
}

async function migrateDeviceSoilReportIntervals(device, log = null) {
  if (!device || typeof device.getSettings !== 'function' || typeof device.setSettings !== 'function') {
    return { changed: false, settings: {} };
  }

  const nextSettings = getReducedSoilReportIntervalSettings(device.getSettings());
  if (Object.keys(nextSettings).length === 0) {
    return { changed: false, settings: {} };
  }

  await device.setSettings(nextSettings);

  if (typeof log === 'function') {
    const name = typeof device.getName === 'function' ? device.getName() : 'soil sensor';
    log(`Migrated ${name} report interval settings to max ${MAX_SOIL_REPORT_INTERVAL_SECONDS}s`, nextSettings);
  }

  return { changed: true, settings: nextSettings };
}

module.exports = {
  MAX_SOIL_REPORT_INTERVAL_SECONDS,
  getReducedSoilReportIntervalSettings,
  migrateDeviceSoilReportIntervals,
};
