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
- Soil topic routing also follows the live Z2M inventory by IEEE, never the old pot name in a profile. It refreshes on renames and reconnects without changing the history id; watering-circuit membership remains explicit. See [soil identity rules](../soil-controller/README.md#stable-sensor-identity).
- Dashboard soil cards are controller-scoped: Z2M soil devices render only when mapped to an HA device (`haDeviceId`); Homey-controller soil devices remain visible under the existing migration policy even without an HA mapping.

## Failure behavior

The adapter volume contains `zigbee-metadata.json`, `zigbee-pending.json`, `wingman-queue.json` and `zigbee-status.json`.

- Raw observations are persisted before processing; outgoing batches are persisted before HTTP delivery. Queue entries are removed only after successful metadata/route synchronization and an ingest **202**.
- Files are replaced atomically. Corrupt queues/caches fail visibly instead of being replaced with empty files. Unacknowledged events are not evicted to meet an arbitrary count limit; monitor free disk space.
- During HA downtime, the persisted IEEE/name/area mapping remains usable. First-ever startup without any HA metadata spools observations until HA is reachable once.
- Configure the live adapter's `HOME_ASSISTANT_URL` as `http://192.168.100.67:8123` (the former `.66` address is deprecated). In `zigbee-status.json`, `haConnected: false`, an old `metadataSyncedAt`, and a growing queued backlog together indicate registry-sync failure. Restore HA connectivity and let the adapter retry; preserve its persistent queue/WAL during recovery.
- Retained state uses its original `last_seen`; an untimestamped retained state is not ingested as a fresh measurement. Retained button actions are not replayed as new presses.
- Availability `offline` creates unavailable/null observations, not invented off/zero readings. Online status alone does not invent a measurement.
- Delivery is **at least once**, not exactly once: a lost HTTP response/crash across acknowledgements can duplicate events because the existing ingest API does not deduplicate source ids. Source ids are retained for diagnosis.
- MQTT QoS cannot recover all history while the adapter/broker itself is down. Retained state only recovers the latest cached value, not intermediate observations. HA downtime alone does not stop direct observation.

## Z2M inventory reconciliation

- On each MQTT connection the adapter waits for a fresh, validated `zigbee2mqtt/bridge/devices` inventory before replaying queued observations. Empty, malformed or duplicate-IEEE inventories are rejected; stale cached inventory is never used to authorize deletion.
- The adapter durably queues a complete snapshot to `POST /api/sync/external-device-inventory` with `inventorySource: "zigbee2mqtt"`; it upserts current devices and removes missing Z2M-owned external-device metadata/current state in one transaction.
- Soil-profile IDs and currently inventoried devices that cannot be safely mapped are sent as protected IDs. Cleanup also checks ownership metadata/legacy Z2M driver and route records, and current-state deletion requires Z2M provenance. Homey state is protected.
- Active routes belonging to removed Z2M devices are closed. Historical `ingest_event` rows are never deleted. Route updates for devices still present continue through the existing replay-route API.
- Queue acknowledgement requires HTTP 202. Failed API delivery retains the complete snapshot for retry; repeating a snapshot is safe. This endpoint is exclusively for complete, source-scoped inventories—partial device updates must continue using `POST /api/sync/external-devices`.

## HA light inventory

- The same endpoint also accepts `inventorySource: "home_assistant_lights"`, restricted to `light.*` devices with `driverId: "home_assistant:light"` and `sourceSystem: "home_assistant"`. Other HA devices, including the energy meter, are outside this scope.
- A successful full HA registry/state read supplies the inventory. Registry changes and light creation/removal/name changes refresh it; unavailable lights still present in HA remain visible as unavailable. Failed reads never produce an empty cleanup snapshot.
- HA owns current names and areas. Metadata sync does not depend on a new physical reading. Delayed MQTT observations cannot overwrite current registry names or recreate removed metadata/replay routes; their original events are retained.
- Direct Z2M history IDs and soil-profile IDs are protected from HA-light cleanup. Removed legacy HA-light metadata/current HA state is deleted, its HA routes closed, and event history preserved. No automatic identity merging occurs.
- Exclusion and protection are separate: a direct Z2M light's current `haEntityId` is excluded from the generic HA inventory, but only its stable history ID is protected. When the history ID is IEEE, protecting the HA alias as well would keep a stale duplicate alive. When the history ID is already `light.*`, that same ID must remain protected.
- Dashboard error text is controller-neutral: an unavailable HA/Z2M device must not be described as a Homey failure.

### Alias reconciliation verified on Hubert, 19 November 2026

- Separate HA-entity exclusion from stable-ID protection. `Værksted Hovedrum` now has one IEEE-bound inventory entry; the stale generic HA alias and its current state were removed automatically.
- Its six historical HA events and all 2,051 pre-verification Z2M events remain. The stale HA route was closed; the active Z2M-to-HA route and 43 unrelated non-HA inventory entries were preserved.
- HA and Wingman both report off, and the authenticated lights dashboard no longer shows the ghost as on. Both adapter queues drained; deployed source/runtime hashes matched. No physical commands or HA/Z2M restarts were used.
- Independent review passed; 176 offline Node tests passed. Source/image backup: `/opt/soil/.backups/light-reconciliation-20261119T212033Z/`.

### Verified on Hubert, 17 November 2026

- 174 Node tests passed; the reconciliation SQL also passed isolated temporary-table tests in Hubert's PostgreSQL (including source boundaries, history, protected IDs and retries).
- The removed HA light `light.0x94a081fffe2f9ad0` disappeared automatically. The active IEEE-bound `Soveværelse skab LED-driver` remained available; all four old HA events and the Z2M history were preserved, along with 30 unrelated external-device metadata records.
- A temporary HA device rename propagated to Wingman without a hardware command. The original name was restored and verified, with the same IEEE/history identity.
- Authenticated lights/overview APIs contain no ghost; served frontend error text is controller-neutral. All seven dashboard build-context files and six runtime assets matched the repository. Source/image baseline: `/opt/soil/.backups/ha-light-inventory-20261117/`.

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
