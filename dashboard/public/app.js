'use strict';

/* global document, window */
/* eslint-disable no-use-before-define */

const REFRESH_INTERVAL_MS_BY_VIEW = {
  home: 3000,
  soil: 3000,
  watering: 10000,
  contact: 3000,
  motion: 3000,
  lights: 3000,
  energy: 5 * 60 * 1000,
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
const VIEWS = ['home', 'soil', 'watering', 'contact', 'motion', 'lights', 'energy'];
let nextRefreshAt = 0;
let refreshTimer = null;
let latestDashboard = null;
let graphDevices = [];
let activeView = 'home';
let activeEnergyPeriod = 'day';
let activeEnergyPeriodOffset = 0;
let thresholdDialogDeviceId = null;

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
        <div class="name">${escapeHtml(device.name)}</div>
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

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);

  nextRefreshAt = Date.now() + (REFRESH_INTERVAL_MS_BY_VIEW[activeView] || 3000);
  updateRefreshNote();
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') {
      updateRefreshNote();
      return;
    }

    if (Date.now() >= nextRefreshAt) {
      if (isThresholdDialogOpen()) {
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
  document.getElementById('watering-tab').classList.toggle('active', activeView === 'watering');
  document.getElementById('contact-tab').classList.toggle('active', activeView === 'contact');
  document.getElementById('motion-tab').classList.toggle('active', activeView === 'motion');
  document.getElementById('lights-tab').classList.toggle('active', activeView === 'lights');
  document.getElementById('energy-tab').classList.toggle('active', activeView === 'energy');
  document.querySelector('.summary').hidden = activeView === 'home';
  document.getElementById('watering-mode-card').hidden = !['soil', 'watering'].includes(activeView);
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
  const normalDevices = devices.filter((device) => !device.needsAction);

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
  setDashboardTitle('Vanding');
  setSummaryThirdCardVisible(true);
  setSummaryLabels('Ventiler', 'Aktive', 'Liter / 14 dage');

  document.getElementById('total-devices').textContent = data.totals.valves;
  document.getElementById('total-alarms').textContent = data.totals.active;
  document.getElementById('total-offline').textContent = data.totals.waterLiters.toLocaleString('da-DK', { maximumFractionDigits: 1 });
  setUpdatedAt(data.generatedAt);

  const content = document.getElementById('content');
  if (data.valves.length === 0) {
    content.innerHTML = '<section class="empty">Ingen vandingsventiler fundet.</section>';
    return;
  }

  const errors = data.totals.errors > 0 ? `<section class="error">${data.totals.errors} ventil(er) kunne ikke hente fuld Insights-historik.</section>` : '';
  content.innerHTML = `${errors}<section><h2 class="section-title">Vandingsventiler</h2><div class="grid">${data.valves.map(renderWateringValve).join('')}</div></section>`;
}

function renderContactSensor(sensor) {
  const error = sensor.error ? `<p class="valve-error">Insights-fejl: ${escapeHtml(sensor.error)}</p>` : '';
  const duration = formatContactDuration(sensor.openDurationMs);

  return `<article class="sensor contact active${sensor.error ? ' offline' : ''}">
    <div class="topline">
      <div>
        <div class="zone">${escapeHtml(formatZonePath(sensor))}</div>
        <div class="name">${escapeHtml(sensor.name)}</div>
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
        <div class="name">${escapeHtml(device.name)}</div>
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
    const response = await fetch('/api/lights-dashboard', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    renderLightsDashboard(data);
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

  if (activeView === 'energy') {
    loadEnergyDashboard();
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
document.getElementById('content').addEventListener('click', (event) => {
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
  };
  loaders[card.dataset.view]?.();
});
document.getElementById('watering-mode-card').addEventListener('click', () => {
  const button = document.getElementById('watering-mode-toggle');
  if (button.disabled) return;
  toggleWateringMode();
});
document.getElementById('threshold-slider').addEventListener('input', updateThresholdOutput);
document.getElementById('threshold-form').addEventListener('submit', saveSoilThreshold);
document.getElementById('threshold-cancel').addEventListener('click', closeThresholdDialog);
document.getElementById('threshold-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'threshold-overlay') closeThresholdDialog();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
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
