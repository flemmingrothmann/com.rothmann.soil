'use strict';

/* eslint-disable no-console */

const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const {
  createFixedLoopActions,
  createReplayActions,
  executeReplayActions,
  getReplayDevices,
  getReplayTime,
  normalizeProfiles,
  normalizeRunInput,
  partitionReplayActions,
} = require('./replay');

const PORT = Number(process.env.PORT || 8789);
const HOMEY_URL = (process.env.HOMEY_URL || '').replace(/\/$/, '');
const HOMEY_TOKEN = process.env.HOMEY_TOKEN || '';
const HOME_ASSISTANT_URL = (process.env.HOME_ASSISTANT_URL || '').replace(/\/$/, '');
const HOME_ASSISTANT_TOKEN = process.env.HOME_ASSISTANT_TOKEN || '';
const WINGMAN_URL = (process.env.WINGMAN_URL || 'http://homey-wingman-ingest-service:8788').replace(/\/$/, '');
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const REPLAY_TOKEN = process.env.REPLAY_TOKEN || '';
const STATE_FILE = process.env.REPLAY_STATE_FILE || '/data/state.json';
const HISTORY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const PLAN_REFRESH_MS = 30 * 1000;
const TICK_MS = 1000;
const ACTION_DELAY_MS = Number(process.env.REPLAY_ACTION_DELAY_MS || 500);

let stateWrite = Promise.resolve();
let execution = null;

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) request.destroy(new Error('Request body is too large'));
    });
    request.on('end', () => resolve(body ? JSON.parse(body) : {}));
    request.on('error', reject);
  });
}

function isAuthorized(request) {
  return REPLAY_TOKEN && request.headers.authorization === `Bearer ${REPLAY_TOKEN}`;
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Could not read replay state: ${error.message || error}`);
    return {};
  }
}

async function mutateState(mutator) {
  let result;
  stateWrite = stateWrite.catch(() => {}).then(async () => {
    const currentState = await readState();
    result = await mutator(currentState);
    const nextState = result?.state || result;
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    const temporaryFile = `${STATE_FILE}.tmp`;
    await fs.writeFile(temporaryFile, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryFile, STATE_FILE);
  });
  await stateWrite;
  return result?.value;
}

async function getJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Upstream returned ${response.status}: ${body || response.statusText}`);
  }
  return response.json();
}

async function getInventory() {
  const snapshot = await getJson(WINGMAN_URL, '/api/homey/snapshot');
  return {
    devices: snapshot.devices || {},
    replayDevices: getReplayDevices(snapshot.devices, snapshot.zones),
  };
}

async function getReplayRoute(action) {
  const query = new URLSearchParams({
    sourceSystem: action.sourceSystem || 'homey',
    deviceId: action.deviceId,
    at: action.sourceTime,
  });
  const result = await getJson(WINGMAN_URL, `/api/replay/routes?${query}`);
  return result.route;
}

async function putHomeyCapability(deviceId, capability, value) {
  const response = await fetch(`${HOMEY_URL}/api/manager/devices/device/${encodeURIComponent(deviceId)}/capability/${encodeURIComponent(capability)}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${HOMEY_TOKEN}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ value }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Homey returned ${response.status}: ${body || response.statusText}`);
  }
}

async function putHomeAssistantCapability(entityId, capability, value) {
  if (!HOME_ASSISTANT_URL || !HOME_ASSISTANT_TOKEN) {
    throw new Error('Home Assistant replay target is not configured');
  }
  const [domain] = entityId.split('.', 1);
  if (domain !== 'light') throw new Error(`Home Assistant replay supports light entities only: ${entityId}`);
  let service;
  let data = { entity_id: entityId };
  if (capability === 'onoff') {
    service = value ? 'turn_on' : 'turn_off';
  } else if (capability === 'dim') {
    service = 'turn_on';
    data = { ...data, brightness_pct: Math.round(Math.max(0, Math.min(1, Number(value))) * 100) };
  } else {
    throw new Error(`Home Assistant replay does not support capability ${capability}`);
  }
  const response = await fetch(`${HOME_ASSISTANT_URL}/api/services/light/${service}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Home Assistant returned ${response.status}: ${body || response.statusText}`);
  }
}

async function dispatchCapability(action) {
  const route = await getReplayRoute(action);
  if (route.targetSystem === 'homey') {
    await putHomeyCapability(route.targetDeviceId, action.capability, action.value);
  } else if (route.targetSystem === 'home_assistant') {
    await putHomeAssistantCapability(route.targetDeviceId, action.capability, action.value);
  } else {
    throw new Error(`Unsupported replay target ${route.targetSystem}`);
  }
  return route;
}

