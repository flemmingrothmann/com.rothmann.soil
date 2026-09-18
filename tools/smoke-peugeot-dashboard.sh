#!/usr/bin/env bash
set -euo pipefail

docker exec -i soil-dashboard node <<'NODE'
const crypto = require('crypto');

async function run() {
  const appId = process.env.HOMEY_APP_ID || 'com.rothmann.soil';
  const secret = process.env.DASHBOARD_COOKIE_SECRET || `${process.env.DASHBOARD_PASSWORD}:${appId}`;
  const value = 'authenticated';
  const signature = crypto.createHmac('sha256', secret).update(value).digest('base64url');
  const response = await fetch('http://127.0.0.1:8787/api/vehicle-dashboard', {
    headers: { cookie: `soil_dashboard_session=${value}.${signature}` },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Dashboard returned ${response.status}`);
  console.log(JSON.stringify({
    configured: data.configured,
    source: data.source,
    vehicle: {
      name: data.vehicle?.name,
      batteryLevel: data.vehicle?.batteryLevel,
      rangeKm: data.vehicle?.rangeKm,
      charging: data.vehicle?.charging,
      plugged: data.vehicle?.plugged,
      updatedAt: data.vehicle?.updatedAt,
      fetchedAt: data.vehicle?.fetchedAt,
      ageMs: data.vehicle?.ageMs,
      freshness: data.vehicle?.freshness,
      stale: data.vehicle?.stale,
    },
  }, null, 2));
}

run().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
NODE
