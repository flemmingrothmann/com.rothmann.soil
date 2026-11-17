'use strict';

const crypto = require('node:crypto');
const { HomeAssistantCategories } = require('./haCategories');

const WATERING = 'wingman/labelled-pot-watering.yaml';
const ALARM = 'wingman/soil-moisture-alarm.yaml';
const MANUAL = 'wingman/manual-soil-moisture-alarm.yaml';
const clone = (value) => JSON.parse(JSON.stringify(value));
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ieeeOf = (device) => (device?.identifiers || []).find(([domain, id]) => domain === 'mqtt' && /^zigbee2mqtt_0x[0-9a-f]{16}$/i.test(id))?.[1].slice(12).toLowerCase();
const inputOf = (automation) => automation?.use_blueprint?.input || {};
const profileFields = ['wateringCircuit', 'generatedWatering', 'haWatering', 'haThresholdEntity', 'haAlarmEntity', 'alarmTopic', 'autoManual', 'wateringAdmin'];

function ownFields(profile) {
  return Object.fromEntries(profileFields.filter((key) => profile[key] !== undefined).map((key) => [key, clone(profile[key])]));
}

function profileRouting(profile) {
  const watering = profile.haWatering || {};
  return { ...ownFields(profile), haWatering: watering };
}

class WateringAdmin {
  constructor({
    profiles, ws, request, readAutomations, persist, backup, changed,
  }) {
    Object.assign(this, {
      profiles, ws, request, readAutomations, persist, backup, changed,
    });
    this.busy = false;
  }

  async snapshot() {
    const [devices, entities, areas, labels, states] = await Promise.all([
      this.ws('config/device_registry/list'), this.ws('config/entity_registry/list'),
      this.ws('config/area_registry/list'), this.ws('config/label_registry/list'), this.request('/api/states'),
    ]);
    const automations = await this.readAutomations();
    const stateById = new Map(states.map((state) => [state.entity_id, state]));
    const candidates = entities.flatMap((entity) => {
      if (entity.disabled_by || entity.entity_category) return [];
      const device = devices.find((entry) => entry.id === entity.device_id);
      const ieee = ieeeOf(device);
      if (!ieee || (device.labels || []).includes('wingman_ignore') || (entity.labels || []).includes('wingman_ignore')) return [];
      const profile = this.profiles[ieee];
      const state = stateById.get(entity.entity_id);
      let kind = null;
      if (entity.entity_id.startsWith('sensor.') && (entity.device_class || state?.attributes?.device_class) === 'moisture') kind = 'sensor';
      if (entity.entity_id.startsWith('switch.') && profile?.type === 'watering_valve' && !/child.?lock|auto.?close|led|alarm|settings/i.test(entity.entity_id)) kind = 'valve';
      if (!kind) return [];
      const area = areas.find((entry) => entry.area_id === (entity.area_id || device.area_id));
      return [{
        entityId: entity.entity_id,
        deviceId: device.id,
        ieee,
        kind,
        name: device.name_by_user || device.name || entity.name || entity.original_name || entity.entity_id,
        tag: device.name || ieee,
        area: area?.name || 'Uplaceret',
        available: !!state && !['unknown', 'unavailable'].includes(state.state),
        state: state?.state || 'unavailable',
      }];
    });
    const ambiguous = new Set(candidates.filter((c) => candidates.filter((other) => other.ieee === c.ieee && other.kind === c.kind).length > 1).map((c) => `${c.ieee}:${c.kind}`));
    const unambiguous = candidates.filter((c) => !ambiguous.has(`${c.ieee}:${c.kind}`));
    const byId = new Map(unambiguous.map((entry) => [entry.entityId, entry]));
    const waters = automations.filter((a) => a.use_blueprint?.path === WATERING);
    const alarms = automations.filter((a) => a.use_blueprint?.path === ALARM);
    const circuits = waters.map((automation) => {
      const inputs = inputOf(automation);
      const alarmEntities = Array.isArray(inputs.water_alarms) ? inputs.water_alarms : [];
      const label = labels.find((entry) => entry.label_id === inputs.watering_label || entry.name === inputs.watering_label);
      const valve = byId.get(inputs.valve) || { entityId: inputs.valve, name: stateById.get(inputs.valve)?.attributes?.friendly_name || inputs.valve, available: false };
      const sensorIds = alarmEntities.map((alarmId) => {
        const matches = alarms.filter((a) => inputOf(a).water_alarm === alarmId);
        return matches.length === 1 ? inputOf(matches[0]).moisture_sensor : null;
      });
      const sensors = sensorIds.map((id, index) => {
        if (byId.has(id)) return byId.get(id);
        const ieee = id?.match(/^sensor\.(0x[0-9a-f]{16})_soil_moisture$/)?.[1];
        return {
          entityId: id, ...(ieee && this.profiles[ieee] ? { ieee } : {}), name: this.profiles[ieee]?.name || id || alarmEntities[index], available: false,
        };
      });
      const profile = this.profiles[valve.ieee];
      const warnings = [];
      if (!label) warnings.push('Kredsens HA-label mangler.');
      if (!alarmEntities.length) warnings.push('Kredsen mangler jordfugtalarmer.');
      if (!valve.available) warnings.push('Ventilen er utilgængelig eller kan ikke identificeres sikkert.');
      if (sensors.some((sensor) => !sensor.available)) warnings.push('En eller flere sensorer er utilgængelige eller mangler alarmkobling.');
      if (profile?.generatedWatering && JSON.stringify([...(profile.generatedWatering.sensorEntities || [])].sort()) !== JSON.stringify([...sensorIds].sort())) warnings.push('Wingmans sensortilknytning afviger fra HA-automationen.');
      const status = stateById.get(inputs.lifecycle_status)?.state || 'unknown';
      const enabled = states.find((s) => s.entity_id.startsWith('automation.') && String(s.attributes?.id) === String(automation.id));
      return {
        id: String(automation.id),
        name: label?.name || automation.alias,
        labelId: label?.label_id || null,
        valve,
        sensors,
        status,
        forbidden: stateById.get(inputs.watering_forbidden)?.state !== 'off',
        enabled: enabled?.state === 'on',
        warnings,
        editable: !!automation.id && !!label && !!valve.ieee,
        automaticAlarmIds: alarms.filter((a) => alarmEntities.includes(inputOf(a).water_alarm)).map((a) => String(a.id)),
      };
    });
    // Stale profile ownership is visible even when HA has lost its automation.
    for (const [ieee, profile] of Object.entries(this.profiles)) {
      if (profile.type !== 'watering_valve' || !profile.wateringCircuit || circuits.some((c) => c.valve.ieee === ieee)) continue;
      const valve = candidates.find((entry) => entry.ieee === ieee && entry.kind === 'valve') || { ieee, name: profile.name, available: false };
      circuits.push({
        id: `orphan:${ieee}`,
        name: profile.wateringCircuit,
        valve,
        sensors: [],
        status: 'unknown',
        forbidden: true,
        enabled: false,
        editable: false,
        warnings: ['Wingman har en kredstilknytning, men den tilhørende HA-automation mangler. Ret koblingen i HA før kredsen ændres.'],
      });
    }
    return {
      devices, entities, labels, states, stateById, automations, candidates: unambiguous, circuits,
    };
  }

