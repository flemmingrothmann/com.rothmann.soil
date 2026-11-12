'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const mqtt = require('mqtt');
const YAML = require('yaml');
const { classifyCircuitMode, generatedHelperEntities } = require('./wateringCircuitMode');
const { ZigbeeIdentityRoutes, cachedStateByIeee, profileMatchesDevice, observeProfileTopics } = require('./zigbeeIdentity');
const { SoilProvisioner, softwareControlEvents } = require('./soilProvisioning');

const MQTT_URL = process.env.MQTT_URL || 'mqtt://mosquitto:1883';
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const WINGMAN_URL = (process.env.WINGMAN_URL || '').replace(/\/$/, '');
const ZIGBEE2MQTT_URL = (process.env.ZIGBEE2MQTT_URL || 'http://zigbee2mqtt:8080').replace(/\/$/, '');
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const PROFILES_FILE = process.env.SOIL_PROFILES_FILE || '/config/profiles.json';
const ZIGBEE2MQTT_STATE_FILE = process.env.ZIGBEE2MQTT_STATE_FILE || '/zigbee2mqtt/state.json';
const HOME_ASSISTANT_URL = (process.env.HOME_ASSISTANT_URL || '').replace(/\/$/, '');
const HOME_ASSISTANT_TOKEN = process.env.HOME_ASSISTANT_TOKEN || '';
const HOME_ASSISTANT_PACKAGES_DIR = process.env.HOME_ASSISTANT_PACKAGES_DIR || '/home-assistant/packages';
const HOME_ASSISTANT_AUTOMATIONS_FILE = process.env.HOME_ASSISTANT_AUTOMATIONS_FILE || '/home-assistant/config/automations.yaml';
const PORT = Number(process.env.PORT || 8790);
const QUEUE_FILE = process.env.QUEUE_FILE || '/data/wingman-queue.json';
const ZIGBEE_ROUTES_FILE = process.env.ZIGBEE_ROUTES_FILE || '/data/zigbee-device-topics.json';
const MAX_QUEUE_EVENTS = Number(process.env.MAX_QUEUE_EVENTS || 100000);
const MIN_RETRY_DELAY_MS = 15000;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

if (!WINGMAN_URL || !INGEST_TOKEN || !HOME_ASSISTANT_URL || !HOME_ASSISTANT_TOKEN) {
  throw new Error('WINGMAN_URL, INGEST_TOKEN, HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN must be configured');
}

const profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
let queue = [];
let flushing = false;
let retryTimer = null;
let retryDelayMs = MIN_RETRY_DELAY_MS;
let syncedProfilesSignature = '';

async function requestHomeAssistant(pathname, options = {}) {
  const response = await fetch(`${HOME_ASSISTANT_URL}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
      accept: 'application/json',
      ...options.headers,
    },
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Home Assistant returned ${response.status}: ${body || response.statusText}`);
  return body ? JSON.parse(body) : null;
}

async function requestHomeAssistantWebSocket(type, fields = {}) {
  const socket = new globalThis.WebSocket(`${HOME_ASSISTANT_URL.replace(/^http/, 'ws')}/api/websocket`);
  const nextMessage = () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`Home Assistant ${type} timed out.`)); }, 15000);
    const message = (event) => { cleanup(); resolve(JSON.parse(event.data)); };
    const error = () => { cleanup(); reject(new Error('Home Assistant WebSocket-forbindelsen fejlede.')); };
    function cleanup() {
      clearTimeout(timeout);
      socket.removeEventListener('message', message);
      socket.removeEventListener('error', error);
      socket.removeEventListener('close', error);
    }
    socket.addEventListener('message', message, { once: true });
    socket.addEventListener('error', error, { once: true });
    socket.addEventListener('close', error, { once: true });
  });
  try {
    await nextMessage();
    socket.send(JSON.stringify({ type: 'auth', access_token: HOME_ASSISTANT_TOKEN }));
    const auth = await nextMessage();
    if (auth.type !== 'auth_ok') throw new Error(`Home Assistant WebSocket-login fejlede: ${auth.message || auth.type}`);
    socket.send(JSON.stringify({ id: 1, type, ...fields }));
    const result = await nextMessage();
    if (!result.success) throw new Error(`Home Assistant WebSocket ${type} fejlede: ${result.error?.message || 'ukendt fejl'}`);
    return result.result;
  } finally { socket.close(); }
}

function slugifyCircuitLabel(label) {
  const slug = String(label || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!slug || slug.length > 60) throw new Error('Labelen skal indeholde 1-60 bogstaver eller tal.');
  return slug;
}

function circuitPackagePath(circuit) {
  const existing = Object.values(profiles).find((profile) => profile.wateringCircuit === circuit && profile.generatedWatering?.packageFile);
  return existing?.generatedWatering?.packageFile || `wingman_watering_${slugifyCircuitLabel(circuit)}.yaml`;
}

function findLegacyPackageFiles(valve, sensors, existingProfiles) {
  if (!fs.existsSync(HOME_ASSISTANT_PACKAGES_DIR)) return [];
  const entities = [
    valve.entity_id,
    ...sensors.map((sensor) => sensor.entity_id),
    ...existingProfiles.flatMap(([, profile]) => [profile.haThresholdEntity, ...Object.values(profile.haWatering || {})].filter(Boolean)),
  ];
  return fs.readdirSync(HOME_ASSISTANT_PACKAGES_DIR)
    .filter((file) => /\.ya?ml$/i.test(file))
    .filter((file) => {
      const source = fs.readFileSync(path.join(HOME_ASSISTANT_PACKAGES_DIR, file), 'utf8');
      return !source.startsWith('# Managed by soil-controller.') && entities.some((entity) => source.includes(entity));
    });
}

