"use strict";

/* eslint-disable no-console, no-use-before-define */

const http = require("http");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 8788);
const INGEST_TOKEN = process.env.INGEST_TOKEN || "";
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://homey_wingman:homey_wingman@postgres:5432/homey_wingman";
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1024 * 1024);
const DEFAULT_PRICE_AREA = process.env.DEFAULT_PRICE_AREA || "DK1";
const PRICE_IMPORT_ENABLED = process.env.PRICE_IMPORT_ENABLED !== "false";
const PRICE_IMPORT_INTERVAL_MS = Number(
  process.env.PRICE_IMPORT_INTERVAL_MS || 6 * 60 * 60 * 1000,
);
const PRICE_IMPORT_LOOKBACK_DAYS = Number(
  process.env.PRICE_IMPORT_LOOKBACK_DAYS || 3,
);
const PRICE_IMPORT_LOOKAHEAD_DAYS = Number(
  process.env.PRICE_IMPORT_LOOKAHEAD_DAYS || 2,
);
const ENERGY_USAGE_AUTO_REBUILD_ENABLED =
  process.env.ENERGY_USAGE_AUTO_REBUILD_ENABLED !== "false";
const ENERGY_USAGE_AUTO_REBUILD_INTERVAL_MS = Number(
  process.env.ENERGY_USAGE_AUTO_REBUILD_INTERVAL_MS || 5 * 60 * 1000,
);
const ENERGY_USAGE_AUTO_REBUILD_LOOKBACK_DAYS = Number(
  process.env.ENERGY_USAGE_AUTO_REBUILD_LOOKBACK_DAYS || 45,
);
const ELSPOT_API_URL =
  process.env.ELSPOT_API_URL ||
  "https://api.energidataservice.dk/dataset/Elspotprices";
const ELSPOT_FALLBACK_API_URL =
  process.env.ELSPOT_FALLBACK_API_URL ||
  "https://www.elprisenligenu.dk/api/v1/prices";
const ELSPOT_PRIMARY_ENABLED = process.env.ELSPOT_PRIMARY_ENABLED === "true";
const ELECTRICITY_TAX_DKK_PER_KWH = Number(
  process.env.ELECTRICITY_TAX_DKK_PER_KWH || 0,
);
const VAT_RATE = Number(process.env.VAT_RATE || 0.25);
const N1_TARIFF_RULES_JSON = process.env.N1_TARIFF_RULES_JSON || "[]";
const DATAHUB_PRICELIST_API_URL =
  process.env.DATAHUB_PRICELIST_API_URL ||
  "https://api.energidataservice.dk/dataset/DatahubPricelist";
const DEFAULT_DATAHUB_PRICE_COMPONENTS = [
  {
    name: "N1 nettarif C",
    kind: "grid",
    gln: "5790001089030",
    chargeType: "D03",
    chargeTypeCode: "CD",
    resolutionDuration: "PT1H",
  },
  {
    name: "Energinet transmissions nettarif",
    kind: "grid",
    gln: "5790000432752",
    chargeType: "D03",
    chargeTypeCode: "40000",
  },
  {
    name: "Energinet systemtarif",
    kind: "grid",
    gln: "5790000432752",
    chargeType: "D03",
    chargeTypeCode: "41000",
  },
  {
    name: "Energinet nettabstarif DK1",
    kind: "grid",
    gln: "5790000432752",
    chargeType: "D03",
    chargeTypeCode: "40021",
    resolutionDuration: "PT1H",
  },
  {
    name: "Elafgift",
    kind: "tax",
    gln: "5790000432752",
    chargeType: "D03",
    chargeTypeCode: "EA-001",
    taxIndicator: "1",
  },
];
const DATAHUB_PRICE_COMPONENTS_JSON =
  process.env.DATAHUB_PRICE_COMPONENTS_JSON ||
  JSON.stringify(DEFAULT_DATAHUB_PRICE_COMPONENTS);
const ENERGY_CAPABILITIES = ["meter_power", "meter_power.imported", "meter_power.exported"];
const ENERGY_METER_MIGRATIONS = JSON.parse(process.env.ENERGY_METER_MIGRATIONS_JSON || "[]");
for (const migration of ENERGY_METER_MIGRATIONS) {
  if (!migration.previousId || !migration.currentId || !Number.isFinite(Date.parse(migration.switchedAt)))
    throw new Error("Invalid ENERGY_METER_MIGRATIONS_JSON");
}
const ENERGY_INTERVALS = new Map([
  ["15m", "15 minutes"],
  ["15min", "15 minutes"],
  ["15 minutes", "15 minutes"],
  ["hour", "1 hour"],
  ["1h", "1 hour"],
  ["1 hour", "1 hour"],
  ["day", "1 day"],
  ["1d", "1 day"],
  ["1 day", "1 day"],
  ["month", "1 month"],
  ["1 month", "1 month"],
]);

const pool = new Pool({ connectionString: DATABASE_URL });
const energyUsageAutoRebuilds = new Map();

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

