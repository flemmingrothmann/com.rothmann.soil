'use strict';

/* eslint-disable max-len, object-curly-newline, prefer-destructuring, no-console */

const configs = [
  { flowName: 'Bregnebed vanding', valveId: '4458888e-351a-4de9-942e-4bd5dc2a8166', duration: 10, statusId: 'f6342e83-f3db-43ff-a6bf-f093c4fe6419', durationId: 'c039bc95-a2ec-422d-b856-cbc7f89cefb9' },
  { flowName: 'Drivhus Indenfor vanding', valveId: '274b89df-e8df-4738-b883-6e16ed130f18', duration: 5, statusId: '48dbc3dc-3f7b-43c0-983e-96d98c7bf068', durationId: '1b60974e-5c86-4153-b5e9-47028416c336' },
  { flowName: 'Drivhus Udenfor vanding', valveId: 'dd9484b5-332f-4fd7-8023-cad83cef0ad7', duration: 7, statusId: '17e6704d-cad8-411e-9cb6-5d988bcae687', durationId: '89873104-53af-4f3d-8564-4ca5498e3f0d' },
  { flowName: 'Husfacade vanding', valveId: 'fed1a6b4-7f4b-4831-9138-2200ba43a6f4', duration: 3, statusId: '270458dd-c376-4453-963c-28931e7dd262', durationId: 'e5025ab0-ad25-4a52-891a-e08ffb45e217' },
  { flowName: 'Nordhegn vanding', valveId: '6ef84586-a950-426d-b602-b14c15d00018', duration: 10, statusId: '691bb52c-30dc-458f-b9fe-36a46cbf7db2', durationId: '816ceb6f-91b4-48b4-a200-a4008f045e2c' },
  { flowName: 'Rhododendron vanding', valveId: '7116460a-e9fb-4589-8040-d1319aa3476c', duration: 10, statusId: '28a4db09-03fc-4cfc-a3ef-3cf41c4b23b0', durationId: 'fe16ef34-de30-4c89-800e-0e5a11387c55' },
  { flowName: 'Terasse vanding', valveId: 'd38e2468-f1ed-4b78-bdee-8d9d1f1229a8', duration: 4, statusId: '30f4030a-0def-4a75-b683-3c97d6a7c699', durationId: '239210e4-e8a5-4f96-8587-ee74ab8c80e9' },
  { flowName: 'Terassebed vanding', valveId: 'de4ddaad-4d8a-455b-9110-a86ca2126de6', duration: 10, statusId: 'e910d9ec-d9c0-45dc-9c30-3d71108d0f31', durationId: '3bc588f2-6ad6-4a07-b437-c628761e22f9' },
];

const DRY_RUN = process.argv.includes('--dry-run');
const HOMEY_URL = (process.env.HOMEY_URL || '').replace(/\/$/, '');
const HOMEY_TOKEN = process.env.HOMEY_TOKEN || '';

function statusCard(statusId, value, x, y) {
  return {
    ownerUri: 'homey:manager:logic',
    id: 'homey:manager:logic:variable_set_string',
    args: {
      variable: { id: statusId },
      value,
    },
    type: 'action',
    x,
    y,
    outputSuccess: [],
  };
}

function appendOutput(card, key) {
  card.outputSuccess ||= [];
  if (!card.outputSuccess.includes(key)) card.outputSuccess.push(key);
}

function getDirectCycleDelay(flow, onAction, duration) {
  const delayKey = (onAction.outputSuccess || []).find((key) => {
    const card = flow.cards[key];
    return card?.type === 'delay'
      || card?.id === 'homey:app:nl.fellownet.chronograph:timer_start_v2'
      || card?.id === 'homey:app:com.athom.homeyscript:runCodeWithArgReturnsNumber_v2';
  });
  const delay = flow.cards[delayKey];
  if (!delay) {
    throw new Error(`${flow.name}: missing physical cycle duration card after valve-on action`);
  }
  if (delay.type === 'delay' && (Number(delay.args?.delay?.number) !== duration || delay.args.delay.multiplier !== 60)) {
    throw new Error(`${flow.name}: unexpected physical cycle delay`);
  }
  return [delayKey, delay];
}

function getOpenTimerName(flow) {
  return `VAND ${flow.name.replace(/ vanding$/, '')} åbent`;
}

function getCardEntries(flow) {
  return Object.entries(flow.cards || {});
}

function requireCard(flow, predicate, description) {
  const entry = getCardEntries(flow).find(([, card]) => predicate(card));
  if (!entry) throw new Error(`${flow.name}: missing ${description}`);
  return entry;
}