function circuitYaml({ circuit, slug, valve, sensors }) {
  const title = circuit.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const helper = `wingman_${slug}`;
  const numbers = sensors.map((sensor) => `  ${helper}_${sensor.key}_threshold:\n    name: ${title} ${sensor.name} jordfugtgrænse\n    min: 0\n    max: 90\n    step: 1\n    unit_of_measurement: '%'\n    mode: box`).join('\n');
  const alarms = sensors.map((sensor) => `  ${helper}_${sensor.key}_water_alarm:\n    name: ${title} ${sensor.name} vandalarm\n    icon: mdi:water-alert`).join('\n');
  return `# Managed by soil-controller. Remove only through the Vanding configurator.\ninput_number:\n${numbers}\n  ${helper}_cycle_duration:\n    name: ${title} cyklusvarighed\n    min: 1\n    max: 30\n    step: 1\n    unit_of_measurement: min\n  ${helper}_pause_duration:\n    name: ${title} pause\n    min: 1\n    max: 120\n    step: 1\n    unit_of_measurement: min\n  ${helper}_maximum_cycles:\n    name: ${title} maks cyklusser\n    min: 1\n    max: 100\n    step: 1\n  ${helper}_cycle_number:\n    name: ${title} cyklusnummer\n    min: 0\n    max: 100\n    step: 1\ninput_boolean:\n${alarms}\n  ${helper}_watering_error:\n    name: ${title} vandingsfejl\n  ${helper}_watering_forbidden:\n    name: ${title} vanding forbudt\ninput_select:\n  ${helper}_watering_status:\n    name: ${title} vandingsstatus\n    options: [idle, watering, waiting_result, waiting_capacity, cycle_limit]\n    initial: idle\n`;
}

function circuitAutomationsYaml({ circuit, slug, valve, sensors }) {
  const title = circuit.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const helper = `wingman_${slug}`;
  const alarmBlocks = sensors.map((sensor) => `- id: ${helper}_${sensor.entity_id.replace(/[^a-z0-9_]/gi, '_')}_alarm\n  alias: ${title} ${sensor.name} jordfugt alarm\n  use_blueprint:\n    path: wingman/soil-moisture-alarm.yaml\n    input:\n      moisture_sensor: ${sensor.entity_id}\n      threshold: input_number.${helper}_${sensor.key}_threshold\n      water_alarm: input_boolean.${helper}_${sensor.key}_water_alarm\n      alarm_topic: homeassistant/soil/${slug}/${sensor.key}/alarm`).join('\n');
  const waterAlarms = sensors.map((sensor) => `        - input_boolean.${helper}_${sensor.key}_water_alarm`).join('\n');
  return `# Managed by soil-controller: ${slug} begin\n${alarmBlocks}\n- id: ${helper}_watering\n  alias: ${title} vanding\n  use_blueprint:\n    path: wingman/labelled-pot-watering.yaml\n    input:\n      watering_label: ${circuit}\n      valve: ${valve.entity_id}\n      water_alarms:\n${waterAlarms}\n      cycle_duration: input_number.${helper}_cycle_duration\n      pause_duration: input_number.${helper}_pause_duration\n      maximum_cycles: input_number.${helper}_maximum_cycles\n      cycle_number: input_number.${helper}_cycle_number\n      watering_error: input_boolean.${helper}_watering_error\n      watering_forbidden: input_boolean.${helper}_watering_forbidden\n      lifecycle_status: input_select.${helper}_watering_status\n      capacity_busy: input_boolean.ha_watering_capacity_busy\n      capacity_acquire: script.ha_watering_capacity_acquire\n# Managed by soil-controller: ${slug} end\n`;
}

function replaceGeneratedAutomations(source, slug, automations) {
  const block = new RegExp(`(?:^|\\n)# Managed by soil-controller: ${slug} begin[\\s\\S]*?# Managed by soil-controller: ${slug} end\\n?`, 'g');
  return `${source.replace(block, '\n').trimEnd()}${source.trim() ? '\n\n' : ''}${automations}`;
}

function removeGeneratedAutomations(source, slug) {
  const block = new RegExp(`(?:^|\\n)# Managed by soil-controller: ${slug} begin[\\s\\S]*?# Managed by soil-controller: ${slug} end\\n?`, 'g');
  return source.replace(block, '\n').replace(/^\s+|\s+$/g, '') + '\n';
}

function getDeviceKeys(device) {
  return (device?.identifiers || []).map((identifier) => String(identifier?.[1] || '').toLowerCase()).filter(Boolean);
}

