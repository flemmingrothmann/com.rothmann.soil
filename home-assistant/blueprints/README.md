# Home Assistant Blueprints

## Bevægelseslys med slukningsvarsel

`automation/wingman/motion-light-warning.yaml` tænder ved bevægelse og dæmper
som varsel inden slukning. Ny bevægelse afbryder nedtællingen og gendanner
normal lysstyrke. Ukendt/utilgængelig sensor afbryder også nedtællingen.

- Opret én automation pr. rum via **Indstillinger → Automatiseringer og scener
  → Blueprints → Bevægelseslys med dæmpet slukningsvarsel**.
- Vælg sensor, dæmpbare lys, normal lysstyrke, ventetid, varslingsstyrke og
  varslingstid. Standard: 100 %, 5 minutter, 30 %, 30 sekunder.
- Brug en sensorgruppe ved flere sensorer; gruppen skal først melde fri, når
  alle sensorer er fri. Undgå andre automatikker, der styrer de samme lys.
- Ventetiden starter, når sensoren melder fri, ikke ved sidste fysiske bevægelse.
- Genstart/reload afbryder ventetider. Næste sensorændring genoptager styringen.
- Verificér fysisk: bevægelse tænder; fri sensor giver varsel og slukning;
  bevægelse både før og under varslet gendanner normal styrke uden senere
  slukning. Sensorudfald må ikke starte slukning.

`automation/wingman/soil-moisture-alarm.yaml` owns the canonical watering alarm for an HA/Z2M soil sensor.

- Alarm on: moisture is at or below the configured threshold.
- Alarm off: moisture is at or above `min(95, threshold + 6)`.
- Values in the hysteresis interval retain the existing alarm state.

Create one `input_number` threshold and one `input_boolean` watering alarm per physical plant/sensor, then create an automation from the blueprint with those two helpers and the sensor entity.

The automation publishes `ON` or `OFF` to its configured retained MQTT alarm topic. `soil-controller` ingests that HA-owned alarm observation and the raw Z2M measurements into Wingman. Zone mapping belongs in `soil-controller/config/profiles.json`, where each stable Z2M IEEE address is mapped to one canonical Wingman zone id.

## Labelled Pot Watering

`automation/wingman/labelled-pot-watering.yaml` controls one valve switch from the soil alarms in one watering circuit.

- Apply the same label to the valve, every soil sensor and every circuit helper in that circuit. Use a specific label such as `vanding-terasse-potter`, not the physical area label.
- The blueprint selects labelled alarm helpers ending in `_water_alarm`. A sensor must therefore first use the `soil-moisture-alarm` blueprint.
- Give each circuit its own `input_number` helpers for cycle duration, pause duration and maximum cycles, plus an `input_boolean` for its latched error and an `input_select` with `idle`, `watering`, `waiting_result` and `cycle_limit`.
- A run starts when any circuit alarm changes to `on`, closes the valve after every cycle, and stops either when all circuit alarms are off or when the maximum is reached. The latter latches the error boolean until it is reset manually.
- Device labels define irrigation membership; Home Assistant areas remain physical placement only.
