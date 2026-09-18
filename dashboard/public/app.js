'use strict';

/* global document, window */
/* eslint-disable no-use-before-define */

const REFRESH_INTERVAL_MS_BY_VIEW = {
  home: 3000,
  soil: 3000,
  watering: 10000,
  circuits: 0,
  contact: 3000,
  motion: 3000,
  lights: 3000,
  replay: 3000,
  energy: 5 * 60 * 1000,
  vehicle: 5 * 60 * 1000,
};
const GRAPH_HISTORY_DAYS = 7;
const GRAPH_AXIS_WIDTH = 34;
const GRAPH_VALUE_HEIGHT = 126;
const GRAPH_VALUE_TOP = 6;
const GRAPH_BOTTOM = 132;
const SOIL_THRESHOLD_MIN = 0;
const SOIL_THRESHOLD_MAX = 90;
const ENERGY_PERIOD_LABELS = {
  day: 'Dag',
  '3days': '3 dage',
  week: 'Uge',
  month: 'Måned',
  billing: 'Faktura',
};
const VIEWS = ['home', 'soil', 'watering', 'circuits', 'contact', 'motion', 'lights', 'replay', 'energy', 'vehicle'];
let nextRefreshAt = 0;
let refreshTimer = null;
let latestDashboard = null;
let graphDevices = [];
let activeView = 'home';
let intervalDialogValveId = null;
const wateringDurationOverrides = new Map();
const wateringMaxCycleOverrides = new Map();
const wateringErrorOverrides = new Map();
let activeEnergyPeriod = 'day';
let activeEnergyPeriodOffset = 0;
let thresholdDialogDeviceId = null;
let replayConfigDirty = false;
let replayRunning = false;

function getViewHash(view) {
  return view === 'home' ? '' : `#${view}`;
}