async function planWateringCircuit(label) {
  const requestedCircuit = String(label || '').trim();
  if (!requestedCircuit) throw new Error('Vælg en HA-label.');
  const [labels, devices, entities, states] = await Promise.all([
    requestHomeAssistantWebSocket('config/label_registry/list'),
    requestHomeAssistantWebSocket('config/device_registry/list'),
    requestHomeAssistantWebSocket('config/entity_registry/list'),
    requestHomeAssistant('/api/states'),
  ]);
  const labelEntry = labels.find((item) => item.name === requestedCircuit || item.label_id === requestedCircuit || item.id === requestedCircuit);
  if (!labelEntry) throw new Error(`HA-labelen "${requestedCircuit}" findes ikke.`);
  // Persist and compare the display name so label ids and names resolve to one circuit.
  const circuit = labelEntry.name;
  const slug = slugifyCircuitLabel(circuit);
  const existingProfiles = Object.entries(profiles).filter(([, profile]) => profile.wateringCircuit === circuit);
  const generatedProfile = existingProfiles.find(([, profile]) => profile.generatedWatering?.packageFile);
  const labelledDeviceIds = new Set(devices.filter((device) => (device.labels || []).includes(labelEntry.label_id || labelEntry.id)).map((device) => device.id));
  const stateById = new Map(states.map((state) => [state.entity_id, state]));
  const labelledEntities = entities.filter((entity) => labelledDeviceIds.has(entity.device_id) || (entity.labels || []).includes(labelEntry.label_id || labelEntry.id));
  const valves = labelledEntities.filter((entity) => entity.entity_id.startsWith('switch.')
    && entity.entity_category !== 'config'
    && !/auto close|child lock|led|alarm/i.test(`${entity.name || ''} ${entity.original_name || ''}`));
  const sensors = labelledEntities.filter((entity) => entity.entity_id.startsWith('sensor.') && (entity.device_class === 'moisture' || stateById.get(entity.entity_id)?.attributes?.device_class === 'moisture'));
  if (valves.length !== 1) throw new Error(`Labelen skal have præcis én switch-ventil; fandt ${valves.length}.`);
  if (sensors.length === 0) throw new Error('Labelen skal have mindst én jordfugtsensor med device class moisture.');
  const usedKeys = new Set();
  const normalizedSensors = sensors.map((sensor, index) => {
    const device = devices.find((item) => item.id === sensor.device_id);
    let key = slugifyCircuitLabel(sensor.entity_id.replace(/^sensor\./, ''));
    while (usedKeys.has(key)) key = `${key}_${index + 1}`;
    usedKeys.add(key);
    return {
      entity_id: sensor.entity_id,
      device_id: sensor.device_id,
      device_keys: getDeviceKeys(devices.find((device) => device.id === sensor.device_id)),
      name: device?.name_by_user || device?.name || sensor.name || sensor.original_name || sensor.entity_id,
      key,
    };
  });
  const valveDevice = devices.find((device) => device.id === valves[0].device_id);
  const valve = {
    entity_id: valves[0].entity_id,
    device_id: valves[0].device_id,
    device_keys: getDeviceKeys(devices.find((device) => device.id === valves[0].device_id)),
    name: valveDevice?.name_by_user || valveDevice?.name || valves[0].name || valves[0].original_name || valves[0].entity_id,
  };
  const packageFile = generatedProfile?.[1]?.generatedWatering?.packageFile || circuitPackagePath(circuit);
  const mode = classifyCircuitMode(existingProfiles);
  const legacyPackageFiles = mode === 'legacy' ? findLegacyPackageFiles(valve, normalizedSensors, existingProfiles) : [];
  return {
    circuit,
    slug,
    valve,
    sensors: normalizedSensors,
    packageFile,
    mode,
    existing: mode !== 'create',
    generated: mode === 'managed',
    legacyPackageFiles,
    yaml: circuitYaml({ circuit, slug, valve, sensors: normalizedSensors }),
    automationsYaml: circuitAutomationsYaml({ circuit, slug, valve, sensors: normalizedSensors }),
  };
}

function persistProfiles() {
  fs.writeFileSync(`${PROFILES_FILE}.tmp`, `${JSON.stringify(profiles, null, 2)}\n`, 'utf8');
  fs.renameSync(`${PROFILES_FILE}.tmp`, PROFILES_FILE);
}

