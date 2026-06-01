'use strict';

/* global document, window */
/* eslint-disable no-use-before-define */

const REFRESH_INTERVAL_MS = 15000;
const GRAPH_HISTORY_DAYS = 7;
const GRAPH_AXIS_WIDTH = 34;
const GRAPH_VALUE_HEIGHT = 126;
const GRAPH_VALUE_TOP = 6;
const GRAPH_BOTTOM = 132;
let nextRefreshAt = 0;
let refreshTimer = null;
let latestDashboard = null;
let graphDevices = [];
let activeView = 'soil';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function formatValue(value, suffix) {
  return typeof value === 'number' ? `${value.toLocaleString('da-DK')}${suffix}` : '-';
}

function formatDecimal(value, suffix, digits = 1) {
  return typeof value === 'number' ? `${value.toLocaleString('da-DK', { maximumFractionDigits: digits })}${suffix}` : '-';
}

function formatTime(value) {
  if (!value) return 'Aldrig';
  return new Date(value).toLocaleString('da-DK', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(minutes) {
  if (typeof minutes !== 'number') return '-';
  if (minutes < 60) return `${Math.round(minutes).toLocaleString('da-DK')} min`;

  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest > 0 ? `${hours} t ${rest} min` : `${hours} t`;
}

function formatMilliseconds(milliseconds) {
  return typeof milliseconds === 'number' ? formatDuration(milliseconds / 60000) : '-';
}

function formatZonePath(device) {
  const zonePath = Array.isArray(device.zonePath)
    ? device.zonePath
    : String(device.zonePathText || '').split(' / ');
  return zonePath.slice(-2).join(' / ');
}

function graphPath(history, width) {
  if (!history || history.length < 2) return '';

  const plotWidth = Math.max(1, width - GRAPH_AXIS_WIDTH);
  const maxT = Date.parse(latestDashboard?.generatedAt) || Date.now();
  const minT = maxT - (GRAPH_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const rangeT = Math.max(1, maxT - minT);
  const visibleHistory = history.filter((point) => point.t >= minT && point.t <= maxT);

  if (visibleHistory.length < 2) return '';

  return visibleHistory.map((point, index) => {
    const x = GRAPH_AXIS_WIDTH + (((point.t - minT) / rangeT) * plotWidth);
    const y = GRAPH_VALUE_HEIGHT - ((Math.max(0, Math.min(100, point.v)) / 100) * GRAPH_VALUE_HEIGHT) + GRAPH_VALUE_TOP;
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
}

function thresholdY(device) {
  if (typeof device.values.alarmThreshold !== 'number') return null;
  return GRAPH_VALUE_HEIGHT - ((Math.max(0, Math.min(100, device.values.alarmThreshold)) / 100) * GRAPH_VALUE_HEIGHT) + GRAPH_VALUE_TOP;
}

function renderLevelLines(width) {
  return [25, 50, 75, 100].map((level) => {
    const y = GRAPH_VALUE_HEIGHT - ((level / 100) * GRAPH_VALUE_HEIGHT) + GRAPH_VALUE_TOP;
    return `<path d="M${GRAPH_AXIS_WIDTH} ${y.toFixed(1)}H${width}" stroke="rgba(102,112,133,0.16)" stroke-width="1" />`;
  }).join('');
}

function renderDayMarkers(history, width) {
  if (!history || history.length < 2) return '';

  const plotWidth = Math.max(1, width - GRAPH_AXIS_WIDTH);
  const maxT = Date.parse(latestDashboard?.generatedAt) || Date.now();
  const minT = maxT - (GRAPH_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const rangeT = Math.max(1, maxT - minT);
  const date = new Date(minT);
  const markers = [];

  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 1);

  while (date.getTime() < maxT) {
    const x = GRAPH_AXIS_WIDTH + (((date.getTime() - minT) / rangeT) * plotWidth);
    const label = date.toLocaleDateString('da-DK', { weekday: 'short' });
    markers.push(`<path d="M${x.toFixed(1)} ${GRAPH_VALUE_TOP}V134" stroke="rgba(102,112,133,0.22)" />`);
    markers.push(`<text x="${Math.min(width - 20, x + 3).toFixed(1)}" y="132" fill="#667085" font-size="10" font-weight="700">${label}</text>`);
    date.setDate(date.getDate() + 1);
  }

  return markers.join('');
}

function buildGraph(device, width) {
  const path = graphPath(device.history, width);
  if (!path) return '<p class="graph-empty">Trend vises efter mindst to rapporter.</p>';

  const alarmY = thresholdY(device);
  const alarmLine = alarmY === null ? '' : `<path d="M${GRAPH_AXIS_WIDTH} ${alarmY.toFixed(1)}H${width}" stroke="#c94b32" stroke-dasharray="5 5" stroke-width="2" />`;

  return `<svg class="graph" viewBox="0 0 ${width} 138" role="img" aria-label="7 dages trend">
    <path d="M${GRAPH_AXIS_WIDTH} 134H${width}" stroke="rgba(76,122,69,0.22)" />
    ${renderLevelLines(width)}
    ${renderDayMarkers(device.history, width)}
    ${alarmLine}
    <path d="${path}" fill="none" stroke="#4c7a45" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
  </svg><span class="graph-label" style="top:${GRAPH_VALUE_TOP + 2}px">100%</span><span class="graph-label" style="top:${GRAPH_BOTTOM - 5}px">0%</span>`;
}

function renderGraphs() {
  document.querySelectorAll('.graph-host').forEach((host) => {
    const device = graphDevices[Number(host.dataset.graphIndex)];
    const width = Math.max(280, Math.round(host.clientWidth));
    host.innerHTML = buildGraph(device, width);
  });
}

function flattenDevices(data) {
  return data.zones.reduce((result, zone) => result.concat(zone.devices), []);
}

function renderSensor(device, showZoneInCard = true) {
  const graphIndex = graphDevices.push(device) - 1;
  const alarmStats = device.waterAlarmStats || { monthlyActivations: 0, periodDays: 30, zoneTopScorer: false };
  let state = 'Offline';
  let statusClass = 'offline';
  let statusMarkup = '';

  if (device.values.waterAlarm) {
    state = 'Vandalarm';
    statusClass = 'action';
  } else if (device.live) {
    state = 'OK';
    statusClass = 'ok';
  }

  const alarmCountMarkup = `<span class="alarm-count">${alarmStats.monthlyActivations} vandalarmer / ${alarmStats.periodDays} dage</span>`;
  const topScorerMarkup = alarmStats.zoneTopScorer ? '<span class="topscorer">Topscorer i zonen</span>' : '';
  const alarmStatsMarkup = `<div class="alarm-stats">${alarmCountMarkup}${topScorerMarkup}</div>`;

  statusMarkup = device.live && !device.values.waterAlarm
    ? '<span class="live-dot">OK</span>'
    : `<span class="badge ${statusClass}">${state}</span>`;

  const cardClass = `sensor${device.needsAction ? ' action' : ''}${!device.live ? ' offline' : ''}`;

  return `<article class="${cardClass}">
    <div class="topline">
      <div>
        ${showZoneInCard ? `<div class="zone">${escapeHtml(formatZonePath(device))}</div>` : ''}
        <div class="name">${escapeHtml(device.name)}</div>
        ${alarmStatsMarkup}
      </div>
      ${statusMarkup}
    </div>
    <div class="moisture">
      <strong>${formatValue(device.values.soilMoisture, '')}</strong><span>% jordfugt</span>
      <span class="threshold-inline">Grænse ${formatValue(device.values.alarmThreshold, '%')}</span>
    </div>
    <div class="facts">
      <div class="fact"><strong>${formatValue(device.values.temperature, ' °C')}</strong>Temperatur</div>
      <div class="fact"><strong>${formatValue(device.values.luminance, ' lx')}</strong>Luminans</div>
      <div class="fact"><strong>${formatTime(device.lastReportedAt)}</strong>Sidst set</div>
    </div>
    <div class="graph-host" data-graph-index="${graphIndex}"></div>
  </article>`;
}

function updateRefreshNote() {
  const element = document.getElementById('next-refresh');
  if (!nextRefreshAt) {
    element.textContent = 'Auto-refresh aktiv';
    return;
  }

  const seconds = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
  element.textContent = `Opdaterer automatisk om ${seconds} sek.`;
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);

  nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
  updateRefreshNote();
  refreshTimer = setInterval(() => {
    if (Date.now() >= nextRefreshAt) {
      loadActiveView();
      return;
    }
    updateRefreshNote();
  }, 1000);
}

function setActiveTab() {
  document.getElementById('soil-tab').classList.toggle('active', activeView === 'soil');
  document.getElementById('watering-tab').classList.toggle('active', activeView === 'watering');
}

function setSummaryLabels(deviceLabel, alarmLabel, offlineLabel) {
  document.getElementById('total-devices-label').textContent = deviceLabel;
  document.getElementById('total-alarms-label').textContent = alarmLabel;
  document.getElementById('total-offline-label').textContent = offlineLabel;
}

function renderSection(title, devices) {
  if (devices.length === 0) return '';
  return `<section><h2 class="section-title">${title}</h2><div class="grid">${devices.map((device) => renderSensor(device, true)).join('')}</div></section>`;
}

function renderOkSensorsByZone(devices) {
  if (devices.length === 0) return '';

  const zones = devices.reduce((result, device) => {
    const zoneKey = device.zonePathText || 'Ukendt zone';
    if (!result[zoneKey]) {
      result[zoneKey] = [];
    }
    result[zoneKey].push(device);
    return result;
  }, {});

  return `<section><h2 class="section-title">OK sensorer</h2>${Object.entries(zones).map(([zonePath, zoneDevices]) => (
    `<h3 class="zone-title">${escapeHtml(formatZonePath({ zonePathText: zonePath }))}</h3>`
      + `<div class="grid">${zoneDevices.map((device) => renderSensor(device, false)).join('')}</div>`
  )).join('')}</section>`;
}

function renderSoilDashboard(data) {
  latestDashboard = data;
  graphDevices = [];
  setActiveTab();
  setSummaryLabels('Sensorer', 'Kræver handling', 'Offline');
  const devices = flattenDevices(data);
  const waterAlarmDevices = devices.filter((device) => device.values.waterAlarm);
  const offlineDevices = devices.filter((device) => !device.values.waterAlarm && !device.live);
  const normalDevices = devices.filter((device) => !device.needsAction);

  document.getElementById('total-devices').textContent = data.totals.devices;
  document.getElementById('total-alarms').textContent = data.totals.alarms;
  document.getElementById('total-offline').textContent = data.totals.offline;
  document.getElementById('updated').textContent = `Opdateret ${new Date(data.generatedAt).toLocaleString('da-DK')}`;

  const content = document.getElementById('content');
  if (devices.length === 0) {
    content.innerHTML = document.getElementById('empty-template').innerHTML;
    return;
  }

  content.innerHTML = renderSection('Vandalarmer', waterAlarmDevices)
    + renderSection('Offline sensorer', offlineDevices)
    + renderOkSensorsByZone(normalDevices);
  renderGraphs();
}

function maxDailyWater(valve) {
  return Math.max(1, ...valve.history.days.map((day) => day.waterLiters || 0));
}

function renderWaterDay(day, maxWater) {
  const height = Math.max(4, Math.round(((day.waterLiters || 0) / maxWater) * 72));
  return `<div class="water-day" title="${escapeHtml(day.label)}: ${formatDecimal(day.waterLiters, ' L')}">
    <span class="water-bar" style="height:${height}px"></span>
    <small>${escapeHtml(day.label.split(' ')[0])}</small>
  </div>`;
}

function renderWaterBars(valve) {
  const maxWater = maxDailyWater(valve);
  return `<div class="water-bars" aria-label="Vandforbrug seneste 14 dage">
    ${valve.history.days.map((day) => renderWaterDay(day, maxWater)).join('')}
  </div>`;
}

function renderSessions(valve) {
  if (valve.recentSessions.length === 0) {
    return '<p class="sessions-empty">Ingen vandinger i de seneste 14 dage.</p>';
  }

  return `<ol class="sessions">
    ${valve.recentSessions.map((session) => `<li>
      <strong>${formatTime(session.startedAt)}</strong>
      <span>${formatDuration(session.durationMinutes)}${session.active ? ' · aktiv nu' : ''}</span>
    </li>`).join('')}
  </ol>`;
}

function renderWateringFlow(valve) {
  if (!valve.wateringFlow) return '';

  const { timer, timerName, name } = valve.wateringFlow;
  const timerLine = timerName
    ? `<span>Timer: ${escapeHtml(timerName)}${timer?.running ? ` · ${formatMilliseconds(timer.remainingMs)} tilbage` : ''}</span>`
    : '<span>Ingen timer fundet</span>';
  const active = timer?.running ? '<strong>Vandingsforløb i gang</strong>' : '<strong>Flow koblet</strong>';

  return `<div class="watering-flow${timer?.running ? ' active' : ''}">
    ${active}
    <span>Flow: ${escapeHtml(name)}</span>
    ${timerLine}
  </div>`;
}

function renderWateringValve(valve) {
  let status = '<span class="live-dot">Lukket</span>';
  if (valve.on) {
    status = '<span class="badge ok">Ventil åben</span>';
  } else if (valve.wateringActive) {
    status = '<span class="badge ok">Afventer</span>';
  }
  const error = valve.error ? `<p class="valve-error">Insights-fejl: ${escapeHtml(valve.error)}</p>` : '';
  const automationError = valve.automationError ? `<p class="valve-error">Flow-fejl: ${escapeHtml(valve.automationError)}</p>` : '';

  return `<article class="sensor valve${valve.wateringActive ? ' active' : ''}${valve.error ? ' offline' : ''}">
    <div class="topline">
      <div>
        <div class="zone">${escapeHtml(formatZonePath(valve))}</div>
        <div class="name">${escapeHtml(valve.name)}</div>
      </div>
      ${status}
    </div>
    <div class="moisture water-total">
      <strong>${formatDecimal(valve.totals.waterLiters, '')}</strong><span>L på 14 dage</span>
    </div>
    <div class="facts">
      <div class="fact"><strong>${valve.totals.sessions.toLocaleString('da-DK')}</strong>Vandinger</div>
      <div class="fact"><strong>${formatDuration(valve.totals.minutes)}</strong>Varighed</div>
      <div class="fact"><strong>${formatTime(valve.lastSession?.startedAt)}</strong>Senest</div>
      <div class="fact"><strong>${formatDecimal(valve.currentFlowLitersPerMinute, ' L/min')}</strong>Flow nu</div>
      <div class="fact"><strong>${formatDecimal(valve.currentMeterM3, ' m³', 3)}</strong>Måler</div>
      <div class="fact"><strong>${formatValue(valve.battery, '%')}</strong>Batteri</div>
    </div>
    ${renderWateringFlow(valve)}
    ${renderWaterBars(valve)}
    <h3 class="sessions-title">Seneste vandinger</h3>
    ${renderSessions(valve)}
    ${error}
    ${automationError}
  </article>`;
}

function renderWateringDashboard(data) {
  latestDashboard = null;
  graphDevices = [];
  setActiveTab();
  setSummaryLabels('Ventiler', 'Aktive', 'Liter / 14 dage');

  document.getElementById('total-devices').textContent = data.totals.valves;
  document.getElementById('total-alarms').textContent = data.totals.active;
  document.getElementById('total-offline').textContent = data.totals.waterLiters.toLocaleString('da-DK', { maximumFractionDigits: 1 });
  document.getElementById('updated').textContent = `Vanding opdateret ${new Date(data.generatedAt).toLocaleString('da-DK')}`;

  const content = document.getElementById('content');
  if (data.valves.length === 0) {
    content.innerHTML = '<section class="empty">Ingen vandingsventiler fundet.</section>';
    return;
  }

  const errors = data.totals.errors > 0 ? `<section class="error">${data.totals.errors} ventil(er) kunne ikke hente fuld Insights-historik.</section>` : '';
  content.innerHTML = `${errors}<section><h2 class="section-title">Vandingsventiler</h2><div class="grid">${data.valves.map(renderWateringValve).join('')}</div></section>`;
}

function renderState(state) {
  const card = document.getElementById('watering-mode-card');
  const title = document.getElementById('watering-mode-title');
  const button = document.getElementById('watering-mode-toggle');

  card.classList.toggle('forbidden', state.wateringForbidden === true);
  button.setAttribute('aria-pressed', state.wateringForbidden ? 'true' : 'false');
  title.textContent = state.wateringForbidden ? 'Vanding forbudt' : 'Vanding tilladt';
  button.setAttribute('aria-label', state.wateringForbidden ? 'Slå vanding tilladt til' : 'Slå vanding forbudt til');
}

async function loadState() {
  const response = await fetch('/api/state', { cache: 'no-store' });
  const state = await response.json();
  if (!response.ok) throw new Error(state.error || response.statusText);
  renderState(state);
}

async function toggleWateringMode() {
  const button = document.getElementById('watering-mode-toggle');
  button.disabled = true;

  try {
    const response = await fetch('/api/state/toggle-watering-forbidden', {
      method: 'POST',
      cache: 'no-store',
    });
    const state = await response.json();
    if (!response.ok) throw new Error(state.error || response.statusText);
    renderState(state);
  } finally {
    button.disabled = false;
  }
}

async function loadDashboard() {
  const refresh = document.getElementById('refresh');
  refresh.disabled = true;
  activeView = 'soil';

  try {
    const response = await fetch('/api/dashboard', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    await loadState();
    renderSoilDashboard(data);
    scheduleRefresh();
  } catch (error) {
    document.getElementById('content').innerHTML = `<section class="error">Kunne ikke hente jordstatus: ${escapeHtml(error.message || error)}</section>`;
    scheduleRefresh();
  } finally {
    refresh.disabled = false;
  }
}

async function loadWateringDashboard() {
  const refresh = document.getElementById('refresh');
  refresh.disabled = true;
  activeView = 'watering';

  try {
    const response = await fetch('/api/watering-dashboard', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    await loadState();
    renderWateringDashboard(data);
    scheduleRefresh();
  } catch (error) {
    document.getElementById('content').innerHTML = `<section class="error">Kunne ikke hente vandingsstatus: ${escapeHtml(error.message || error)}</section>`;
    scheduleRefresh();
  } finally {
    refresh.disabled = false;
  }
}

function loadActiveView() {
  if (activeView === 'watering') {
    loadWateringDashboard();
    return;
  }

  loadDashboard();
}

document.getElementById('refresh').addEventListener('click', loadActiveView);
document.getElementById('soil-tab').addEventListener('click', loadDashboard);
document.getElementById('watering-tab').addEventListener('click', loadWateringDashboard);
document.getElementById('watering-mode-card').addEventListener('click', () => {
  const button = document.getElementById('watering-mode-toggle');
  if (button.disabled) return;
  toggleWateringMode();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    loadActiveView();
  }
});
window.addEventListener('resize', () => {
  if (!latestDashboard) return;
  renderGraphs();
});
loadDashboard();
