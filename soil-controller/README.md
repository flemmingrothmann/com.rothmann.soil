# Soil Controller

This service owns soil ingest and automatic setup of manual soil alarms. Home Assistant owns threshold evaluation, hysteresis, notifications and the canonical watering alarm. The adapter does not operate valves for automatic onboarding.

It uses a persistent write-ahead queue in its Docker volume. A Z2M observation is written to disk before Wingman ingest is attempted and is removed only after Wingman returns `202`. Retry starts at 15 seconds and backs off to five minutes. Z2M's cached `state.json` bootstraps the latest state after a bridge restart; historical events emitted while both Z2M and the bridge are down cannot be reconstructed.

## Label-Driven Watering Circuits

The Vanding dashboard can plan, apply and remove HA watering circuits from one HA label. Discovery uses HA's authenticated WebSocket registries and REST state API, never HA `.storage`.

- A label must resolve to exactly one `switch` valve and one or more moisture sensors.
- Apply writes only a `# Managed by soil-controller` YAML package, updates matching controller profiles and reloads HA.
- Remove first returns a dry-run. The UI requires confirmation, then removes only that generated package and its generated profile fields. HA labels, devices and history remain unchanged.

## Zone Mapping

Home Assistant `Område` and device name are the source of truth for migrated device placement and display. Each entry in `config/profiles.json` maps a stable Z2M IEEE address to the matching HA device id, area id and display name for Wingman/dashboard use. Registry data is read through HA WebSocket APIs. Do not derive zones from device names or reuse Homey zone ids for new HA devices.

The bridge also ingests Z2M `linkquality` as a non-authoritative coverage indicator. The dashboard renders it only for Z2M devices as a five-level dot; stable reporting remains the actual coverage criterion.

## Stable Sensor Identity

- Profile keys and Wingman history ids are the physical Zigbee IEEE address. Names, HA registry ids and MQTT friendly names are not interchangeable identities.
- The adapter resolves current state topics from `zigbee2mqtt/bridge/devices`, keyed by IEEE, and follows inventory updates without restarting. Old `zigbeeTopic` profile values are legacy hints and are no longer used to route observations.
- A fresh retained inventory is required after each MQTT reconnect, even when `/data/zigbee-device-topics.json` exists. Reused names, ambiguous mappings and command subtopics must not cross-wire sensor history.
- Cached sensor state is read only by IEEE and keeps its source timestamp. A stale cache is not made fresh by redeploying. Unsupported/missing identities are not guessed from old pot names.
- HA remains authoritative for visual names/areas, refreshed at most once per minute. Moving or renaming a sensor does not reassign its watering circuit or change thresholds/automations.
- History follows the **sensor**, not the pot: moving one sensor between pots keeps one series; reusing a pot name for another sensor does not merge their series.

Verify with `node --test tests/soilIdentity.test.js` and an actual MQTT observation reaching Wingman under the same IEEE id. For deployment, copy the complete adapter build context (including `zigbeeIdentity.js`), preserve live `config/` and private `.env`, and recreate only `homey-wingman-soil-controller` on `hubert`.

## Automatic Manual Alarms

New Zigbee devices exposing `soil_moisture` are reconciled against HA's registry by IEEE, without a model whitelist or custom Zigbee converter. Once HA discovery is ready, the adapter creates UI-managed threshold/alarm/cooldown helpers and one editable blueprint instance. This runs on inventory updates and retries approximately once per minute.

- Default threshold: **25 %**; **0 disables**. Existing thresholds (including zero), helper values, notification cooldowns and disabled automation states are never reset to defaults.
- Alarm on at/below the threshold; off at threshold + 6 percentage points, capped at 95 %. HA remains the only alarm evaluator.
- Existing `manual-soil-moisture-alarm` instances are extended, not duplicated. Existing notification ids/cooldowns are retained. Future instances use a stable IEEE-based key.
- Helpers are created through HA WebSocket CRUD, not YAML packages. Numeric values are set once on creation; helper ids, history ids and notification keys survive visual renames.
- Explicit soil profiles/watering-alarm owners and `wingman-ignore` devices are excluded from onboarding. No watering circuit, valve command or HA mobile-app list is inferred or changed.
- HA publishes software control state to the profile's `homeassistant/soil/.../control` topic. Only changes are queued, with `source_system=home_assistant`; raw physical readings retain Z2M provenance.
- The completed profile is persisted before publishing software capabilities. The generic ingest adapter observes the shared profile ownership file and must not overwrite domain metadata when draining old queued observations.
- A deleted/unavailable existing helper is reported, not replaced with a fresh default. Repair its binding in the HA automation UI. User-created automation/helper settings remain authoritative.

Tests: `node --test tests/soilProvisioning.test.js` plus `home-assistant/tests/test_software_soil_alarm.py` and the notification cooldown tests. HA blueprint changes must be deployed before starting a new adapter version that uses the additional inputs. Preserve all unrelated live automations and private configuration.