async function reloadHomeAssistant() {
  await requestHomeAssistant('/api/services/homeassistant/reload_all', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
}

async function getHomeAssistantStates(entityIds) {
  const entries = await Promise.all(entityIds.map(async (entityId) => {
    try {
      return [entityId, await requestHomeAssistant(`/api/states/${encodeURIComponent(entityId)}`)];
    } catch (error) {
      if (String(error.message).includes('returned 404')) return [entityId, null];
      throw error;
    }
  }));
  return Object.fromEntries(entries);
}

async function validateGeneratedCircuit(plan) {
  const helpers = generatedHelperEntities(plan.slug, plan.sensors);
  const states = await getHomeAssistantStates([
    ...helpers.thresholds,
    ...helpers.waterAlarmEntities,
    ...Object.values(helpers).filter((value) => typeof value === 'string'),
  ]);
  if (Object.values(states).some((state) => !state)) {
    throw new Error('Den genererede HA-konfiguration blev ikke indlæst fuldt ud.');
  }
}

async function restoreHelperValues(values, targetEntities, sensors) {
  const writeNumber = (entityId, value) => requestHomeAssistant('/api/services/input_number/set_value', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entity_id: entityId, value: Number(value) }),
  });
  const writeBoolean = (entityId, value) => requestHomeAssistant(`/api/services/input_boolean/${value === 'on' ? 'turn_on' : 'turn_off'}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entity_id: entityId }),
  });
  const legacyWatering = values.legacyWatering || {};
  await Promise.all([
    ...sensors.map((sensor, index) => writeNumber(targetEntities.thresholds[index], values.thresholds[index])),
    ...targetEntities.waterAlarmEntities.map((entityId, index) => writeBoolean(entityId, values.waterAlarms[index])),
    ...Object.entries({
      cycleDurationEntity: targetEntities.cycleDurationEntity,
      pauseDurationEntity: targetEntities.pauseDurationEntity,
      maximumCyclesEntity: targetEntities.maximumCyclesEntity,
      cycleNumberEntity: targetEntities.cycleNumberEntity,
    }).filter(([key]) => legacyWatering[key] !== undefined).map(([key, entityId]) => writeNumber(entityId, legacyWatering[key])),
    ...Object.entries({ errorEntity: targetEntities.errorEntity, forbiddenEntity: targetEntities.forbiddenEntity }).filter(([key]) => legacyWatering[key] !== undefined).map(([key, entityId]) => writeBoolean(entityId, legacyWatering[key])),
    legacyWatering.statusEntity === undefined ? Promise.resolve() : requestHomeAssistant('/api/services/input_select/select_option', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entity_id: targetEntities.statusEntity, option: legacyWatering.statusEntity }),
    }),
  ]);
}

function updateCircuitProfiles(plan) {
  const helpers = generatedHelperEntities(plan.slug, plan.sensors);
  const valveProfile = Object.entries(profiles).find(([id, profile]) => profile.type === 'watering_valve' && (
    profileMatchesDevice(id, profile, plan.valve)
  ))?.[1];
  if (valveProfile) {
    valveProfile.wateringCircuit = plan.circuit;
    valveProfile.generatedWatering = { packageFile: plan.packageFile, valveEntity: plan.valve.entity_id, sensorEntities: plan.sensors.map((sensor) => sensor.entity_id) };
    valveProfile.haWatering = Object.fromEntries(Object.entries(helpers).filter(([key]) => !['thresholds', 'waterAlarmEntities'].includes(key)));
  }
  plan.sensors.forEach((sensor, index) => {
    const profile = Object.entries(profiles).find(([id, item]) => profileMatchesDevice(id, item, sensor))?.[1];
    if (profile) {
      profile.wateringCircuit = plan.circuit;
      profile.generatedWatering = { packageFile: plan.packageFile };
      profile.haThresholdEntity = helpers.thresholds[index];
      profile.alarmTopic = `homeassistant/soil/${plan.slug}/${sensor.key}/alarm`;
    }
  });
}

async function applyWateringCircuit(label) {
  const plan = await planWateringCircuit(label);
  if (plan.mode === 'legacy') throw new Error('Kredsen er manuel. Brug Overtag og migrer med bekræftelse.');
  const packagePath = path.join(HOME_ASSISTANT_PACKAGES_DIR, plan.packageFile);
  fs.mkdirSync(HOME_ASSISTANT_PACKAGES_DIR, { recursive: true });
  const previousSource = fs.existsSync(packagePath) ? fs.readFileSync(packagePath, 'utf8') : null;
  const previousAutomations = fs.existsSync(HOME_ASSISTANT_AUTOMATIONS_FILE) ? fs.readFileSync(HOME_ASSISTANT_AUTOMATIONS_FILE, 'utf8') : '';
  if (previousSource && !previousSource.startsWith('# Managed by soil-controller.')) {
    throw new Error('Pakken er ikke genereret af soil-controller og ændres ikke.');
  }
  fs.writeFileSync(`${packagePath}.tmp`, plan.yaml, 'utf8');
  fs.renameSync(`${packagePath}.tmp`, packagePath);
  fs.mkdirSync(path.dirname(HOME_ASSISTANT_AUTOMATIONS_FILE), { recursive: true });
  fs.writeFileSync(`${HOME_ASSISTANT_AUTOMATIONS_FILE}.tmp`, replaceGeneratedAutomations(previousAutomations, plan.slug, plan.automationsYaml), 'utf8');
  fs.renameSync(`${HOME_ASSISTANT_AUTOMATIONS_FILE}.tmp`, HOME_ASSISTANT_AUTOMATIONS_FILE);
  try {
    await reloadHomeAssistant();
    await validateGeneratedCircuit(plan);
    updateCircuitProfiles(plan);
    persistProfiles();
    return { ...plan, yaml: undefined, automationsYaml: undefined, applied: true, repaired: plan.mode === 'managed' };
  } catch (error) {
    if (previousSource === null) fs.unlinkSync(packagePath);
    else fs.writeFileSync(packagePath, previousSource, 'utf8');
    fs.writeFileSync(HOME_ASSISTANT_AUTOMATIONS_FILE, previousAutomations, 'utf8');
    await reloadHomeAssistant().catch(() => {});
    throw error;
  }
}

async function migrateWateringCircuit(label, confirm) {
  if (!confirm) throw new Error('Migration kræver eksplicit bekræftelse.');
  const plan = await planWateringCircuit(label);
  if (plan.mode !== 'legacy') throw new Error('Kun manuelle vandingskredse kan overtages.');
  if (plan.legacyPackageFiles.length === 0) throw new Error('Kunne ikke identificere den manuelle HA-pakke sikkert. Intet blev ændret.');
  const existingProfiles = Object.entries(profiles).filter(([, profile]) => profile.wateringCircuit === plan.circuit);
  const legacyWatering = existingProfiles.find(([, profile]) => profile.haWatering)?.[1]?.haWatering || {};
  const sourceStates = await getHomeAssistantStates([...plan.sensors.map((sensor) => {
    const profile = existingProfiles.find(([, item]) => item.haDeviceId === sensor.device_id)?.[1];
    return profile?.haThresholdEntity;
  }).filter(Boolean), ...plan.sensors.map((sensor) => {
    const profile = existingProfiles.find(([, item]) => item.haDeviceId === sensor.device_id)?.[1];
    return profile?.haThresholdEntity?.replace(/_water_threshold$/, '_water_alarm');
  }).filter(Boolean), ...Object.values(legacyWatering)]);
  const values = {
    thresholds: plan.sensors.map((sensor) => Number(sourceStates[existingProfiles.find(([, item]) => item.haDeviceId === sensor.device_id)?.[1]?.haThresholdEntity]?.state)),
    waterAlarms: plan.sensors.map((sensor) => sourceStates[existingProfiles.find(([, item]) => item.haDeviceId === sensor.device_id)?.[1]?.haThresholdEntity?.replace(/_water_threshold$/, '_water_alarm')]?.state || 'off'),
    legacyWatering: Object.fromEntries(Object.entries(legacyWatering).map(([key, entityId]) => [key, sourceStates[entityId]?.state]).filter(([, value]) => value !== undefined)),
  };
  if (values.thresholds.some((value) => !Number.isFinite(value))) throw new Error('Kunne ikke læse alle eksisterende jordfugtgrænser. Intet blev ændret.');
  const packagePath = path.join(HOME_ASSISTANT_PACKAGES_DIR, plan.packageFile);
  const previousAutomations = fs.existsSync(HOME_ASSISTANT_AUTOMATIONS_FILE) ? fs.readFileSync(HOME_ASSISTANT_AUTOMATIONS_FILE, 'utf8') : '';
  fs.writeFileSync(`${packagePath}.tmp`, plan.yaml, 'utf8');
  fs.renameSync(`${packagePath}.tmp`, packagePath);
  fs.mkdirSync(path.dirname(HOME_ASSISTANT_AUTOMATIONS_FILE), { recursive: true });
  fs.writeFileSync(`${HOME_ASSISTANT_AUTOMATIONS_FILE}.tmp`, replaceGeneratedAutomations(previousAutomations, plan.slug, plan.automationsYaml), 'utf8');
  fs.renameSync(`${HOME_ASSISTANT_AUTOMATIONS_FILE}.tmp`, HOME_ASSISTANT_AUTOMATIONS_FILE);
  const targets = generatedHelperEntities(plan.slug, plan.sensors);
  try {
    await reloadHomeAssistant();
    await validateGeneratedCircuit(plan);
    await restoreHelperValues(values, targets, plan.sensors);
    const backupSuffix = `.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const backups = plan.legacyPackageFiles.map((file) => {
      fs.copyFileSync(path.join(HOME_ASSISTANT_PACKAGES_DIR, file), path.join(HOME_ASSISTANT_PACKAGES_DIR, `${file}${backupSuffix}`));
      return `${file}${backupSuffix}`;
    });
    plan.legacyPackageFiles.forEach((file) => fs.renameSync(path.join(HOME_ASSISTANT_PACKAGES_DIR, file), path.join(HOME_ASSISTANT_PACKAGES_DIR, `${file}.disabled`)));
    await reloadHomeAssistant();
    updateCircuitProfiles(plan);
    persistProfiles();
    return { ...plan, yaml: undefined, automationsYaml: undefined, migrated: true, backups };
  } catch (error) {
    if (fs.existsSync(packagePath)) fs.unlinkSync(packagePath);
    fs.writeFileSync(HOME_ASSISTANT_AUTOMATIONS_FILE, previousAutomations, 'utf8');
    plan.legacyPackageFiles.forEach((file) => {
      const disabled = path.join(HOME_ASSISTANT_PACKAGES_DIR, `${file}.disabled`);
      if (fs.existsSync(disabled)) fs.renameSync(disabled, path.join(HOME_ASSISTANT_PACKAGES_DIR, file));
    });
    await reloadHomeAssistant().catch(() => {});
    throw error;
  }
}

