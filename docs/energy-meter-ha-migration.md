# Energy main meter: Home Assistant

## Active data path

`Homey Energy Dongle → Homey P1 (HA) → HA Wingman ingest → Wingman → dashboard`.

- HA integration: stable `homey_p1` 0.5.1 at migration.
- HA observer: `home-assistant-wingman-ingest-service` on `hubert`, enabled with `HA_ENERGY_ENABLED=true`.
- Controller-local Wingman device: `home_assistant:energy_main`, displayed as `Elmåler (HA)` under its configured HA area (currently `Hjem`).
- Entities: `sensor.electricity_meter_power_consumption`, `power_production`, `energy_import_total`, `energy_export_total`.
- Capabilities: `measure_power.imported/exported` in W, `meter_power.imported/exported` in kWh. No guessed conversions or tariff sensors.
- Observer subscribes to HA state triggers, seeds current state after subscribing and reconnects after disconnects. Events are persisted in the existing adapter queue before delivery and removed only after `202`.
- Sensor observations never create replay/write routes. Existing light handling continues separately.

## Authority and history

Cutover: **2026-10-13T08:10:00Z (10:10 Danish time)**.

`ENERGY_METER_MIGRATIONS_JSON` in ingest's private `.env` contains:

```json
[{"previousId":"9369fb97-310f-4105-92a2-5a285f14ab00","currentId":"home_assistant:energy_main","switchedAt":"2026-10-13T08:10:00Z"}]
```

- Raw Homey and HA observations retain their original controller ids and provenance; history is not rewritten or deleted.
- Derived meter deltas use Homey **before** cutover and HA **at/after** cutover, joining the unchanged physical meter counter across the boundary.
- Derived history retains the previous id as its stable series key. Homey observations after cutover are not included in the main-meter calculation.
- Dashboard uses `ENERGY_MAIN_DEVICE_ID=home_assistant:energy_main` for live power and `ENERGY_USAGE_DEVICE_ID=9369fb97-310f-4105-92a2-5a285f14ab00` for history.
- Existing `deviceId` filtering restricts the dashboard to the main meter, excluding submeter/plug consumption from the household total.
- Price import remains independent in Wingman. Export is shown as negative net power and receives zero instantaneous consumption cost.
- Keep the cutover timestamp fixed on redeploy. A subsequent controller migration needs another explicit authority decision.

## Verification

```powershell
node --test tests/ha-energy.test.js
```

On `hubert`, copy the verification scripts into their respective containers, then run:

```sh
docker exec homey-wingman-ingest-service node /app/verify-energy-migration.js
docker exec soil-dashboard node /tmp/verify-ha-energy-runtime.js
docker exec homey-wingman-ingest-service node /app/verify-energy-authority.js
```

- Migration fixture uses temporary tables and always rolls back; checks cutover continuity, overlap exclusion, command exclusion and price matching.
- Runtime check verifies current HA provenance, main-meter aggregation and authenticated dashboard overview/details.
- Authority check compares buckets to raw authoritative meter deltas at the last rebuild timestamp and confirms both controllers are still emitting without separate HA-derived duplicate buckets.
- `tools/configure-ha-energy-migration.py` configures private environment files from existing runtime credentials; backups use `.env.before-ha-energy-migration`. It does not print secrets.

Verified on `hubert` after cutover: live HA observations and dashboard costs; old history remains visible. Phase power entities remain disabled in HA and are not emitted.

At startup, upstream Datahub returned `429` for two tariff lookups; existing current-day price intervals remained available and dashboard costs were verified. Avoid forcing another price import; normal scheduled imports handle later windows.
