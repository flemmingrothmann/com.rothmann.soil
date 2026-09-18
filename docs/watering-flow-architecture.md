# Watering Flow Architecture

This document is the setup contract for Homey watering valves, their Advanced Flows, Wingman and the Bogfinkevej dashboard.

## Data Flow

1. Homey Advanced Flow controls the physical valve.
2. Homey Logic variables expose cycle duration, maximum cycles, watering error and lifecycle status.
3. Homey Wingman syncs devices, flows, timers and Logic variables to Hubert.
4. Ingest stores the snapshot and serves it from `/api/homey/snapshot`.
5. The dashboard reads Hubert data and writes watering settings and error resets back to Homey Logic through its authenticated backend.

Do not make the dashboard infer lifecycle from valve state or timer names when a status variable is available.

## Valve Contract

Each managed valve must have exactly one enabled Advanced Flow that contains:

- One physical `on` action and one physical `off` action for the valve.
- One Chronograph opening timer named `VAND <flow zone> åbent`.
- The opening timer `time` set directly to `[[homey:manager:logic|<duration-variable-id>]]`, with `unit: minutes`.
- One Chronograph `timer_finished` trigger for `VAND <flow zone> åbent`, connected directly to the valve's existing `off` action.
- A close verification branch. If the valve remains on, set `closing_error` and retry/alert as appropriate.
- A max-cycle notification branch. When the configured maximum is reached, set `cycle_limit` and `VAND <flow zone> vandingsfejl` to `true`.
- An error gate before the normal demand-start path. A latched watering error must prevent a new lifecycle.
- A recovery branch triggered by `VAND <flow zone> vandingsfejl`. When it changes to `false`, reset the cycle counter, set `idle` and re-evaluate the flow's own demand source.

Never use an unverified Logic tag in a Homey delay card. Use the verified direct Logic tag in Chronograph's `time` field.

## Logic Variables

Every managed valve flow has four variables. Keep the shared `VAND <flow zone>` prefix and put the variable function last, so one flow's variables stay grouped in Homey's variable list:

| Variable | Type | Purpose |
|---|---|---|
| `VAND <flow zone> cyklus varighed` | number | Physical valve-open time in minutes. Dashboard permits 1-30. |
| `VAND <flow zone> max cyklusser` | number | Maximum cycles in one watering lifecycle. Dashboard permits 1-100. The max comparator references this variable with its direct Logic tag. |
| `VAND <flow zone> vandingsfejl` | boolean | Latched watering error. `true` stops the lifecycle; dashboard reset writes only `false`. |
| `VAND <flow zone> status` | string | Explicit lifecycle source of truth for the dashboard. |

When `vandingsfejl` is true, the dashboard shows a clear error action. After confirmation, `POST /api/watering/:valveId/restart` resets only that variable to `false`; it never opens the valve. The Homey flow owns any conditional restart based on current watering demand. Pending duration, maximum-cycle and error-reset writes override stale Wingman snapshot values until synchronization catches up.

Reset behavior:

- Sensor- and zone-controlled flows restart only while their associated water alarm is still active.
- Rhododendron restarts only while `VAND Rhododendron ønskes` is still `true`; do not substitute an unrelated soil alarm.
- Resetting an error without current demand leaves the flow in `idle`.

Allowed status values:

| Value | Meaning | Dashboard |
|---|---|---|
| `idle` | No active watering lifecycle. | Lukket |
| `watering` | Flow has opened the valve and the opening cycle is active. | Vander nu / Vandingsforløb kører |
| `closing` | Flow has asked the valve to close and is verifying it. | Lukker ventil |
| `waiting_result` | Valve is closed; flow awaits soil/result before retrying or completing. | Afventer resultat |
| `closing_error` | Close verification found the valve still open. | Ventil lukker ikke |
| `cycle_limit` | Flow stopped after its configured maximum cycles. | Maks. cyklusser nået |

Set status cards as separate outgoing branches from existing phase cards. Do not replace existing connections.

## Trigger Types

### Sensor-controlled

Use when a soil sensor or zone water alarm owns watering demand.

- Trigger: sensor `alarm_water_true` or zone `alarm_true` for `alarm_water`.
- After each cycle: test the same sensor/zone alarm.
- If still dry: set `waiting_result`, schedule/restart the next cycle.
- If satisfied: set `idle` and reset cycle counter.

Examples: `Bregnebed vanding`, `Terasse vanding`.

### Timer/request-controlled

Use when a separate schedule/request signal owns watering demand.

- Trigger: a dedicated Logic request variable, schedule or other explicit trigger.
- Rhododendron uses `VAND Rhododendron ønskes` as its request variable.
- Do not assume an unrelated soil sensor is the demand source.
- Clear the request only at the existing terminal completion point.

Example: `Rhododendron vanding`.

## Advanced Flow Layout

Preserve all existing card coordinates and connections.

- Place new lifecycle status cards in the dedicated right column at `x=1900`.
- Existing positions used by current flows:
  - `watering`: `y=240`
  - `closing`: `y=420`
  - `closing_error`: `y=560`
  - `waiting_result`: `y=740`
  - `idle`: `y=940`
  - `cycle_limit`: `y=1280`
- The direct Chronograph duration card is at the existing physical-open-time position, normally `x=1240`, `y=340`.
- Its `timer_finished` card is placed nearby at `x=1480`, `y=440` and connects to the existing valve-off card.
- Error gate, latch and recovery cards use the dedicated recovery area from `x=2180` without moving existing cards.
- Never automatically reset manual flow positions.

## New Valve Checklist

1. Identify the physical valve device ID, display name and Homey zone.
2. Decide demand owner: soil sensor/zone alarm or explicit timer/request variable.
3. Create an enabled Advanced Flow named `<zone> vanding`.
4. Create all four `VAND <flow zone>` Logic variables from the contract above.
5. Add direct-Logic Chronograph opening timer and finished-to-off connection.
6. Add every lifecycle status card in the right status column.
7. Add cycle counting, compare against the direct `max cyklusser` Logic tag, and set `cycle_limit` from its max-cycle branch.
8. Sync Wingman and verify on Hubert snapshot that the device, flow and all four Logic variables appear.
9. Verify the public dashboard shows the valve, interval control, maximum cycles, status and error reset when relevant.
10. Test a non-destructive cycle or observe the next real cycle through `watering`, `closing`, `waiting_result` and terminal `idle`/`cycle_limit`.

## Current Managed Flows

- Bregnebed
- Drivhus inde
- Drivhus ude
- Husfacade
- Nordhegn
- Rhododendron
- Terasse
- Terassebed

`Vandventil utility` is not currently part of this managed flow contract and has no dashboard interval control.

The managed flows were migrated to the four-variable contract on 2026-08-03. Use `tools/configure-watering-flow-errors.ps1` for idempotent preflight, backup, migration and verification.