function getViewFromHash() {
  const view = window.location.hash.replace(/^#/, '');
  return VIEWS.includes(view) ? view : 'home';
}

function setActiveView(view, updateHash = true) {
  activeView = view;

  if (!updateHash) return;

  const nextUrl = `${window.location.pathname}${window.location.search}${getViewHash(view)}`;
  window.history.replaceState(null, '', nextUrl);
}

function setRefreshDisabled(disabled) {
  const refresh = document.getElementById('refresh');
  if (refresh) refresh.disabled = disabled;
}

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

function formatUpdatedAt(value) {
  return new Date(value).toLocaleString('da-DK', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDataAge(milliseconds) {
  if (typeof milliseconds !== 'number') return 'Ukendt';
  const minutes = Math.max(0, Math.floor(milliseconds / 60000));
  if (minutes < 1) return 'Under 1 minut';
  if (minutes < 60) return `${minutes} min.`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes ? `${hours} t ${remainingMinutes} min.` : `${hours} t`;
  const days = Math.floor(hours / 24);
  return `${days} dage`;
}

function formatEnergyRange(from, to) {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (!Number.isFinite(fromDate.getTime()) || !Number.isFinite(toDate.getTime())) return '';

  const dateOptions = {
    timeZone: 'Europe/Copenhagen',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  };
  const timeOptions = {
    timeZone: 'Europe/Copenhagen',
    hour: '2-digit',
    minute: '2-digit',
  };
  const keyOptions = {
    timeZone: 'Europe/Copenhagen',
  };
  const fromDay = fromDate.toLocaleDateString('en-CA', keyOptions);
  const toDay = toDate.toLocaleDateString('en-CA', keyOptions);
  const fromText = `${fromDate.toLocaleDateString('da-DK', dateOptions)} ${fromDate.toLocaleTimeString('da-DK', timeOptions)}`;
  const toText = fromDay === toDay
    ? toDate.toLocaleTimeString('da-DK', timeOptions)
    : `${toDate.toLocaleDateString('da-DK', dateOptions)} ${toDate.toLocaleTimeString('da-DK', timeOptions)}`;

  return `${fromText} - ${toText}`;
}

function setUpdatedAt(value) {
  document.getElementById('updated').textContent = formatUpdatedAt(value);
}

function getRefreshNote() {
  const intervalMs = REFRESH_INTERVAL_MS_BY_VIEW[activeView] || 3000;
  if (intervalMs >= 60 * 1000) return ` · opdaterer hvert ${Math.round(intervalMs / 60000)} min`;
  return ` · opdaterer hvert ${Math.round(intervalMs / 1000)} sek`;
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

function formatContactDuration(milliseconds) {
  if (typeof milliseconds !== 'number') return null;

  const totalMinutes = Math.max(0, Math.round(milliseconds / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days} d ${hours} t`;
  if (hours > 0) return `${hours} t ${minutes} min`;
  return `${minutes} min`;
}

function formatZonePath(device) {
  const zonePath = Array.isArray(device.zonePath)
    ? device.zonePath
    : String(device.zonePathText || '').split(' / ');
  return zonePath.slice(-2).join(' / ');
}

function getGraphWindow(history) {
  const maxT = Date.parse(latestDashboard?.generatedAt) || Date.now();
  const minT = maxT - (GRAPH_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const visibleHistory = (history || []).filter((point) => point.t >= minT && point.t <= maxT);

  return { maxT, minT, visibleHistory };
}

function getGraphMaxValue(device, visibleHistory) {
  const alarmThreshold = Number(device.values.alarmThreshold);
  const values = visibleHistory.map((point) => Math.max(0, Number(point.v) || 0));
  if (Number.isFinite(alarmThreshold)) {
    values.push(Math.max(0, alarmThreshold));
  }

  return Math.max(1, ...values);
}

function getGraphMinValue(device, visibleHistory) {
  const alarmThreshold = Number(device.values.alarmThreshold);
  const values = visibleHistory
    .map((point) => Number(point.v))
    .filter(Number.isFinite);

  if (Number.isFinite(alarmThreshold)) {
    values.push(alarmThreshold - 5);
  }

  if (values.length === 0) {
    return 0;
  }

  return Math.max(0, Math.min(...values));
}

function getMoistureRange(device) {
  const { visibleHistory } = getGraphWindow(device.history);
  const values = visibleHistory
    .map((point) => Number(point.v))
    .filter(Number.isFinite);
  const currentValue = Number(device.values.soilMoisture);

  if (Number.isFinite(currentValue)) {
    values.push(currentValue);
  }

  if (values.length === 0) {
    return { max: null, current: null, min: null };
  }

  return {
    max: Math.max(...values),
    current: Number.isFinite(currentValue) ? currentValue : null,
    min: Math.min(...values),
  };
}

function formatMoistureNumber(value) {
  return typeof value === 'number' ? value.toLocaleString('da-DK', { maximumFractionDigits: 1 }) : '-';
}

function clampSoilThreshold(value) {
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue)) return 30;
  return Math.max(SOIL_THRESHOLD_MIN, Math.min(SOIL_THRESHOLD_MAX, Math.round(parsedValue)));
}

function findSoilDevice(apiDeviceId) {
  if (!latestDashboard) return null;
  return flattenDevices(latestDashboard).find((device) => device.apiDeviceId === apiDeviceId) || null;
}

function getGraphY(value, minValue, maxValue) {
  const range = Math.max(1, maxValue - minValue);
  const scaledValue = Math.max(minValue, Math.min(maxValue, value));
  return GRAPH_VALUE_HEIGHT - (((scaledValue - minValue) / range) * GRAPH_VALUE_HEIGHT) + GRAPH_VALUE_TOP;
}

function graphPath(visibleHistory, width, minT, maxT, minValue, maxValue) {
  if (!visibleHistory || visibleHistory.length < 2) return '';

  const plotWidth = Math.max(1, width - GRAPH_AXIS_WIDTH);
  const rangeT = Math.max(1, maxT - minT);

  return visibleHistory.map((point, index) => {
    const x = GRAPH_AXIS_WIDTH + (((point.t - minT) / rangeT) * plotWidth);
    const y = getGraphY(point.v, minValue, maxValue);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
}

function thresholdY(device, minValue, maxValue) {
  if (typeof device.values.alarmThreshold !== 'number') return null;
  return getGraphY(device.values.alarmThreshold, minValue, maxValue);
}

function renderLevelLines(width) {
  return [0.25, 0.5, 0.75, 1].map((fraction) => {
    const y = GRAPH_VALUE_HEIGHT - (fraction * GRAPH_VALUE_HEIGHT) + GRAPH_VALUE_TOP;
    return `<path d="M${GRAPH_AXIS_WIDTH} ${y.toFixed(1)}H${width}" stroke="rgba(102,112,133,0.16)" stroke-width="1" />`;
  }).join('');
}

function renderDayMarkers(visibleHistory, width, minT, maxT) {
  if (!visibleHistory || visibleHistory.length < 2) return '';

  const plotWidth = Math.max(1, width - GRAPH_AXIS_WIDTH);
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
  const { maxT, minT, visibleHistory } = getGraphWindow(device.history);
  const minValue = getGraphMinValue(device, visibleHistory);
  const maxValue = getGraphMaxValue(device, visibleHistory);
  const path = graphPath(visibleHistory, width, minT, maxT, minValue, maxValue);
  if (!path) return '<p class="graph-empty">Trend vises efter mindst to rapporter.</p>';

  const alarmY = thresholdY(device, minValue, maxValue);
  const alarmLabelY = alarmY === null
    ? null
    : Math.max(GRAPH_VALUE_TOP + 10, Math.min(GRAPH_BOTTOM - 8, alarmY - 4));
  const alarmLabel = formatValue(device.values.alarmThreshold, '%');
  const alarmLine = alarmY === null ? '' : `<path d="M${GRAPH_AXIS_WIDTH} ${alarmY.toFixed(1)}H${width}" stroke="#c94b32" stroke-dasharray="5 5" stroke-width="2" />
    <text x="${GRAPH_AXIS_WIDTH + 6}" y="${alarmLabelY.toFixed(1)}" fill="#c94b32" font-size="11" font-weight="800">
      Grænse ${alarmLabel}
    </text>`;
  const maxLabel = `${Math.ceil(maxValue).toLocaleString('da-DK')}%`;
  const minLabel = `${Math.floor(minValue).toLocaleString('da-DK')}%`;
  const graphLine = `<path d="${path}" fill="none" stroke="#4c7a45" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />`;
  const topLabel = `<span class="graph-label" style="top:${GRAPH_VALUE_TOP + 2}px">${maxLabel}</span>`;
  const bottomLabel = `<span class="graph-label" style="top:${GRAPH_BOTTOM - 5}px">${minLabel}</span>`;

  return `<svg class="graph" viewBox="0 0 ${width} 138" role="img" aria-label="7 dages trend">
    <path d="M${GRAPH_AXIS_WIDTH} 134H${width}" stroke="rgba(76,122,69,0.22)" />
    ${renderLevelLines(width)}
    ${renderDayMarkers(visibleHistory, width, minT, maxT)}
    ${alarmLine}
    ${graphLine}
  </svg>${topLabel}${bottomLabel}`;
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

function getThresholdDisabledReason(device) {
  if (device.error) return 'Sensoren melder fejl i Homey.';
  if (device.offline || !device.live) return 'Sensoren er offline.';
  if (!device.controls?.canSetAlarmThreshold) return 'Sensoren har ingen jordfugtgrænse, der kan ændres her.';
  return '';
}

function renderSoilStatusControl(device, state, statusClass) {
  const disabledReason = getThresholdDisabledReason(device);
  const title = disabledReason || 'Indstil jordfugtgrænse';
  const threshold = clampSoilThreshold(device.values.alarmThreshold);
  const ariaLabel = disabledReason
    ? `${state}. ${disabledReason}`
    : `Indstil jordfugtgrænse for ${device.name}. Aktuel grænse ${threshold} %.`;
  const attributes = [
    `class="status-button ${statusClass}"`,
    'type="button"',
    `data-threshold-device-id="${escapeHtml(device.apiDeviceId)}"`,
    `title="${escapeHtml(title)}"`,
    `aria-label="${escapeHtml(ariaLabel)}"`,
  ];

  if (disabledReason) attributes.push('disabled');

  return `<button ${attributes.join(' ')}>
    ${escapeHtml(state)}
  </button>`;
}

function renderMaintenanceNote(device) {
  if (!device.needsMaintenance) return '';

  const duration = formatDuration(device.maintenance?.unchangedMinutes);
  const threshold = device.maintenance?.thresholdHours || 22;
  return `<p class="maintenance-note">Jordfugten har ikke ændret sig i ${escapeHtml(duration)}. `
    + `Flyt/omplacer sensoren eller rens spyddene. Reglen udløser efter ca. ${threshold} timer uden ændring.</p>`;
}

function getIssueCounterValue(device, type) {
  const value = Number(device.issueCounters?.[type]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function renderIssueCounter(device, type, label) {
  const count = getIssueCounterValue(device, type);
  const title = `Nulstil ${label.toLowerCase()}-tæller for ${device.name}`;
  return `<button class="issue-counter ${type}" type="button" data-counter-device-id="${escapeHtml(device.apiDeviceId)}" data-counter-type="${type}" title="${escapeHtml(title)}">
    <span>${escapeHtml(label)}</span><b>${count.toLocaleString('da-DK')}</b>
  </button>`;
}

function renderIssueCounters(device) {
  return `<div class="issue-counters" aria-label="Akkumulerede sensorhændelser">
    ${renderIssueCounter(device, 'offline', 'Offline')}
    ${renderIssueCounter(device, 'maintenance', 'Flyt/rens')}
  </div>`;
}

function getSignalStatus(linkQuality) {
  const value = Number(linkQuality);
  if (!Number.isFinite(value)) return null;
  if (value <= 30) return { level: 1, label: 'Dårlig dækning' };
  if (value <= 60) return { level: 2, label: 'Svag dækning' };
  if (value <= 100) return { level: 3, label: 'Rimelig dækning' };
  if (value <= 160) return { level: 4, label: 'God dækning' };
  return { level: 5, label: 'Meget god dækning' };
}

function renderSignalIndicator(device) {
  const linkQualityIngested = device.values?.linkQualityIngested ?? device.linkQualityIngested;
  if (linkQualityIngested !== true) return '';
  const linkQuality = device.values?.linkQuality ?? device.linkQuality;
  const signal = getSignalStatus(linkQuality);
  if (!signal) return '';
  return `<span class="signal-dot level-${signal.level}" title="${escapeHtml(signal.label)}: LQI ${Math.round(linkQuality)}" aria-label="${escapeHtml(signal.label)}: LQI ${Math.round(linkQuality)}">LQI ${Math.round(linkQuality)}</span>`;
}

function renderSensor(device, showZoneInCard = true) {
  const graphIndex = graphDevices.push(device) - 1;
  const alarmStats = device.waterAlarmStats || { monthlyActivations: 0, periodDays: 30, zoneTopScorer: false };
  const moistureRange = getMoistureRange(device);
  const moistureMarkup = `<small class="moisture-max">${formatMoistureNumber(moistureRange.max)}</small><span>/</span>`
    + `<b>${formatMoistureNumber(moistureRange.current)}</b><span>/</span>`
    + `<small class="moisture-min">${formatMoistureNumber(moistureRange.min)}</small>`;
  let state = 'Offline';
  let statusClass = 'offline';
  let statusMarkup = '';

  if (device.values.waterAlarm) {
    state = 'Vandalarm';
    statusClass = 'action';
  } else if (device.error) {
    state = 'Fejl';
    statusClass = 'action';
  } else if (device.offline || !device.live) {
    state = 'Offline';
    statusClass = 'offline';
  } else if (device.needsMaintenance) {
    state = 'Flyt/rens';
    statusClass = 'maintenance';
  } else if (device.live) {
    state = 'OK';
    statusClass = 'ok';
  }

  const alarmCountMarkup = `<span class="alarm-count">${alarmStats.monthlyActivations} vandalarmer / ${alarmStats.periodDays} dage</span>`;
  const topScorerMarkup = alarmStats.zoneTopScorer ? '<span class="topscorer">Topscorer i zonen</span>' : '';
  const alarmStatsMarkup = `<div class="alarm-stats">${alarmCountMarkup}${topScorerMarkup}</div>`;

  statusMarkup = renderSoilStatusControl(device, state, statusClass);

  const cardClass = [
    'sensor',
    device.values.waterAlarm || device.error ? 'action' : '',
    device.needsMaintenance ? 'maintenance' : '',
    device.offline || !device.live ? 'offline' : '',
    device.error ? 'error' : '',
  ].filter(Boolean).join(' ');

  return `<article class="${cardClass}">
    <div class="topline">
      <div>
        ${showZoneInCard ? `<div class="zone">${escapeHtml(formatZonePath(device))}</div>` : ''}
        <div class="name">${escapeHtml(device.name)}${renderSignalIndicator(device)}</div>
        ${alarmStatsMarkup}
        ${renderIssueCounters(device)}
      </div>
      ${statusMarkup}
    </div>
    <div class="moisture">
      <strong class="moisture-range">${moistureMarkup}</strong><span>% fugt</span>
    </div>
    <div class="facts">
      <div class="fact"><strong>${formatValue(device.values.temperature, ' °C')}</strong>Temperatur</div>
      <div class="fact"><strong>${formatValue(device.values.luminance, ' lx')}</strong>Luminans</div>
      <div class="fact"><strong>${formatTime(device.lastReportedAt)}</strong>Sidst set</div>
    </div>
    ${renderMaintenanceNote(device)}
    <div class="graph-host" data-graph-index="${graphIndex}"></div>
  </article>`;
}

function updateRefreshNote() {
  const element = document.getElementById('next-refresh');
  if (document.visibilityState === 'hidden') {
    element.textContent = ' · pause';
    return;
  }

  if (!nextRefreshAt) {
    element.textContent = '';
    return;
  }

  element.textContent = getRefreshNote();
}

function scheduleRefresh(enabled = true) {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;

  if (!enabled) {
    nextRefreshAt = 0;
    updateRefreshNote();
    return;
  }

  nextRefreshAt = Date.now() + (REFRESH_INTERVAL_MS_BY_VIEW[activeView] || 3000);
  updateRefreshNote();
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') {
      updateRefreshNote();
      return;
    }

    if (Date.now() >= nextRefreshAt) {
      if (isThresholdDialogOpen() || replayConfigDirty) {
        nextRefreshAt = Date.now() + (REFRESH_INTERVAL_MS_BY_VIEW[activeView] || 3000);
        updateRefreshNote();
        return;
      }

      loadActiveView();
      return;
    }
    updateRefreshNote();
  }, 1000);
}

function setActiveTab() {
  document.getElementById('home-tab').classList.toggle('active', activeView === 'home');
  document.getElementById('soil-tab').classList.toggle('active', activeView === 'soil');
  document.getElementById('watering-tab').classList.toggle('active', ['watering', 'circuits'].includes(activeView));
  document.getElementById('contact-tab').classList.toggle('active', activeView === 'contact');
  document.getElementById('motion-tab').classList.toggle('active', activeView === 'motion');
  document.getElementById('lights-tab').classList.toggle('active', activeView === 'lights');
  document.getElementById('energy-tab').classList.toggle('active', activeView === 'energy');
  document.getElementById('vehicle-tab').classList.toggle('active', activeView === 'vehicle');
  document.querySelector('.summary').hidden = ['home', 'replay'].includes(activeView);
  document.getElementById('watering-mode-card').hidden = !['soil', 'watering', 'circuits'].includes(activeView);
}

function setSummaryLabels(deviceLabel, alarmLabel, offlineLabel) {
  document.getElementById('total-devices-label').textContent = deviceLabel;
  document.getElementById('total-alarms-label').textContent = alarmLabel;
  document.getElementById('total-offline-label').textContent = offlineLabel;
  document.getElementById('total-alarms').closest('article').className = 'danger';
}

function setSummaryThirdCardVisible(visible) {
  document.getElementById('total-offline').closest('article').hidden = !visible;
}

function setDashboardTitle(title) {
  document.getElementById('dashboard-title').textContent = title;
}

function renderSection(title, devices) {
  if (devices.length === 0) return '';
  return `<section><h2 class="section-title">${title}</h2><div class="grid">${devices.map((device) => renderSensor(device, true)).join('')}</div></section>`;
}

function renderOverviewStatus(status) {
  return `<li>
    <span>${escapeHtml(status)}</span>
  </li>`;
}

function getOverviewMetricClass(card, total) {
  if (!(total.value > 0)) return '';

  if (card.id === 'soil' && total.label === 'Alarm') return ' danger';
  if (card.id === 'soil' && total.label === 'Tjek') return ' muted-alert';
  if (card.id === 'soil' && total.label === 'Fejl') return ' muted-alert';
  if (card.id === 'watering' && total.label === 'Aktive') return ' positive';
  if (card.id === 'contact' && ['Åbne', 'Fejl'].includes(total.label)) return ' danger';

  return '';
}

function renderOverviewMetric(card, total) {
  return `<span class="metric${getOverviewMetricClass(card, total)}"><b>${formatDecimal(total.value, '', 1)}</b>${escapeHtml(total.label)}</span>`;
}

function formatMoney(value) {
  return typeof value === 'number' ? `${value.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr.` : '-';
}

function formatSignedMoney(value) {
  if (typeof value !== 'number') return '-';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${formatMoney(value)}`;
}

function renderElectricityLine(label, kwh, dkk) {
  return `<li>
    <span>${escapeHtml(label)}</span>
    <b>${formatDecimal(kwh, ' kWh', 2)}</b>
    <em>${formatMoney(dkk)}</em>
  </li>`;
}

function renderElectricityCard(card) {
  const data = card.electricity || {};
  const now = data.now || {};
  return `<article class="dashboard-card electricity" data-view="energy">
    <span class="dashboard-card-kicker">${escapeHtml(card.subtitle)}</span>
    <strong>${escapeHtml(card.title)}</strong>
    <ol class="electricity-lines">
      ${renderElectricityLine('I går', data.yesterday?.kwh, data.yesterday?.costDkk)}
      ${renderElectricityLine('I dag', data.today?.kwh, data.today?.costDkk)}
      ${renderElectricityLine('Seneste time', data.latestHour?.kwh, data.latestHour?.costDkk)}
      <li>
        <span>Lige nu</span>
        <b>${formatDecimal(now.kw, ' kW', 2)}</b>
        <em>${formatMoney(now.dkkPerHour)}/t</em>
      </li>
    </ol>
    <p class="electricity-note">Aktuel pris: ${formatMoney(now.dkkPerKwh)}/kWh</p>
  </article>`;
}

function getTimingClass(value) {
  if (typeof value !== 'number') return '';
  if (value > 0.01) return ' positive';
  if (value < -0.01) return ' danger';
  return '';
}

function renderEnergyPeriodButton(period, label) {
  const active = activeEnergyPeriod === period ? ' active' : '';
  return `<button class="period-button${active}" type="button" data-energy-period="${period}">${label}</button>`;
}

function renderEnergyPeriodNavigation(data) {
  const navigation = data.navigation || {};
  const range = formatEnergyRange(data.from, data.to);
  const nextDisabled = navigation.canNavigateNext === false ? ' disabled' : '';

  return `<div class="period-navigation" aria-label="Skift periode">
    <button class="period-step" type="button" data-energy-period-delta="-1">Forrige</button>
    <span class="period-range">${escapeHtml(range || data.label || '')}</span>
    <button class="period-step" type="button" data-energy-period-delta="1"${nextDisabled}>Næste</button>
  </div>`;
}

function renderEnergyStat(label, value, suffix = '') {
  return `<article class="energy-stat"><span>${escapeHtml(label)}</span><strong>${value}${escapeHtml(suffix)}</strong></article>`;
}

function renderTimingGauge(data) {
  const totals = data.totals || {};
  const best = Number(totals.bestPossibleCostDkk);
  const worst = Number(totals.worstPossibleCostDkk);
  const actual = Number(totals.costDkk);
  const position = Number.isFinite(best) && Number.isFinite(worst) && worst > best
    ? Math.max(0, Math.min(100, ((actual - best) / (worst - best)) * 100))
    : 50;
  return `<section class="energy-panel timing-panel">
    <div class="timing-heading">
      <span>Forbrug på billige timer</span>
      <strong class="timing-result${getTimingClass(totals.timingEffectDkk)}">${formatSignedMoney(totals.timingEffectDkk)}</strong>
    </div>
    <div class="timing-gauge" aria-label="Timing-score">
      <span class="timing-marker" style="left: ${position.toFixed(1)}%"></span>
    </div>
    <div class="timing-scale"><span>Billigst muligt</span><span>Gennemsnit</span><span>Dyrest muligt</span></div>
    <p>${escapeHtml(data.note || '')}</p>
  </section>`;
}

function getEnergyChartTicks(buckets) {
  if (buckets.length <= 5) return buckets.map((_, index) => index);
  const step = Math.max(1, Math.ceil(buckets.length / 5));
  const ticks = [];
  for (let index = 0; index < buckets.length; index += step) ticks.push(index);
  if (ticks[ticks.length - 1] !== buckets.length - 1) ticks.push(buckets.length - 1);
  return ticks;
}

function renderEnergyChart(data) {
  const buckets = data.buckets || [];
  if (buckets.length === 0) return '';

  const width = 720;
  const height = 260;
  const left = 72;
  const right = 86;
  const top = 34;
  const bottom = 50;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxKwh = Math.max(0.1, data.scale?.maxKwh || 0);
  const maxPrice = Math.max(0.1, data.scale?.maxPrice || 0, data.totals?.neutralDkkPerKwh || 0);
  const barGap = buckets.length > 48 ? 1 : 3;
  const barWidth = Math.max(2, (plotWidth / buckets.length) - barGap);
  const xFor = (index) => left + (index * (plotWidth / buckets.length)) + ((plotWidth / buckets.length) / 2);
  const boundaryXFor = (index) => left + (index * (plotWidth / buckets.length));
  const kwhY = (value) => top + plotHeight - ((Math.max(0, value) / maxKwh) * plotHeight);
  const priceY = (value) => top + plotHeight - ((Math.max(0, value || 0) / maxPrice) * plotHeight);
  const pricePoints = buckets
    .filter((bucket) => bucket.priceDkkPerKwh !== null)
    .map((bucket) => `${xFor(buckets.indexOf(bucket)).toFixed(1)},${priceY(bucket.priceDkkPerKwh).toFixed(1)}`)
    .join(' ');
  const averageY = priceY(data.totals?.neutralDkkPerKwh || 0);
  const ticks = getEnergyChartTicks(buckets);
  const dayMarkers = buckets.map((bucket, index) => {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Copenhagen', hour: '2-digit', hourCycle: 'h23' }).format(new Date(bucket.startsAt)));
    if (hour === 0) return `<path d="M${boundaryXFor(index).toFixed(1)} ${top}V${top + plotHeight}" class="day-marker midnight" />`;
    if (hour === 12) return `<path d="M${boundaryXFor(index).toFixed(1)} ${top + (plotHeight / 2)}V${top + plotHeight}" class="day-marker noon" />`;
    return '';
  }).join('');
  const bars = buckets.map((bucket, index) => {
    const x = left + (index * (plotWidth / buckets.length)) + (barGap / 2);
    const y = kwhY(bucket.kwh);
    const barHeight = top + plotHeight - y;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(1, barHeight).toFixed(1)}" rx="2" />`;
  }).join('');
  const timeLabels = ticks.map((index) => {
    const label = buckets[index].chartLabel || buckets[index].timeLabel;
    return `<text class="energy-time-label" x="${xFor(index).toFixed(1)}" y="${height - 18}" text-anchor="middle">${escapeHtml(label)}</text>`;
  }).join('');

  return `<section class="energy-panel energy-chart-panel">
    <div class="energy-chart-heading">
      <h3>Forbrug og pris over tid</h3>
      <span><i></i> kWh</span><span><b></b> kr./kWh</span><span><em></em> gennemsnitspris</span>
    </div>
    <svg class="energy-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Forbrug og elpris over tid">
      <path d="M${left} ${top}V${top + plotHeight}H${width - right}" fill="none" stroke="rgba(102,112,133,0.35)" />
      <path d="M${width - right} ${top}V${top + plotHeight}" fill="none" stroke="rgba(102,112,133,0.22)" />
      <text x="${left - 12}" y="${top - 12}" text-anchor="end" class="axis-label">kWh</text>
      <text x="${left - 12}" y="${top + 8}" text-anchor="end">${formatDecimal(maxKwh, '', 1)}</text>
      <text x="${left - 12}" y="${top + plotHeight}" text-anchor="end">0</text>
      <text x="${width - right + 12}" y="${top - 12}" class="axis-label">kr/kWh</text>
      <text x="${width - right + 12}" y="${top + 8}">${formatDecimal(maxPrice, '', 1)}</text>
      <text x="${width - right + 12}" y="${top + plotHeight}">0</text>
      ${dayMarkers}
      ${bars}
      <path d="M${left} ${averageY.toFixed(1)}H${width - right}" class="average-line" />
      ${pricePoints ? `<polyline points="${pricePoints}" class="price-line" />` : ''}
      ${timeLabels}
    </svg>
    <p class="energy-help">X-akse: tid. Venstre Y-akse: kWh. Højre Y-akse: kr/kWh.</p>
  </section>`;
}

function renderHourPatternChart(data) {
  const patterns = data.hourPatterns || [];
  if (patterns.length === 0) return '';

  const width = 720;
  const height = 250;
  const left = 72;
  const right = 86;
  const top = 34;
  const bottom = 50;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxKwh = Math.max(0.1, data.hourPatternScale?.maxKwh || 0);
  const maxPrice = Math.max(0.1, data.hourPatternScale?.maxPrice || 0);
  const slot = plotWidth / patterns.length;
  const barWidth = Math.max(8, slot * 0.58);
  const xFor = (index) => left + (index * slot) + (slot / 2);
  const kwhY = (value) => top + plotHeight - ((Math.max(0, value) / maxKwh) * plotHeight);
  const priceY = (value) => top + plotHeight - ((Math.max(0, value || 0) / maxPrice) * plotHeight);
  const pricePoints = patterns.map((pattern, index) => `${xFor(index).toFixed(1)},${priceY(pattern.averageDkkPerKwh).toFixed(1)}`).join(' ');
  const prices = patterns.map((pattern) => pattern.averageDkkPerKwh).filter((value) => typeof value === 'number').sort((a, b) => a - b);
  const expensiveLimit = prices[Math.max(0, Math.floor(prices.length * 0.67))] || Number.POSITIVE_INFINITY;
  const barClass = (pattern) => {
    const cheapRatio = pattern.days > 0 ? pattern.cheapestDays / pattern.days : 0;
    if (cheapRatio >= 0.34) return 'cheap-pattern';
    if (pattern.averageDkkPerKwh >= expensiveLimit) return 'expensive-pattern';
    return 'middle-pattern';
  };
  const patternBars = patterns.map((pattern, index) => {
    const x = xFor(index) - (barWidth / 2);
    const y = kwhY(pattern.kwh);
    const barHeight = top + plotHeight - y;
    return `<rect class="${barClass(pattern)}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(1, barHeight).toFixed(1)}" rx="3" />`;
  }).join('');
  const hourLabels = patterns.map((pattern, index) => {
    if (Number(pattern.hour) % 4 !== 0) return '';
    return `<text class="hour-pattern-label" x="${xFor(index).toFixed(1)}" y="${height - 18}" text-anchor="middle">${escapeHtml(pattern.hour)}</text>`;
  }).join('');

  return `<section class="energy-panel energy-chart-panel">
    <div class="energy-chart-heading">
      <h3>Klokkeslæt der flytter regningen</h3>
      <span><i class="cheap-key"></i> ofte billig</span><span><i class="middle-key"></i> midtertimer</span><span><i class="expensive-key"></i> ofte dyr</span><span><b></b> gennemsnitspris</span>
    </div>
    <p class="energy-help">Brug grafen som flyttehjælp: høje røde søjler er forbrug, der ofte ligger dyrt. Hvis noget kan vente, så flyt det mod grønne klokkeslæt.</p>
    <svg class="energy-chart hour-pattern-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Forbrug og pris fordelt på klokkeslæt">
      <path d="M${left} ${top}V${top + plotHeight}H${width - right}" fill="none" stroke="rgba(102,112,133,0.35)" />
      <path d="M${width - right} ${top}V${top + plotHeight}" fill="none" stroke="rgba(102,112,133,0.22)" />
      <text x="${left - 12}" y="${top - 12}" text-anchor="end" class="axis-label">kWh</text>
      <text x="${left - 12}" y="${top + 8}" text-anchor="end">${formatDecimal(maxKwh, '', 1)}</text>
      <text x="${width - right + 12}" y="${top - 12}" class="axis-label">kr/kWh</text>
      <text x="${width - right + 12}" y="${top + 8}">${formatDecimal(maxPrice, '', 1)}</text>
      ${patternBars}
      ${pricePoints ? `<polyline points="${pricePoints}" class="price-line" />` : ''}
      ${hourLabels}
    </svg>
  </section>`;
}

function renderEnergyDashboard(data) {
  latestDashboard = null;
  graphDevices = [];
  setActiveTab();
  setDashboardTitle('Elpriser');
  setSummaryThirdCardVisible(true);
  setSummaryLabels('kWh', 'Gevinst', 'Pris');
  document.getElementById('total-devices').textContent = formatDecimal(data.totals.kwh, '', 1);
  document.getElementById('total-alarms').textContent = formatSignedMoney(data.totals.timingEffectDkk);
  document.getElementById('total-offline').textContent = formatDecimal(data.totals.actualDkkPerKwh, '', 2);
  document.getElementById('total-alarms').closest('article').className = data.totals.timingEffectDkk >= 0 ? 'positive' : 'danger';
  setUpdatedAt(data.generatedAt);

  document.getElementById('content').innerHTML = `<section class="energy-detail">
    <div class="energy-controls">
      <div class="period-tabs">
        ${Object.entries(ENERGY_PERIOD_LABELS).map(([period, label]) => renderEnergyPeriodButton(period, label)).join('')}
      </div>
      ${renderEnergyPeriodNavigation(data)}
    </div>
    <section class="energy-hero-card">
      <span class="dashboard-card-kicker">${escapeHtml(data.label)}</span>
      <h2>Forbrug på billige timer</h2>
      <div class="energy-stats">
        ${renderEnergyStat('Forbrug', formatDecimal(data.totals.kwh, '', 2), ' kWh')}
        ${renderEnergyStat('Betalt', formatMoney(data.totals.costDkk))}
        ${renderEnergyStat('Faktisk pris', formatDecimal(data.totals.actualDkkPerKwh, '', 2), ' kr./kWh')}
        ${renderEnergyStat('Gennemsnitspris', formatDecimal(data.totals.neutralDkkPerKwh, '', 2), ' kr./kWh')}
      </div>
    </section>
    ${renderTimingGauge(data)}
    ${renderEnergyChart(data)}
    ${renderHourPatternChart(data)}
  </section>`;
}

function renderOverviewCard(card) {
  if (card.id === 'electricity') return renderElectricityCard(card);
  if (card.id === 'vehicle') return renderVehicleOverviewCard(card);

  const statusItems = card.statusItems || ['Ingen aktuelle afvigelser'];
  const status = `<ol class="dashboard-activities">${statusItems.map(renderOverviewStatus).join('')}</ol>`;

  return `<button class="dashboard-card ${escapeHtml(card.id)}" type="button" data-view="${escapeHtml(card.target)}">
    <span class="dashboard-card-kicker">${escapeHtml(card.subtitle)}</span>
    <strong>${escapeHtml(card.title)}</strong>
    <span class="dashboard-card-metrics">
      ${card.totals.map((total) => renderOverviewMetric(card, total)).join('')}
    </span>
    ${status}
  </button>`;
}

function renderVehicleOverviewCard(card) {
  const vehicle = card.vehicle || {};
  const freshnessClass = ['fresh', 'aging', 'old'].includes(vehicle.freshness) ? vehicle.freshness : 'old';
  const age = formatDataAge(vehicle.ageMs);
  return `<button class="dashboard-card vehicle-overview ${freshnessClass}" type="button" data-view="vehicle">
    <span class="dashboard-card-kicker">${escapeHtml(card.subtitle)}</span>
    <strong>${escapeHtml(vehicle.name || card.title)}</strong>
    <span class="dashboard-card-metrics">
      <span class="metric"><b>${formatValue(card.totals?.[0]?.value, '%')}</b>SOC</span>
      <span class="metric"><b>${formatValue(card.totals?.[1]?.value, ' km')}</b>Rækkevidde</span>
      <span class="metric vehicle-age-metric"><b>${escapeHtml(age)}</b>Dataalder</span>
    </span>
    <span class="dashboard-activities"><span>${escapeHtml(card.statusItems?.[0] || 'Dataalder ukendt')}</span></span>
  </button>`;
}

function renderVehicleDashboard(data) {
  latestDashboard = null;
  graphDevices = [];
  setActiveTab();
  setDashboardTitle('Peugeot');
  setSummaryThirdCardVisible(true);
  setSummaryLabels('SOC', 'Rækkevidde', 'Ladning');
  setUpdatedAt(data.generatedAt);

  const { vehicle } = data;
  document.getElementById('total-devices').textContent = vehicle?.batteryLevel === null ? '-' : `${vehicle?.batteryLevel ?? '-'} %`;
  document.getElementById('total-alarms').textContent = vehicle?.rangeKm === null ? '-' : `${vehicle?.rangeKm ?? '-'} km`;
  document.getElementById('total-offline').textContent = vehicle?.charging ? 'Aktiv' : 'Nej';

  if (!data.configured) {
    document.getElementById('content').innerHTML = '<section class="empty">MyPeugeot er installeret, men bilen mangler login og VIN på Hubert.</section>';
    return;
  }

  const freshness = {
    fresh: { label: 'Frisk', detail: 'Under 1 time', className: 'fresh' },
    aging: { label: 'Ikke helt frisk', detail: '1-6 timer', className: 'aging' },
    old: { label: 'Gammel', detail: 'Over 6 timer', className: 'old' },
  }[vehicle.freshness] || { label: 'Ukendt', detail: 'Ingen datatid', className: 'old' };
  document.getElementById('content').innerHTML = `<section class="vehicle-stage">
    <article class="vehicle-card ${freshness.className}">
      <div class="vehicle-heading">
        <div><span class="dashboard-card-kicker">MyPeugeot</span><h2>${escapeHtml(vehicle.name)}</h2></div>
      </div>
      <div class="vehicle-freshness-box ${freshness.className}">
        <span>Datastatus</span><strong>${freshness.label}</strong><small>${freshness.detail} · ${formatDataAge(vehicle.ageMs)}</small>
      </div>
      <div class="vehicle-battery"><strong>${formatValue(vehicle.batteryLevel, '%')}</strong><span><i style="width:${Math.max(0, Math.min(100, vehicle.batteryLevel || 0))}%"></i></span></div>
      <div class="vehicle-facts">
        <div><strong>${formatValue(vehicle.rangeKm, ' km')}</strong><span>Rækkevidde</span></div>
        <div><strong>${vehicle.charging ? 'Lader' : getVehicleConnectionStatus(vehicle)}</strong><span>Ladestatus</span></div>
        <div><strong>${formatDataAge(vehicle.ageMs)}</strong><span>Dataalder</span></div>
        <div><strong>${formatTime(vehicle.updatedAt)}</strong><span>Rapporteret af bilen</span></div>
        <div><strong>${formatTime(vehicle.fetchedAt || data.generatedAt)}</strong><span>Hentet af Hubert</span></div>
      </div>
      <p>Frisk: under 1 time. Ikke helt frisk: 1-6 timer. Gammel: over 6 timer. En sovende bil kan vise ældre værdier uden at integrationen fejler.</p>
    </article>
  </section>`;
}

function getVehicleConnectionStatus(vehicle) {
  return vehicle.plugged ? 'Tilsluttet' : 'Ikke tilsluttet';
}

function renderOverviewDashboard(data) {
  latestDashboard = null;
  graphDevices = [];
  setActiveTab();
  setDashboardTitle('Dashboard');
  setSummaryThirdCardVisible(true);
  setSummaryLabels('Områder', 'Kræver kig', 'Aktive nu');

  document.getElementById('total-devices').textContent = data.totals.cards;
  document.getElementById('total-alarms').textContent = data.totals.attention;
  document.getElementById('total-offline').textContent = data.totals.active;
  setUpdatedAt(data.generatedAt);

  document.getElementById('content').innerHTML = `<section class="overview-section">
    <h2 class="section-title">Overblik</h2>
    <div class="dashboard-grid">${data.cards.map(renderOverviewCard).join('')}</div>
  </section>`;
}

function renderSensorsByZone(devices) {
  if (devices.length === 0) return '';

  const zones = devices.reduce((result, device) => {
    const zoneKey = device.zonePathText || 'Ukendt zone';
    if (!result[zoneKey]) {
      result[zoneKey] = [];
    }
    result[zoneKey].push(device);
    return result;
  }, {});

  return `<section><h2 class="section-title">Sensorer efter zone</h2>${Object.entries(zones).map(([zonePath, zoneDevices]) => (
    `<h3 class="zone-title">${escapeHtml(formatZonePath({ zonePathText: zonePath }))}</h3>`
      + `<div class="grid">${zoneDevices.map((device) => renderSensor(device, false)).join('')}</div>`
  )).join('')}</section>`;
}

function renderSoilCounterActions() {
  return `<section class="counter-actions">
    <div>
      <h2 class="section-title">Hændelsestællere</h2>
      <p>Klik på en sensors tæller for at nulstille den, eller nulstil alle tællere her.</p>
    </div>
    <button class="reset-counters" type="button" data-reset-all-counters>Nulstil alle tællere</button>
  </section>`;
}

function renderSoilDashboard(data) {
  latestDashboard = data;
  graphDevices = [];
  setActiveTab();
  setDashboardTitle('Jordstatus');
  setSummaryThirdCardVisible(true);
  setSummaryLabels('Sensorer', 'Kræver handling', 'Offline');
  const devices = flattenDevices(data);
  const waterAlarmDevices = devices.filter((device) => device.values.waterAlarm);
  const maintenanceDevices = devices.filter((device) => !device.values.waterAlarm && !device.error && !(device.offline || !device.live) && device.needsMaintenance);
  const offlineDevices = devices.filter((device) => !device.values.waterAlarm && !device.error && (device.offline || !device.live));
  const errorDevices = devices.filter((device) => !device.values.waterAlarm && device.error);

  document.getElementById('total-devices').textContent = data.totals.devices;
  document.getElementById('total-alarms').textContent = data.totals.alarms;
  document.getElementById('total-offline').textContent = data.totals.offline;
  setUpdatedAt(data.generatedAt);

  const content = document.getElementById('content');
  if (devices.length === 0) {
    content.innerHTML = document.getElementById('empty-template').innerHTML;
    return;
  }

  content.innerHTML = renderSoilCounterActions()
    + renderSection('Vandalarmer', waterAlarmDevices)
    + renderSection('Flyt/rens sensorer', maintenanceDevices)
    + renderSection('Offline sensorer', offlineDevices)
    + renderSection('Sensorfejl i Homey', errorDevices)
    + renderSensorsByZone(devices);
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

  const {
    status,
    timer,
    timerName,
    name,
  } = valve.wateringFlow;
  const timerLine = timerName
    ? `<span>Timer: ${escapeHtml(timerName)}${timer?.running ? ` · ${formatMilliseconds(timer.remainingMs)} tilbage` : ''}</span>`
    : '<span>Ingen timer fundet</span>';
  const statusText = {
    watering: 'Vander nu',
    closing: 'Lukker ventil',
    waiting_result: 'Afventer resultat',
    closing_error: 'Ventil lukker ikke',
    cycle_limit: 'Maks. cyklusser nået',
    idle: 'Lukket',
  }[status] || (timer?.running ? 'Vandingsforløb i gang' : 'Flow koblet');
  const active = status && status !== 'idle' ? `<strong>${statusText}</strong>` : `<strong>${statusText}</strong>`;

  return `<div class="watering-flow${valve.wateringActive ? ' active' : ''}">
    ${active}
    <span>Flow: ${escapeHtml(name)}</span>
    ${timerLine}
  </div>`;
}

function renderWateringValve(valve) {
  let status = '<span class="live-dot">Lukket</span>';
  if (valve.haWatering?.forbidden) {
    status = '<span class="badge forbidden">Vanding forbudt</span>';
  } else if (valve.on) {
    status = '<span class="badge ok">Vander nu</span>';
  } else if (valve.wateringFlow?.status === 'watering' || valve.haWatering?.status === 'watering') {
    status = '<span class="badge ok">Vandingsforløb kører</span>';
  } else if (valve.wateringFlow?.status === 'waiting_result' || valve.haWatering?.status === 'waiting_result') {
    status = '<span class="badge ok">Afventer resultat</span>';
  } else if (valve.wateringFlow?.status === 'closing') {
    status = '<span class="badge ok">Lukker ventil</span>';
  } else if (valve.wateringFlow?.status === 'closing_error') {
    status = '<span class="badge action">Ventil lukker ikke</span>';
  } else if (valve.wateringFlow?.status === 'cycle_limit' || valve.haWatering?.status === 'cycle_limit') {
    status = '<span class="badge action">Maks. cyklusser nået</span>';
  }
  const error = valve.error ? `<p class="valve-error">Insights-fejl: ${escapeHtml(valve.error)}</p>` : '';
  const automationError = valve.automationError ? `<p class="valve-error">Flow-fejl: ${escapeHtml(valve.automationError)}</p>` : '';
  const syncedCycleDuration = valve.wateringFlow?.durationVariable?.value;
  const cycleDuration = wateringDurationOverrides.get(valve.id) ?? syncedCycleDuration;
  if (wateringDurationOverrides.has(valve.id) && syncedCycleDuration === cycleDuration) {
    wateringDurationOverrides.delete(valve.id);
  }
  const syncedMaxCycles = valve.wateringFlow?.maxCycleVariable?.value;
  const maxCycles = wateringMaxCycleOverrides.get(valve.id) ?? syncedMaxCycles;
  if (wateringMaxCycleOverrides.has(valve.id) && syncedMaxCycles === maxCycles) {
    wateringMaxCycleOverrides.delete(valve.id);
  }
  const intervalFact = valve.wateringFlow?.durationVariable
    ? `<div class="fact interval-fact">
      <button class="interval-action" type="button"
        data-watering-valve-id="${escapeHtml(valve.id)}"
        data-watering-setting="duration"
        data-cycle-duration="${escapeHtml(cycleDuration)}"
        ${Number.isInteger(maxCycles) ? `data-max-cycles="${escapeHtml(maxCycles)}"` : ''}>${formatDuration(cycleDuration)}</button>
      Interval
    </div>`
    : '';
  const maxCyclesFact = valve.wateringFlow?.maxCycleVariable
    ? `<div class="fact interval-fact">
      <button class="interval-action" type="button"
        data-watering-valve-id="${escapeHtml(valve.id)}"
        data-watering-setting="max-cycles"
        data-cycle-duration="${escapeHtml(cycleDuration)}"
        data-max-cycles="${escapeHtml(maxCycles)}">${escapeHtml(maxCycles)}</button>
      Maks. cyklusser
    </div>`
    : '';
  const haWateringFacts = valve.haWatering ? `<div class="fact"><strong>${escapeHtml(valve.haWatering.status || 'idle')}</strong>Status</div>
    <div class="fact"><strong>${escapeHtml(valve.haWatering.cycleNumber)}</strong>Cyklus nu</div>
    <div class="fact"><strong>${escapeHtml(valve.haWatering.maximumCycles)}</strong>Maks. cyklusser</div>
    ` : '';
  const forbiddenControl = valve.haWatering ? `<button class="device-action" type="button" data-watering-forbidden="${escapeHtml(valve.id)}" data-watering-forbidden-value="${valve.haWatering.forbidden ? 'true' : 'false'}">${valve.haWatering.forbidden ? 'Tillad vanding' : 'Forbyd vanding'}</button>` : '';
  const syncedWateringError = valve.wateringFlow?.errorVariable?.value === true;
  const wateringError = wateringErrorOverrides.get(valve.id) ?? syncedWateringError;
  if (wateringErrorOverrides.has(valve.id) && syncedWateringError === false) {
    wateringErrorOverrides.delete(valve.id);
  }
  const wateringErrorState = (wateringError || valve.haWatering?.error)
    ? `<div class="watering-error" role="alert">
      <strong>Vandingsfejl</strong>
      <span>Vandingen er stoppet. Nulstil fejlen for at lade automatikken genstarte, hvis der stadig er vandingsbehov.</span>
      <button class="device-action" type="button" data-watering-restart="${escapeHtml(valve.id)}">Nulstil og genstart</button>
    </div>`
    : '';

  return `<article class="sensor valve${valve.wateringActive ? ' active' : ''}${valve.wateringNeedsAttention ? ' action' : ''}${valve.haWatering?.forbidden ? ' forbidden' : ''}${valve.error ? ' offline' : ''}">
    <div class="topline">
      <div>
        <div class="zone">${escapeHtml(formatZonePath(valve))}</div>
        <div class="name">${escapeHtml(valve.name)}${renderSignalIndicator(valve)}</div>
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
      ${intervalFact}
      ${maxCyclesFact}
      ${haWateringFacts}
      <div class="fact"><strong>${formatDecimal(valve.currentFlowLitersPerMinute, ' L/min')}</strong>Flow nu</div>
      <div class="fact"><strong>${formatDecimal(valve.currentMeterM3, ' m³', 3)}</strong>Måler</div>
      <div class="fact"><strong>${formatValue(valve.battery, '%')}</strong>Batteri</div>
    </div>
    ${renderWateringFlow(valve)}
    ${wateringErrorState}
    ${forbiddenControl}
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
  setDashboardTitle('Vanding');
  setSummaryThirdCardVisible(true);
  setSummaryLabels('Ventiler', 'Aktive', 'Liter / 14 dage');

  document.getElementById('total-devices').textContent = data.totals.valves;
  document.getElementById('total-alarms').textContent = data.totals.active;
  document.getElementById('total-offline').textContent = data.totals.waterLiters.toLocaleString('da-DK', { maximumFractionDigits: 1 });
  setUpdatedAt(data.generatedAt);

  const content = document.getElementById('content');
  const configurator = '<section class="watering-circuit-launch"><button type="button" class="device-action" data-watering-circuit-page>Administrér vandingskredse</button></section>';
  if (data.valves.length === 0) {
    content.innerHTML = `${configurator}<section class="empty">Ingen vandingsventiler fundet.</section>`;
    return;
  }

  const errors = data.totals.errors > 0 ? `<section class="error">${data.totals.errors} ventil(er) kunne ikke hente fuld Insights-historik.</section>` : '';
  content.innerHTML = `${configurator}${errors}<section><h2 class="section-title">Vandingsventiler</h2><div class="grid">${data.valves.map(renderWateringValve).join('')}</div></section>`;
}

function showWateringCircuitResult(message, actions = '') {
  const result = document.getElementById('watering-circuit-result');
  result.innerHTML = `<p>${escapeHtml(message)}</p>${actions}`;
  result.hidden = false;
}

function lockWateringCircuitLabel(label) {
  const form = document.getElementById('watering-circuit-form');
  form.hidden = true;
  form.insertAdjacentHTML('afterend', `<div id="watering-circuit-locked" class="watering-circuit-locked"><strong>Vandingslabel: ${escapeHtml(label)}</strong><button type="button" data-watering-circuit-new>Ny label</button></div>`);
}

function resetWateringCircuitLabel() {
  document.getElementById('watering-circuit-locked')?.remove();
  const form = document.getElementById('watering-circuit-form');
  form.hidden = false;
  form.elements.label.value = '';
  form.querySelector('button').disabled = false;
  document.getElementById('watering-circuit-result').hidden = true;
  form.elements.label.focus();
}

function loadWateringCircuitPage() {
  setActiveView('circuits');
  setActiveTab();
  setDashboardTitle('Vandingskredse');
  setSummaryThirdCardVisible(false);
  setSummaryLabels('Kredse', 'Fejl', '');
  document.getElementById('total-devices').textContent = '-';
  document.getElementById('total-alarms').textContent = '-';
  setUpdatedAt(null);
  document.getElementById('content').innerHTML = `<section class="watering-circuit-page">
    <button type="button" class="back-button" data-watering-circuit-back>Tilbage til vanding</button>
    <p class="threshold-kicker">Administrer vandingskredse</p>
    <h2>HA-vandingskreds</h2>
    <p>Indtast én HA-label. Den skal mærke præcis én ventil og mindst én jordfugtsensor.</p>
    <form id="watering-circuit-form"><label for="watering-circuit-label">Vandingslabel</label><input id="watering-circuit-label" name="label" maxlength="60" placeholder="fx vanding-terasse-potter" required><button type="submit">Kontrollér</button></form>
    <div id="watering-circuit-result" class="watering-circuit-result" hidden></div>
  </section>`;
  document.getElementById('watering-circuit-label').focus();
  scheduleRefresh(false);
}

async function configureWateringCircuit(action, label, confirm = false) {
  const response = await fetch(`/api/watering-circuits/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label, confirm }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

async function planWateringCircuit(form) {
  const label = form.elements.label.value.trim();
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const plan = await configureWateringCircuit('plan', label);
    const sensors = plan.sensors.map((sensor) => sensor.name).join(', ');
    lockWateringCircuitLabel(label);
    if (plan.mode === 'managed') {
      showWateringCircuitResult(`Administreret kreds: Ventil: ${plan.valve.name}. Potter: ${sensors}.`, `<button type="button" data-watering-circuit-apply="${escapeHtml(label)}">Reparer</button> <button type="button" data-watering-circuit-remove="${escapeHtml(label)}">Slet</button>`);
      return;
    }
    if (plan.mode === 'legacy') {
      showWateringCircuitResult(`Manuel kreds: Ventil: ${plan.valve.name}. Potter: ${sensors}. Manuelle pakker: ${plan.legacyPackageFiles.join(', ') || 'ikke fundet'}.`, `<button type="button" data-watering-circuit-migrate="${escapeHtml(label)}">Overtag og migrer</button>`);
      return;
    }
    showWateringCircuitResult(`Ny vandingskreds: Ventil: ${plan.valve.name}. Potter: ${sensors}.`, `<button type="button" data-watering-circuit-apply="${escapeHtml(label)}">Opret</button>`);
  } catch (error) {
    showWateringCircuitResult(`Kunne ikke planlægge: ${error.message || error}`);
  } finally {
    if (!form.hidden) button.disabled = false;
  }
}

async function applyWateringCircuit(label) {
  try {
    const result = await configureWateringCircuit('apply', label);
    showWateringCircuitResult(`${result.circuit} er anvendt og Home Assistant genindlæst.`);
  } catch (error) {
    showWateringCircuitResult(`Kunne ikke anvende: ${error.message || error}`);
  }
}

async function migrateWateringCircuit(label) {
  // eslint-disable-next-line no-alert
  if (!window.confirm('Overtag den manuelle kreds? Dens pakke sikkerhedskopieres, værdier overføres, og den deaktiveres først efter den genererede konfiguration er valideret. Labels, enheder og historik ændres ikke.')) return;
  try {
    const result = await configureWateringCircuit('migrate', label, true);
    showWateringCircuitResult(`${result.circuit} er overtaget. Backup: ${result.backups.join(', ')}.`);
  } catch (error) {
    showWateringCircuitResult(`Kunne ikke migrere: ${error.message || error}`);
  }
}

async function removeWateringCircuit(label) {
  try {
    const plan = await configureWateringCircuit('remove', label);
    const description = `Fjern ${plan.packageFile} og ${plan.profiles.length} profil(er)? Labels, enheder og historik bevares.`;
    // eslint-disable-next-line no-alert
    if (!window.confirm(description)) return;
    await configureWateringCircuit('remove', label, true);
    showWateringCircuitResult(`${label} er fjernet og Home Assistant genindlæst.`);
  } catch (error) {
    showWateringCircuitResult(`Kunne ikke fjerne: ${error.message || error}`);
  }
}

function renderContactSensor(sensor) {
  const error = sensor.error ? `<p class="valve-error">Insights-fejl: ${escapeHtml(sensor.error)}</p>` : '';
  const duration = formatContactDuration(sensor.openDurationMs);

  return `<article class="sensor contact active${sensor.error ? ' offline' : ''}">
    <div class="topline">
      <div>
        <div class="zone">${escapeHtml(formatZonePath(sensor))}</div>
        <div class="name">${escapeHtml(sensor.name)}${renderSignalIndicator(sensor)}</div>
      </div>
      <span class="badge action">Åben</span>
    </div>
    <div class="moisture contact-duration">
      <strong>${escapeHtml(duration || 'Åben')}</strong>${duration ? '<span>åben</span>' : ''}
    </div>
    <div class="facts">
      ${sensor.openSince ? `<div class="fact"><strong>${formatTime(sensor.openSince)}</strong>Åben siden</div>` : ''}
      <div class="fact"><strong>${formatValue(sensor.battery, '%')}</strong>Batteri</div>
      <div class="fact"><strong>${sensor.available ? 'Ja' : 'Nej'}</strong>Tilgængelig</div>
    </div>
    ${error}
  </article>`;
}

function renderContactDashboard(data) {
  latestDashboard = null;
  graphDevices = [];
  setActiveTab();
  setDashboardTitle('Åbne døre og vinduer');
  setSummaryThirdCardVisible(false);
  setSummaryLabels('Døre/vinduer/låger', 'Åbne', '');

  document.getElementById('total-devices').textContent = data.totals.sensors;
  document.getElementById('total-alarms').textContent = data.totals.active;
  document.getElementById('total-offline').textContent = data.totals.zones;
  setUpdatedAt(data.generatedAt);

  const content = document.getElementById('content');
  if (data.totals.active === 0) {
    content.innerHTML = '<section class="empty">Ingen åbne døre, vinduer eller låger.</section>';
    return;
  }

  const errors = data.totals.errors > 0 ? `<section class="error">${data.totals.errors} dør-/vinduesensor(er) kunne ikke hente Insights-historik.</section>` : '';
  const sensors = data.zones.flatMap((zone) => zone.sensors);
  content.innerHTML = `${errors}<section><div class="grid">${sensors.map(renderContactSensor).join('')}</div></section>`;
}

function renderActiveDevice(device, options) {
  const error = device.error ? `<p class="valve-error">Fejl: ${escapeHtml(device.error)}</p>` : '';
  const duration = formatContactDuration(device.activeDurationMs);
  const badgeClass = device.available ? options.badgeClass : 'action';
  const badge = device.available ? options.badge : 'Fejl';
  const action = options.allowTurnOff && device.available && device.active
    ? `<button class="device-action" type="button" data-light-id="${escapeHtml(device.id)}" data-light-value="false">Sluk</button>`
    : '';
  const status = `${action}<span class="badge ${escapeHtml(badgeClass)}">${escapeHtml(badge)}</span>`;

  return `<article class="sensor ${escapeHtml(options.className)}${device.active ? ' active' : ''}${!device.available ? ' offline' : ''}">
    <div class="topline">
      <div>
        <div class="zone">${escapeHtml(formatZonePath(device))}</div>
        <div class="name">${escapeHtml(device.name)}${renderSignalIndicator(device)}</div>
      </div>
      <span class="device-status">${status}</span>
    </div>
    <div class="moisture ${escapeHtml(options.durationClass)}">
      <strong>${escapeHtml(duration || badge)}</strong>${duration ? `<span>${escapeHtml(options.durationLabel)}</span>` : ''}
    </div>
    <div class="facts">
      ${device.activeSince ? `<div class="fact"><strong>${formatTime(device.activeSince)}</strong>${escapeHtml(options.sinceLabel)}</div>` : ''}
      <div class="fact"><strong>${formatValue(device.battery, '%')}</strong>Batteri</div>
      <div class="fact"><strong>${device.available ? 'Ja' : 'Nej'}</strong>Tilgængelig</div>
    </div>
    ${error}
  </article>`;
}

function renderActiveDeviceDashboard(data, options) {
  latestDashboard = null;
  graphDevices = [];
  setActiveTab();
  setDashboardTitle(options.title);
  setSummaryThirdCardVisible(options.showSummaryThirdCard !== false);
  setSummaryLabels(options.totalLabel, options.activeLabel, options.summaryThirdLabel || 'Zoner');

  document.getElementById('total-devices').textContent = data.totals[options.totalKey];
  document.getElementById('total-alarms').textContent = data.totals.active;
  document.getElementById('total-offline').textContent = data.totals.zones;
  setUpdatedAt(data.generatedAt);

  const content = document.getElementById('content');
  if (data.totals.active === 0 && data.totals.errors === 0) {
    content.innerHTML = `<section class="empty">${escapeHtml(options.emptyText)}</section>`;
    return;
  }

  const errors = data.totals.errors > 0 ? `<section class="error">${data.totals.errors} ${escapeHtml(options.errorLabel)} melder fejl.</section>` : '';
  if (options.showZoneHeadings === false) {
    const devices = data.zones.flatMap((zone) => zone.devices);
    content.innerHTML = `${errors}<section class="${escapeHtml(options.className)}-section"><div class="grid">${devices.map((device) => renderActiveDevice(device, options)).join('')}</div></section>`;
    return;
  }

  content.innerHTML = errors + data.zones.map((zone) => `<section>
    <h2 class="section-title">${escapeHtml(formatZonePath({ zonePath: zone.path, zonePathText: zone.pathText }))}</h2>
    <div class="grid">${zone.devices.map((device) => renderActiveDevice(device, options)).join('')}</div>
  </section>`).join('');
}

function renderMotionDashboard(data) {
  renderActiveDeviceDashboard(data, {
    title: 'Aktiv bevægelse',
    updatedLabel: 'Bevægelse',
    totalLabel: 'Motionssensorer',
    totalKey: 'sensors',
    activeLabel: 'Aktive',
    emptyText: 'Ingen aktive motionssensorer.',
    errorLabel: 'motionssensor(er)',
    className: 'motion',
    badgeClass: 'ok',
    badge: 'Aktiv',
    durationClass: 'motion-duration',
    durationLabel: 'aktiv',
    sinceLabel: 'Aktiv siden',
    showZoneHeadings: false,
    showSummaryThirdCard: false,
  });
}

function renderLightsDashboard(data) {
  renderActiveDeviceDashboard(data, {
    title: 'Tændte lys',
    updatedLabel: 'Lys',
    totalLabel: 'Lys',
    totalKey: 'lights',
    activeLabel: 'Tændt',
    emptyText: 'Ingen lys er tændt.',
    errorLabel: 'lys',
    className: 'light',
    badgeClass: 'ok',
    badge: 'Tændt',
    durationClass: 'light-duration',
    durationLabel: 'tændt',
    sinceLabel: 'Tændt siden',
    showZoneHeadings: false,
    showSummaryThirdCard: false,
    allowTurnOff: true,
  });
}

function formatReplaySource(run) {
  if (!run?.sourceStart) return '-';
  return new Date(run.sourceStart).toLocaleString('da-DK', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function getDefaultReplaySourceValue() {
  const value = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function toLocalDateTimeValue(value) {
  if (!value) return getDefaultReplaySourceValue();
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function updateReplayModeFields() {
  const mode = document.getElementById('replay-mode')?.value;
  const fixed = mode === 'fixed-loop';
  document.querySelectorAll('[data-fixed-loop-field]').forEach((field) => {
    field.hidden = !fixed;
  });
  const speed = document.getElementById('replay-speed');
  if (speed) {
    speed.disabled = !fixed || replayRunning;
    if (!fixed) speed.value = '1';
  }
}

function renderReplayStatus(data) {
  const content = document.getElementById('content');
  const active = data.activeRun;
  const status = active
    ? `<div class="replay-live"><strong>I gang</strong><span>${escapeHtml(active.profileName)}</span></div>`
    : '<div class="replay-idle"><strong>Ikke i gang</strong></div>';

  content.insertAdjacentHTML('afterbegin', `<section class="replay-panel replay-status-panel">
    <div class="replay-heading"><div><p class="replay-kicker">Der er nogen hjemme</p><h2>Replay</h2></div><button class="replay-link" type="button" data-replay-config>Åbn replay</button></div>
    ${status}
  </section>`);
}

function renderReplayDevice(device, selected) {
  return `<label class="replay-device${selected ? ' selected' : ''}">
    <input type="checkbox" name="replay-device" value="${escapeHtml(device.id)}"${selected ? ' checked' : ''}>
    <span><strong>${escapeHtml(device.name)}</strong><small>${escapeHtml(device.zoneName)} · ${escapeHtml(device.capabilities.join(', '))}</small></span>
  </label>`;
}

function renderReplayConfig(data, selectedProfileId) {
  replayConfigDirty = false;
  replayRunning = Boolean(data.activeRun);
  latestDashboard = null;
  graphDevices = [];
  setActiveTab();
  setDashboardTitle('Replay');
  setUpdatedAt(data.generatedAt);
  const selectedProfile = data.profiles.find((profile) => profile.id === selectedProfileId)
    || data.profiles.find((profile) => profile.isDefault)
    || data.profiles[0];
  const selected = new Set(selectedProfile?.deviceIds || []);
  const lights = data.devices.filter((device) => device.isLight);
  const others = data.devices.filter((device) => !device.isLight);
  const active = data.activeRun;
  const defaultProfile = data.profiles.find((profile) => profile.isDefault) || data.profiles[0];
  const options = data.profiles.map((profile) => `<option value="${escapeHtml(profile.id)}"${profile.id === defaultProfile?.id ? ' selected' : ''}>${escapeHtml(profile.name)}${profile.isDefault ? ' (standard)' : ''}</option>`).join('');
  const fixedLoop = active?.mode === 'fixed-loop';
  const runStatus = active
    ? `<div class="replay-live"><strong>Replay er i gang</strong><span>Kilde start: ${escapeHtml(formatReplaySource(active))}</span><span>Nået til ${escapeHtml(formatReplaySource({ sourceStart: active.replayTime }))}</span><span>${active.actionsApplied || 0} udført · ${active.actionsSkipped || 0} sprunget over · ${active.queuedActions || 0} i kø</span>${active.lastError ? `<span class="replay-warning">Seneste fejl: ${escapeHtml(active.lastError)}</span>` : ''}</div>`
    : '<div class="replay-idle"><strong>Replay er ikke i gang</strong><span>Standard: samme tidspunkt for 7 dage siden</span></div>';
  document.getElementById('content').innerHTML = `<section class="replay-panel">
    <div class="replay-heading"><div><p class="replay-kicker">Der er nogen hjemme</p><h2>Historisk replay</h2></div><button class="replay-link" type="button" data-replay-back>Tilbage til lys</button></div>
    ${runStatus}
    <div class="replay-controls">
      <label>Profil<select id="replay-profile"${active ? ' disabled' : ''}>${options}</select></label>
      <label>Tilstand<select id="replay-mode"${active ? ' disabled' : ''}><option value="rolling"${fixedLoop ? '' : ' selected'}>Rullende 1x</option><option value="fixed-loop"${fixedLoop ? ' selected' : ''}>Fast loop</option></select></label>
      <label>Kildetidspunkt<input id="replay-source" type="datetime-local" value="${escapeHtml(toLocalDateTimeValue(active?.sourceStart))}"${active ? ' disabled' : ''}></label>
      <fieldset class="replay-loop-duration" data-fixed-loop-field${fixedLoop ? '' : ' hidden'}><legend>Loop-længde</legend><label><input id="replay-loop-days" type="number" min="0" max="30" step="1" value="${escapeHtml(active?.loopDays ?? 1)}"${active ? ' disabled' : ''}><span>dage</span></label><label><input id="replay-loop-time" type="time" step="60" value="${String(active?.loopHours ?? 0).padStart(2, '0')}:${String(active?.loopMinutes ?? 0).padStart(2, '0')}"${active ? ' disabled' : ''}><span>timer:minutter</span></label></fieldset>
      <label>Hastighed<select id="replay-speed"${!fixedLoop || active ? ' disabled' : ''}><option value="1"${Number(active?.speed || 1) === 1 ? ' selected' : ''}>1x</option><option value="5"${Number(active?.speed) === 5 ? ' selected' : ''}>5x test</option><option value="10"${Number(active?.speed) === 10 ? ' selected' : ''}>10x test</option><option value="60"${Number(active?.speed) === 60 ? ' selected' : ''}>60x test</option></select></label>
      <label>Testvarighed<input id="replay-duration" type="number" min="1" max="10080" placeholder="Ubegrænset"${active ? ' disabled' : ''}></label>
    </div>
    <div id="replay-error" class="replay-warning" hidden></div>
    <button class="replay-primary${active ? ' stop' : ''}" type="button" data-replay-${active ? 'stop' : 'start'}>${active ? 'Stop replay' : 'Start replay nu'}</button>
  </section>
  <section class="replay-config">
    <div class="replay-config-sidebar">
      <p class="replay-kicker">Profiler</p>
      ${data.profiles.map((profile) => `<button type="button" class="replay-profile${profile.id === selectedProfile?.id ? ' active' : ''}" data-replay-profile="${escapeHtml(profile.id)}"><strong>${escapeHtml(profile.name)}</strong><span>${profile.deviceIds.length} enheder${profile.isDefault ? ' · standard' : ''}</span></button>`).join('')}
      <button type="button" class="replay-link" data-replay-new>Ny profil</button>
    </div>
    <form id="replay-profile-form" class="replay-config-main" data-profile-id="${escapeHtml(selectedProfile?.id || '')}">
      <div class="replay-profile-fields"><label>Profilnavn<input name="name" maxlength="80" value="${escapeHtml(selectedProfile?.name || '')}" required></label><label class="replay-default"><input name="isDefault" type="checkbox"${selectedProfile?.isDefault ? ' checked' : ''}> Vælg som standard</label></div>
      <div class="replay-config-actions"><button type="button" class="replay-delete" data-replay-delete${data.profiles.length === 1 ? ' disabled' : ''}>Slet profil</button><button type="submit" class="replay-primary">Gem profil</button></div>
      <div class="replay-selection-heading"><div><h2>Lys</h2><p>Farve, dæmpning og tænd/sluk afspilles, når enheden understøtter det.</p></div><div><button type="button" class="replay-link" data-replay-select="lights">Vælg alle</button><button type="button" class="replay-link" data-replay-clear="lights">Fravælg alle</button></div></div>
      <div class="replay-device-grid" data-device-group="lights">${lights.map((device) => renderReplayDevice(device, selected.has(device.id))).join('')}</div>
      <div class="replay-selection-heading"><div><h2>Øvrige enheder</h2><p>Kun tænd/sluk afspilles. Vælg bevidst enheder, der er sikre at automatisere.</p></div><div><button type="button" class="replay-link" data-replay-select="others">Vælg alle</button><button type="button" class="replay-link" data-replay-clear="others">Fravælg alle</button></div></div>
      <div class="replay-device-grid" data-device-group="others">${others.map((device) => renderReplayDevice(device, selected.has(device.id))).join('')}</div>
      <div id="replay-config-error" class="replay-warning" hidden></div>
    </form>
  </section>`;
}

async function loadReplayConfig(selectedProfileId) {
  setRefreshDisabled(true);
  setActiveView('replay');
  try {
    const response = await fetch('/api/replay', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    renderReplayConfig(data, selectedProfileId);
    scheduleRefresh(replayRunning);
  } catch (error) {
    document.getElementById('content').innerHTML = `<section class="error">Kunne ikke hente replay-profiler: ${escapeHtml(error.message || error)}</section>`;
  } finally {
    setRefreshDisabled(false);
  }
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

function isThresholdDialogOpen() {
  const overlay = document.getElementById('threshold-overlay');
  return overlay ? !overlay.hidden : false;
}

function setThresholdDialogError(message) {
  const error = document.getElementById('threshold-error');
  error.textContent = message || '';
  error.hidden = !message;
}

function updateThresholdOutput() {
  const slider = document.getElementById('threshold-slider');
  const output = document.getElementById('threshold-output');
  const value = clampSoilThreshold(slider.value);
  output.value = `${value} %`;
  output.textContent = `${value} %`;
}

function setThresholdSaving(saving) {
  const slider = document.getElementById('threshold-slider');
  const save = document.getElementById('threshold-save');
  const cancel = document.getElementById('threshold-cancel');
  slider.disabled = saving;
  save.disabled = saving;
  cancel.disabled = saving;
  save.textContent = saving ? 'Gemmer...' : 'Gem grænse';
}

function openThresholdDialog(apiDeviceId) {
  const device = findSoilDevice(apiDeviceId);
  if (!device || !device.controls?.canSetAlarmThreshold) return;

  const overlay = document.getElementById('threshold-overlay');
  const title = document.getElementById('threshold-title');
  const subtitle = document.getElementById('threshold-subtitle');
  const slider = document.getElementById('threshold-slider');
  const value = clampSoilThreshold(device.values.alarmThreshold);

  thresholdDialogDeviceId = device.apiDeviceId;
  title.textContent = device.name;
  subtitle.textContent = `${formatZonePath(device)} · alarm under denne fugtighed`;
  slider.value = value;
  setThresholdDialogError('');
  setThresholdSaving(false);
  updateThresholdOutput();
  overlay.hidden = false;
  document.body.classList.add('modal-open');
  slider.focus();
}

function closeThresholdDialog() {
  const overlay = document.getElementById('threshold-overlay');
  thresholdDialogDeviceId = null;
  overlay.hidden = true;
  document.body.classList.remove('modal-open');
  setThresholdDialogError('');
}

async function saveSoilThreshold(event) {
  event.preventDefault();
  if (!thresholdDialogDeviceId) return;

  const slider = document.getElementById('threshold-slider');
  const value = clampSoilThreshold(slider.value);
  setThresholdDialogError('');
  setThresholdSaving(true);

  try {
    const response = await fetch(`/api/soil-sensors/${encodeURIComponent(thresholdDialogDeviceId)}/threshold`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    closeThresholdDialog();
    await loadDashboard();
  } catch (error) {
    setThresholdDialogError(error.message || String(error));
    setThresholdSaving(false);
  }
}

async function loadOverviewDashboard() {
  setRefreshDisabled(true);
  setActiveView('home');

  try {
    const response = await fetch('/api/overview-dashboard', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    renderOverviewDashboard(data);
    scheduleRefresh();
  } catch (error) {
    document.getElementById('content').innerHTML = `<section class="error">Kunne ikke hente dashboard: ${escapeHtml(error.message || error)}</section>`;
    scheduleRefresh();
  } finally {
    setRefreshDisabled(false);
  }
}

async function loadDashboard() {
  setRefreshDisabled(true);
  setActiveView('soil');

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
    setRefreshDisabled(false);
  }
}

async function loadWateringDashboard() {
  setRefreshDisabled(true);
  setActiveView('watering');

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
    setRefreshDisabled(false);
  }
}

async function loadContactDashboard() {
  setRefreshDisabled(true);
  setActiveView('contact');

  try {
    const response = await fetch('/api/contact-dashboard', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    renderContactDashboard(data);
    scheduleRefresh();
  } catch (error) {
    document.getElementById('content').innerHTML = `<section class="error">Kunne ikke hente kontaktstatus: ${escapeHtml(error.message || error)}</section>`;
    scheduleRefresh();
  } finally {
    setRefreshDisabled(false);
  }
}

async function loadMotionDashboard() {
  setRefreshDisabled(true);
  setActiveView('motion');

  try {
    const response = await fetch('/api/motion-dashboard', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    renderMotionDashboard(data);
    scheduleRefresh();
  } catch (error) {
    document.getElementById('content').innerHTML = `<section class="error">Kunne ikke hente bevægelsesstatus: ${escapeHtml(error.message || error)}</section>`;
    scheduleRefresh();
  } finally {
    setRefreshDisabled(false);
  }
}

async function loadLightsDashboard() {
  setRefreshDisabled(true);
  setActiveView('lights');

  try {
    const [lightsResponse, replayResponse] = await Promise.all([
      fetch('/api/lights-dashboard', { cache: 'no-store' }),
      fetch('/api/replay', { cache: 'no-store' }),
    ]);
    const [lights, replay] = await Promise.all([lightsResponse.json(), replayResponse.json()]);
    if (!lightsResponse.ok) throw new Error(lights.error || lightsResponse.statusText);
    if (!replayResponse.ok) throw new Error(replay.error || replayResponse.statusText);
    renderLightsDashboard(lights);
    renderReplayStatus(replay);
    scheduleRefresh();
  } catch (error) {
    document.getElementById('content').innerHTML = `<section class="error">Kunne ikke hente lysstatus: ${escapeHtml(error.message || error)}</section>`;
    scheduleRefresh();
  } finally {
    setRefreshDisabled(false);
  }
}

function normalizeEnergyPeriodOffset(value) {
  const offset = Number(value);
  if (!Number.isFinite(offset)) return 0;
  return Math.min(0, Math.trunc(offset));
}

async function loadEnergyDashboard(period = activeEnergyPeriod, offset = activeEnergyPeriodOffset) {
  setRefreshDisabled(true);
  activeEnergyPeriod = period;
  activeEnergyPeriodOffset = normalizeEnergyPeriodOffset(offset);
  setActiveView('energy');
  const { scrollY } = window;

  try {
    const params = new URLSearchParams({
      period: activeEnergyPeriod,
      offset: String(activeEnergyPeriodOffset),
    });
    const response = await fetch(`/api/energy-dashboard?${params.toString()}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    activeEnergyPeriod = data.period || activeEnergyPeriod;
    activeEnergyPeriodOffset = normalizeEnergyPeriodOffset(data.offset);
    renderEnergyDashboard(data);
    if (scrollY > 0) window.scrollTo({ top: scrollY });
    scheduleRefresh();
  } catch (error) {
    document.getElementById('content').innerHTML = `<section class="error">Kunne ikke hente elprisstatus: ${escapeHtml(error.message || error)}</section>`;
    scheduleRefresh();
  } finally {
    setRefreshDisabled(false);
  }
}

async function loadVehicleDashboard() {
  setRefreshDisabled(true);
  setActiveView('vehicle');
  try {
    const response = await fetch('/api/vehicle-dashboard', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    renderVehicleDashboard(data);
    scheduleRefresh();
  } catch (error) {
    document.getElementById('content').innerHTML = `<section class="error">Kunne ikke hente bilen: ${escapeHtml(error.message || error)}</section>`;
    scheduleRefresh();
  } finally {
    setRefreshDisabled(false);
  }
}

async function setLightOnOff(deviceId, value, button) {
  button.disabled = true;
  button.textContent = value ? 'Tænder...' : 'Slukker...';

  try {
    const response = await fetch(`/api/lights/${encodeURIComponent(deviceId)}/onoff`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    await loadLightsDashboard();
  } catch (error) {
    document.getElementById('content').insertAdjacentHTML('afterbegin', `<section class="error">Kunne ikke styre lys: ${escapeHtml(error.message || error)}</section>`);
    button.disabled = false;
    button.textContent = value ? 'Tænd' : 'Sluk';
  }
}

function showReplayError(id, message) {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = message || '';
  element.hidden = !message;
}

async function startReplay(button) {
  button.disabled = true;
  button.textContent = 'Starter...';
  showReplayError('replay-error', '');
  try {
    const sourceValue = document.getElementById('replay-source').value;
    const profileId = document.getElementById('replay-profile').value;
    const [loopHours, loopMinutes] = document.getElementById('replay-loop-time').value.split(':').map(Number);
    const response = await fetch('/api/replay/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profileId,
        mode: document.getElementById('replay-mode').value,
        sourceStart: sourceValue ? new Date(sourceValue).toISOString() : null,
        speed: Number(document.getElementById('replay-speed').value),
        loopDays: Number(document.getElementById('replay-loop-days').value),
        loopHours,
        loopMinutes,
        durationMinutes: document.getElementById('replay-duration').value || null,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    await loadReplayConfig(profileId);
  } catch (error) {
    showReplayError('replay-error', error.message || error);
    button.disabled = false;
    button.textContent = 'Start replay nu';
  }
}

async function stopReplay(button) {
  button.disabled = true;
  button.textContent = 'Stopper...';
  try {
    const response = await fetch('/api/replay/runs/stop', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    await loadReplayConfig();
  } catch (error) {
    showReplayError('replay-error', error.message || error);
    button.disabled = false;
    button.textContent = 'Stop replay';
  }
}

async function saveReplayProfiles(profiles) {
  const response = await fetch('/api/replay/profiles', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profiles }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data.profiles;
}

async function saveReplayProfile(event) {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  button.textContent = 'Gemmer...';
  showReplayError('replay-config-error', '');
  try {
    const response = await fetch('/api/replay', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    const profile = {
      id: form.dataset.profileId,
      name: form.elements.name.value,
      isDefault: form.elements.isDefault.checked,
      deviceIds: [...form.querySelectorAll('[name="replay-device"]:checked')].map((input) => input.value),
    };
    const profiles = data.profiles.map((item) => (item.id === profile.id ? profile : {
      ...item,
      isDefault: profile.isDefault ? false : item.isDefault,
    }));
    await saveReplayProfiles(profiles);
    replayConfigDirty = false;
    await loadReplayConfig(profile.id);
  } catch (error) {
    showReplayError('replay-config-error', error.message || error);
    button.disabled = false;
    button.textContent = 'Gem profil';
  }
}

async function createReplayProfile() {
  try {
    const response = await fetch('/api/replay', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    const id = window.crypto.randomUUID();
    await saveReplayProfiles(data.profiles.concat({
      id, name: 'Ny profil', isDefault: false, deviceIds: data.devices.filter((device) => device.isLight).map((device) => device.id),
    }));
    await loadReplayConfig(id);
  } catch (error) {
    showReplayError('replay-config-error', error.message || error);
  }
}

async function deleteReplayProfile() {
  const form = document.getElementById('replay-profile-form');
  try {
    const response = await fetch('/api/replay', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    await saveReplayProfiles(data.profiles.filter((profile) => profile.id !== form.dataset.profileId));
    await loadReplayConfig();
  } catch (error) {
    showReplayError('replay-config-error', error.message || error);
  }
}

function setIntervalDialogError(message) {
  const error = document.getElementById('interval-error');
  error.textContent = message || '';
  error.hidden = !message;
}

function updateIntervalOutput() {
  const slider = document.getElementById('interval-slider');
  const output = document.getElementById('interval-output');
  output.value = `${slider.value} min`;
  output.textContent = `${slider.value} min`;
  const maxCyclesSlider = document.getElementById('max-cycles-slider');
  const maxCyclesOutput = document.getElementById('max-cycles-output');
  maxCyclesOutput.value = maxCyclesSlider.value;
  maxCyclesOutput.textContent = maxCyclesSlider.value;
}

function setIntervalSaving(saving) {
  document.getElementById('interval-slider').disabled = saving;
  document.getElementById('max-cycles-slider').disabled = saving;
  document.getElementById('interval-save').disabled = saving;
  document.getElementById('interval-cancel').disabled = saving;
  document.getElementById('interval-save').textContent = saving ? 'Gemmer...' : 'Gem indstillinger';
}

function openIntervalDialog(valveId, currentValue, currentMaxCycles) {
  intervalDialogValveId = valveId;
  document.getElementById('interval-title').textContent = document.querySelector(`[data-watering-valve-id="${valveId}"]`).closest('.sensor').querySelector('.name').textContent;
  document.getElementById('interval-slider').value = currentValue;
  const hasMaxCycles = Number.isInteger(currentMaxCycles);
  document.getElementById('max-cycles-setting').hidden = !hasMaxCycles;
  document.getElementById('max-cycles-slider').value = hasMaxCycles ? currentMaxCycles : 1;
  setIntervalDialogError('');
  setIntervalSaving(false);
  updateIntervalOutput();
  document.getElementById('interval-overlay').hidden = false;
  document.body.classList.add('modal-open');
  document.getElementById('interval-slider').focus();
}

function closeIntervalDialog() {
  intervalDialogValveId = null;
  document.getElementById('interval-overlay').hidden = true;
  document.body.classList.remove('modal-open');
  setIntervalDialogError('');
}

async function saveWateringCycleDuration(event) {
  event.preventDefault();
  if (!intervalDialogValveId) return;

  const value = Number(document.getElementById('interval-slider').value);
  const maxCyclesSetting = document.getElementById('max-cycles-setting');
  const maxCycles = Number(document.getElementById('max-cycles-slider').value);
  const valveId = intervalDialogValveId;
  setIntervalDialogError('');
  setIntervalSaving(true);

  try {
    const response = await fetch(`/api/watering/${encodeURIComponent(intervalDialogValveId)}/cycle-duration`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    if (!maxCyclesSetting.hidden) {
      const maxCyclesResponse = await fetch(`/api/watering/${encodeURIComponent(valveId)}/max-cycles`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: maxCycles }),
      });
      const maxCyclesData = await maxCyclesResponse.json();
      if (!maxCyclesResponse.ok) throw new Error(maxCyclesData.error || maxCyclesResponse.statusText);
      wateringMaxCycleOverrides.set(valveId, maxCycles);
    }
    wateringDurationOverrides.set(valveId, value);
    closeIntervalDialog();
    document.querySelectorAll(`[data-watering-valve-id="${valveId}"]`).forEach((button) => {
      button.dataset.cycleDuration = String(value);
      if (!maxCyclesSetting.hidden) button.dataset.maxCycles = String(maxCycles);
      if (button.dataset.wateringSetting === 'duration') button.textContent = `${value} min`;
      if (button.dataset.wateringSetting === 'max-cycles') button.textContent = String(maxCycles);
    });
  } catch (error) {
    setIntervalDialogError(error.message || String(error));
    setIntervalSaving(false);
  }
}

async function restartWateringAfterError(valveId, button) {
  // eslint-disable-next-line no-alert
  if (!window.confirm('Nulstil vandingsfejlen? Automatikken genstarter kun vandingen, hvis der stadig er behov.')) return;

  button.disabled = true;
  button.textContent = 'Nulstiller...';
  try {
    const response = await fetch(`/api/watering/${encodeURIComponent(valveId)}/restart`, {
      method: 'POST',
      cache: 'no-store',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    wateringErrorOverrides.set(valveId, false);
    button.textContent = 'Fejl nulstillet';
    window.setTimeout(loadWateringDashboard, 700);
  } catch (error) {
    button.disabled = false;
    button.textContent = `Kunne ikke nulstille: ${error.message || error}`;
  }
}

async function toggleWateringForbiddenForValve(button) {
  const valveId = button.dataset.wateringForbidden;
  const nextValue = button.dataset.wateringForbiddenValue !== 'true';
  button.disabled = true;
  try {
    const response = await fetch(`/api/watering/${encodeURIComponent(valveId)}/forbidden`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: nextValue }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    await loadWateringDashboard();
  } catch (error) {
    button.disabled = false;
    button.textContent = `Kunne ikke ændre: ${error.message || error}`;
  }
}

function getIssueCounterLabel(type) {
  return type === 'maintenance' ? 'flyt/rens' : 'offline';
}

function showSoilCounterError(error) {
  document.getElementById('content').insertAdjacentHTML(
    'afterbegin',
    `<section class="error">Kunne ikke nulstille tæller: ${escapeHtml(error.message || error)}</section>`,
  );
}

async function resetSoilIssueCounter(deviceId, type, button) {
  const device = findSoilDevice(deviceId);
  const label = getIssueCounterLabel(type);
  const name = device?.name || 'sensoren';

  // eslint-disable-next-line no-alert
  if (!window.confirm(`Nulstil ${label}-tæller for ${name}?`)) return;

  button.disabled = true;

  try {
    const response = await fetch(`/api/soil-sensors/${encodeURIComponent(deviceId)}/counters/${encodeURIComponent(type)}/reset`, {
      method: 'POST',
      cache: 'no-store',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    await loadDashboard();
  } catch (error) {
    showSoilCounterError(error);
    button.disabled = false;
  }
}

async function resetAllSoilIssueCounters(button) {
  // eslint-disable-next-line no-alert
  if (!window.confirm('Nulstil alle offline- og flyt/rens-tællere?')) return;

  button.disabled = true;
  button.textContent = 'Nulstiller...';

  try {
    const response = await fetch('/api/soil-sensors/counters/reset', {
      method: 'POST',
      cache: 'no-store',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    await loadDashboard();
  } catch (error) {
    showSoilCounterError(error);
    button.disabled = false;
    button.textContent = 'Nulstil alle tællere';
  }
}

function loadActiveView() {
  if (activeView === 'home') {
    loadOverviewDashboard();
    return;
  }

  if (activeView === 'watering') {
    loadWateringDashboard();
    return;
  }

  if (activeView === 'circuits') {
    loadWateringCircuitPage();
    return;
  }

  if (activeView === 'contact') {
    loadContactDashboard();
    return;
  }

  if (activeView === 'motion') {
    loadMotionDashboard();
    return;
  }

  if (activeView === 'lights') {
    loadLightsDashboard();
    return;
  }

  if (activeView === 'replay') {
    loadReplayConfig();
    return;
  }

  if (activeView === 'energy') {
    loadEnergyDashboard();
    return;
  }

  if (activeView === 'vehicle') {
    loadVehicleDashboard();
    return;
  }

  loadDashboard();
}

document.getElementById('refresh')?.addEventListener('click', loadActiveView);
document.getElementById('home-tab').addEventListener('click', loadOverviewDashboard);
document.getElementById('soil-tab').addEventListener('click', loadDashboard);
document.getElementById('watering-tab').addEventListener('click', loadWateringDashboard);
document.getElementById('contact-tab').addEventListener('click', loadContactDashboard);
document.getElementById('motion-tab').addEventListener('click', loadMotionDashboard);
document.getElementById('lights-tab').addEventListener('click', loadLightsDashboard);
document.getElementById('energy-tab').addEventListener('click', () => loadEnergyDashboard());
document.getElementById('vehicle-tab').addEventListener('click', loadVehicleDashboard);
document.getElementById('content').addEventListener('click', (event) => {
  if (event.target.closest('[data-watering-circuit-page]')) {
    loadWateringCircuitPage();
    return;
  }
  if (event.target.closest('[data-watering-circuit-new]')) {
    resetWateringCircuitLabel();
    return;
  }
  if (event.target.closest('[data-watering-circuit-back]')) {
    loadWateringDashboard();
    return;
  }
  const applyCircuit = event.target.closest('[data-watering-circuit-apply]');
  if (applyCircuit) {
    applyWateringCircuit(applyCircuit.dataset.wateringCircuitApply);
    return;
  }
  const migrateCircuit = event.target.closest('[data-watering-circuit-migrate]');
  if (migrateCircuit) {
    migrateWateringCircuit(migrateCircuit.dataset.wateringCircuitMigrate);
    return;
  }
  const removeCircuit = event.target.closest('[data-watering-circuit-remove]');
  if (removeCircuit) {
    removeWateringCircuit(removeCircuit.dataset.wateringCircuitRemove);
    return;
  }
  const replayStart = event.target.closest('[data-replay-start]');
  if (replayStart) {
    startReplay(replayStart);
    return;
  }

  const replayStop = event.target.closest('[data-replay-stop]');
  if (replayStop) {
    stopReplay(replayStop);
    return;
  }

  if (event.target.closest('[data-replay-config]')) {
    loadReplayConfig();
    return;
  }

  if (event.target.closest('[data-replay-back]')) {
    loadLightsDashboard();
    return;
  }

  const replayProfile = event.target.closest('[data-replay-profile]');
  if (replayProfile) {
    loadReplayConfig(replayProfile.dataset.replayProfile);
    return;
  }

  if (event.target.closest('[data-replay-new]')) {
    createReplayProfile();
    return;
  }

  if (event.target.closest('[data-replay-delete]')) {
    deleteReplayProfile();
    return;
  }

  const selectGroup = event.target.closest('[data-replay-select]');
  const clearGroup = event.target.closest('[data-replay-clear]');
  if (selectGroup || clearGroup) {
    const group = (selectGroup || clearGroup).dataset.replaySelect || (selectGroup || clearGroup).dataset.replayClear;
    document.querySelectorAll(`[data-device-group="${group}"] input`).forEach((input) => {
      input.checked = Boolean(selectGroup);
    });
    replayConfigDirty = true;
    return;
  }
  const intervalButton = event.target.closest('[data-watering-valve-id]');
  if (intervalButton) {
    openIntervalDialog(
      intervalButton.dataset.wateringValveId,
      Number(intervalButton.dataset.cycleDuration),
      intervalButton.dataset.maxCycles ? Number(intervalButton.dataset.maxCycles) : null,
    );
    return;
  }

  const wateringRestartButton = event.target.closest('[data-watering-restart]');
  if (wateringRestartButton) {
    restartWateringAfterError(wateringRestartButton.dataset.wateringRestart, wateringRestartButton);
    return;
  }
  const wateringForbiddenButton = event.target.closest('[data-watering-forbidden]');
  if (wateringForbiddenButton) {
    toggleWateringForbiddenForValve(wateringForbiddenButton);
    return;
  }

  const counterButton = event.target.closest('[data-counter-device-id][data-counter-type]');
  if (counterButton) {
    resetSoilIssueCounter(counterButton.dataset.counterDeviceId, counterButton.dataset.counterType, counterButton);
    return;
  }

  const resetAllCountersButton = event.target.closest('[data-reset-all-counters]');
  if (resetAllCountersButton) {
    resetAllSoilIssueCounters(resetAllCountersButton);
    return;
  }

  const thresholdButton = event.target.closest('[data-threshold-device-id]');
  if (thresholdButton) {
    if (!thresholdButton.disabled) openThresholdDialog(thresholdButton.dataset.thresholdDeviceId);
    return;
  }

  const periodButton = event.target.closest('[data-energy-period]');
  if (periodButton) {
    loadEnergyDashboard(periodButton.dataset.energyPeriod, 0);
    return;
  }

  const periodNavigationButton = event.target.closest('[data-energy-period-delta]');
  if (periodNavigationButton) {
    const delta = Number(periodNavigationButton.dataset.energyPeriodDelta);
    if (Number.isFinite(delta)) loadEnergyDashboard(activeEnergyPeriod, activeEnergyPeriodOffset + delta);
    return;
  }

  const lightButton = event.target.closest('[data-light-id]');
  if (lightButton) {
    setLightOnOff(lightButton.dataset.lightId, lightButton.dataset.lightValue === 'true', lightButton);
    return;
  }

  const card = event.target.closest('[data-view]');
  if (!card) return;

  const loaders = {
    soil: loadDashboard,
    watering: loadWateringDashboard,
    contact: loadContactDashboard,
    motion: loadMotionDashboard,
    lights: loadLightsDashboard,
    energy: loadEnergyDashboard,
    vehicle: loadVehicleDashboard,
  };
  loaders[card.dataset.view]?.();
});
document.getElementById('content').addEventListener('change', (event) => {
  if (event.target.id === 'replay-mode') updateReplayModeFields();
  if (event.target.closest('#replay-profile-form')) replayConfigDirty = true;
});
document.getElementById('content').addEventListener('input', (event) => {
  if (event.target.closest('#replay-profile-form')) replayConfigDirty = true;
});
document.getElementById('content').addEventListener('submit', (event) => {
  if (event.target.id === 'watering-circuit-form') {
    event.preventDefault();
    planWateringCircuit(event.target);
    return;
  }
  if (event.target.id === 'replay-profile-form') saveReplayProfile(event);
});
document.getElementById('watering-mode-card').addEventListener('click', () => {
  const button = document.getElementById('watering-mode-toggle');
  if (button.disabled) return;
  toggleWateringMode();
});
document.getElementById('interval-slider').addEventListener('input', updateIntervalOutput);
document.getElementById('max-cycles-slider').addEventListener('input', updateIntervalOutput);
document.getElementById('interval-cancel').addEventListener('click', closeIntervalDialog);
document.getElementById('interval-form').addEventListener('submit', saveWateringCycleDuration);
document.getElementById('threshold-slider').addEventListener('input', updateThresholdOutput);
document.getElementById('threshold-form').addEventListener('submit', saveSoilThreshold);
document.getElementById('threshold-cancel').addEventListener('click', closeThresholdDialog);
document.getElementById('threshold-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'threshold-overlay') closeThresholdDialog();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (activeView === 'replay' && !replayRunning) {
      updateRefreshNote();
      return;
    }
    loadActiveView();
    return;
  }

  updateRefreshNote();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isThresholdDialogOpen()) closeThresholdDialog();
});
window.addEventListener('hashchange', () => {
  const nextView = getViewFromHash();
  if (nextView === activeView) return;

  setActiveView(nextView, false);
  loadActiveView();
});
window.addEventListener('resize', () => {
  if (!latestDashboard) return;
  renderGraphs();
});
setActiveView(getViewFromHash(), false);
loadActiveView();
