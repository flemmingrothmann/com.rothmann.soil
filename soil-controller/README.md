# Soil Controller

This service is an ingest adapter only. Home Assistant owns soil threshold, hysteresis and the canonical watering alarm for migrated sensors.

It uses a persistent write-ahead queue in its Docker volume. A Z2M observation is written to disk before Wingman ingest is attempted and is removed only after Wingman returns `202`. Retry starts at 15 seconds and backs off to five minutes. Z2M's cached `state.json` bootstraps the latest state after a bridge restart; historical events emitted while both Z2M and the bridge are down cannot be reconstructed.

## Label-Driven Watering Circuits

The Vanding dashboard can plan, apply and remove HA watering circuits from one HA label. Discovery uses HA's authenticated WebSocket registries and REST state API, never HA `.storage`.

- A label must resolve to exactly one `switch` valve and one or more moisture sensors.
- Apply writes only a `# Managed by soil-controller` YAML package, updates matching controller profiles and reloads HA.
- Remove first returns a dry-run. The UI requires confirmation, then removes only that generated package and its generated profile fields. HA labels, devices and history remain unchanged.

## Zone Mapping

Home Assistant `Område` and device name are the source of truth for migrated device placement and display. Each entry in `config/profiles.json` maps a stable Z2M IEEE address to the matching HA device id, area id and display name for Wingman/dashboard use. Registry data is read through HA WebSocket APIs. Do not derive zones from device names or reuse Homey zone ids for new HA devices.

The bridge also ingests Z2M `linkquality` as a non-authoritative coverage indicator. The dashboard renders it only for Z2M devices as a five-level dot; stable reporting remains the actual coverage criterion.