async function removeWateringCircuit(label, confirm) {
  const circuit = String(label || '').trim();
  const allCircuitProfiles = Object.entries(profiles).filter(([, profile]) => profile.wateringCircuit === circuit);
  const circuitProfiles = allCircuitProfiles.filter(([, profile]) => profile.generatedWatering?.packageFile);
  const profileEntries = circuitProfiles;
  const packageFile = profileEntries[0]?.[1]?.generatedWatering?.packageFile || `wingman_watering_${slugifyCircuitLabel(circuit)}.yaml`;
  const packagePath = path.join(HOME_ASSISTANT_PACKAGES_DIR, packageFile);
  const exists = fs.existsSync(packagePath);
  const plan = { circuit, packageFile, packageExists: exists, profiles: circuitProfiles.map(([id]) => id) };
  if (allCircuitProfiles.length > 0 && circuitProfiles.length === 0) {
    throw new Error('Kredsen er ikke genereret af konfiguratoren og kan ikke fjernes her.');
  }
  if (!confirm) return { ...plan, dryRun: true };
  if (!exists && profileEntries.length === 0) throw new Error('Der findes ingen genereret vandingskreds for labelen.');
  if (exists) {
    const source = fs.readFileSync(packagePath, 'utf8');
    if (!source.startsWith('# Managed by soil-controller.')) throw new Error('Pakken er ikke genereret af soil-controller og slettes ikke.');
    fs.unlinkSync(packagePath);
  }
  if (fs.existsSync(HOME_ASSISTANT_AUTOMATIONS_FILE)) {
    fs.writeFileSync(HOME_ASSISTANT_AUTOMATIONS_FILE, removeGeneratedAutomations(fs.readFileSync(HOME_ASSISTANT_AUTOMATIONS_FILE, 'utf8'), slugifyCircuitLabel(circuit)), 'utf8');
  }
  circuitProfiles.forEach(([, profile]) => {
    delete profile.generatedWatering;
    delete profile.haWatering;
    delete profile.wateringCircuit;
  });
  persistProfiles();
  await reloadHomeAssistant();
  return { ...plan, removed: true };
}

function getProfileByDeviceId(deviceId) {
  const profile = profiles[deviceId];
  if (!profile) throw new Error('Jordfugtsensoren blev ikke fundet.');
  if (!profile.haThresholdEntity) throw new Error('Sensoren mangler en HA jordfugtgrænse.');
  return profile;
}

async function readProfileThreshold(profile) {
  const state = await requestHomeAssistant(`/api/states/${encodeURIComponent(profile.haThresholdEntity)}`);
  const threshold = Number(state?.state);
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 90) {
    throw new Error(`${profile.name}: HA jordfugtgrænsen er ugyldig.`);
  }
  return threshold;
}

