'use strict';

function soilDisplayName(device, haDevice, ieee) {
  return haDevice.name_by_user || device.friendly_name || haDevice.name || ieee;
}

function nameChange({
  current, original, desired, previous, legacy,
}) {
  if (previous && original !== previous.original && original !== previous.name && original !== desired) {
    // A helper/automation renamed in its own editor must supersede our display override.
    return current === previous.name ? { name: null, record: previous } : null;
  }
  if (current !== desired && current !== previous?.name && !(!previous && legacy.includes(current))) return null;
  return { name: desired, record: { name: desired, original } };
}

async function syncSoilNames({
  ieee, device, haDevice, profile, automation, snapshot, ws,
}) {
  const display = soilDisplayName(device, haDevice, ieee);
  const prefixes = [...new Set([ieee, device.friendly_name, haDevice.name, haDevice.name_by_user, profile.name,
    automation?.use_blueprint?.input?.plant_name].filter(Boolean))];
  const automationEntity = automation && snapshot.entities.find((entity) => entity.platform === 'automation'
    && String(entity.unique_id) === String(automation.id));
  const inputs = automation?.use_blueprint?.input || {};
  const notificationKey = profile.notificationKey || inputs.notification_key || `ieee_${ieee.slice(2)}`;
  const roles = [
    [profile.haThresholdEntity || inputs.threshold_helper || `input_number.soil_${ieee}_threshold`, 'jordfugtgrænse'],
    [profile.haAlarmEntity || inputs.water_alarm || `input_boolean.soil_${ieee}_water_alarm`, 'vandalarm'],
    [`input_datetime.manual_soil_alarm_${notificationKey}_last_push`, 'seneste vandingspush'],
    [automationEntity?.entity_id, 'jordfugt alarm'],
  ];
  let changed = false;
  for (const [entityId, suffix] of roles) {
    if (!entityId) continue;
    const entity = snapshot.entities.find((entry) => entry.entity_id === entityId);
    if (!entity) continue; // Never recreate a deleted helper/automation just to name it.
    const domain = entityId.split('.')[0];
    if (entity.platform !== domain) continue;
    if (domain !== 'automation' && !String(entity.unique_id).toLowerCase().includes(ieee.slice(2))) continue;
    const original = entity.original_name || (domain === 'automation' ? automation.alias : snapshot.states.get(entityId)?.attributes?.friendly_name);
    if (!original) continue;
    const current = entity.name || original;
    const desired = `${display} ${suffix}`;
    const previous = profile.managedSoilNames?.[entityId];
    const suffixes = suffix === 'jordfugt alarm' ? [suffix, 'jordfugtalarm'] : [suffix];
    const legacy = prefixes.flatMap((prefix) => suffixes.map((ending) => `${prefix} ${ending}`));
    let change = nameChange({
      current, original, desired, previous, legacy,
    });
    if (!change) continue;
    if ((change.name === null && entity.name) || (change.name !== null && current !== change.name)) {
      // Re-read immediately before writing so an intervening user rename wins.
      const latest = await ws('config/entity_registry/get', { entity_id: entityId });
      const latestOriginal = latest.original_name || original;
      change = nameChange({
        current: latest.name || latestOriginal, original: latestOriginal, desired, previous, legacy,
      });
      if (!change) continue;
      if ((change.name === null && latest.name) || (change.name !== null && (latest.name || latestOriginal) !== change.name)) {
        await ws('config/entity_registry/update', { entity_id: entityId, name: change.name });
      }
    }
    if (JSON.stringify(previous) !== JSON.stringify(change.record)) {
      profile.managedSoilNames = { ...profile.managedSoilNames, [entityId]: change.record };
      changed = true;
    }
  }
  return changed;
}

module.exports = { soilDisplayName, nameChange, syncSoilNames };
