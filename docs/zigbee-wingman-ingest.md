# Zigbee observations and HA metadata

## Ownership

- Zigbee2MQTT owns the Zigbee radio and mesh. MQTT is transport, not the owner of rooms.
- HA owns names, areas, labels, helpers, automations and light writes.
- `home-assistant-wingman-ingest-service` observes Zigbee2MQTT directly when `ZIGBEE_INGEST_ENABLED=true`. It does not publish device commands.
- `soil-controller` retains its existing direct observations for IEEE addresses in its live `profiles.json`, plus HA watering alarms/settings. The general adapter excludes these addresses dynamically.
- The HA light automation remains useful for groups and non-Zigbee lights. The adapter suppresses its events for unambiguously mapped direct Zigbee lights, including supported `switch_as_x` light helpers.
- The main energy meter remains HA-authoritative; its existing migration cutoff is unchanged.

## Identity and areas

The adapter reads HA's device/entity/area/label registries through authenticated WebSocket calls. It matches the exact MQTT identifier `zigbee2mqtt_<IEEE>`, never a display name. Registry update events trigger refreshes; reconnection performs a full refresh.

- Entity area overrides device area for a mapped light. No area becomes **Uplaceret**, never a guessed room.
- Device `name_by_user` and light entity name overrides take precedence over automatic names.
- `wingman-ignore` works at device, mapped light-helper and individual MQTT measurement-entity level.
- A single supported MQTT light or switch-as-light retains its existing HA light id as the Wingman history id. Other devices use IEEE. Once assigned, the history id stays fixed.
- An HA entity rename changes `haEntityId` and creates a new dated Z2M-observer-to-HA replay route. The history id and old routes remain intact. Dashboard writes use the current explicit HA entity reference.
- Ambiguous/multi-endpoint light mappings are not taken over silently. Their HA light observations continue; unsupported per-endpoint values are not guessed.
- Existing soil profiles periodically refresh names/areas from HA by IEEE, including valves that did not previously have `haDeviceId`.

## Failure behavior

The adapter volume contains `zigbee-metadata.json`, `zigbee-pending.json`, `wingman-queue.json` and `zigbee-status.json`.

- Raw observations are persisted before processing; outgoing batches are persisted before HTTP delivery. Queue entries are removed only after successful metadata/route synchronization and an ingest **202**.
- Files are replaced atomically. Corrupt queues/caches fail visibly instead of being replaced with empty files. Unacknowledged events are not evicted to meet an arbitrary count limit; monitor free disk space.
- During HA downtime, the persisted IEEE/name/area mapping remains usable. First-ever startup without any HA metadata spools observations until HA is reachable once.
- Retained state uses its original `last_seen`; an untimestamped retained state is not ingested as a fresh measurement. Retained button actions are not replayed as new presses.
- Availability `offline` creates unavailable/null observations, not invented off/zero readings. Online status alone does not invent a measurement.
- Delivery is **at least once**, not exactly once: a lost HTTP response/crash across acknowledgements can duplicate events because the existing ingest API does not deduplicate source ids. Source ids are retained for diagnosis.
- MQTT QoS cannot recover all history while the adapter/broker itself is down. Retained state only recovers the latest cached value, not intermediate observations. HA downtime alone does not stop direct observation.

## Deploy and verify

Preserve existing private `.env` files and named volumes. Enable `ZIGBEE_INGEST_ENABLED=true` in the HA ingest service's `.env`. The compose file mounts the soil profiles directory read-only; changes to ownership therefore do not require a copied profile list.

Only rebuild/recreate the affected adapters and dashboard on **hubert**. Do not restart HA, Zigbee2MQTT or Mosquitto, reset pairings, or run `down -v`.

Some `/opt/soil` source files and private `.env` files are root-owned. Use `sudo -n` for backup/extraction and `docker compose` rather than weakening file permissions. Both adapters use committed lockfiles and `npm ci` for reproducible dependency installation.

```powershell
npm test
```

Runtime verification script (copy into the adapter's `/app` first):

```sh
docker exec home-assistant-wingman-ingest-service node /app/verify-zigbee-ingest.js
docker exec home-assistant-wingman-ingest-service cat /data/zigbee-status.json
```

Verify live Z2M provenance in Wingman, matching HA names/areas, explicit replay routes, no new HA-source observations for direct lights after cutover, unchanged HA energy observations and a draining queue. Metadata-only updates must not create physical observations.

Rollback: disable the feature and recreate the HA ingest adapter using its backed-up source/config. The unchanged HA light automation resumes as the light observation source. Preserve persistent queues and historical events; do not delete the volume to roll back.

## Runtime verification, 11 November 2026

- 72 deterministic tests passed; both deployed adapters' production dependency audits reported zero known vulnerabilities.
- 23 Zigbee models discovered; 7 lights mapped directly, including switch-as-light helpers. Soil-profile devices remain excluded from the general observer.
- A real MQTT power observation reached Wingman unchanged with Z2M provenance. The same message was processed with cached metadata and an intentionally unreachable HA connection in an isolated verifier; the real HA was not stopped.
- A temporary HA light-name/area override reached Wingman automatically, then was restored and verified. No physical devices were commanded.
- A duplicate HA light observation was suppressed; neither history nor `state_current` gained a new HA-source observation.
- HA energy retained its four authoritative capabilities. Both adapter queues drained; affected containers had zero restarts. Public authenticated lights, watering and overview dashboard reads returned 200.
- Deployed checksums matched all 11 changed application/lock files checked. Original source/image references were backed up under `/opt/soil/.backups/zigbee-ingest-*`; the complete pre-change source backup is `zigbee-ingest-20261111T102939Z/sources.tar.gz`.