async function refreshProfileThreshold(profile, deviceId, timestamp = new Date().toISOString()) {
  const threshold = await readProfileThreshold(profile);
  profile.threshold = threshold;
  if (profile.autoManual) {
    const alarm = await requestHomeAssistant(`/api/states/${encodeURIComponent(profile.haAlarmEntity)}`);
    if (!['on', 'off'].includes(alarm?.state)) throw new Error(`${profile.name}: HA-alarmstatus er utilgængelig.`);
    await ingestSoftwareControl(profile, deviceId, { threshold, alarm: alarm.state === 'on', time: timestamp });
    return threshold;
  }
  enqueueIngest([toEvent(profile, deviceId, 'soil_warning_threshold', threshold, timestamp, `${deviceId}:${timestamp}:threshold`, 'home_assistant')]);
  return threshold;
}

async function setProfileThreshold(deviceId, value) {
  const profile = getProfileByDeviceId(deviceId);
  const threshold = Number(value);
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 90) {
    throw new Error('Jordfugtgrænsen skal være et helt tal fra 0 til 90 %.');
  }
  await requestHomeAssistant('/api/services/input_number/set_value', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entity_id: profile.haThresholdEntity, value: threshold }),
  });
  const confirmed = await refreshProfileThreshold(profile, deviceId);
  await syncProfiles();
  return confirmed;
}

async function getWateringStatus(deviceId) {
  const profile = profiles[deviceId];
  if (!profile) throw new Error('Vandingsventilen blev ikke fundet.');
  if (profile.type !== 'watering_valve' || !profile.haWatering) {
    throw new Error('Vandingsstatus er ikke konfigureret for ventilen.');
  }
  const entries = Object.entries(profile.haWatering);
  const states = await Promise.all(entries.map(async ([key, entityId]) => {
    const state = await requestHomeAssistant(`/api/states/${encodeURIComponent(entityId)}`);
    return [key, state.state];
  }));
  const values = Object.fromEntries(states);
  return {
    status: values.statusEntity,
    error: values.errorEntity === 'on',
    forbidden: values.forbiddenEntity === 'on',
    cycleNumber: Number(values.cycleNumberEntity) || 0,
    cycleDuration: Number(values.cycleDurationEntity) || null,
    pauseDuration: Number(values.pauseDurationEntity) || null,
    maximumCycles: Number(values.maximumCyclesEntity) || null,
  };
}