function isAuthorized(request) {
  if (!INGEST_TOKEN) return false;

  const authorization = request.headers.authorization || "";
  if (authorization === `Bearer ${INGEST_TOKEN}`) return true;
  return request.headers["x-ingest-token"] === INGEST_TOKEN;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function initializeDatabase() {
  await pool.query(`
    create extension if not exists timescaledb;

    create table if not exists ingest_event (
      id bigserial primary key,
      received_at timestamptz not null default now(),
      event_time timestamptz not null,
      homey_device_id text not null,
      homey_zone_id text,
      device_name text,
      driver_id text,
      device_class text,
      capability text not null,
      value_json jsonb not null,
      value_number double precision,
      value_boolean boolean,
      unit text,
      available boolean,
      source_system text not null default 'homey',
      source_instance text,
      source_event_id text,
      author_system text,
      event_type text not null default 'observation',
      causation_id text,
      correlation_id text,
      replay_run_id text,
      payload jsonb not null
    );

    create index if not exists ix_ingest_event_device_capability_time
      on ingest_event (homey_device_id, capability, event_time desc);

    create index if not exists ix_ingest_event_id
      on ingest_event (id);

    create table if not exists state_current (
      homey_device_id text not null,
      capability text not null,
      event_time timestamptz not null,
      received_at timestamptz not null default now(),
      homey_zone_id text,
      device_name text,
      driver_id text,
      device_class text,
      value_json jsonb not null,
      value_number double precision,
      value_boolean boolean,
      unit text,
      available boolean,
      source_system text not null default 'homey',
      source_instance text,
      source_event_id text,
      author_system text,
      event_type text not null default 'observation',
      causation_id text,
      correlation_id text,
      replay_run_id text,
      payload jsonb not null,
      primary key (homey_device_id, capability)
    );

    create table if not exists homey_zone (
      id text primary key,
      name text,
      parent_id text,
      payload jsonb not null,
      synced_at timestamptz not null default now()
    );

    create table if not exists homey_device (
      id text primary key,
      name text,
      zone_id text,
      driver_id text,
      device_class text,
      available boolean,
      capabilities text[] not null default '{}',
      payload jsonb not null,
      synced_at timestamptz not null default now()
    );

    create table if not exists homey_flow (
      id text primary key,
      name text,
      enabled boolean,
      payload jsonb not null,
      synced_at timestamptz not null default now()
    );

    create table if not exists homey_advanced_flow (
      id text primary key,
      name text,
      enabled boolean,
      payload jsonb not null,
      synced_at timestamptz not null default now()
    );

    create table if not exists homey_timer (
      name text primary key,
      payload jsonb not null,
      synced_at timestamptz not null default now()
    );

    create table if not exists homey_logic_variable (
      id text primary key,
      name text not null,
      payload jsonb not null,
      synced_at timestamptz not null default now()
    );

    create table if not exists external_zone (
      id text primary key,
      name text not null,
      payload jsonb not null default '{}'::jsonb,
      synced_at timestamptz not null default now()
    );

    create table if not exists external_device (
      id text primary key,
      name text not null,
      zone_id text,
      driver_id text,
      device_class text,
      available boolean not null default true,
      capabilities text[] not null default '{}',
      payload jsonb not null,
      synced_at timestamptz not null default now()
    );

    create table if not exists device_route (
      id bigserial primary key,
      source_system text not null,
      source_device_id text not null,
      target_system text not null,
      target_device_id text not null,
      valid_from timestamptz not null default '-infinity',
      valid_to timestamptz,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      constraint device_route_validity check (valid_to is null or valid_to > valid_from)
    );

    create unique index if not exists ux_device_route_source_target_from
      on device_route (source_system, source_device_id, target_system, target_device_id, valid_from);

    create index if not exists ix_device_route_source_validity
      on device_route (source_system, source_device_id, valid_from desc);

    create table if not exists price_interval (
      price_area text not null,
      starts_at timestamptz not null,
      ends_at timestamptz not null,
      spot_dkk_per_kwh numeric,
      grid_tariff_dkk_per_kwh numeric,
      taxes_dkk_per_kwh numeric,
      vat_rate numeric,
      effective_dkk_per_kwh numeric not null,
      currency text not null default 'DKK',
      source text,
      payload jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now(),
      primary key (price_area, starts_at),
      constraint price_interval_ends_after_start check (ends_at > starts_at)
    );

    create index if not exists ix_price_interval_area_end
      on price_interval (price_area, ends_at);

    create table if not exists energy_usage_15m (
      bucket_start timestamptz not null,
      bucket_end timestamptz not null,
      homey_device_id text not null,
      device_name text,
      capability text not null,
      kwh numeric not null,
      price_area text not null,
      effective_dkk_per_kwh numeric,
      cost_dkk numeric,
      source text not null default 'meter_delta',
      updated_at timestamptz not null default now(),
      primary key (price_area, bucket_start, homey_device_id, capability),
      constraint energy_usage_15m_ends_after_start check (bucket_end > bucket_start)
    );

    create index if not exists ix_energy_usage_15m_device_time
      on energy_usage_15m (homey_device_id, bucket_start desc);

    alter table energy_usage_15m
      drop constraint if exists energy_usage_15m_kwh_nonnegative;

    create table if not exists zigbee_route_node_observation (
      bucket_start timestamptz not null,
      node_id text not null,
      label text,
      category text,
      node_type text,
      address_label text,
      zone text,
      zone_short text,
      last_seen timestamptz,
      available boolean,
      child_count integer,
      payload jsonb not null default '{}'::jsonb,
      observed_at timestamptz not null default now(),
      primary key (bucket_start, node_id)
    );

    create index if not exists ix_zigbee_route_node_observation_node_time
      on zigbee_route_node_observation (node_id, bucket_start desc);

    create table if not exists zigbee_route_edge_observation (
      bucket_start timestamptz not null,
      source_id text not null,
      target_id text not null,
      source_category text,
      route_depth integer,
      payload jsonb not null default '{}'::jsonb,
      observed_at timestamptz not null default now(),
      primary key (bucket_start, source_id, target_id)
    );

    create index if not exists ix_zigbee_route_edge_observation_edge_time
      on zigbee_route_edge_observation (source_id, target_id, bucket_start desc);

    create table if not exists zigbee_map_layout (
      node_id text primary key,
      x double precision not null,
      y double precision not null,
      updated_at timestamptz not null default now()
    );
  `);

  // Existing deployments predate event provenance; keep their history intact.
  await pool.query(`
    alter table ingest_event add column if not exists source_system text not null default 'homey';
    alter table ingest_event add column if not exists source_instance text;
    alter table ingest_event add column if not exists source_event_id text;
    alter table ingest_event add column if not exists author_system text;
    alter table ingest_event add column if not exists event_type text not null default 'observation';
    alter table ingest_event add column if not exists causation_id text;
    alter table ingest_event add column if not exists correlation_id text;
    alter table ingest_event add column if not exists replay_run_id text;
    alter table state_current add column if not exists source_system text not null default 'homey';
    alter table state_current add column if not exists source_instance text;
    alter table state_current add column if not exists source_event_id text;
    alter table state_current add column if not exists author_system text;
    alter table state_current add column if not exists event_type text not null default 'observation';
    alter table state_current add column if not exists causation_id text;
    alter table state_current add column if not exists correlation_id text;
    alter table state_current add column if not exists replay_run_id text;
    create index if not exists ix_ingest_event_source_event
      on ingest_event (source_system, source_event_id, event_time desc)
      where source_event_id is not null;
    insert into device_route (source_system, source_device_id, target_system, target_device_id)
      select 'homey', id, 'homey', id from homey_device
      on conflict (source_system, source_device_id, target_system, target_device_id, valid_from) do nothing;
  `);

  // eslint-disable-next-line no-use-before-define
  await migrateIngestEventToHypertable();
}

async function migrateIngestEventToHypertable() {
  const extension = await pool.query(`
    select exists (
      select 1 from pg_extension where extname = 'timescaledb'
    ) as installed
  `);
  if (extension.rows[0]?.installed !== true) {
    return;
  }

  const hypertable = await pool.query(`
    select exists (
      select 1 from timescaledb_information.hypertables
      where hypertable_schema = 'public' and hypertable_name = 'ingest_event'
    ) as exists
  `);
  if (hypertable.rows[0]?.exists === true) {
    return;
  }

  await pool.query(`
    alter table ingest_event drop constraint if exists ingest_event_pkey;
    select create_hypertable('ingest_event', 'event_time', if_not_exists => true, migrate_data => true);
  `);
}

function normalizeEvent(payload) {
  const eventTime =
    payload.time ||
    payload.timestamp ||
    payload.event_time ||
    new Date().toISOString();
  const homeyDeviceId =
    payload.homey_device_id || payload.deviceId || payload.device_id;
  const { capability, value } = payload;

  if (!homeyDeviceId) {
    throw new Error("homey_device_id is required");
  }
  if (!capability) {
    throw new Error("capability is required");
  }
  if (Number.isNaN(Date.parse(eventTime))) {
    throw new Error("time must be a valid timestamp");
  }

  const valueNumber =
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const valueBoolean = typeof value === "boolean" ? value : null;
  const sourceSystem = String(
    payload.source_system || payload.sourceSystem || "homey",
  ).trim();
  const eventType = String(
    payload.event_type || payload.eventType || "observation",
  ).trim();
  if (!sourceSystem) throw new Error("source_system must not be empty");
  if (!["observation", "command"].includes(eventType)) {
    throw new Error("event_type must be observation or command");
  }

  return {
    eventTime,
    homeyDeviceId,
    homeyZoneId:
      payload.homey_zone_id || payload.zoneId || payload.zone_id || null,
    deviceName: payload.device_name || payload.deviceName || null,
    driverId: payload.driver_id || payload.driverId || null,
    deviceClass: payload.device_class || payload.deviceClass || null,
    capability,
    value,
    valueNumber,
    valueBoolean,
    unit: payload.unit || null,
    available:
      typeof payload.available === "boolean" ? payload.available : null,
    sourceSystem,
    sourceInstance: payload.source_instance || payload.sourceInstance || null,
    sourceEventId: payload.source_event_id || payload.sourceEventId || null,
    authorSystem: payload.author_system || payload.authorSystem || null,
    eventType,
    causationId: payload.causation_id || payload.causationId || null,
    correlationId: payload.correlation_id || payload.correlationId || null,
    replayRunId: payload.replay_run_id || payload.replayRunId || null,
    payload,
  };
}

function parseTimestamp(value, fieldName) {
  const parsed = value ? new Date(Number(value) || value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new Error(`${fieldName} must be a valid timestamp`);
  }
  return parsed.toISOString();
}

function parseOptionalTimestamp(value, fieldName) {
  return value ? parseTimestamp(value, fieldName) : null;
}

function parseOptionalNumber(value, fieldName) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be a number`);
  }
  return parsed;
}

function normalizePriceInterval(payload) {
  const startsAt = parseTimestamp(
    payload.startsAt || payload.start || payload.from,
    "start",
  );
  const endsAt = parseTimestamp(
    payload.endsAt || payload.end || payload.to,
    "end",
  );
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new Error("end must be after start");
  }

  const spot = parseOptionalNumber(
    payload.spotDkkPerKwh ?? payload.spot,
    "spotDkkPerKwh",
  );
  const gridTariff = parseOptionalNumber(
    payload.gridTariffDkkPerKwh ?? payload.gridTariff,
    "gridTariffDkkPerKwh",
  );
  const taxes = parseOptionalNumber(
    payload.taxesDkkPerKwh ?? payload.taxes,
    "taxesDkkPerKwh",
  );
  const vatRate = parseOptionalNumber(payload.vatRate, "vatRate");
  let effective = parseOptionalNumber(
    payload.effectiveDkkPerKwh ?? payload.effective,
    "effectiveDkkPerKwh",
  );

  if (effective === null) {
    const net = (spot || 0) + (gridTariff || 0) + (taxes || 0);
    effective = vatRate === null ? net : net * (1 + vatRate);
  }
  if (!Number.isFinite(effective)) {
    throw new Error(
      "effectiveDkkPerKwh is required when price components are missing",
    );
  }

  return {
    priceArea: payload.priceArea || payload.area || DEFAULT_PRICE_AREA,
    startsAt,
    endsAt,
    spot,
    gridTariff,
    taxes,
    vatRate,
    effective,
    currency: payload.currency || "DKK",
    source: payload.source || null,
    payload,
  };
}

function getEnergyInterval(value) {
  const key = (value || "hour").toLowerCase();
  const interval = ENERGY_INTERVALS.get(key);
  if (!interval) {
    throw new Error("interval must be one of 15m, hour, day or month");
  }
  return interval;
}

function getN1TariffRules() {
  try {
    const rules = JSON.parse(N1_TARIFF_RULES_JSON);
    return Array.isArray(rules) ? rules : [];
  } catch (error) {
    console.warn(`Ignoring invalid N1_TARIFF_RULES_JSON: ${error.message}`);
    return [];
  }
}

function matchesWrappedRange(value, from, to, max) {
  const start = Number(from ?? 0);
  const end = Number(to ?? max);
  if (start === end) return true;
  if (start < end) return value >= start && value < end;
  return value >= start || value < end;
}

function getN1TariffDkkPerKwh(date) {
  const rules = getN1TariffRules();
  const month = date.getUTCMonth() + 1;
  const hour = date.getUTCHours();
  const match = rules.find((rule) => {
    const monthMatches = matchesWrappedRange(
      month,
      rule.fromMonth,
      rule.toMonth,
      13,
    );
    const hourMatches = matchesWrappedRange(
      hour,
      rule.fromHour,
      rule.toHour,
      24,
    );
    return monthMatches && hourMatches;
  });

  return (
    parseOptionalNumber(
      match?.gridTariffDkkPerKwh ?? match?.tariffDkkPerKwh,
      "gridTariffDkkPerKwh",
    ) || 0
  );
}

function getDatahubPriceComponents() {
  try {
    const components = JSON.parse(DATAHUB_PRICE_COMPONENTS_JSON);
    return Array.isArray(components) ? components : [];
  } catch (error) {
    console.warn(
      `Ignoring invalid DATAHUB_PRICE_COMPONENTS_JSON: ${error.message}`,
    );
    return [];
  }
}

function getDanishHourPriceField(date) {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Copenhagen",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `Price${Number(hour) + 1}`;
}

function isDatahubRowValidFor(row, date) {
  const validFrom = Date.parse(row.ValidFrom);
  const validTo = row.ValidTo
    ? Date.parse(row.ValidTo)
    : Number.POSITIVE_INFINITY;
  const time = date.getTime();
  return Number.isFinite(validFrom) && time >= validFrom && time < validTo;
}

function getDatahubRowPriceForDate(row, date) {
  if (row.ResolutionDuration !== "PT1H") {
    const dailyValue = Number(row.Price1);
    return Number.isFinite(dailyValue) ? dailyValue : 0;
  }

  const field = getDanishHourPriceField(date);
  const value = Number(row[field]);
  return Number.isFinite(value) ? value : 0;
}

function buildDatahubComponentFilter(component) {
  const filter = {};
  if (component.gln || component.glnNumber)
    filter.GLN_Number = component.gln || component.glnNumber;
  if (component.chargeOwner) filter.ChargeOwner = component.chargeOwner;
  if (component.chargeType) filter.ChargeType = component.chargeType;
  if (component.chargeTypeCode)
    filter.ChargeTypeCode = component.chargeTypeCode;
  if (component.taxIndicator !== undefined)
    filter.TaxIndicator = String(component.taxIndicator);
  return filter;
}

function datahubRowMatchesComponent(row, component) {
  if (component.descriptionIncludes) {
    const description =
      `${row.Note || ""} ${row.Description || ""}`.toLowerCase();
    if (
      !description.includes(String(component.descriptionIncludes).toLowerCase())
    )
      return false;
  }
  if (
    component.resolutionDuration &&
    row.ResolutionDuration !== component.resolutionDuration
  )
    return false;
  return true;
}

async function fetchDatahubComponentRows(component) {
  const url = new URL(DATAHUB_PRICELIST_API_URL);
  url.searchParams.set("limit", String(component.limit || 1000));
  url.searchParams.set("sort", "ValidFrom DESC");

  const filter = buildDatahubComponentFilter(component);
  if (Object.keys(filter).length > 0) {
    url.searchParams.set("filter", JSON.stringify(filter));
  }
  if (component.q) {
    url.searchParams.set("q", component.q);
  }

  const json = await fetchJson(url);
  return (Array.isArray(json.records) ? json.records : []).filter((row) =>
    datahubRowMatchesComponent(row, component),
  );
}

async function fetchDatahubComponentRowMap() {
  const components = getDatahubPriceComponents();
  const result = [];

  for (const component of components) {
    try {
      result.push({
        component,
        rows: await fetchDatahubComponentRows(component),
      });
    } catch (error) {
      console.warn(
        `Datahub component ${component.name || component.chargeTypeCode || "unknown"} failed: ${error.message || error}`,
      );
      result.push({ component, rows: [] });
    }
  }

  return result;
}

function calculateDatahubComponentsForDate(componentRows, date) {
  const result = {
    gridTariff: 0,
    taxes: 0,
    other: 0,
    applied: [],
  };

  for (const { component, rows } of componentRows) {
    const row = rows.find((candidate) => isDatahubRowValidFor(candidate, date));
    if (!row) continue;

    const value = getDatahubRowPriceForDate(row, date);
    const kind =
      component.kind || (Number(row.TaxIndicator) === 1 ? "tax" : "grid");
    if (kind === "tax") result.taxes += value;
    else if (kind === "grid") result.gridTariff += value;
    else result.other += value;

    result.applied.push({
      name: component.name || row.ChargeTypeCode,
      kind,
      value,
      chargeOwner: row.ChargeOwner,
      gln: row.GLN_Number,
      chargeType: row.ChargeType,
      chargeTypeCode: row.ChargeTypeCode,
      validFrom: row.ValidFrom,
      validTo: row.ValidTo,
      resolutionDuration: row.ResolutionDuration,
      priceField: getDanishHourPriceField(date),
    });
  }

  return result;
}

function toEnergyDataServiceDate(date) {
  return date.toISOString().slice(0, 19);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}`);
  }
  return response.json();
}

