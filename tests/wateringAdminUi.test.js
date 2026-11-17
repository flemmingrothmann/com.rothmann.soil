'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function page(data, responseError) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        innerHTML: '', hidden: false, textContent: '', scrollIntoView() {},
      });
    }
    return elements.get(id);
  };
  const calls = [];
  const context = vm.createContext({
    activeView: 'circuits',
    document: { getElementById: element, querySelectorAll: () => [] },
    escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;'),
    setActiveView(view) {
      context.activeView = view;
    },
    setActiveTab() {},
    setDashboardTitle() {},
    setSummaryThirdCardVisible() {},
    setSummaryLabels() {},
    setUpdatedAt() {},
    scheduleRefresh() {},
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: !responseError, statusText: 'Bad request', json: async () => (responseError ? { error: responseError } : data) };
    },
  });
  const source = fs.readFileSync(require.resolve('../dashboard/public/app.js'), 'utf8');
  const start = source.indexOf('let wateringCircuitData =');
  const end = source.indexOf('function renderContactSensor(', start);
  vm.runInContext(`${source.slice(start, end)}\nthis.api = { loadWateringCircuitPage, editWateringCircuit, renderWateringCircuitConfirmation, planWateringCircuit, removeWateringCircuit, saveWateringCircuit };`, context);
  return {
    api: context.api, elements, element, calls, context,
  };
}

const data = {
  circuits: [{
    id: 'circuit1',
    name: 'Terrassepotter',
    valve: { entityId: 'switch.valve', name: 'Ventil', area: 'Terrasse' },
    sensors: [{
      entityId: 'sensor.soil', name: 'Efeu - T-1', area: 'Værelse', available: true,
    }],
    editable: true,
    warnings: [],
    forbidden: true,
    enabled: true,
    status: 'idle',
  }],
  valves: [{
    entityId: 'switch.valve', name: 'Ventil', area: 'Terrasse', available: true,
  }],
  sensors: [{
    entityId: 'sensor.soil', name: 'Efeu - T-1', area: 'Værelse', available: true,
  }],
};

test('administration shows actual circuit, valve, current HA sensor name/area and CRUD actions', async () => {
  const p = page(data); await p.api.loadWateringCircuitPage();
  const html = p.element('content').innerHTML;
  for (const text of ['Terrassepotter', 'Ventil', 'Efeu - T-1', 'Værelse', 'Opret vandingskreds', 'Redigér kreds', 'Fjern kreds', 'Vanding forbudt']) assert.ok(html.includes(text), text);
  assert.equal(p.calls[0].url, '/api/watering-circuits');
  assert.equal(html.includes('watering-circuit-label'), false);
});

test('editor chooses physical devices instead of asking for a technical label', async () => {
  const p = page(data); await p.api.loadWateringCircuitPage(); p.api.editWateringCircuit('circuit1');
  const html = p.element('watering-circuit-editor').innerHTML;
  assert.match(html, /name="valve"/); assert.match(html, /name="sensors"/);
  assert.match(html, /checked/); assert.match(html, /selected/); assert.match(html, /Kontrollér ændring/);
  assert.equal(html.includes('readonly'), false);
});

test('HA names and API errors are escaped; error text is taken from the API response', async () => {
  const unsafe = JSON.parse(JSON.stringify(data)); unsafe.circuits[0].name = '<img onerror="bad()">';
  const p = page(unsafe); await p.api.loadWateringCircuitPage();
  assert.match(p.element('content').innerHTML, /&lt;img/);
  assert.equal(p.element('content').innerHTML.includes('<img'), false);
  const failure = page(null, 'HA siger: <utilgængelig>'); await failure.api.loadWateringCircuitPage();
  assert.match(failure.element('content').innerHTML, /HA siger: &lt;utilgængelig&gt;/);
});

test('removal only requests a read-only preview until the user explicitly confirms', async () => {
  const plan = {
    name: 'Terrasse', valve: { name: 'Ventil' }, sensors: [], removed: [], effects: ['Historik bevares.'], deleting: true, revision: 'abc',
  };
  const p = page(plan); await p.api.removeWateringCircuit('circuit1');
  assert.equal(p.calls.length, 1); assert.equal(p.calls[0].url, '/api/watering-circuits/preview');
  assert.equal(JSON.parse(p.calls[0].options.body).deleting, true);
  assert.match(p.element('watering-circuit-result').innerHTML, /Ja, fjern kredsen/);
  assert.match(p.element('watering-circuit-result').innerHTML, /Historik bevares/);
});

test('empty and ambiguous/orphan circuits remain visible instead of silently disappearing', async () => {
  const p = page({ circuits: [], valves: [], sensors: [] }); await p.api.loadWateringCircuitPage();
  assert.match(p.element('content').innerHTML, /endnu ingen HA-vandingskredse/);
  const orphan = JSON.parse(JSON.stringify(data)); orphan.circuits[0].editable = false; orphan.circuits[0].warnings = ['HA-automation mangler.'];
  const q = page(orphan); await q.api.loadWateringCircuitPage();
  assert.match(q.element('content').innerHTML, /HA-automation mangler/);
  assert.match(q.element('content').innerHTML, /disabled/);
});

test('an unavailable valve is explained before confirmation and the save button stays disabled', () => {
  const p = page(data);
  p.api.renderWateringCircuitConfirmation({
    name: 'Terrasse', valve: { name: 'Ventil' }, sensors: [], removed: [], effects: [], blockers: ['Ventilen er utilgængelig.'],
  });
  const html = p.element('watering-circuit-result').innerHTML;
  assert.match(html, /kan ikke gemmes endnu/); assert.match(html, /Ventilen er utilgængelig/);
  assert.match(html, /data-watering-circuit-confirm disabled/);
});

test('removal offers an explicit physical dismantling assertion and gets a new read-only preview', async () => {
  const plan = {
    id: 'circuit1', name: 'Terrasse', valve: { name: 'Ventil' }, sensors: [], removed: [], effects: [], deleting: true, decommissioned: true, blockers: [], revision: 'new-revision',
  };
  const p = page(plan); await p.api.removeWateringCircuit('circuit1', true);
  assert.deepEqual(JSON.parse(p.calls[0].options.body), { id: 'circuit1', deleting: true, decommissioned: true });
  const html = p.element('watering-circuit-result').innerHTML;
  assert.match(html, /fysisk afmonteret og frakoblet vand/);
  assert.match(html, /data-watering-circuit-decommissioned checked/);
  assert.equal(html.includes('data-watering-circuit-confirm disabled'), false);
});