async function setWateringForbidden(deviceId, value) {
  const profile = profiles[deviceId];
  if (!profile || profile.type !== 'watering_valve' || !profile.haWatering?.forbiddenEntity) {
    throw new Error('Vandingsforbud kan ikke ændres for ventilen.');
  }
  await requestHomeAssistant(`/api/services/input_boolean/${value === true ? 'turn_on' : 'turn_off'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entity_id: profile.haWatering.forbiddenEntity }),
  });
  return getWateringStatus(deviceId);
}

async function restartWateringAfterError(deviceId) {
  const profile = profiles[deviceId];
  if (!profile || profile.type !== 'watering_valve' || !profile.haWatering?.errorEntity) {
    throw new Error('Vandingsfejlen kan ikke nulstilles for ventilen.');
  }
  await requestHomeAssistant('/api/services/input_boolean/turn_off', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entity_id: profile.haWatering.errorEntity }),
  });
  return getWateringStatus(deviceId);
}

async function syncNamesFromHomeAssistant() {
  const [devices, areas] = await Promise.all([
    requestHomeAssistantWebSocket('config/device_registry/list'),
    requestHomeAssistantWebSocket('config/area_registry/list'),
  ]);
  const areasById = new Map(areas.map((area) => [area.area_id || area.id, area]));
  const before = JSON.stringify(profiles);
  for (const [ieee, profile] of Object.entries(profiles)) {
    if (profile.autoManual) continue; // Provisioning also respects a moisture entity's area override.
    const matches = devices.filter((item) => getDeviceKeys(item).includes(`zigbee2mqtt_${ieee.toLowerCase()}`));
    const device = matches.length === 1 ? matches[0] : null;
    if (!device) continue;
    profile.haDeviceId = device.id;
    const name = String(device?.name_by_user || device?.name || '').trim();
    if (name) profile.name = name;
    const area = areasById.get(device?.area_id);
    profile.zoneId = area ? area.area_id || area.id : 'ha_unassigned';
    profile.zoneName = area?.name || 'Uplaceret';
  }
  const changed = before !== JSON.stringify(profiles);
  if (changed) persistProfiles();
  return changed;
}

function loadQueue() {
  try {
    queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    if (!Array.isArray(queue)) throw new Error('Invalid persistent soil queue');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    queue = [];
  }
}

function persistQueue() {
  fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
  fs.writeFileSync(`${QUEUE_FILE}.tmp`, `${JSON.stringify(queue)}\n`, 'utf8');
  fs.renameSync(`${QUEUE_FILE}.tmp`, QUEUE_FILE);
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    flushQueue().catch((error) => console.error(error.message || error));
  }, retryDelayMs);
  retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, Math.round(retryDelayMs * 1.6));
}

async function post(pathname, body) {
  const response = await fetch(`${WINGMAN_URL}${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${INGEST_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (response.status !== 202) throw new Error(`Wingman returned ${response.status}: ${await response.text()}`);
}

function enqueueIngest(events) {
  queue.push({ events });
  if (queue.length === MAX_QUEUE_EVENTS) console.warn('Soil queue reached its warning limit; retaining unacknowledged observations.');
  persistQueue();
  flushQueue().catch((error) => console.error(error.message || error));
}

async function flushQueue() {
  if (flushing || queue.length === 0) return;
  flushing = true;
  try {
    while (queue.length > 0) {
      await post('/api/ingest', queue[0]);
      queue.shift();
      persistQueue();
      retryDelayMs = MIN_RETRY_DELAY_MS;
    }
  } catch (error) {
    scheduleRetry();
    throw error;
  } finally {
    flushing = false;
  }
}

function toEvent(profile, deviceId, capability, value, timestamp, sourceEventId, authorSystem = null) {
  return {
    time: timestamp,
    homey_device_id: deviceId,
    homey_zone_id: profile.zoneId,
    device_name: profile.name,
    device_class: profile.type === 'watering_valve' ? 'valve' : 'sensor',
    capability,
    value,
    unit: ['measure_soil_moisture', 'measure_humidity', 'measure_battery'].includes(capability) ? '%' : null,
    available: true,
    source_system: 'zigbee2mqtt',
    source_instance: 'hubert-zigbee2mqtt',
    source_event_id: sourceEventId,
    author_system: authorSystem,
    event_type: 'observation',
  };
}

async function syncProfiles() {
  await Promise.all(Object.entries(profiles).map(async ([deviceId, profile]) => {
    try {
      profile.threshold = await readProfileThreshold(profile);
    } catch (error) {
      console.error(error.message || error);
    }
  }));
  const devices = Object.entries(profiles).map(([id, profile]) => ({
    id,
    name: profile.name,
    zoneId: profile.zoneId,
    zoneName: profile.zoneName,
    driverId: profile.driverId || (profile.type === 'watering_valve' ? 'zigbee2mqtt:SONOFF:SWV' : 'zigbee2mqtt:Arteco:ZS-304Z'),
    class: profile.type === 'watering_valve' ? 'valve' : 'sensor',
    available: true,
    capabilities: profile.capabilities || (profile.type === 'watering_valve' ? [
      'onoff', 'measure_water', 'meter_water', 'measure_battery', 'linkquality',
    ] : [
      'measure_soil_moisture', 'soil_warning_threshold', 'measure_temperature',
      'measure_humidity', 'measure_luminance', 'measure_battery', 'linkquality', 'alarm_water',
    ]),
    settings: profile.type === 'watering_valve'
      ? { wateringCircuit: profile.wateringCircuit }
      : { soil_warning: profile.threshold ?? null, soil_sampling: profile.samplingSeconds },
    sourceSystem: 'zigbee2mqtt',
  }));
  const signature = JSON.stringify(devices);
  if (signature === syncedProfilesSignature) return;
  await post('/api/sync/external-devices', { devices });
  syncedProfilesSignature = signature;
}

async function ingestCachedSensorState() {
  const states = JSON.parse(fs.readFileSync(ZIGBEE2MQTT_STATE_FILE, 'utf8'));
  for (const [deviceId, profile] of Object.entries(profiles)) {
    const state = cachedStateByIeee(states, deviceId);
    if (!state || !state.last_seen || !Number.isFinite(typeof state.last_seen === 'number' ? state.last_seen : Date.parse(state.last_seen))) continue;
    const ingest = profile.type === 'watering_valve' ? ingestValve : ingestSensor;
    await ingest(profile, deviceId, Buffer.from(JSON.stringify(state)));
  }
}

async function ingestSensor(profile, deviceId, raw) {
  const payload = JSON.parse(raw.toString());
  const timestamp = payload.last_seen || new Date().toISOString();
  const sourceEventId = `${deviceId}:${timestamp}`;
  const mappings = [
    ['soil_moisture', 'measure_soil_moisture'], ['temperature', 'measure_temperature'],
    ['humidity', 'measure_humidity'], ['illuminance', 'measure_luminance'], ['battery', 'measure_battery'],
    ['linkquality', 'linkquality'],
  ];
  const events = mappings
    .filter(([source]) => typeof payload[source] === 'number' && Number.isFinite(payload[source]))
    .map(([source, capability]) => toEvent(profile, deviceId, capability, Number(payload[source]), timestamp, `${sourceEventId}:${source}`));
  if (!profile.autoManual && Number.isInteger(profile.threshold)) {
    events.push(toEvent(profile, deviceId, 'soil_warning_threshold', profile.threshold, timestamp, `${sourceEventId}:threshold`, 'home_assistant'));
  }
  if (events.length > 0) enqueueIngest(events);
}

async function ingestSoftwareControl(profile, deviceId, payload) {
  if (!profile.autoManual) throw new Error(`${deviceId}: automatisk softwarealarm er ikke konfigureret.`);
  if (profile.controlUpdatedAt && Date.parse(payload.time) < Date.parse(profile.controlUpdatedAt)) return;
  const { events, state } = softwareControlEvents(profile, deviceId, payload);
  if (!events.length) return;
  enqueueIngest(events);
  profile.threshold = state.threshold;
  profile.controlState = state;
  profile.controlUpdatedAt = payload.time;
  persistProfiles();
  await syncProfiles();
}

async function ingestValve(profile, deviceId, raw) {
  const payload = JSON.parse(raw.toString());
  const timestamp = payload.last_seen || new Date().toISOString();
  const sourceEventId = `${deviceId}:${timestamp}`;
  const mappings = [
    ['state', 'onoff', (value) => String(value).toUpperCase() === 'ON'],
    ['flow', 'measure_water', Number],
    ['daily_irrigation_volume', 'meter_water', (value) => Number(value) / 1000],
    ['battery', 'measure_battery', Number],
    ['linkquality', 'linkquality', Number],
  ];
  const events = mappings
    .filter(([source]) => payload[source] !== undefined && Number.isFinite(Number(payload[source])) || source === 'state')
    .map(([source, capability, normalize]) => toEvent(profile, deviceId, capability, normalize(payload[source]), timestamp, `${sourceEventId}:${source}`));
  if (events.length > 0) enqueueIngest(events);
}

async function ingestAlarm(profile, deviceId, raw) {
  const value = raw.toString().trim().toLowerCase() === 'on';
  const timestamp = new Date().toISOString();
  enqueueIngest([toEvent(profile, deviceId, 'alarm_water', value, timestamp, `${deviceId}:${timestamp}:alarm`, 'home_assistant')]);
}

async function main() {
  loadQueue();
  let routes;
  try {
    routes = new ZigbeeIdentityRoutes(JSON.parse(fs.readFileSync(ZIGBEE_ROUTES_FILE, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    routes = new ZigbeeIdentityRoutes();
  }
  http.createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${INGEST_TOKEN}`) {
        response.writeHead(401).end();
        return;
      }
      const match = request.url.match(/^\/api\/soil-sensors\/([^/]+)\/threshold$/);
      if (request.method === 'POST' && request.url === '/api/watering-circuits/plan') {
        let body = '';
        for await (const chunk of request) body += chunk;
        const plan = await planWateringCircuit(JSON.parse(body || '{}').label);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...plan, yaml: undefined, automationsYaml: undefined }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/watering-circuits/apply') {
        let body = '';
        for await (const chunk of request) body += chunk;
        const result = await applyWateringCircuit(JSON.parse(body || '{}').label);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/watering-circuits/migrate') {
        let body = '';
        for await (const chunk of request) body += chunk;
        const parsed = JSON.parse(body || '{}');
        const result = await migrateWateringCircuit(parsed.label, parsed.confirm === true);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/watering-circuits/remove') {
        let body = '';
        for await (const chunk of request) body += chunk;
        const result = await removeWateringCircuit(JSON.parse(body || '{}').label, JSON.parse(body || '{}').confirm === true);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
        return;
      }
      const wateringMatch = request.url.match(/^\/api\/watering\/([^/]+)\/status$/);
      if (request.method === 'GET' && wateringMatch) {
        const status = await getWateringStatus(decodeURIComponent(wateringMatch[1]));
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(status));
        return;
      }
      if (request.method === 'POST' && request.url.match(/^\/api\/watering\/([^/]+)\/restart$/)) {
        const valveId = decodeURIComponent(request.url.match(/^\/api\/watering\/([^/]+)\/restart$/)[1]);
        const status = await restartWateringAfterError(valveId);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(status));
        return;
      }
      if (request.method === 'POST' && request.url.match(/^\/api\/watering\/([^/]+)\/forbidden$/)) {
        const valveId = decodeURIComponent(request.url.match(/^\/api\/watering\/([^/]+)\/forbidden$/)[1]);
        let body = '';
        for await (const chunk of request) body += chunk;
        const status = await setWateringForbidden(valveId, JSON.parse(body || '{}').value);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(status));
        return;
      }
      if (!match) {
        response.writeHead(404).end();
        return;
      }
      const deviceId = decodeURIComponent(match[1]);
      if (request.method === 'GET') {
        const profile = getProfileByDeviceId(deviceId);
        const value = await refreshProfileThreshold(profile, deviceId);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ value }));
        return;
      }
      if (request.method === 'POST') {
        let body = '';
        for await (const chunk of request) body += chunk;
        const value = await setProfileThreshold(deviceId, JSON.parse(body || '{}').value);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ value }));
        return;
      }
      response.writeHead(405).end();
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message || String(error) }));
    }
  }).listen(PORT);
  const client = mqtt.connect(MQTT_URL, { username: MQTT_USERNAME, password: MQTT_PASSWORD, reconnectPeriod: 5000 });
  let latestDevices = [];
  const provisioner = new SoilProvisioner({ profiles, ws: requestHomeAssistantWebSocket, request: requestHomeAssistant,
    readAutomations: () => YAML.parse(fs.readFileSync(HOME_ASSISTANT_AUTOMATIONS_FILE, 'utf8')) || [],
    persist: persistProfiles, onControl: (id, profile, payload) => ingestSoftwareControl(profile, id, payload), onChanged: syncProfiles });
  observeProfileTopics(client, {
    profiles,
    routes,
    onDevices(devices) { latestDevices = devices; refreshMetadata(); },
    onInventory(snapshot) {
      fs.mkdirSync(path.dirname(ZIGBEE_ROUTES_FILE), { recursive: true });
      fs.writeFileSync(`${ZIGBEE_ROUTES_FILE}.tmp`, `${JSON.stringify(snapshot)}\n`, 'utf8');
      fs.renameSync(`${ZIGBEE_ROUTES_FILE}.tmp`, ZIGBEE_ROUTES_FILE);
    },
    onObservation: (id, profile, payload) => profile.type === 'watering_valve' ? ingestValve(profile, id, payload) : ingestSensor(profile, id, payload),
    onAlarm: (id, profile, payload) => ingestAlarm(profile, id, payload),
    onControl: (id, profile, payload) => ingestSoftwareControl(profile, id, JSON.parse(payload.toString())),
    onError(error) {
      console.error(`Soil identity routing: ${error.message || error}`);
      if (error.code) process.exit(1);
    },
  });
  client.on('error', (error) => console.error(error.message || error));
  let syncingMetadata = false;
  let refreshRequested = false;
  async function refreshMetadata() {
    if (syncingMetadata) { refreshRequested = true; return; }
    syncingMetadata = true;
    try {
      if (await syncNamesFromHomeAssistant()) await syncProfiles();
      await provisioner.reconcile(latestDevices);
      await syncProfiles();
    } catch (error) { console.error(error.message || error); }
    finally {
      syncingMetadata = false;
      if (refreshRequested) { refreshRequested = false; setImmediate(refreshMetadata); }
    }
  }
  // HA metadata is optional for observations: cached profiles remain usable during outages.
  refreshMetadata();
  setInterval(refreshMetadata, 60000).unref();
  syncProfiles().catch((error) => console.error(error.message || error));
  ingestCachedSensorState().catch((error) => console.error(error.message || error));
  flushQueue().catch((error) => console.error(error.message || error));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
