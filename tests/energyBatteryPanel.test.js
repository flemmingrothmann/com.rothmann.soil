'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function renderer() {
  const source = fs.readFileSync(path.join(__dirname, '../dashboard/public/app.js'), 'utf8');
  const startup = source.indexOf("\ndocument.getElementById('refresh')");
  assert.ok(startup > 0, 'Expected frontend event wiring boundary');
  const elements = new Map();
  const context = vm.createContext({
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { innerHTML: '', closest: () => ({}) });
      return elements.get(id);
    } },
  });
  vm.runInContext(source.slice(0, startup), context);
  for (const name of ['setActiveTab', 'setDashboardTitle', 'setSummaryThirdCardVisible', 'setSummaryLabels', 'setUpdatedAt',
    'renderEnergyPeriodNavigation', 'renderTimingGauge', 'renderEnergyChart', 'renderHourPatternChart']) context[name] = () => '';
  return { context, elements };
}

test('energy view actually includes the battery simulation and state-of-charge figures', () => {
  const { context, elements } = renderer();
  context.renderEnergyDashboard({ label: 'I dag', totals: { kwh: 10, costDkk: 20, timingEffectDkk: 1, actualDkkPerKwh: 2, neutralDkkPerKwh: 2.1 },
    battery: { actualCost: 20, simulatedCost: 15, savingsDkk: 5, savingsPercent: 25, solarChargeKwh: 2, gridChargeKwh: 3,
      dischargeKwh: 4, initialSoc: 8, finalSoc: 4, revision: 1 } });
  const html = elements.get('content').innerHTML;
  assert.match(html, /Batteri-simulering/);
  assert.match(html, /Betalt med batteri/);
  assert.match(html, /Start SoC/);
  assert.match(html, /50 %/);
  assert.match(html, /25 %/);
  assert.doesNotMatch(html, /NaN|undefined/);
});

test('absent battery data does not render an empty simulation panel', () => {
  const { context } = renderer();
  assert.equal(context.renderBatteryPanel(undefined), '');
});