function updateFlow(flow, config) {
  const onAction = requireCard(flow, (card) => card.type === 'action' && card.id === `homey:device:${config.valveId}:on`, 'valve-on action');
  const offAction = requireCard(flow, (card) => card.type === 'action' && card.id === `homey:device:${config.valveId}:off`, 'valve-off action');
  const inactive = requireCard(flow, (card) => card.id === 'homey:manager:logic:variable_set_boolean' && card.args?.value === false, 'Vanding Aktiv=false action');
  const completed = requireCard(flow, (card) => card.id === 'homey:manager:notifications:create_notification' && /Vanding er gennemført|stopper efter/.test(card.args?.text || ''), 'completion notification');
  const closeCheck = requireCard(flow, (card) => card.type === 'condition' && card.id === `homey:device:${config.valveId}:on`, 'valve-close check');
  const cycleDelay = getDirectCycleDelay(flow, onAction[1], config.duration);

  const cards = flow.cards;
  const keyPrefix = `dashboard-${config.valveId}`;
  const keys = {
    watering: `${keyPrefix}-watering`,
    closing: `${keyPrefix}-closing`,
    waiting: `${keyPrefix}-waiting`,
    closingError: `${keyPrefix}-closing-error`,
    cycleLimit: `${keyPrefix}-cycle-limit`,
    idle: `${keyPrefix}-idle`,
    durationFinished: `${keyPrefix}-duration-finished`,
  };

  cards[keys.watering] ||= statusCard(config.statusId, 'watering', 1900, 240);
  cards[keys.closing] ||= statusCard(config.statusId, 'closing', 1900, 420);
  cards[keys.waiting] ||= statusCard(config.statusId, 'waiting_result', 1900, 740);
  cards[keys.closingError] ||= statusCard(config.statusId, 'closing_error', 1900, 560);
  cards[keys.cycleLimit] ||= statusCard(config.statusId, 'cycle_limit', 1900, 1280);
  cards[keys.idle] ||= statusCard(config.statusId, 'idle', 1900, 940);

  appendOutput(onAction[1], keys.watering);
  appendOutput(offAction[1], keys.closing);
  appendOutput(inactive[1], keys.waiting);
  closeCheck[1].outputTrue ||= [];
  if (!closeCheck[1].outputTrue.includes(keys.closingError)) closeCheck[1].outputTrue.push(keys.closingError);
  appendOutput(completed[1], keys.idle);

  const cycleLimit = requireCard(flow,
    (card) => card.id === 'homey:manager:notifications:create_notification' && /stopper efter .*vandcyklusser/i.test(card.args?.text || ''),
    'cycle-limit notification');
  appendOutput(cycleLimit[1], keys.cycleLimit);

  const [delayKey] = cycleDelay;
  cards[delayKey] = {
    ownerUri: 'homey:app:nl.fellownet.chronograph',
    id: 'homey:app:nl.fellownet.chronograph:timer_start_v2',
    type: 'action',
    x: 1240,
    y: 340,
    args: {
      namedd: { name: getOpenTimerName(flow), description: 'New' },
      name: '',
      time: `[[homey:manager:logic|${config.durationId}]]`,
      unit: 'minutes',
    },
    outputSuccess: [],
  };
  cards[keys.durationFinished] ||= {
    ownerUri: 'homey:app:nl.fellownet.chronograph',
    id: 'homey:app:nl.fellownet.chronograph:timer_finished',
    type: 'trigger',
    x: 1480,
    y: 440,
    args: { namedd: { name: getOpenTimerName(flow), description: 'New' } },
    outputSuccess: [offAction[0]],
  };

  return {
    name: flow.name,
    durationTimerKey: delayKey,
    addedStatusCards: Object.values(keys),
  };
}

async function homeyRequest(pathname, options = {}) {
  const response = await fetch(`${HOMEY_URL}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${HOMEY_TOKEN}`,
      accept: 'application/json',
      ...options.headers,
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}: ${body || response.statusText}`);
  return body ? JSON.parse(body) : null;
}

async function main() {
  if (!HOMEY_URL || !HOMEY_TOKEN) throw new Error('HOMEY_URL and HOMEY_TOKEN must be configured');

  const flows = await homeyRequest('/api/manager/flow/advancedflow');
  const updates = [];

  for (const config of configs) {
    const flow = Object.values(flows).find((item) => item.name === config.flowName);
    if (!flow) throw new Error(`Missing flow: ${config.flowName}`);

    updates.push(updateFlow(flow, config));
    if (!DRY_RUN) {
      await homeyRequest(`/api/manager/flow/advancedflow/${encodeURIComponent(flow.id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(flow),
      });
    }
  }

  console.log(JSON.stringify({ dryRun: DRY_RUN, updates }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
