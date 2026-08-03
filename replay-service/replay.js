'use strict';

const crypto = require('crypto');

const LIGHT_CAPABILITIES = ['light_mode', 'light_temperature', 'light_hue', 'light_saturation', 'dim', 'onoff'];
const CAPABILITY_ORDER = new Map(LIGHT_CAPABILITIES.map((capability, index) => [capability, index]));

function createId() {
  return crypto.randomUUID();
}

function isLight(device) {
  return device?.class === 'light';
}

function hasCapability(device, capability) {
  return Array.isArray(device?.capabilities) && device.capabilities.includes(capability);
}

function getReplayCapabilities(device) {
  const capabilities = isLight(device) ? LIGHT_CAPABILITIES : ['onoff'];
  return capabilities.filter((capability) => hasCapability(device, capability));
}

function toReplayDevice(device, zones = {}) {
  return {
    id: device.id,
    name: String(device.name || 'Unavngivet').trim(),
    zoneName: String(zones[device.zone]?.name || 'Ukendt zone').trim(),
    class: device.class || 'other',
    isLight: isLight(device),
    available: device.available !== false,
    capabilities: getReplayCapabilities(device),
    sourceSystem: device.sourceSystem || 'homey',
  };
}

function getReplayDevices(devices = {}, zones = {}) {
  return Object.values(devices)
    .filter((device) => hasCapability(device, 'onoff'))
    .map((device) => toReplayDevice(device, zones))
    .sort((a, b) => Number(b.isLight) - Number(a.isLight)
      || a.zoneName.localeCompare(b.zoneName, 'da')
      || a.name.localeCompare(b.name, 'da'));
}

function createDefaultProfile(devices, name = 'Alle lys') {
  return {
    id: createId(),
    name,
    isDefault: true,
    deviceIds: devices.filter((device) => device.isLight).map((device) => device.id),
  };
}

function normalizeProfile(profile, validDeviceIds) {
  const name = String(profile?.name || '').trim();
  if (!name) throw new Error('Profilen skal have et navn.');

  return {
    id: String(profile.id || createId()),
    name: name.slice(0, 80),
    isDefault: profile.isDefault === true,
    deviceIds: [...new Set(Array.isArray(profile.deviceIds) ? profile.deviceIds : [])]
      .filter((id) => validDeviceIds.has(id)),
  };
}

function normalizeProfiles(profiles, devices) {
  const validDeviceIds = new Set(devices.map((device) => device.id));
  const normalized = (Array.isArray(profiles) ? profiles : [])
    .map((profile) => normalizeProfile(profile, validDeviceIds));

  if (normalized.length === 0) return [createDefaultProfile(devices)];

  const defaultIndex = normalized.findIndex((profile) => profile.isDefault);
  normalized.forEach((profile, index) => {
    profile.isDefault = index === (defaultIndex < 0 ? 0 : defaultIndex);
  });
  return normalized;
}