async function fetchElspotPrices({ from, to, priceArea }) {
  const missingDays = await getMissingPriceDays({ from, to, priceArea });
  const records = [];

  for (const day of missingDays) {
    if (!ELSPOT_PRIMARY_ENABLED) {
      try {
        records.push(
          ...(await fetchFallbackElspotDay({
            day,
            priceArea,
            from,
            to,
          })),
        );
      } catch (error) {
        console.warn(
          `Elspot fallback skipped ${day.year}-${day.month}-${day.day}: ${error.message || error}`,
        );
      }
      continue;
    }

    try {
      records.push(
        ...(await fetchEnergyDataServiceElspotDay({ day, priceArea })),
      );
    } catch (error) {
      console.warn(
        `Elspot primary source failed for ${day.year}-${day.month}-${day.day}, using fallback: ${error.message || error}`,
      );
      try {
        records.push(
          ...(await fetchFallbackElspotDay({
            day,
            priceArea,
            from,
            to,
          })),
        );
      } catch (fallbackError) {
        console.warn(
          `Elspot fallback skipped ${day.year}-${day.month}-${day.day}: ${fallbackError.message || fallbackError}`,
        );
      }
    }
  }

  return records;
}

function getUtcDateKeysBetween(from, to) {
  const keys = [];
  const start = new Date(from);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(0, 0, 0, 0);

  for (
    let current = start;
    current <= end;
    current = new Date(current.getTime() + 24 * 60 * 60 * 1000)
  ) {
    const year = current.getUTCFullYear();
    const month = String(current.getUTCMonth() + 1).padStart(2, "0");
    const day = String(current.getUTCDate()).padStart(2, "0");
    keys.push({ year, month, day });
  }
  return keys;
}

async function getMissingPriceDays({ from, to, priceArea }) {
  const days = getUtcDateKeysBetween(from, to);
  const missing = [];

  for (const day of days) {
    const dayStart = `${day.year}-${day.month}-${day.day}T00:00:00.000Z`;
    const dayEnd = new Date(
      Date.parse(dayStart) + 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = await pool.query(
      `
      select count(*)::integer as intervals
      from price_interval
      where price_area = $1
        and starts_at >= $2
        and starts_at < $3
    `,
      [priceArea, dayStart, dayEnd],
    );

    if ((result.rows[0]?.intervals || 0) < 20) {
      missing.push(day);
    }
  }

  return missing;
}

async function fetchEnergyDataServiceElspotDay({ day, priceArea }) {
  const from = `${day.year}-${day.month}-${day.day}T00:00:00`;
  const to = new Date(
    Date.parse(`${day.year}-${day.month}-${day.day}T00:00:00.000Z`) +
      24 * 60 * 60 * 1000,
  );
  const url = new URL(ELSPOT_API_URL);
  url.searchParams.set("limit", "100");
  url.searchParams.set("sort", "HourUTC ASC");
  url.searchParams.set("start", from);
  url.searchParams.set("end", toEnergyDataServiceDate(to));
  url.searchParams.set("filter", JSON.stringify({ PriceArea: priceArea }));

  const json = await fetchJson(url);
  return (Array.isArray(json.records) ? json.records : []).map((record) => {
    const startsAt = parseTimestamp(record.HourUTC, "HourUTC");
    return {
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + 60 * 60 * 1000).toISOString(),
      spotDkkPerKwh: Number(record.SpotPriceDKK) / 1000,
      source: "energidataservice-elspotprices",
      payload: record,
    };
  });
}

async function fetchFallbackElspotDay({ day, priceArea, from, to }) {
  const url = `${ELSPOT_FALLBACK_API_URL}/${day.year}/${day.month}-${day.day}_${priceArea}.json`;
  const json = await fetchJson(url);
  if (!Array.isArray(json)) return [];

  return json
    .map((record) => {
      const startsAt = parseTimestamp(record.time_start, "time_start");
      const endsAt = parseTimestamp(record.time_end, "time_end");
      return {
        startsAt,
        endsAt,
        spotDkkPerKwh: Number(record.DKK_per_kWh),
        source: "elprisenligenu-nordpool-fallback",
        payload: record,
      };
    })
    .filter(
      (record) =>
        Date.parse(record.endsAt) > Date.parse(from) &&
        Date.parse(record.startsAt) < Date.parse(to),
    );
}

