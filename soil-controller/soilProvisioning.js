'use strict';

const { normalizeIeee } = require('./zigbeeIdentity');
const MANUAL_BLUEPRINT = 'wingman/manual-soil-moisture-alarm.yaml';
const DEFAULT_THRESHOLD = 25;

function featuresOf(device) {
  const features = [];
  function visit(feature) {
    if (feature.property && (feature.access & 1)) features.push(feature);
    if (!feature.property) (feature.features || []).forEach(visit);
  }
  (device.definition?.exposes || []).forEach(visit);
  return features;
}

function candidates(inventory, devices, entities, profiles) {
  return inventory.flatMap((device) => {
    const ieee = normalizeIeee(device.ieee_address);
    if (!ieee || !featuresOf(device).some((feature) => feature.property === 'soil_moisture')) return [];
    if (profiles[ieee] && !profiles[ieee].autoManual) return [];
    const matches = devices.filter((entry) => (entry.identifiers || []).some(([domain, id]) => domain === 'mqtt' && id.toLowerCase() === `zigbee2mqtt_${ieee}`));
    if (matches.length !== 1 || (matches[0].labels || []).includes('wingman_ignore')) return [];
    const haDevice = matches[0];
    const sensors = entities.filter((entry) => entry.device_id === haDevice.id && entry.platform === 'mqtt' && !entry.disabled_by
      && entry.unique_id === `${ieee}_soil_moisture_zigbee2mqtt` && !(entry.labels || []).includes('wingman_ignore'));
    if (sensors.length !== 1) return [];
    return [{ ieee, device, haDevice, sensor: sensors[0] }];
  });
}

function existingManual(candidate, automations, profile) {
  const matches = automations.filter((automation) => automation.use_blueprint?.path === MANUAL_BLUEPRINT && (
    automation.id === profile?.automationId || automation.use_blueprint.input?.moisture_sensor === candidate.sensor.entity_id
    || String(automation.use_blueprint.input?.moisture_sensor).toLowerCase().includes(candidate.ieee)
  ));
  if (matches.length > 1) throw new Error(`${candidate.ieee}: flere manuelle jordfugtautomatikker; vælg én i HA.`);
  return matches[0] || null;
}

function softwareControlEvents(profile, id, payload) {
  const threshold = payload.threshold;
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 90 || typeof payload.alarm !== 'boolean' || !Number.isFinite(Date.parse(payload.time)))
    throw new Error(`${id}: ugyldig HA jordfugtstatus.`);
  const events = [];
  for (const [key, capability, value, unit] of [['threshold', 'soil_warning_threshold', threshold, '%'], ['alarm', 'alarm_water', payload.alarm, null]]) {
    if (profile.controlState?.[key] === value) continue;
    events.push({ time: payload.time, homey_device_id: id, homey_zone_id: profile.zoneId, device_name: profile.name,
      driver_id: profile.driverId, device_class: 'sensor', capability, value, unit, available: true,
      source_system: 'home_assistant', source_instance: 'hubert-home-assistant', author_system: 'home_assistant',
      event_type: 'observation', source_event_id: `${id}:${payload.time}:${capability}` });
  }
  return { events, state: { threshold, alarm: payload.alarm } };
}

class SoilProvisioner {
  constructor({ profiles, ws, request, readAutomations, persist, onControl, onChanged, log = console.error }) {
    Object.assign(this, { profiles, ws, request, readAutomations, persist, onControl, onChanged, log });
  }