function normalizeRunInput(input, profiles, now = Date.now()) {
  const profile = profiles.find((item) => item.id === input?.profileId)
    || profiles.find((item) => item.isDefault);
  if (!profile) throw new Error('Replay-profilen blev ikke fundet.');
  if (profile.deviceIds.length === 0) throw new Error('Replay-profilen har ingen valgte enheder.');

  const sourceStartMs = input?.sourceStart ? Date.parse(input.sourceStart) : now - 7 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(sourceStartMs) || sourceStartMs >= now) {
    throw new Error('Kildetidspunktet skal ligge før nu.');
  }

  const mode = input?.mode === 'fixed-loop' ? 'fixed-loop' : 'rolling';
  const speed = mode === 'rolling' ? 1 : Number(input?.speed ?? 1);
  if (!Number.isFinite(speed) || speed < 0.1 || speed > 100) {
    throw new Error('Hastigheden skal være mellem 0,1x og 100x.');
  }

  const durationMinutes = input?.durationMinutes === null || input?.durationMinutes === '' || input?.durationMinutes === undefined
    ? null
    : Number(input.durationMinutes);
  if (durationMinutes !== null && (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 10080)) {
    throw new Error('Varigheden skal være mellem 1 minut og 7 dage.');
  }

  const loopDays = mode === 'fixed-loop' ? Number(input?.loopDays ?? 1) : null;
  const loopHours = mode === 'fixed-loop' ? Number(input?.loopHours ?? 0) : null;
  const loopMinutes = mode === 'fixed-loop' ? Number(input?.loopMinutes ?? 0) : null;
  const validLoopPart = (value) => Number.isInteger(value) && value >= 0;
  if (mode === 'fixed-loop' && (!validLoopPart(loopDays) || !validLoopPart(loopHours) || !validLoopPart(loopMinutes)
    || loopHours > 23 || loopMinutes > 59)) {
    throw new Error('Loop-længden skal angives som hele dage, 0-23 timer og 0-59 minutter.');
  }
  const loopDurationMs = loopDays === null ? null : ((loopDays * 24 + loopHours) * 60 + loopMinutes) * 60 * 1000;
  if (mode === 'fixed-loop' && (loopDurationMs < 60 * 1000 || loopDurationMs > 30 * 24 * 60 * 60 * 1000)) {
    throw new Error('Loop-længden skal være mellem 1 minut og 30 døgn.');
  }
  if (loopDurationMs !== null && sourceStartMs + loopDurationMs > now) {
    throw new Error('Hele loop-perioden skal ligge i fortiden.');
  }

  return {
    id: createId(),
    profileId: profile.id,
    profileName: profile.name,
    mode,
    sourceStart: new Date(sourceStartMs).toISOString(),
    targetStart: new Date(now).toISOString(),
    sourceCutoff: mode === 'fixed-loop' ? new Date(sourceStartMs + loopDurationMs).toISOString() : null,
    loopDays,
    loopHours,
    loopMinutes,
    loopDurationMs,
    speed,
    durationMinutes,
    status: 'running',
    stoppedAt: null,
    stopReason: null,
    actionsApplied: 0,
    actionsSkipped: 0,
    cursors: {},
    lastActionAt: null,
    lastError: null,
  };
}

function mapSourceTime(sourceTime, run) {
  const sourceMs = Date.parse(sourceTime);
  const sourceStartMs = Date.parse(run.sourceStart);
  const targetStartMs = Date.parse(run.targetStart);
  return targetStartMs + (sourceMs - sourceStartMs) / run.speed;
}

function getReplayTime(run, now = Date.now()) {
  const sourceStartMs = Date.parse(run.sourceStart);
  const targetStartMs = Date.parse(run.targetStart);
  const elapsedSourceMs = Math.max(0, now - targetStartMs) * run.speed;
  const loopDurationMs = run.mode === 'fixed-loop' ? run.loopDurationMs : null;
  return new Date(sourceStartMs + (loopDurationMs ? elapsedSourceMs % loopDurationMs : elapsedSourceMs)).toISOString();
}

function partitionReplayActions(actions, now = Date.now()) {
  const due = [];
  const queued = [];
  for (const action of actions) {
    (Date.parse(action.targetTime) <= now ? due : queued).push(action);
  }
  return { due, queued };
}

async function executeReplayActions(actions, apply, options = {}) {
  const delayMs = Number(options.delayMs) || 0;
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const shouldContinue = options.shouldContinue || (() => true);
  const results = [];
  for (const [index, action] of actions.entries()) {
    if (!shouldContinue()) break;
    if (index > 0 && delayMs > 0) await sleep(delayMs);
    if (!shouldContinue()) break;
    try {
      await apply(action);
      results.push({ action, applied: true, error: null });
    } catch (error) {
      results.push({ action, applied: false, error });
    }
  }
  return results;
}