async function importEnergyPrices({ from, to, priceArea }) {
  const records = await fetchElspotPrices({ from, to, priceArea });
  const datahubComponentRows = await fetchDatahubComponentRowMap();
  const hasDatahubComponents = datahubComponentRows.length > 0;
  const client = await pool.connect();

  try {
    await client.query("begin");
    for (const record of records) {
      const { startsAt, endsAt, spotDkkPerKwh } = record;
      if (!Number.isFinite(spotDkkPerKwh)) continue;

      const intervalStart = new Date(startsAt);
      const datahubComponents = hasDatahubComponents
        ? calculateDatahubComponentsForDate(datahubComponentRows, intervalStart)
        : null;
      const gridTariff = datahubComponents
        ? datahubComponents.gridTariff + datahubComponents.other
        : getN1TariffDkkPerKwh(intervalStart);
      const configuredTaxes = Number.isFinite(ELECTRICITY_TAX_DKK_PER_KWH)
        ? ELECTRICITY_TAX_DKK_PER_KWH
        : 0;
      const taxes = datahubComponents
        ? datahubComponents.taxes
        : configuredTaxes;
      const vatRate = Number.isFinite(VAT_RATE) ? VAT_RATE : 0;
      const effective = (spotDkkPerKwh + gridTariff + taxes) * (1 + vatRate);
      const payload = {
        source: `${record.source}+datahub-components`,
        elspot: record.payload,
        assumptions: {
          spotDkkPerKwh,
          datahubComponentsConfigured: hasDatahubComponents,
          datahubComponentsApplied: datahubComponents?.applied || [],
          n1TariffRulesConfigured:
            !hasDatahubComponents && getN1TariffRules().length > 0,
          electricityTaxDkkPerKwh: taxes,
          vatRate,
        },
      };

      await client.query(
        `
        insert into price_interval (
          price_area, starts_at, ends_at, spot_dkk_per_kwh, grid_tariff_dkk_per_kwh,
          taxes_dkk_per_kwh, vat_rate, effective_dkk_per_kwh, currency, source, payload, updated_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'DKK', $9, $10::jsonb, now())
        on conflict (price_area, starts_at) do update set
          ends_at = excluded.ends_at,
          spot_dkk_per_kwh = excluded.spot_dkk_per_kwh,
          grid_tariff_dkk_per_kwh = excluded.grid_tariff_dkk_per_kwh,
          taxes_dkk_per_kwh = excluded.taxes_dkk_per_kwh,
          vat_rate = excluded.vat_rate,
          effective_dkk_per_kwh = excluded.effective_dkk_per_kwh,
          currency = excluded.currency,
          source = excluded.source,
          payload = excluded.payload,
          updated_at = excluded.updated_at
      `,
        [
          priceArea,
          startsAt,
          endsAt,
          spotDkkPerKwh,
          gridTariff,
          taxes,
          vatRate,
          effective,
          record.source,
          JSON.stringify(payload),
        ],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  const buckets =
    records.length > 0 ? await rebuildEnergyUsage({ from, to, priceArea }) : 0;
  return { imported: records.length, buckets };
}

function getDefaultPriceImportWindow() {
  const now = Date.now();
  return {
    from: new Date(
      now - PRICE_IMPORT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString(),
    to: new Date(
      now + PRICE_IMPORT_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString(),
    priceArea: DEFAULT_PRICE_AREA,
  };
}

async function insertEvent(client, event) {
  await client.query(
    `
    insert into ingest_event (
      event_time, homey_device_id, homey_zone_id, device_name, driver_id, device_class,
      capability, value_json, value_number, value_boolean, unit, available, source_system,
      source_instance, source_event_id, author_system, event_type, causation_id, correlation_id, replay_run_id, payload
    ) values ($1, $2, $3, $4, $5, $6, $7, to_jsonb($8::json), $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb)
  `,
    [
      event.eventTime,
      event.homeyDeviceId,
      event.homeyZoneId,
      event.deviceName,
      event.driverId,
      event.deviceClass,
      event.capability,
      JSON.stringify(event.value),
      event.valueNumber,
      event.valueBoolean,
      event.unit,
      event.available,
      event.sourceSystem,
      event.sourceInstance,
      event.sourceEventId,
      event.authorSystem,
      event.eventType,
      event.causationId,
      event.correlationId,
      event.replayRunId,
      JSON.stringify(event.payload),
    ],
  );

  if (event.eventType === "command") return;

  await client.query(
    `
    insert into state_current (
      homey_device_id, capability, event_time, received_at, homey_zone_id, device_name,
      driver_id, device_class, value_json, value_number, value_boolean, unit, available, source_system,
      source_instance, source_event_id, author_system, event_type, causation_id, correlation_id, replay_run_id, payload
    ) values ($1, $2, $3, now(), $4, $5, $6, $7, to_jsonb($8::json), $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb)
    on conflict (homey_device_id, capability) do update set
      event_time = excluded.event_time,
      received_at = excluded.received_at,
      homey_zone_id = excluded.homey_zone_id,
      device_name = excluded.device_name,
      driver_id = excluded.driver_id,
      device_class = excluded.device_class,
      value_json = excluded.value_json,
      value_number = excluded.value_number,
      value_boolean = excluded.value_boolean,
      unit = excluded.unit,
      available = excluded.available,
      source_system = excluded.source_system,
      source_instance = excluded.source_instance,
      source_event_id = excluded.source_event_id,
      author_system = excluded.author_system,
      event_type = excluded.event_type,
      causation_id = excluded.causation_id,
      correlation_id = excluded.correlation_id,
      replay_run_id = excluded.replay_run_id,
      payload = excluded.payload
    where state_current.event_time <= excluded.event_time
  `,
    [
      event.homeyDeviceId,
      event.capability,
      event.eventTime,
      event.homeyZoneId,
      event.deviceName,
      event.driverId,
      event.deviceClass,
      JSON.stringify(event.value),
      event.valueNumber,
      event.valueBoolean,
      event.unit,
      event.available,
      event.sourceSystem,
      event.sourceInstance,
      event.sourceEventId,
      event.authorSystem,
      event.eventType,
      event.causationId,
      event.correlationId,
      event.replayRunId,
      JSON.stringify(event.payload),
    ],
  );
}

async function handleIngest(request, response) {
  if (!isAuthorized(request)) {
    sendError(response, 401, "Unauthorized");
    return;
  }

  const body = await readRequestBody(request);
  const parsed = body ? JSON.parse(body) : null;
  const payloads = Array.isArray(parsed) ? parsed : parsed?.events || [parsed];
  const events = payloads.map(normalizeEvent);
  const client = await pool.connect();

  try {
    await client.query("begin");
    for (const event of events) {
      await insertEvent(client, event);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  sendJson(response, 202, { ok: true, accepted: events.length });
}

function getObjectEntries(value) {
  return Object.entries(value || {});
}

function getZigbeeBucketStart(value = new Date()) {
  const date = new Date(value);
  const minutes = Math.floor(date.getUTCMinutes() / 10) * 10;
  date.setUTCMinutes(minutes, 0, 0);
  return date.toISOString();
}

async function handleZigbeeRouteSnapshot(request, response) {
  if (!isAuthorized(request)) {
    sendError(response, 401, "Unauthorized");
    return;
  }

  const body = await readRequestBody(request);
  const snapshot = body ? JSON.parse(body) : {};
  const bucketStart = getZigbeeBucketStart(snapshot.generatedAt || new Date());
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const links = Array.isArray(snapshot.links) ? snapshot.links : [];
  const client = await pool.connect();

  try {
    await client.query("begin");
    for (const node of nodes) {
      await client.query(
        `
        insert into zigbee_route_node_observation (
          bucket_start, node_id, label, category, node_type, address_label, zone, zone_short,
          last_seen, available, child_count, payload, observed_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, now())
        on conflict (bucket_start, node_id) do update set
          label = excluded.label,
          category = excluded.category,
          node_type = excluded.node_type,
          address_label = excluded.address_label,
          zone = excluded.zone,
          zone_short = excluded.zone_short,
          last_seen = excluded.last_seen,
          available = excluded.available,
          child_count = excluded.child_count,
          payload = excluded.payload,
          observed_at = excluded.observed_at
      `,
        [
          bucketStart,
          String(node.id),
          node.label || null,
          node.category || null,
          node.type || null,
          node.addressLabel || null,
          node.zone || null,
          node.zoneShort || null,
          node.lastSeen || null,
          node.available,
          Number.isFinite(Number(node.childCount))
            ? Number(node.childCount)
            : null,
          JSON.stringify(node),
        ],
      );
    }

    for (const link of links) {
      await client.query(
        `
        insert into zigbee_route_edge_observation (
          bucket_start, source_id, target_id, source_category, route_depth, payload, observed_at
        ) values ($1, $2, $3, $4, $5, $6::jsonb, now())
        on conflict (bucket_start, source_id, target_id) do update set
          source_category = excluded.source_category,
          route_depth = excluded.route_depth,
          payload = excluded.payload,
          observed_at = excluded.observed_at
      `,
        [
          bucketStart,
          String(link.source),
          String(link.target),
          link.sourceCategory || null,
          Number.isFinite(Number(link.depth)) ? Number(link.depth) : null,
          JSON.stringify(link),
        ],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  sendJson(response, 202, {
    ok: true,
    bucketStart,
    nodes: nodes.length,
    links: links.length,
  });
}

async function getZigbeeRouteHistory(requestUrl, response) {
  const days = Math.max(
    1,
    Math.min(30, Number(requestUrl.searchParams.get("days") || 7)),
  );
  const params = [days];
  const [nodes, edges, layout] = await Promise.all([
    pool.query(
      `
      with recent_nodes as (
        select *
        from zigbee_route_node_observation
        where bucket_start >= now() - ($1::int * interval '1 day')
      ),
      latest_nodes as (
        select distinct on (node_id) *
        from recent_nodes
        order by node_id, bucket_start desc
      ),
      latest_known_nodes as (
        select distinct on (node_id) *
        from recent_nodes
        where coalesce(category, 'unknown') <> 'unknown'
           or coalesce(label, '') !~ '^Ukendt '
           or last_seen is not null
        order by node_id, bucket_start desc
      )
      select latest.node_id as id,
        coalesce(known.label, latest.label) as label,
        coalesce(known.category, latest.category) as category,
        coalesce(known.node_type, latest.node_type) as type,
        coalesce(known.address_label, latest.address_label) as address_label,
        coalesce(known.zone, latest.zone) as zone,
        coalesce(known.zone_short, latest.zone_short) as zone_short,
        coalesce(known.last_seen, latest.last_seen) as last_seen,
        coalesce(known.available, latest.available) as available,
        coalesce(known.child_count, latest.child_count) as child_count,
        coalesce(known.payload, latest.payload) as payload,
        latest.bucket_start as last_observed_at,
        coalesce(known.last_seen, latest.last_seen, latest.bucket_start) < now() - interval '24 hours' as stale,
        known.node_id is not null and coalesce(latest.category, 'unknown') = 'unknown' as removed
      from latest_nodes latest
      left join latest_known_nodes known on known.node_id = latest.node_id
      order by latest.node_id
    `,
      params,
    ),
    pool.query(
      `
      with ranked_edges as (
        select source_id,
          target_id,
          source_category,
          payload,
          bucket_start,
          count(*) over (partition by source_id, target_id)::int as observations,
          max(bucket_start) over (partition by source_id, target_id) as last_observed_at,
          row_number() over (partition by source_id, target_id order by bucket_start desc) as row_number
        from zigbee_route_edge_observation
        where bucket_start >= now() - ($1::int * interval '1 day')
      )
      select source_id,
        target_id,
        source_category,
        observations,
        last_observed_at,
        payload
      from ranked_edges
      where row_number = 1
      order by observations desc, source_id, target_id
    `,
      params,
    ),
    pool.query("select node_id as id, x, y, updated_at from zigbee_map_layout"),
  ]);

  sendJson(response, 200, {
    generatedAt: new Date().toISOString(),
    days,
    nodes: nodes.rows,
    edges: edges.rows,
    layout: layout.rows,
  });
}

async function getZigbeeLayout(response) {
  const result = await pool.query(
    "select node_id as id, x, y, updated_at from zigbee_map_layout order by node_id",
  );
  sendJson(response, 200, {
    generatedAt: new Date().toISOString(),
    layout: result.rows,
  });
}

async function putZigbeeLayout(request, response) {
  if (!isAuthorized(request)) {
    sendError(response, 401, "Unauthorized");
    return;
  }

  const body = await readRequestBody(request);
  const parsed = body ? JSON.parse(body) : {};
  const layout = Array.isArray(parsed.layout) ? parsed.layout : [];
  const client = await pool.connect();

  try {
    await client.query("begin");
    if (parsed.clear === true) {
      await client.query("delete from zigbee_map_layout");
    }
    for (const item of layout) {
      if (
        !item.id ||
        !Number.isFinite(Number(item.x)) ||
        !Number.isFinite(Number(item.y))
      )
        continue;
      await client.query(
        `
        insert into zigbee_map_layout (node_id, x, y, updated_at)
        values ($1, $2, $3, now())
        on conflict (node_id) do update set
          x = excluded.x,
          y = excluded.y,
          updated_at = excluded.updated_at
      `,
        [String(item.id), Number(item.x), Number(item.y)],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  sendJson(response, 202, { ok: true, saved: layout.length });
}

function toCapabilityArray(device) {
  return Array.isArray(device?.capabilities) ? device.capabilities : [];
}

async function upsertSnapshotCapabilityState(client, device, syncedAt) {
  const capabilitiesObj = device?.capabilitiesObj || {};
  for (const capability of toCapabilityArray(device)) {
    if (!Object.prototype.hasOwnProperty.call(capabilitiesObj, capability))
      continue;

    const capabilityInfo = capabilitiesObj[capability] || {};
    const { value } = capabilityInfo;
    const eventTime = capabilityInfo.lastUpdated || syncedAt;
    const valueNumber =
      typeof value === "number" && Number.isFinite(value) ? value : null;
    const valueBoolean = typeof value === "boolean" ? value : null;
    const payload = {
      source: "snapshot",
      capability: capabilityInfo,
    };

    await client.query(
      `
      insert into ingest_event (
        event_time, homey_device_id, homey_zone_id, device_name, driver_id, device_class,
        capability, value_json, value_number, value_boolean, unit, available, payload
      )
      select $3, $1, $4, $5, $6, $7, $2, to_jsonb($8::json), $9, $10, $11, $12, $13::jsonb
      where not exists (
        select 1 from state_current
        where homey_device_id = $1
          and capability = $2
          and value_json = to_jsonb($8::json)
          and available is not distinct from $12
      )
      and not exists (
        select 1 from ingest_event
        where homey_device_id = $1
          and capability = $2
          and event_time = $3
          and value_json = to_jsonb($8::json)
      )
    `,
      [
        device.id,
        capability,
        eventTime,
        device.zone || null,
        device.name || null,
        device.driverId || null,
        device.class || null,
        JSON.stringify(value),
        valueNumber,
        valueBoolean,
        capabilityInfo.units || capabilityInfo.unit || null,
        device.available !== false,
        JSON.stringify(payload),
      ],
    );

    await client.query(
      `
      insert into state_current (
        homey_device_id, capability, event_time, received_at, homey_zone_id, device_name,
        driver_id, device_class, value_json, value_number, value_boolean, unit, available, payload
      ) values ($1, $2, $3, now(), $4, $5, $6, $7, to_jsonb($8::json), $9, $10, $11, $12, $13::jsonb)
      on conflict (homey_device_id, capability) do update set
        event_time = excluded.event_time,
        received_at = excluded.received_at,
        homey_zone_id = excluded.homey_zone_id,
        device_name = excluded.device_name,
        driver_id = excluded.driver_id,
        device_class = excluded.device_class,
        value_json = excluded.value_json,
        value_number = excluded.value_number,
        value_boolean = excluded.value_boolean,
        unit = excluded.unit,
        available = excluded.available,
        payload = excluded.payload
      where state_current.event_time <= excluded.event_time
    `,
      [
        device.id,
        capability,
        eventTime,
        device.zone || null,
        device.name || null,
        device.driverId || null,
        device.class || null,
        JSON.stringify(value),
        valueNumber,
        valueBoolean,
        capabilityInfo.units || capabilityInfo.unit || null,
        device.available !== false,
        JSON.stringify(payload),
      ],
    );
  }
}

async function handleHomeySync(request, response) {
  if (!isAuthorized(request)) {
    sendError(response, 401, "Unauthorized");
    return;
  }

  const body = await readRequestBody(request);
  const snapshot = body ? JSON.parse(body) : {};
  const syncedAt = snapshot.syncedAt || new Date().toISOString();
  const client = await pool.connect();

  try {
    await client.query("begin");

    for (const [id, zone] of getObjectEntries(snapshot.zones)) {
      await client.query(
        `
        insert into homey_zone (id, name, parent_id, payload, synced_at)
        values ($1, $2, $3, $4::jsonb, $5)
        on conflict (id) do update set
          name = excluded.name,
          parent_id = excluded.parent_id,
          payload = excluded.payload,
          synced_at = excluded.synced_at
      `,
        [
          id,
          zone.name || null,
          zone.parent || zone.parentId || null,
          JSON.stringify(zone),
          syncedAt,
        ],
      );
    }

    const deviceIds = getObjectEntries(snapshot.devices).map(([id]) => id);
    await client.query(
      "delete from homey_device where not (id = any($1::text[]))",
      [deviceIds],
    );

    for (const [id, device] of getObjectEntries(snapshot.devices)) {
      await client.query(
        `
        insert into homey_device (id, name, zone_id, driver_id, device_class, available, capabilities, payload, synced_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
        on conflict (id) do update set
          name = excluded.name,
          zone_id = excluded.zone_id,
          driver_id = excluded.driver_id,
          device_class = excluded.device_class,
          available = excluded.available,
          capabilities = excluded.capabilities,
          payload = excluded.payload,
          synced_at = excluded.synced_at
      `,
        [
          id,
          device.name || null,
          device.zone || null,
          device.driverId || null,
          device.class || null,
          device.available !== false,
          toCapabilityArray(device),
          JSON.stringify(device),
          syncedAt,
        ],
      );
      await client.query(
        `
        insert into device_route (source_system, source_device_id, target_system, target_device_id)
        values ('homey', $1, 'homey', $1)
        on conflict (source_system, source_device_id, target_system, target_device_id, valid_from) do nothing
      `,
        [id],
      );
      device.id = id;
      await upsertSnapshotCapabilityState(client, device, syncedAt);
    }

    for (const [id, flow] of getObjectEntries(snapshot.flows)) {
      await client.query(
        `
        insert into homey_flow (id, name, enabled, payload, synced_at)
        values ($1, $2, $3, $4::jsonb, $5)
        on conflict (id) do update set
          name = excluded.name,
          enabled = excluded.enabled,
          payload = excluded.payload,
          synced_at = excluded.synced_at
      `,
        [
          id,
          flow.name || null,
          flow.enabled !== false,
          JSON.stringify(flow),
          syncedAt,
        ],
      );
    }

    for (const [id, flow] of getObjectEntries(snapshot.advancedFlows)) {
      await client.query(
        `
        insert into homey_advanced_flow (id, name, enabled, payload, synced_at)
        values ($1, $2, $3, $4::jsonb, $5)
        on conflict (id) do update set
          name = excluded.name,
          enabled = excluded.enabled,
          payload = excluded.payload,
          synced_at = excluded.synced_at
      `,
        [
          id,
          flow.name || null,
          flow.enabled !== false,
          JSON.stringify(flow),
          syncedAt,
        ],
      );
    }

    if (Array.isArray(snapshot.timers)) {
      const timerNames = snapshot.timers
        .map((timer) => timer?.name)
        .filter(Boolean);

      await client.query(
        "delete from homey_timer where not (name = any($1::text[]))",
        [timerNames],
      );

      for (const timer of snapshot.timers) {
        if (!timer?.name) continue;
        await client.query(
          `
          insert into homey_timer (name, payload, synced_at)
          values ($1, $2::jsonb, $3)
          on conflict (name) do update set
            payload = excluded.payload,
            synced_at = excluded.synced_at
        `,
          [timer.name, JSON.stringify(timer), syncedAt],
        );
      }
    }

    if (
      snapshot.logicVariables &&
      typeof snapshot.logicVariables === "object"
    ) {
      const variables = getObjectEntries(snapshot.logicVariables);
      const variableIds = variables.map(([id]) => id);

      await client.query(
        "delete from homey_logic_variable where not (id = any($1::text[]))",
        [variableIds],
      );

      for (const [id, variable] of variables) {
        await client.query(
          `
          insert into homey_logic_variable (id, name, payload, synced_at)
          values ($1, $2, $3::jsonb, $4)
          on conflict (id) do update set
            name = excluded.name,
            payload = excluded.payload,
            synced_at = excluded.synced_at
        `,
          [id, variable.name || id, JSON.stringify(variable), syncedAt],
        );
      }
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  sendJson(response, 202, {
    ok: true,
    devices: Object.keys(snapshot.devices || {}).length,
    zones: Object.keys(snapshot.zones || {}).length,
    flows: Object.keys(snapshot.flows || {}).length,
    advancedFlows: Object.keys(snapshot.advancedFlows || {}).length,
    timers: Array.isArray(snapshot.timers) ? snapshot.timers.length : null,
    logicVariables:
      snapshot.logicVariables && typeof snapshot.logicVariables === "object"
        ? Object.keys(snapshot.logicVariables).length
        : null,
  });
}

async function handleExternalDeviceSync(request, response) {
  if (!isAuthorized(request)) {
    sendError(response, 401, "Unauthorized");
    return;
  }
  const body = await readRequestBody(request);
  const parsed = body ? JSON.parse(body) : {};
  const devices = Array.isArray(parsed.devices) ? parsed.devices : [];
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const device of devices) {
      if (!device?.id || !device?.name) continue;
      const zoneId = device.zoneId || "external";
      const zoneName = device.zoneName || "Ukendt zone";
      await client.query(
        `
        insert into external_zone (id, name, payload, synced_at)
        values ($1, $2, $3::jsonb, now())
        on conflict (id) do update set name = excluded.name, payload = excluded.payload, synced_at = excluded.synced_at
      `,
        [zoneId, zoneName, JSON.stringify({ id: zoneId, name: zoneName })],
      );
      await client.query(
        `
        insert into external_device (id, name, zone_id, driver_id, device_class, available, capabilities, payload, synced_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
        on conflict (id) do update set name = excluded.name, zone_id = excluded.zone_id,
          driver_id = excluded.driver_id, device_class = excluded.device_class, available = excluded.available,
          capabilities = excluded.capabilities, payload = excluded.payload, synced_at = excluded.synced_at
      `,
        [
          device.id,
          device.name,
          zoneId,
          device.driverId || null,
          device.class || null,
          device.available !== false,
          Array.isArray(device.capabilities) ? device.capabilities : [],
          JSON.stringify(device),
        ],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  sendJson(response, 202, { ok: true, devices: devices.length });
}

async function getReplayRoute(requestUrl, response) {
  const sourceSystem = requestUrl.searchParams.get("sourceSystem");
  const sourceDeviceId = requestUrl.searchParams.get("deviceId");
  const at = requestUrl.searchParams.get("at");
  if (!sourceSystem || !sourceDeviceId || !at || Number.isNaN(Date.parse(at))) {
    sendError(response, 400, "sourceSystem, deviceId and at must be valid");
    return;
  }
  const result = await pool.query(
    `
    select source_system as "sourceSystem", source_device_id as "sourceDeviceId",
      target_system as "targetSystem", target_device_id as "targetDeviceId",
      valid_from as "validFrom", valid_to as "validTo", payload
    from device_route
    where source_system = $1 and source_device_id = $2
      and valid_from <= $3 and (valid_to is null or valid_to > $3)
    order by valid_from desc
    limit 2
  `,
    [sourceSystem, sourceDeviceId, at],
  );
  if (result.rows.length !== 1) {
    sendError(
      response,
      409,
      `No unambiguous route for ${sourceSystem}:${sourceDeviceId} at ${at}`,
    );
    return;
  }
  sendJson(response, 200, { route: result.rows[0] });
}

async function putDeviceRoute(request, response) {
  if (!isAuthorized(request)) {
    sendError(response, 401, "Unauthorized");
    return;
  }
  const body = await readRequestBody(request);
  const route = body ? JSON.parse(body) : {};
  const sourceSystem = String(
    route.sourceSystem || route.source_system || "",
  ).trim();
  const sourceDeviceId = String(
    route.sourceDeviceId || route.source_device_id || "",
  ).trim();
  const targetSystem = String(
    route.targetSystem || route.target_system || "",
  ).trim();
  const targetDeviceId = String(
    route.targetDeviceId || route.target_device_id || "",
  ).trim();
  const validFrom =
    route.validFrom || route.valid_from || new Date().toISOString();
  const validTo = route.validTo || route.valid_to || null;
  if (
    !sourceSystem ||
    !sourceDeviceId ||
    !targetSystem ||
    !targetDeviceId ||
    Number.isNaN(Date.parse(validFrom)) ||
    (validTo && Number.isNaN(Date.parse(validTo)))
  ) {
    sendError(
      response,
      400,
      "source/target systems and device ids plus validFrom are required",
    );
    return;
  }
  if (validTo && Date.parse(validTo) <= Date.parse(validFrom)) {
    sendError(response, 400, "validTo must be after validFrom");
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `
      update device_route set valid_to = $3
      where source_system = $1 and source_device_id = $2
        and valid_from < $3 and (valid_to is null or valid_to > $3)
    `,
      [sourceSystem, sourceDeviceId, validFrom],
    );
    await client.query(
      `
      insert into device_route (
        source_system, source_device_id, target_system, target_device_id, valid_from, valid_to, payload
      ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)
      on conflict (source_system, source_device_id, target_system, target_device_id, valid_from) do update set
        valid_to = excluded.valid_to, payload = excluded.payload
    `,
      [
        sourceSystem,
        sourceDeviceId,
        targetSystem,
        targetDeviceId,
        validFrom,
        validTo,
        JSON.stringify(route.payload || {}),
      ],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  sendJson(response, 202, { ok: true });
}

async function handlePriceIngest(request, response) {
  if (!isAuthorized(request)) {
    sendError(response, 401, "Unauthorized");
    return;
  }

  const body = await readRequestBody(request);
  const parsed = body ? JSON.parse(body) : null;
  const payloads = Array.isArray(parsed)
    ? parsed
    : parsed?.prices || parsed?.intervals || [parsed];
  const prices = payloads.map(normalizePriceInterval);
  const client = await pool.connect();

  try {
    await client.query("begin");
    for (const price of prices) {
      await client.query(
        `
        insert into price_interval (
          price_area, starts_at, ends_at, spot_dkk_per_kwh, grid_tariff_dkk_per_kwh,
          taxes_dkk_per_kwh, vat_rate, effective_dkk_per_kwh, currency, source, payload, updated_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, now())
        on conflict (price_area, starts_at) do update set
          ends_at = excluded.ends_at,
          spot_dkk_per_kwh = excluded.spot_dkk_per_kwh,
          grid_tariff_dkk_per_kwh = excluded.grid_tariff_dkk_per_kwh,
          taxes_dkk_per_kwh = excluded.taxes_dkk_per_kwh,
          vat_rate = excluded.vat_rate,
          effective_dkk_per_kwh = excluded.effective_dkk_per_kwh,
          currency = excluded.currency,
          source = excluded.source,
          payload = excluded.payload,
          updated_at = excluded.updated_at
      `,
        [
          price.priceArea,
          price.startsAt,
          price.endsAt,
          price.spot,
          price.gridTariff,
          price.taxes,
          price.vatRate,
          price.effective,
          price.currency,
          price.source,
          JSON.stringify(price.payload),
        ],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  sendJson(response, 202, { ok: true, accepted: prices.length });
}

async function rebuildEnergyUsage({ from, to, priceArea }) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `
      delete from energy_usage_15m
      where bucket_start >= $1 and bucket_start < $2 and price_area = $3
    `,
      [from, to, priceArea],
    );

    const result = await client.query(
      `
      insert into energy_usage_15m (
        bucket_start, bucket_end, homey_device_id, device_name, capability,
        kwh, price_area, effective_dkk_per_kwh, cost_dkk, updated_at
      )
      with migrations as (
        select * from jsonb_to_recordset($5::jsonb)
          as m("previousId" text, "currentId" text, "switchedAt" timestamptz)
      ), authoritative as (
        select e.event_time,
          coalesce(m."previousId", e.homey_device_id) as homey_device_id,
          e.device_name, e.capability, e.value_number
        from ingest_event e
        left join migrations m on e.homey_device_id in (m."previousId", m."currentId")
        where e.capability = any($4::text[])
          and e.value_number is not null
          and e.event_type = 'observation'
          and e.event_time >= $1::timestamptz - interval '2 days'
          and e.event_time < $2
          and (m."previousId" is null
            or (e.homey_device_id = m."previousId" and e.source_system = 'homey' and e.event_time < m."switchedAt")
            or (e.homey_device_id = m."currentId" and e.source_system = 'home_assistant' and e.event_time >= m."switchedAt"))
      ), ordered as (
        select event_time, homey_device_id, device_name, capability, value_number,
          lag(value_number) over (
            partition by homey_device_id, capability
            order by event_time
          ) as previous_value
        from authoritative
      ), deltas as (
        select time_bucket('15 minutes', event_time) as bucket_start,
          homey_device_id,
          max(device_name) as device_name,
          capability,
          sum(
            case when capability = 'meter_power.exported'
            then -(value_number - previous_value)
            else (value_number - previous_value)
            end
          )::numeric as kwh
        from ordered
        where previous_value is not null
          and event_time >= $1
        group by bucket_start, homey_device_id, capability
      )
      select d.bucket_start,
        d.bucket_start + interval '15 minutes' as bucket_end,
        d.homey_device_id,
        d.device_name,
        d.capability,
        d.kwh,
        $3 as price_area,
        p.effective_dkk_per_kwh,
        case
          when d.kwh <= 0 or p.effective_dkk_per_kwh is null then 0
          else d.kwh * p.effective_dkk_per_kwh
        end as cost_dkk,
        now()
      from deltas d
      left join price_interval p
        on p.price_area = $3
       and d.bucket_start >= p.starts_at
       and d.bucket_start < p.ends_at
      on conflict (price_area, bucket_start, homey_device_id, capability) do update set
        bucket_end = excluded.bucket_end,
        device_name = excluded.device_name,
        kwh = excluded.kwh,
        price_area = excluded.price_area,
        effective_dkk_per_kwh = excluded.effective_dkk_per_kwh,
        cost_dkk = excluded.cost_dkk,
        updated_at = excluded.updated_at
    `,
      [from, to, priceArea, ENERGY_CAPABILITIES, JSON.stringify(ENERGY_METER_MIGRATIONS)],
    );
    await client.query("commit");
    return result.rowCount;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function ensureEnergyUsageFresh({ from, to, priceArea }) {
  if (!ENERGY_USAGE_AUTO_REBUILD_ENABLED) return;

  const now = Date.now();
  const toTime = Date.parse(to);
  if (!Number.isFinite(toTime) || Math.abs(now - toTime) > 10 * 60 * 1000)
    return;

  const state = energyUsageAutoRebuilds.get(priceArea) || {
    lastRunAt: 0,
    promise: null,
  };
  if (state.promise) {
    await state.promise;
    return;
  }
  if (now - state.lastRunAt < ENERGY_USAGE_AUTO_REBUILD_INTERVAL_MS) return;

  const requestedFrom = Date.parse(from);
  const earliestFrom =
    now - ENERGY_USAGE_AUTO_REBUILD_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const rebuildFrom = new Date(
    Math.max(
      Number.isFinite(requestedFrom) ? requestedFrom : earliestFrom,
      earliestFrom,
    ),
  ).toISOString();
  const rebuildTo = new Date(now).toISOString();
  const promise = rebuildEnergyUsage({
    from: rebuildFrom,
    to: rebuildTo,
    priceArea,
  })
    .catch((error) => {
      console.warn(
        `Energy usage auto rebuild failed: ${error.message || error}`,
      );
    })
    .finally(() => {
      const current = energyUsageAutoRebuilds.get(priceArea) || {};
      energyUsageAutoRebuilds.set(priceArea, { ...current, promise: null });
    });

  energyUsageAutoRebuilds.set(priceArea, { lastRunAt: now, promise });
  await promise;
}

async function handleEnergyRebuild(request, response) {
  if (!isAuthorized(request)) {
    sendError(response, 401, "Unauthorized");
    return;
  }

  const body = await readRequestBody(request);
  const parsed = body ? JSON.parse(body) : {};
  const to =
    parseOptionalTimestamp(parsed.to || parsed.end, "to") ||
    new Date().toISOString();
  const from =
    parseOptionalTimestamp(parsed.from || parsed.start, "from") ||
    new Date(Date.parse(to) - 7 * 24 * 60 * 60 * 1000).toISOString();
  const priceArea = parsed.priceArea || DEFAULT_PRICE_AREA;

  if (Date.parse(to) <= Date.parse(from)) {
    sendError(response, 400, "to must be after from");
    return;
  }

  const buckets = await rebuildEnergyUsage({ from, to, priceArea });
  sendJson(response, 202, {
    ok: true,
    from,
    to,
    priceArea,
    buckets,
  });
}

async function handleEnergyPriceImport(request, response) {
  if (!isAuthorized(request)) {
    sendError(response, 401, "Unauthorized");
    return;
  }

  const body = await readRequestBody(request);
  const parsed = body ? JSON.parse(body) : {};
  const defaults = getDefaultPriceImportWindow();
  const to =
    parseOptionalTimestamp(parsed.to || parsed.end, "to") || defaults.to;
  const from =
    parseOptionalTimestamp(parsed.from || parsed.start, "from") ||
    defaults.from;
  const priceArea = parsed.priceArea || defaults.priceArea;

  if (Date.parse(to) <= Date.parse(from)) {
    sendError(response, 400, "to must be after from");
    return;
  }

  if (parsed.force === true) {
    await pool.query(
      `
      delete from price_interval
      where price_area = $1
        and starts_at >= $2
        and starts_at < $3
    `,
      [priceArea, from, to],
    );
  }

  const result = await importEnergyPrices({ from, to, priceArea });
  sendJson(response, 202, {
    ok: true,
    from,
    to,
    priceArea,
    forced: parsed.force === true,
    ...result,
  });
}

async function getEnergyUsage(requestUrl, response) {
  const to =
    parseOptionalTimestamp(requestUrl.searchParams.get("to"), "to") ||
    new Date().toISOString();
  const from =
    parseOptionalTimestamp(requestUrl.searchParams.get("from"), "from") ||
    new Date(Date.parse(to) - 24 * 60 * 60 * 1000).toISOString();
  const interval = getEnergyInterval(requestUrl.searchParams.get("interval"));
  const priceArea =
    requestUrl.searchParams.get("priceArea") || DEFAULT_PRICE_AREA;
  const homeyDeviceId = requestUrl.searchParams.get("deviceId");

  if (Date.parse(to) <= Date.parse(from)) {
    sendError(response, 400, "to must be after from");
    return;
  }

  await ensureEnergyUsageFresh({ from, to, priceArea });

  const params = [interval, from, to, priceArea];
  let deviceClause = "";
  if (homeyDeviceId) {
    params.push(homeyDeviceId);
    deviceClause = `and homey_device_id = $${params.length}`;
  }

  const result = await pool.query(
    `
    select time_bucket($1::interval, bucket_start) as bucket_start,
      time_bucket($1::interval, bucket_start) + $1::interval as bucket_end,
      sum(kwh)::double precision as kwh,
      sum(cost_dkk)::double precision as cost_dkk,
      case
        when sum(kwh) > 0 and sum(cost_dkk) is not null then (sum(cost_dkk) / sum(kwh))::double precision
        else null
      end as effective_dkk_per_kwh,
      count(*)::integer as source_buckets
    from energy_usage_15m
    where bucket_start >= $2
      and bucket_start < $3
      and price_area = $4
      ${deviceClause}
    group by 1, 2
    order by 1
  `,
    params,
  );

  sendJson(response, 200, {
    generatedAt: new Date().toISOString(),
    from,
    to,
    interval,
    priceArea,
    deviceId: homeyDeviceId || null,
    buckets: result.rows,
  });
}

async function getEnergyPrices(requestUrl, response) {
  const priceArea =
    requestUrl.searchParams.get("priceArea") || DEFAULT_PRICE_AREA;
  const from = parseOptionalTimestamp(
    requestUrl.searchParams.get("from"),
    "from",
  );
  const to = parseOptionalTimestamp(requestUrl.searchParams.get("to"), "to");
  const params = [priceArea];
  let rangeClause = `
    and starts_at >= (date_trunc('day', now() at time zone 'Europe/Copenhagen') at time zone 'Europe/Copenhagen')
    and starts_at < ((date_trunc('day', now() at time zone 'Europe/Copenhagen') + interval '1 day') at time zone 'Europe/Copenhagen')
  `;

  if (from || to) {
    rangeClause = "";
    if (from) {
      params.push(from);
      rangeClause += ` and starts_at >= $${params.length}`;
    }
    if (to) {
      params.push(to);
      rangeClause += ` and starts_at < $${params.length}`;
    }
  }

  const result = await pool.query(
    `
    select starts_at,
      ends_at,
      to_char(starts_at at time zone 'Europe/Copenhagen', 'HH24:MI') as time_dk,
      spot_dkk_per_kwh::double precision as spot_dkk_per_kwh,
      grid_tariff_dkk_per_kwh::double precision as grid_tariff_dkk_per_kwh,
      grid_tariff_dkk_per_kwh::double precision as n1_tariff_dkk_per_kwh,
      taxes_dkk_per_kwh::double precision as elafgift_dkk_per_kwh,
      vat_rate::double precision as vat_rate,
      effective_dkk_per_kwh::double precision as total_dkk_per_kwh,
      source
    from price_interval
    where price_area = $1
      ${rangeClause}
    order by starts_at
  `,
    params,
  );

  sendJson(response, 200, {
    generatedAt: new Date().toISOString(),
    priceArea,
    prices: result.rows,
  });
}

async function getCurrentState(response) {
  const result = await pool.query(`
    select homey_device_id, capability, event_time, received_at, homey_zone_id, device_name,
      driver_id, device_class, value_json as value, value_number, value_boolean, unit, available,
      source_system, source_instance, source_event_id, author_system, event_type, causation_id, correlation_id, replay_run_id
    from state_current
    order by device_name nulls last, homey_device_id, capability
  `);
  sendJson(response, 200, {
    generatedAt: new Date().toISOString(),
    states: result.rows,
  });
}

async function getHomeySnapshot(response) {
  const [
    zones,
    devices,
    externalZones,
    externalDevices,
    states,
    flows,
    advancedFlows,
    timers,
    logicVariables,
  ] = await Promise.all([
    pool.query(
      "select id, payload from homey_zone order by name nulls last, id",
    ),
    pool.query(
      "select id, payload from homey_device order by name nulls last, id",
    ),
    pool.query("select id, payload from external_zone order by name, id"),
    pool.query(
      "select id, zone_id, payload from external_device order by name, id",
    ),
    pool.query("select * from state_current"),
    pool.query(
      "select id, payload from homey_flow order by name nulls last, id",
    ),
    pool.query(
      "select id, payload from homey_advanced_flow order by name nulls last, id",
    ),
    pool.query("select payload, synced_at from homey_timer order by name"),
    pool.query(
      "select id, payload from homey_logic_variable order by name, id",
    ),
  ]);
  const statesByDevice = states.rows.reduce((result, state) => {
    result[state.homey_device_id] ||= {};
    result[state.homey_device_id][state.capability] = state;
    return result;
  }, {});
  const deviceMap = devices.rows.reduce((result, row) => {
    const device = row.payload;
    device.id = row.id;
    device.capabilitiesObj ||= {};
    for (const [capability, state] of Object.entries(
      statesByDevice[row.id] || {},
    )) {
      device.capabilitiesObj[capability] ||= {};
      device.capabilitiesObj[capability].value = state.value_json;
      device.capabilitiesObj[capability].lastUpdated = state.event_time;
      device.capabilitiesObj[capability].ingested = true;
      if (state.unit) device.capabilitiesObj[capability].units = state.unit;
    }
    result[row.id] = device;
    return result;
  }, {});
  for (const row of externalDevices.rows) {
    const device = row.payload;
    device.id = row.id;
    device.zone ||= row.zone_id;
    device.capabilities ||= row.capabilities;
    device.capabilitiesObj ||= {};
    for (const [capability, state] of Object.entries(
      statesByDevice[row.id] || {},
    )) {
      device.capabilitiesObj[capability] ||= {};
      device.capabilitiesObj[capability].value = state.value_json;
      device.capabilitiesObj[capability].lastUpdated = state.event_time;
      device.capabilitiesObj[capability].ingested = true;
      if (state.unit) device.capabilitiesObj[capability].units = state.unit;
    }
    deviceMap[row.id] = device;
  }
  const toMap = (rows) =>
    rows.reduce((result, row) => {
      result[row.id] = row.payload;
      result[row.id].id = row.id;
      return result;
    }, {});

  sendJson(response, 200, {
    generatedAt: new Date().toISOString(),
    zones: toMap(zones.rows.concat(externalZones.rows)),
    devices: deviceMap,
    flows: toMap(flows.rows),
    advancedFlows: toMap(advancedFlows.rows),
    timers: timers.rows.map((row) => {
      const timer = row.payload;
      timer.syncedAt = row.synced_at;
      return timer;
    }),
    logicVariables: toMap(logicVariables.rows),
  });
}

async function getEvents(requestUrl, response) {
  const homeyDeviceId = requestUrl.searchParams.get("deviceId");
  const capability = requestUrl.searchParams.get("capability");
  const since = requestUrl.searchParams.get("since");

  if (!homeyDeviceId || !capability) {
    sendError(response, 400, "deviceId and capability are required");
    return;
  }

  const params = [homeyDeviceId, capability];
  let sinceClause = "";
  if (since) {
    params.push(new Date(Number(since) || since).toISOString());
    sinceClause = `and event_time >= $${params.length}`;
  }

  const result = await pool.query(
    `
    select id, event_time as t, value_json as v, device_name as "originName", 'homey:device:' || homey_device_id as "originUri",
      source_system as "sourceSystem", source_instance as "sourceInstance", source_event_id as "sourceEventId",
      author_system as "authorSystem", event_type as "eventType", causation_id as "causationId", correlation_id as "correlationId", replay_run_id as "replayRunId"
    from ingest_event
    where homey_device_id = $1 and capability = $2 and event_type = 'observation' ${sinceClause}
    order by event_time
  `,
    params,
  );

  sendJson(response, 200, { values: result.rows });
}

async function getHealth(response) {
  await pool.query("select 1");
  sendJson(response, 200, {
    ok: true,
    service: "homey-wingman-ingest-service",
    generatedAt: new Date().toISOString(),
  });
}

async function runAutomaticPriceImport() {
  if (!PRICE_IMPORT_ENABLED) return;

  const window = getDefaultPriceImportWindow();
  try {
    const result = await importEnergyPrices(window);
    console.log(
      `Imported ${result.imported} price intervals and rebuilt ${result.buckets} energy buckets for ${window.priceArea}`,
    );
  } catch (error) {
    console.warn(`Automatic price import failed: ${error.message || error}`);
  }
}

function startAutomaticPriceImport() {
  if (!PRICE_IMPORT_ENABLED) return;

  setTimeout(runAutomaticPriceImport, 15 * 1000);
  setInterval(runAutomaticPriceImport, PRICE_IMPORT_INTERVAL_MS);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/health") {
      await getHealth(response);
      return;
    }
    if (
      request.method === "POST" &&
      (url.pathname === "/api/ingest" || url.pathname === "/api/ingest/homey")
    ) {
      await handleIngest(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/sync/homey") {
      await handleHomeySync(request, response);
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/sync/external-devices"
    ) {
      await handleExternalDeviceSync(request, response);
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/zigbee/routes/snapshot"
    ) {
      await handleZigbeeRouteSnapshot(request, response);
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/zigbee/routes/history"
    ) {
      await getZigbeeRouteHistory(url, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/zigbee/layout") {
      await getZigbeeLayout(response);
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/zigbee/layout") {
      await putZigbeeLayout(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/energy/prices") {
      await handlePriceIngest(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/energy/rebuild") {
      await handleEnergyRebuild(request, response);
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/energy/import-prices"
    ) {
      await handleEnergyPriceImport(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/current-state") {
      await getCurrentState(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/homey/snapshot") {
      await getHomeySnapshot(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      await getEvents(url, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/replay/routes") {
      await getReplayRoute(url, response);
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/replay/routes") {
      await putDeviceRoute(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/energy/usage") {
      await getEnergyUsage(url, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/energy/prices") {
      await getEnergyPrices(url, response);
      return;
    }
    sendError(response, 404, "Not found");
  } catch (error) {
    console.error(error.message || error);
    sendError(response, 500, error.message || "Internal server error");
  }
});

if (require.main === module) {
  initializeDatabase()
    .then(() => {
      server.listen(PORT, "0.0.0.0", () => {
        console.log(
          `Homey Wingman ingest service listening on http://0.0.0.0:${PORT}`,
        );
        startAutomaticPriceImport();
      });
    })
    .catch((error) => {
      console.error(error.message || error);
      process.exitCode = 1;
    });
}