  async service(domain, action, body) {
    return this.request(`/api/services/${domain}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  async ensureHelper(domain, key, name, fields, initial, explicit, snapshot) {
    const existing = snapshot.entities.find((entity) => entity.platform === domain && entity.unique_id === key);
    const entityId = explicit || existing?.entity_id || `${domain}.${key}`;
    if (snapshot.states.has(entityId)) return entityId;
    if (explicit || existing) throw new Error(`${entityId}: helper utilgængelig; eksisterende indstilling nulstilles ikke.`);
    const definitions = await this.ws(`${domain}/list`);
    if (definitions.some((definition) => definition.id === key)) throw new Error(`${entityId}: afventer indlæsning af helper.`);
    const created = await this.ws(`${domain}/create`, { name: key, ...fields });
    if (created.id !== key) throw new Error(`${entityId}: uventet helper-identitet ${created.id}.`);
    await this.ws(`${domain}/update`, { [`${domain}_id`]: key, ...fields, name });
    if (domain === 'input_number') await this.service(domain, 'set_value', { entity_id: entityId, value: initial });
    else if (domain === 'input_boolean' && initial) await this.service(domain, 'turn_on', { entity_id: entityId });
    else if (domain === 'input_datetime') await this.service(domain, 'set_datetime', { entity_id: entityId, datetime: initial });
    const state = await this.request(`/api/states/${entityId}`);
    snapshot.states.set(entityId, state);
    return entityId;
  }

  async reconcile(inventory) {
    if (!inventory.length) return;
    const [devices, entities, areas, stateList] = await Promise.all([
      this.ws('config/device_registry/list'), this.ws('config/entity_registry/list'), this.ws('config/area_registry/list'), this.request('/api/states'),
    ]);
    const snapshot = { entities, states: new Map(stateList.map((state) => [state.entity_id, state])) };
    const automations = this.readAutomations();
    let reload = false;
    const activate = [];
    let changed = false;
    for (const candidate of candidates(inventory, devices, entities, this.profiles)) {
      try {
        const { ieee, device, haDevice, sensor } = candidate;
        // Explicit watering/alarm owners are never silently converted to manual watering.
        if (automations.some((automation) => automation.use_blueprint?.path === 'wingman/soil-moisture-alarm.yaml'
          && automation.use_blueprint.input?.moisture_sensor === sensor.entity_id)) continue;
        const prior = this.profiles[ieee];
        const existing = existingManual(candidate, automations, prior);
        const inputs = existing?.use_blueprint.input || {};
        const oldSensor = inputs.moisture_sensor;
        const key = `soil_${ieee}`;
        const notificationKey = inputs.notification_key || prior?.notificationKey || (oldSensor ? oldSensor.replaceAll('.', '_') : `ieee_${ieee.slice(2)}`);
        const notificationId = `manual_soil_alarm_${notificationKey}`;
        const name = haDevice.name_by_user || haDevice.name || device.friendly_name;
        const notifications = prior ? [] : await this.ws('persistent_notification/get');
        const threshold = await this.ensureHelper('input_number', `${key}_threshold`, `${name} jordfugtgrænse`,
          { min: 0, max: 90, step: 1, unit_of_measurement: '%', mode: 'box' }, inputs.threshold ?? DEFAULT_THRESHOLD,
          inputs.threshold_helper || prior?.haThresholdEntity, snapshot);
        const alarm = await this.ensureHelper('input_boolean', `${key}_water_alarm`, `${name} vandalarm`, { icon: 'mdi:water-alert' },
          notifications.some((notification) => notification.notification_id === notificationId), inputs.water_alarm || prior?.haAlarmEntity, snapshot);
        await this.ensureHelper('input_datetime', `${notificationId}_last_push`, `${name} seneste vandingspush`, { has_date: true, has_time: true },
          '2000-01-01 00:00:00', undefined, snapshot);
        const controlTopic = inputs.control_topic || prior?.controlTopic || `homeassistant/soil/${ieee}/control`;
        if (!controlTopic.startsWith('homeassistant/soil/') || /[+#]/.test(controlTopic)) throw new Error(`${ieee}: ugyldigt status-topic.`);
        const config = existing ? structuredClone(existing) : { id: `manual_soil_${ieee}`, alias: `${name} jordfugt alarm`, use_blueprint: { path: MANUAL_BLUEPRINT, input: { plant_name: '' } } };
        config.id = String(config.id);
        Object.assign(config.use_blueprint.input, { moisture_sensor: sensor.entity_id, threshold_helper: threshold, water_alarm: alarm,
          control_topic: controlTopic, notification_key: notificationKey });
        if (!existing || JSON.stringify(config) !== JSON.stringify(existing)) {
          await this.request(`/api/config/automation/config/${config.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) });
          reload = true;
          const was = stateList.find((state) => state.entity_id.startsWith('automation.') && state.attributes?.id === config.id);
          activate.push({ id: config.id, enabled: was?.state !== 'off' });
        }
        const featureNames = new Set(featuresOf(device).map((feature) => feature.property));
        const capabilities = [['soil_moisture', 'measure_soil_moisture'], ['temperature', 'measure_temperature'], ['humidity', 'measure_humidity'],
          ['illuminance', 'measure_luminance'], ['battery', 'measure_battery'], ['linkquality', 'linkquality']]
          .filter(([property]) => featureNames.has(property)).map(([, capability]) => capability).concat(['soil_warning_threshold', 'alarm_water']);
        const area = areas.find((entry) => entry.area_id === (sensor.area_id || haDevice.area_id));
        const profile = { ...prior, autoManual: true, name, haDeviceId: haDevice.id, zoneId: area?.area_id || 'ha_unassigned', zoneName: area?.name || 'Uplaceret',
          haMoistureEntity: sensor.entity_id, haThresholdEntity: threshold, haAlarmEntity: alarm, controlTopic, notificationKey, automationId: config.id,
          driverId: `zigbee2mqtt:${device.definition.vendor}:${device.definition.model}`, capabilities };
        if (JSON.stringify(profile) !== JSON.stringify(prior)) { this.profiles[ieee] = profile; changed = true; }
        const thresholdReading = snapshot.states.get(threshold);
        const alarmReading = snapshot.states.get(alarm);
        const thresholdState = thresholdReading?.state;
        const alarmState = alarmReading?.state;
        const timestamps = [thresholdReading?.last_updated, alarmReading?.last_updated].map(Date.parse).filter(Number.isFinite);
        const controlTime = timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : new Date().toISOString();
        if (!['unknown', 'unavailable', undefined].includes(thresholdState) && ['on', 'off'].includes(alarmState))
          await this.onControl(ieee, this.profiles[ieee], { threshold: Number(thresholdState), alarm: alarmState === 'on', time: controlTime });
      } catch (error) { this.log(`Soil setup: ${error.message || error}`); }
    }
    if (changed) this.persist();
    if (changed) await this.onChanged();
    if (reload) {
      await this.service('automation', 'reload', {});
      const states = await this.request('/api/states');
      for (const item of activate) {
        const entity = states.find((state) => state.entity_id.startsWith('automation.') && state.attributes?.id === item.id);
        if (!entity) throw new Error(`${item.id}: automation blev ikke indlæst.`);
        if (!item.enabled) await this.service('automation', 'turn_off', { entity_id: entity.entity_id, stop_actions: true });
        else await this.service('automation', 'trigger', { entity_id: entity.entity_id, skip_condition: false });
      }
    }
  }
}

module.exports = { DEFAULT_THRESHOLD, MANUAL_BLUEPRINT, featuresOf, candidates, existingManual, softwareControlEvents, SoilProvisioner };
