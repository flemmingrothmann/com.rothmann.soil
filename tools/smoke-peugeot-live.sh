#!/usr/bin/env bash
set -euo pipefail

docker exec -i soil-dashboard node <<'NODE'
async function run() {
  const response = await fetch(`${process.env.PEUGEOT_URL}/get_vehicleinfo/${encodeURIComponent(process.env.PEUGEOT_VIN)}`);
  const body = await response.text();
  if (!response.ok) throw new Error(`Peugeot service returned ${response.status}: ${body}`);
  const data = JSON.parse(body);

  function findElectric(value) {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) return value.map(findElectric).find(Boolean) || null;
    if (/electric/i.test(String(value.type || value.energyType || '')) && (value.level != null || value.autonomy != null)) return value;
    return Object.values(value).map(findElectric).find(Boolean) || null;
  }

  const energy = findElectric(data) || {};
  console.log(JSON.stringify({
    batteryLevel: energy.level ?? energy.batteryLevel ?? null,
    rangeKm: energy.autonomy ?? energy.range ?? null,
    updatedAt: data.updatedAt || data.timestamp || energy.updatedAt || energy.timestamp || null,
  }, null, 2));
}

run().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
NODE