async function recordReplayCommand(action, run, route) {
  const response = await fetch(`${WINGMAN_URL}/api/ingest`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${INGEST_TOKEN}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      time: new Date().toISOString(),
      homey_device_id: action.deviceId,
      device_name: action.deviceName,
      capability: action.capability,
      value: action.value,
      source_system: 'replay',
      source_instance: 'homey-replay-service',
      source_event_id: action.key,
      author_system: 'replay',
      event_type: 'command',
      causation_id: action.sourceEventId || null,
      correlation_id: run.id,
      replay_run_id: run.id,
      source_time: action.sourceTime,
      target_time: action.targetTime,
      target_system: route.targetSystem,
      target_device_id: route.targetDeviceId,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Wingman ingest returned ${response.status}: ${body || response.statusText}`);
  }
}

async function loadProfilesAndDevices() {
  const [stored, inventory] = await Promise.all([readState(), getInventory()]);
  const profiles = normalizeProfiles(stored.profiles, inventory.replayDevices);
  if (JSON.stringify(profiles) !== JSON.stringify(stored.profiles || [])) {
    await mutateState((current) => ({ ...current, profiles }));
  }
  return { stored: { ...stored, profiles }, inventory, profiles };
}

async function getApiState() {
  const { stored, inventory, profiles } = await loadProfilesAndDevices();
  let activeRun = null;
  if (execution) {
    activeRun = {
      ...execution.run,
      replayTime: getReplayTime(execution.run),
      queuedActions: execution.actions.length,
      nextActionAt: execution.actions[0]?.targetTime || null,
    };
  } else if (stored.activeRun?.status === 'running') {
    activeRun = { ...stored.activeRun, replayTime: getReplayTime(stored.activeRun) };
  }
  return {
    generatedAt: new Date().toISOString(),
    profiles,
    devices: inventory.replayDevices,
    activeRun,
    lastRun: stored.lastRun || null,
  };
}

async function saveProfiles(input) {
  const { inventory } = await loadProfilesAndDevices();
  const profiles = normalizeProfiles(input.profiles, inventory.replayDevices);
  await mutateState((current) => ({ ...current, profiles }));
  return { ok: true, profiles };
}

async function loadEntries(selectedDevices, run) {
  const since = Date.parse(run.sourceStart) - HISTORY_LOOKBACK_MS;
  const entries = {};
  await Promise.all(selectedDevices.flatMap((device) => device.capabilities.map(async (capability) => {
    const result = await getJson(WINGMAN_URL, `/api/events?deviceId=${encodeURIComponent(device.id)}&capability=${encodeURIComponent(capability)}&since=${encodeURIComponent(String(since))}`);
    entries[`${device.id}:${capability}`] = Array.isArray(result.values) ? result.values : [];
  })));
  return entries;
}

function createRunActions(entries, selectedDevices, run, until) {
  if (run.mode === 'fixed-loop') {
    return createFixedLoopActions(entries, selectedDevices, run, until);
  }
  return createReplayActions(entries, selectedDevices, run, until);
}

async function persistRun(run, final = false) {
  await mutateState((stored) => ({
    ...stored,
    activeRun: final ? null : run,
    lastRun: final ? run : stored.lastRun || null,
  }));
}

async function stopExecution(reason = 'stopped') {
  if (!execution) return null;
  execution.run.status = reason === 'completed' ? 'completed' : 'stopped';
  execution.run.stoppedAt = new Date().toISOString();
  execution.run.stopReason = reason;
  const run = { ...execution.run };
  execution = null;
  await persistRun(run, true);
  return run;
}

async function startRun(input) {
  if (execution) {
    const error = new Error('En replay er allerede i gang.');
    error.statusCode = 409;
    throw error;
  }

  const { inventory, profiles } = await loadProfilesAndDevices();
  const run = normalizeRunInput(input, profiles);
  const profile = profiles.find((item) => item.id === run.profileId);
  const selected = inventory.replayDevices.filter((device) => profile.deviceIds.includes(device.id));
  const entries = await loadEntries(selected, run);
  const actions = createRunActions(entries, selected, run, Date.now() + PLAN_REFRESH_MS);
  execution = {
    run,
    selected,
    actionKeys: new Set(),
    actions,
    nextPlanRefreshAt: Date.now() + PLAN_REFRESH_MS,
    ticking: false,
  };
  await persistRun(run);
  return run;
}

async function refreshPlan(current) {
  const entries = await loadEntries(current.selected, current.run);
  const actions = createRunActions(entries, current.selected, current.run, Date.now() + PLAN_REFRESH_MS);
  current.actions = actions.filter((action) => !current.actionKeys.has(action.key));
  current.nextPlanRefreshAt = Date.now() + PLAN_REFRESH_MS;
}

async function tick() {
  const current = execution;
  if (!current || current.ticking) return;
  current.ticking = true;
  try {
    const now = Date.now();
    if (current.run.durationMinutes !== null
      && now >= Date.parse(current.run.targetStart) + current.run.durationMinutes * 60 * 1000) {
      await stopExecution('completed');
      return;
    }

    if (now >= current.nextPlanRefreshAt) await refreshPlan(current);
    const { due, queued } = partitionReplayActions(current.actions, now);
    current.actions = queued;
    const results = await executeReplayActions(
      due,
      async (action) => {
        const route = await dispatchCapability(action);
        await recordReplayCommand(action, current.run, route);
      },
      { delayMs: ACTION_DELAY_MS, shouldContinue: () => execution === current },
    );

    for (const result of results) {
      if (execution !== current) return;
      const { action } = result;
      if (result.applied) {
        current.run.actionsApplied += 1;
        current.run.lastActionAt = new Date().toISOString();
      } else {
        current.run.actionsSkipped = (current.run.actionsSkipped || 0) + 1;
        current.run.lastError = `${action.deviceName} (${action.capability}): ${result.error.message || result.error}`;
        console.warn(`Replay action failed: ${current.run.lastError}`);
      }
      current.run.cursors[`${action.deviceId}:${action.capability}`] = action.sourceTime;
      current.run.lastTargetTime = action.targetTime;
      current.actionKeys.add(action.key);
    }

    if (due.length > 0 && execution === current) await persistRun(current.run);
  } catch (error) {
    current.run.lastError = error.message || String(error);
    console.error(`Replay tick failed: ${current.run.lastError}`);
  } finally {
    if (execution === current) current.ticking = false;
  }
}

async function recoverRun() {
  const stored = await readState();
  if (stored.activeRun?.status !== 'running') return;
  try {
    const { inventory, profiles } = await loadProfilesAndDevices();
    const profile = profiles.find((item) => item.id === stored.activeRun.profileId);
    if (!profile) throw new Error('Profilen findes ikke længere.');
    const selected = inventory.replayDevices.filter((device) => profile.deviceIds.includes(device.id));
    stored.activeRun.sourceCutoff ||= stored.activeRun.targetStart;
    const entries = await loadEntries(selected, stored.activeRun);
    execution = {
      run: stored.activeRun,
      selected,
      actionKeys: new Set(),
      actions: createRunActions(entries, selected, stored.activeRun, Date.now() + PLAN_REFRESH_MS),
      nextPlanRefreshAt: Date.now() + PLAN_REFRESH_MS,
      ticking: false,
    };
    console.log(`Resumed replay ${stored.activeRun.id} (${stored.activeRun.profileName})`);
  } catch (error) {
    stored.activeRun.status = 'failed';
    stored.activeRun.stoppedAt = new Date().toISOString();
    stored.activeRun.stopReason = 'recovery-failed';
    stored.activeRun.lastError = error.message || String(error);
    await mutateState((current) => ({ ...current, activeRun: null, lastRun: stored.activeRun }));
    console.error(`Could not resume replay: ${stored.activeRun.lastError}`);
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { ok: true, service: 'homey-replay-service', active: Boolean(execution) });
      return;
    }
    if (!isAuthorized(request)) {
      sendJson(response, 401, { error: 'Unauthorized' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/replay') {
      sendJson(response, 200, await getApiState());
      return;
    }
    if (request.method === 'PUT' && url.pathname === '/api/replay/profiles') {
      sendJson(response, 200, await saveProfiles(await readBody(request)));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/replay/runs') {
      sendJson(response, 202, { ok: true, run: await startRun(await readBody(request)) });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/replay/runs/stop') {
      const run = await stopExecution('stopped-by-user');
      sendJson(response, 200, { ok: true, run });
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error.message || error);
    sendJson(response, error.statusCode || 500, { error: error.message || 'Internal server error' });
  }
});

if (require.main === module) {
  if (!HOMEY_URL || !HOMEY_TOKEN || !INGEST_TOKEN || !REPLAY_TOKEN) {
    throw new Error('HOMEY_URL, HOMEY_TOKEN, INGEST_TOKEN and REPLAY_TOKEN must be configured');
  }
  server.listen(PORT, '0.0.0.0', async () => {
    console.log(`Homey replay service listening on http://0.0.0.0:${PORT}`);
    await recoverRun();
    setInterval(tick, TICK_MS);
  });
}

module.exports = { server };
