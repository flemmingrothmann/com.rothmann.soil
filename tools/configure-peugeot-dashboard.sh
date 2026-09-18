#!/usr/bin/env bash
set -euo pipefail

env_file=${1:-/opt/soil/dashboard/.env}
vin=$(docker exec peugeot-car-controller sh -c "grep -oE '[A-HJ-NPR-Z0-9]{17}' /config/cars.json | head -n 1")
model=$(docker exec peugeot-car-controller python3 -c 'import json; data=json.load(open("/config/cars.json")); print(data[0].get("label", "Peugeot"))')
existing_model=$(sed -n 's/^PEUGEOT_MODEL=//p' "$env_file" | tail -n 1)

if [[ -z "$vin" ]]; then
  echo "No Peugeot VIN found in the controller configuration." >&2
  exit 1
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
grep -v -E '^PEUGEOT_(VIN|MODEL)=' "$env_file" > "$tmp" || true
printf 'PEUGEOT_VIN=%s\n' "$vin" >> "$tmp"
if [[ -z "$model" || "$model" == "unknown" ]]; then
  model=${existing_model:-Peugeot}
fi
printf 'PEUGEOT_MODEL=%s\n' "$model" >> "$tmp"
chmod --reference="$env_file" "$tmp"
mv "$tmp" "$env_file"
trap - EXIT

docker compose \
  --env-file "$env_file" \
  --project-directory /opt/soil/dashboard \
  -f /opt/soil/dashboard/compose.yaml \
  up -d --force-recreate

echo "Dashboard configured with the Peugeot vehicle."