function createReplayActions(entriesByDeviceCapability, selectedDevices, run, now = Date.now()) {
  const sourceStartMs = Date.parse(run.sourceStart);
  const mappedSourceNowMs = sourceStartMs + (now - Date.parse(run.targetStart)) * run.speed;
  const sourceCutoffMs = Date.parse(run.sourceCutoff || '');
  const sourceNowMs = Number.isFinite(sourceCutoffMs) ? Math.min(mappedSourceNowMs, sourceCutoffMs) : mappedSourceNowMs;
  const actions = [];

  for (const device of selectedDevices) {
    const initialValues = new Map();
    for (const capability of device.capabilities) {
      const entries = entriesByDeviceCapability[`${device.id}:${capability}`] || [];
      for (const entry of entries) {
        const sourceTimeMs = Date.parse(entry.t);
        if (Number.isFinite(sourceTimeMs) && sourceTimeMs <= sourceStartMs) {
          initialValues.set(capability, entry);
        }
      }
    }

    const initialCapabilities = device.capabilities.includes('onoff') && initialValues.get('onoff')?.v !== true
      ? ['onoff']
      : device.capabilities;
    for (const capability of initialCapabilities) {
      if (!initialValues.has(capability)) continue;
      const key = `${device.id}:${capability}`;
      actions.push({
        key: `${key}:${sourceStartMs}:initial`,
        deviceId: device.id,
        deviceName: device.name,
        capability,
        value: initialValues.get(capability).v,
        sourceTime: run.sourceStart,
        sourceSystem: initialValues.get(capability).sourceSystem || device.sourceSystem || 'homey',
        sourceEventId: initialValues.get(capability).id || initialValues.get(capability).sourceEventId || null,
        targetTime: run.targetStart,
      });
    }

    for (const capability of device.capabilities) {
      const key = `${device.id}:${capability}`;
      const entries = Array.isArray(entriesByDeviceCapability[key]) ? entriesByDeviceCapability[key] : [];
      let previousValue = initialValues.get(capability);

      for (const entry of entries) {
        const sourceTimeMs = Date.parse(entry.t);
        if (!Number.isFinite(sourceTimeMs) || sourceTimeMs <= sourceStartMs || sourceTimeMs > sourceNowMs) continue;
        if (Object.is(entry.v, previousValue)) continue;
        previousValue = entry.v;
        actions.push({
          key: `${key}:${entry.t}:${JSON.stringify(entry.v)}`,
          deviceId: device.id,
          deviceName: device.name,
          capability,
          value: entry.v,
          sourceTime: entry.t,
          sourceSystem: entry.sourceSystem || device.sourceSystem || 'homey',
          sourceEventId: entry.id || entry.sourceEventId || null,
          targetTime: new Date(mapSourceTime(entry.t, run)).toISOString(),
        });
      }
    }
  }

  return actions
    .filter((action) => {
      const cursorTimeMs = Date.parse(run.cursors?.[`${action.deviceId}:${action.capability}`] || '');
      return !Number.isFinite(cursorTimeMs) || Date.parse(action.sourceTime) > cursorTimeMs;
    })
    .sort((a, b) => Date.parse(a.targetTime) - Date.parse(b.targetTime)
      || (CAPABILITY_ORDER.get(a.capability) ?? 99) - (CAPABILITY_ORDER.get(b.capability) ?? 99)
      || a.deviceName.localeCompare(b.deviceName, 'da'));
}

function createFixedLoopActions(entriesByDeviceCapability, selectedDevices, run, now = Date.now()) {
  const { loopDurationMs } = run;
  const targetStartMs = Date.parse(run.targetStart);
  const maxCycle = Math.floor((Math.max(0, now - targetStartMs) * run.speed) / loopDurationMs);
  const baseRun = {
    ...run, targetStart: run.sourceStart, speed: 1, cursors: {},
  };
  const baseActions = createReplayActions(entriesByDeviceCapability, selectedDevices, baseRun, Date.parse(run.sourceCutoff));
  const actions = [];

  for (let cycle = 0; cycle <= maxCycle; cycle += 1) {
    const cycleTargetStartMs = targetStartMs + (cycle * loopDurationMs) / run.speed;
    for (const action of baseActions) {
      const sourceOffsetMs = Date.parse(action.sourceTime) - Date.parse(run.sourceStart);
      const targetTimeMs = cycleTargetStartMs + sourceOffsetMs / run.speed;
      if (targetTimeMs > now) continue;
      actions.push({
        ...action,
        key: `${action.key}:cycle:${cycle}`,
        targetTime: new Date(targetTimeMs).toISOString(),
        cycle,
      });
    }
  }
  const lastTargetTimeMs = Date.parse(run.lastTargetTime || '');
  return actions.filter((action) => !Number.isFinite(lastTargetTimeMs) || Date.parse(action.targetTime) > lastTargetTimeMs);
}

module.exports = {
  createDefaultProfile,
  createReplayActions,
  createFixedLoopActions,
  executeReplayActions,
  getReplayCapabilities,
  getReplayDevices,
  getReplayTime,
  mapSourceTime,
  normalizeProfiles,
  normalizeRunInput,
  partitionReplayActions,
};