  async list() {
    const s = await this.snapshot();
    return {
      generatedAt: new Date().toISOString(), circuits: s.circuits, valves: s.candidates.filter((c) => c.kind === 'valve'), sensors: s.candidates.filter((c) => c.kind === 'sensor'),
    };
  }

  async preview(body, deleting = false) {
    if (body.decommissioned === true && !deleting) throw new Error('Afmontering kan kun bekræftes ved fjernelse af en kreds.');
    const decommissioned = deleting && body.decommissioned === true;
    const s = await this.snapshot();
    const existing = body.id ? s.circuits.find((c) => c.id === body.id) : null;
    if (deleting && !existing) throw new Error('Vælg en eksisterende kreds, der skal fjernes.');
    if (body.id && !existing) throw new Error('Kredsen findes ikke længere. Genindlæs oversigten.');
    if (existing && !existing.editable) throw new Error('Kredsens tilknytninger skal afklares i HA, før den kan ændres her.');
    const name = String(deleting ? existing?.name || '' : body.name || '').trim();
    if (!name || name.length > 60 || [...name].some((character) => character.charCodeAt(0) < 32)) throw new Error('Kredsnavnet skal være 1-60 tegn.');
    if (s.labels.some((label) => label.label_id !== existing?.labelId && label.name.toLowerCase() === name.toLowerCase())) throw new Error('Navnet bruges allerede af en HA-label. Vælg et andet kredsnavn.');
    const valveId = deleting ? existing.valve.entityId : body.valve;
    const valve = s.candidates.find((c) => c.entityId === valveId && c.kind === 'valve');
    if (!valve) throw new Error('Vælg en kendt vandventil.');
    const requested = deleting ? existing.sensors.map((c) => c.entityId).filter(Boolean) : body.sensors;
    if (!Array.isArray(requested) || (!deleting && !requested.length) || requested.length > 50 || new Set(requested).size !== requested.length) throw new Error('Vælg 1-50 forskellige jordfugtsensorer.');
    const sensors = deleting ? existing.sensors : requested.map((id) => {
      const sensor = s.candidates.find((c) => c.entityId === id && c.kind === 'sensor');
      if (!sensor) throw new Error(`Jordfugtsensoren ${id} kan ikke identificeres sikkert.`);
      return sensor;
    });
    for (const circuit of s.circuits.filter((c) => c.id !== existing?.id)) {
      if (circuit.valve.entityId === valveId || circuit.sensors.some((sensor) => requested.includes(sensor.entityId))) throw new Error(`En valgt enhed tilhører allerede kredsen ${circuit.name}. Fjern tilknytningen dér først.`);
    }
    for (const sensor of deleting ? [] : sensors) {
      const p = this.profiles[sensor.ieee];
      if (!p) throw new Error(`${sensor.name} afventer klargøring til Wingman. Prøv igen om et minut.`);
      if (p.wateringCircuit && !p.autoManual && (!existing || ![existing.name, this.profiles[existing.valve.ieee]?.wateringCircuit].includes(p.wateringCircuit))) throw new Error(`${sensor.name} er allerede tilknyttet ${p.wateringCircuit}.`);
      const owners = s.automations.filter((a) => a.use_blueprint?.path === ALARM && inputOf(a).moisture_sensor === sensor.entityId);
      if (owners.some((a) => !existing?.automaticAlarmIds.includes(String(a.id)))) throw new Error(`${sensor.name} har allerede en separat automatisk jordfugtalarm. Afklar den i HA først.`);
    }
    if (existing) {
      const shared = s.automations.some((a) => a.use_blueprint?.path === WATERING && String(a.id) !== existing.id
        && (inputOf(a).water_alarms || []).some((id) => inputOf(s.automations.find((a) => String(a.id) === existing.id)).water_alarms.includes(id)));
      if (shared) throw new Error('Kredsen deler jordfugtalarmer med en anden kreds. Afklar ejerskabet i HA først.');
    }
    const added = sensors.filter((sensor) => !existing?.sensors.some((old) => old.entityId === sensor.entityId));
    const removed = existing?.sensors.filter((sensor) => deleting || !requested.includes(sensor.entityId)) || [];
    if (existing) {
      const oldCircuit = this.profiles[existing.valve.ieee]?.wateringCircuit;
      for (const [ieee, profile] of Object.entries(this.profiles)) {
        if (profile.type === 'watering_valve' || !oldCircuit || profile.wateringCircuit !== oldCircuit || (!deleting && sensors.some((sensor) => sensor.ieee === ieee)) || removed.some((sensor) => sensor.ieee === ieee)) continue;
        removed.push({
          ieee, name: profile.name, entityId: profile.haMoistureEntity || null, available: false,
        });
      }
    }
    const revision = digest({
      deleting,
      decommissioned,
      existingId: existing?.id,
      name,
      valveId,
      requested,
      labels: s.labels,
      registry: s.entities.map((e) => [e.entity_id, e.device_id, e.labels, e.disabled_by]),
      devices: s.devices.map((d) => [d.id, d.labels]),
      automations: s.automations,
      profiles: Object.entries(this.profiles).map(([id, p]) => [id, profileRouting(p)]),
    });
    const blockers = [];
    try {
      this.assertIdle(s, decommissioned ? existing.id : null);
    } catch (error) {
      blockers.push(error.message);
    }
    if (!decommissioned && (!valve.available || valve.state !== 'off')) blockers.push('Ventilen skal være tilgængelig og lukket, før ændringen kan gemmes.');
    if (!deleting && sensors.some((sensor) => !sensor.available)) blockers.push('Alle valgte sensorer skal være tilgængelige, før ændringen kan gemmes.');
    const plan = {
      id: existing?.id || null,
      name,
      valve,
      sensors,
      added,
      removed,
      deleting,
      decommissioned,
      revision,
      blockers,
      effects: deleting ? ['Kredsens vandingsautomation og dens egne jordfugtalarmer fjernes.', 'Helpers, grænseværdier og historik bevares. Sensorer frigøres til manuel vanding.',
        ...(decommissioned ? ['Den afmonterede kreds fjernes uden kald til ventilen.'] : [])]
        : [existing ? 'Sensorvalget opdateres. Eksisterende grænser og vandingsindstillinger bevares.' : 'Kredsen oprettes med vanding forbudt. Aktivér den bagefter under Vanding.',
          ...(existing?.enabled && !existing.forbidden ? ['Kredsen kan genoptage automatisk vanding efter ændringen.'] : []),
          ...(existing && existing.valve.entityId !== valveId ? [`Ventilen skiftes fra ${existing.valve.name} til ${valve.name}. Den gamle ventil frigøres fra kredsen.`] : []),
          ...(added.some((sensor) => s.automations.some((a) => a.use_blueprint?.path === MANUAL && inputOf(a).moisture_sensor === sensor.entityId)) ? ['Manuelle vandingsalarmer for tilføjede sensorer sættes på pause.'] : []),
          ...(removed.length ? ['Fjernede sensorer frigøres til manuel vanding.'] : [])],
    };
    return { s, existing, plan };
  }

  assertIdle(s, decommissionedId = null) {
    // Reloading HA automations also interrupts other HA watering runs.
    for (const c of s.circuits) {
      if (c.id === decommissionedId) {
        const automation = s.states.find((state) => state.entity_id.startsWith('automation.') && String(state.attributes?.id) === c.id);
        if (automation?.state !== 'off' || Number(automation.attributes?.current || 0) !== 0) throw new Error('Slå kredsens vandingsautomation fra i HA, før den afmonterede kreds fjernes.');
        if (c.valve.available && c.valve.state !== 'off') throw new Error('Ventilen melder stadig åben. Luk den, før kredsen fjernes.');
        continue;
      }
      if (!c.valve.available || c.valve.state !== 'off' || !['idle', 'cycle_limit'].includes(c.status)) throw new Error(`Kan ikke ændre kredse, mens ${c.name} vander, afventer et forløb eller ikke kan bekræftes lukket.`);
    }
    if (s.stateById.get('input_boolean.ha_watering_capacity_busy')?.state === 'on') throw new Error('Den fælles vandingskapacitet er optaget. Vent til vandingsforløbet er afsluttet.');
    if (s.states.some((state) => state.entity_id.startsWith('automation.') && Number(state.attributes?.current) > 0
      && s.automations.some((a) => a.use_blueprint?.path === WATERING && String(a.id) === String(state.attributes?.id)))) throw new Error('Et automatisk vandingsforløb kører stadig. Vent til det er afsluttet.');
  }

  async commit(body, deleting = false) {
    if (this.busy) throw new Error('En kredsændring er allerede i gang. Vent og prøv igen.');
    if (body.confirm !== true || typeof body.revision !== 'string') throw new Error('Kontrollér ændringen og bekræft den først.');
    this.busy = true;
    const undo = [];
    const safetyGates = new Set();
    const originalGates = new Map();
    const originalAutomationStates = new Map();
    let committed = false;
    try {
      const { s, existing, plan } = await this.preview(body, deleting);
      if (body.revision !== plan.revision) throw new Error('Opsætningen er ændret siden forhåndsvisningen. Kontrollér igen.');
      const decommissionedId = plan.decommissioned ? existing.id : null;
      this.assertIdle(s, decommissionedId);
      if (!plan.decommissioned && (!plan.valve.available || plan.valve.state !== 'off')) throw new Error('Ventilen skal være tilgængelig og lukket.');
      if (!deleting && plan.sensors.some((sensor) => !sensor.available)) throw new Error('Alle valgte sensorer skal være tilgængelige, før kredsen gemmes.');
      await this.backup({ automations: s.automations, labels: s.labels, profiles: this.profiles });
      const service = (domain, action, data) => this.request(`/api/services/${domain}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
      const categories = new HomeAssistantCategories({ ws: this.ws, name: 'Vandingskredse', undo });
      // HA reload is global: freeze every circuit, then check for a run that raced the initial check.
      for (const automation of s.automations.filter((a) => a.use_blueprint?.path === WATERING)) {
        if (String(automation.id) === decommissionedId) continue; // Already disabled; an offline gate is not needed for dismantling.
        const gate = inputOf(automation).watering_forbidden;
        const value = s.stateById.get(gate)?.state;
        if (!['on', 'off'].includes(value)) throw new Error('En kreds mangler en læsbar vanding-forbudt helper.');
        if (originalGates.has(gate)) continue;
        originalGates.set(gate, value); safetyGates.add(gate);
        await service('input_boolean', 'turn_on', { entity_id: gate });
      }
      this.assertIdle(await this.snapshot(), decommissionedId);
      const configPath = (id) => `/api/config/automation/config/${encodeURIComponent(id)}`;
      const desiredAutomationStates = new Map();
      const rememberAutomationState = (id) => {
        const state = s.states.find((entry) => entry.entity_id.startsWith('automation.') && String(entry.attributes?.id) === String(id));
        if (state && !originalAutomationStates.has(state.entity_id)) originalAutomationStates.set(state.entity_id, state.state === 'on');
        return state;
      };
      const writeAutomation = async (config) => {
        const old = s.automations.find((a) => String(a.id) === String(config.id));
        const oldState = rememberAutomationState(config.id);
        desiredAutomationStates.set(String(config.id), old ? oldState?.state === 'on' : true);
        undo.push(() => this.request(configPath(config.id), { method: old ? 'POST' : 'DELETE', headers: { 'content-type': 'application/json' }, ...(old ? { body: JSON.stringify(old) } : {}) }));
        await this.request(configPath(config.id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) });
      };
      const deleteAutomation = async (id) => {
        const old = s.automations.find((a) => String(a.id) === String(id));
        if (!old) return;
        rememberAutomationState(id);
        undo.push(() => this.request(configPath(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(old) }));
        await this.request(configPath(id), { method: 'DELETE' });
      };
      const record = existing ? this.profiles[existing.valve.ieee]?.wateringAdmin : null;
      const key = record?.key || `watering_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      let labelId = existing?.labelId;
      if (!labelId) {
        const label = await this.ws('config/label_registry/create', { name: plan.name });
        labelId = label.label_id;
        undo.push(() => this.ws('config/label_registry/delete', { label_id: labelId }));
      } else if (!deleting && existing.name !== plan.name) {
        undo.push(() => this.ws('config/label_registry/update', { label_id: labelId, name: existing.name }));
        await this.ws('config/label_registry/update', { label_id: labelId, name: plan.name });
      }
      const original = existing ? s.automations.find((a) => String(a.id) === existing.id) : null;
      const oldInputs = inputOf(original);
      const stateValue = (id) => s.stateById.get(id)?.state;
      const ensureHelper = async (domain, suffix, name, fields, value, previous) => {
        if (previous) {
          if (!s.stateById.has(previous) || ['unknown', 'unavailable'].includes(stateValue(previous))) throw new Error(`Helperen ${previous} er utilgængelig. Intet nulstilles.`);
          return previous;
        }
        const id = `${key}_${suffix}`;
        const created = await this.ws(`${domain}/create`, { name: id, ...fields });
        undo.push(() => this.ws(`${domain}/delete`, { [`${domain}_id`]: created.id }));
        if (created.id !== id) throw new Error('HA tildelte en uventet helper-identitet.');
        await this.ws(`${domain}/update`, { [`${domain}_id`]: id, ...fields, name });
        const eid = `${domain}.${id}`;
        if (domain === 'input_number') await service(domain, 'set_value', { entity_id: eid, value });
        if (domain === 'input_boolean' && value) await service(domain, 'turn_on', { entity_id: eid });
        return eid;
      };
      const oldProfileFields = new Map();
      const rememberProfile = (ieee) => {
        if (!oldProfileFields.has(ieee)) oldProfileFields.set(ieee, ownFields(this.profiles[ieee]));
      };
      undo.push(async () => {
        for (const [ieee, fields] of oldProfileFields) {
          for (const field of profileFields) delete this.profiles[ieee][field];
          Object.assign(this.profiles[ieee], fields);
        }
        await this.persist();
      });
      const manualState = (a) => s.states.find((state) => state.entity_id.startsWith('automation.') && String(state.attributes?.id) === String(a.id));
      const setManualEnabled = async (automation, enabled) => {
        const state = manualState(automation);
        if (!state) throw new Error(`Alarmen ${automation.alias} er ikke indlæst i HA.`);
        rememberAutomationState(automation.id);
        desiredAutomationStates.set(String(automation.id), enabled);
        undo.push(() => service('automation', state.state === 'on' ? 'turn_on' : 'turn_off', { entity_id: state.entity_id, ...(state.state === 'off' ? { stop_actions: true } : {}) }));
        await service('automation', enabled ? 'turn_on' : 'turn_off', { entity_id: state.entity_id, ...(!enabled ? { stop_actions: true } : {}) });
      };
      const releaseSensor = async (sensor) => {
        const profile = this.profiles[sensor.ieee];
        if (!profile) throw new Error(`Sensoren ${sensor.name} mangler en profil.`);
        rememberProfile(sensor.ieee);
        const previous = record?.sensors?.find((entry) => entry.ieee === sensor.ieee);
        for (const field of ['wateringCircuit', 'generatedWatering', 'alarmTopic', 'wateringAdmin']) delete profile[field];
        if (previous?.manual) {
          const manual = s.automations.find((a) => String(a.id) === previous.manual.id);
          if (!manual) throw new Error(`Den oprindelige manuelle alarm for ${sensor.name} mangler.`);
          profile.autoManual = true;
          profile.haThresholdEntity = inputOf(manual).threshold_helper;
          profile.haAlarmEntity = inputOf(manual).water_alarm;
          await setManualEnabled(manual, previous.manual.enabled);
        } else {
          delete profile.autoManual;
          const automatic = s.automations.find((a) => a.use_blueprint?.path === ALARM && inputOf(a).moisture_sensor === sensor.entityId);
          if (automatic) {
            profile.haThresholdEntity = inputOf(automatic).threshold;
            profile.haAlarmEntity = inputOf(automatic).water_alarm;
          }
          // Provisioning can create a manual alarm after the automatic owner is gone.
          profile.autoManual = true;
        }
      };
      let waterInputs;
      const sensorRecords = [];
      const alarmConfigs = [];
      if (!deleting) {
        for (const sensor of plan.sensors) {
          const prior = record?.sensors?.find((entry) => entry.ieee === sensor.ieee);
          const automatic = s.automations.find((a) => a.use_blueprint?.path === ALARM && inputOf(a).moisture_sensor === sensor.entityId);
          const manual = s.automations.filter((a) => a.use_blueprint?.path === MANUAL && inputOf(a).moisture_sensor === sensor.entityId);
          if (manual.length > 1) throw new Error(`${sensor.name} har flere manuelle alarmer. Afklar dem i HA.`);
          const source = automatic ? inputOf(automatic) : inputOf(manual[0]);
          const profile = this.profiles[sensor.ieee];
          const sourceThreshold = source.threshold_helper || (typeof source.threshold === 'string' ? source.threshold : null) || profile.haThresholdEntity;
          const suffix = sensor.ieee.slice(2);
          const threshold = await ensureHelper('input_number', `${suffix}_threshold`, `${sensor.tag} jordfugtgrænse`, {
            min: 0, max: 90, step: 1, mode: 'box', unit_of_measurement: '%',
          }, 25, sourceThreshold);
          const alarm = await ensureHelper('input_boolean', `${suffix}_alarm`, `${sensor.tag} vandalarm`, { icon: 'mdi:water-alert' }, false, source.water_alarm);
          await categories.assign(threshold, 'helpers');
          await categories.assign(alarm, 'helpers');
          const topic = automatic ? source.alarm_topic : `homeassistant/soil/${key}/${sensor.ieee}/alarm`;
          const id = automatic ? String(automatic.id) : `${key}_${suffix}_alarm`;
          alarmConfigs.push({
            ...automatic,
            id,
            alias: `${sensor.tag} jordfugtalarm til automatisk vandingskreds`,
            description: 'Danner vandingsbehov for den tilknyttede kreds. Sensorens navn og område vedligeholdes i HA.',
            use_blueprint: {
              path: ALARM,
              input: {
                moisture_sensor: sensor.entityId, threshold, water_alarm: alarm, alarm_topic: topic,
              },
            },
          });
          let manualRecord = prior?.manual;
          if (manual[0] && !manualRecord) manualRecord = { id: String(manual[0].id), enabled: manualState(manual[0])?.state === 'on' };
          if (manual[0]) await setManualEnabled(manual[0], false);
          sensorRecords.push({
            ieee: sensor.ieee, entityId: sensor.entityId, alarmId: id, threshold, alarm, topic, ...(manualRecord ? { manual: manualRecord } : {}),
          });
        }
        const settings = {
          cycle_duration: ['input_number', 'cycle_duration', 'cyklusvarighed', {
            min: 1, max: 30, step: 1, unit_of_measurement: 'min',
          }, 1],
          pause_duration: ['input_number', 'pause_duration', 'pause', {
            min: 1, max: 120, step: 1, unit_of_measurement: 'min',
          }, 10],
          maximum_cycles: ['input_number', 'maximum_cycles', 'maks cyklusser', { min: 1, max: 100, step: 1 }, 3],
          cycle_number: ['input_number', 'cycle_number', 'cyklusnummer', { min: 0, max: 100, step: 1 }, 0],
          watering_error: ['input_boolean', 'error', 'vandingsfejl', {}, false],
          watering_forbidden: ['input_boolean', 'forbidden', 'vanding forbudt', {}, true],
          lifecycle_status: ['input_select', 'status', 'vandingsstatus', { options: ['idle', 'watering', 'waiting_result', 'waiting_capacity', 'cycle_limit'] }, null],
        };
        waterInputs = {
          watering_label: labelId,
          valve: plan.valve.entityId,
          water_alarms: sensorRecords.map((r) => r.alarm),
          capacity_busy: oldInputs.capacity_busy || 'input_boolean.ha_watering_capacity_busy',
          capacity_acquire: oldInputs.capacity_acquire || 'script.ha_watering_capacity_acquire',
        };
        for (const field of ['capacity_busy', 'capacity_acquire']) {
          if (!s.stateById.has(waterInputs[field]) || stateValue(waterInputs[field]) === 'unavailable') throw new Error('Den fælles HA-vandingskapacitet mangler. Opret den i HA først.');
        }
        for (const [field, [domain, suffix, title, fields, value]] of Object.entries(settings)) {
          waterInputs[field] = await ensureHelper(domain, suffix, `${plan.name} ${title}`, fields, value, oldInputs[field]);
          await categories.assign(waterInputs[field], 'helpers');
        }
        if (waterInputs.capacity_busy === 'input_boolean.ha_watering_capacity_busy') await categories.assign(waterInputs.capacity_busy, 'helpers');
        if (waterInputs.capacity_acquire === 'script.ha_watering_capacity_acquire') await categories.assign(waterInputs.capacity_acquire, 'script');
        for (const config of alarmConfigs) await writeAutomation(config);
        safetyGates.add(waterInputs.watering_forbidden);
        await writeAutomation({
          ...original,
          id: existing?.id || key,
          alias: `${plan.name} automatisk vanding`,
          description: 'Vander den valgte kreds ud fra dens jordfugtalarmer. Enheder, områder og grænser vedligeholdes i HA.',
          use_blueprint: { path: WATERING, input: waterInputs },
        });
      }
      const keepAlarmIds = alarmConfigs.map((a) => String(a.id));
      for (const id of existing?.automaticAlarmIds || []) if (deleting || !keepAlarmIds.includes(id)) await deleteAutomation(id);
      if (deleting) await deleteAutomation(existing.id);
      for (const sensor of plan.removed.filter((entry) => entry.ieee)) await releaseSensor(sensor);
      // Move this label to explicit measurement/valve entities; never label config switches.
      const desired = deleting ? [] : [plan.valve.entityId, ...plan.sensors.map((sensor) => sensor.entityId)];
      for (const device of s.devices.filter((d) => (d.labels || []).includes(labelId))) {
        undo.push(() => this.ws('config/device_registry/update', { device_id: device.id, labels: device.labels }));
        await this.ws('config/device_registry/update', { device_id: device.id, labels: device.labels.filter((id) => id !== labelId) });
      }
      for (const entity of s.entities.filter((e) => (e.labels || []).includes(labelId) || desired.includes(e.entity_id))) {
        const labels = (entity.labels || []).filter((id) => id !== labelId);
        if (desired.includes(entity.entity_id)) labels.push(labelId);
        undo.push(() => this.ws('config/entity_registry/update', { entity_id: entity.entity_id, labels: entity.labels || [] }));
        await this.ws('config/entity_registry/update', { entity_id: entity.entity_id, labels });
      }
      const valveProfile = this.profiles[plan.valve.ieee];
      rememberProfile(plan.valve.ieee);
      if (existing && existing.valve.ieee !== plan.valve.ieee) {
        rememberProfile(existing.valve.ieee);
        const previousValve = this.profiles[existing.valve.ieee];
        for (const field of ['wateringCircuit', 'generatedWatering', 'haWatering', 'wateringAdmin']) delete previousValve[field];
      }
      if (deleting) {
        for (const field of ['wateringCircuit', 'generatedWatering', 'haWatering', 'wateringAdmin']) delete valveProfile[field];
      } else {
        valveProfile.wateringCircuit = plan.name;
        valveProfile.wateringAdmin = {
          key, automationId: existing?.id || key, labelId, sensors: sensorRecords,
        };
        valveProfile.generatedWatering = { ...valveProfile.generatedWatering, valveEntity: plan.valve.entityId, sensorEntities: plan.sensors.map((sensor) => sensor.entityId) };
        valveProfile.haWatering = Object.fromEntries(Object.entries({
          cycleDurationEntity: 'cycle_duration', pauseDurationEntity: 'pause_duration', maximumCyclesEntity: 'maximum_cycles', cycleNumberEntity: 'cycle_number', statusEntity: 'lifecycle_status', errorEntity: 'watering_error', forbiddenEntity: 'watering_forbidden',
        }).map(([key, field]) => [key, waterInputs[field]]));
        for (const sensor of sensorRecords) {
          rememberProfile(sensor.ieee);
          const profile = this.profiles[sensor.ieee];
          profile.autoManual = false; profile.wateringCircuit = plan.name;
          profile.haThresholdEntity = sensor.threshold; profile.haAlarmEntity = sensor.alarm; profile.alarmTopic = sensor.topic;
          profile.generatedWatering = { ...profile.generatedWatering, administration: 'ha-ui' };
        }
      }
      await this.persist();
      await service('automation', 'reload', {});
      const verified = await this.snapshot();
      if (deleting ? verified.circuits.some((c) => c.id === existing.id) : !verified.circuits.some((c) => c.id === (existing?.id || key) && c.sensors.length === plan.sensors.length)) throw new Error('Kredsen kunne ikke verificeres efter HA-genindlæsning.');
      for (const [id, enabled] of desiredAutomationStates) {
        const state = verified.states.find((entry) => entry.entity_id.startsWith('automation.') && String(entry.attributes?.id) === id);
        if (!state) throw new Error('En kredsautomation er ikke indlæst i HA.');
        if ((state.state === 'on') !== enabled) await service('automation', enabled ? 'turn_on' : 'turn_off', { entity_id: state.entity_id, ...(!enabled ? { stop_actions: true } : {}) });
      }
      if (!deleting) {
        for (const id of [...keepAlarmIds, existing?.id || key]) {
          const loaded = verified.states.find((state) => state.entity_id.startsWith('automation.') && String(state.attributes?.id) === id);
          if (!loaded) throw new Error('En kredsautomation er ikke indlæst i HA.');
          await categories.assign(loaded.entity_id, 'automation');
          if (id !== (existing?.id || key) && desiredAutomationStates.get(id)) await service('automation', 'trigger', { entity_id: loaded.entity_id, skip_condition: false });
        }
      }
      // A transient Wingman sync failure must not roll a completed HA transaction back.
      await this.changed().catch(() => {});
      committed = true;
      for (const [gate, value] of originalGates) {
        if (deleting && gate === oldInputs.watering_forbidden) continue;
        if (value === 'off') await service('input_boolean', 'turn_off', { entity_id: gate });
      }
      return { saved: !deleting, removed: deleting, name: plan.name };
    } catch (error) {
      if (committed) throw new Error(`Kredsændringen er gemt, men vanding-forbudt kunne ikke gendannes fuldt ud. Kontrollér kredsenes indstillinger i HA. ${error.message}`);
      const failures = [];
      for (const restore of undo.reverse()) {
        try {
          await restore();
        } catch (rollbackError) {
          failures.push(rollbackError.message);
        }
      }
      if (undo.length) {
        try {
          await this.request('/api/services/automation/reload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        } catch (reloadError) {
          failures.push(reloadError.message);
        }
      }
      for (const [entityId, enabled] of originalAutomationStates) {
        try {
          await this.request(`/api/services/automation/${enabled ? 'turn_on' : 'turn_off'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entity_id: entityId, ...(!enabled ? { stop_actions: true } : {}) }) });
        } catch (stateError) {
          failures.push(stateError.message);
        }
      }
      if (!failures.length) {
        for (const [gate, value] of originalGates) {
          try {
            await this.request(`/api/services/input_boolean/${value === 'on' ? 'turn_on' : 'turn_off'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entity_id: gate }) });
          } catch (gateError) {
            failures.push(gateError.message); break;
          }
        }
      }
      if (failures.length) {
        for (const gate of safetyGates) await this.request('/api/services/input_boolean/turn_on', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entity_id: gate }) }).catch(() => {});
      }
      throw new Error(`${error.message}${failures.length ? ' Gendannelse er ikke fuldført; kontrollér HA før vanding tillades.' : ''}`);
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { WateringAdmin, ieeeOf };
