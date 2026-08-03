# Wingman Architecture

This document is the source of truth for Wingman's controller boundaries, event provenance and replay behavior. Code, integrations and deployment configuration must follow these rules.

## Purpose And Boundaries

Wingman is the local event history, analysis and replay platform on `hubert`.

- Homey, Home Assistant and Zigbee2MQTT are controllers. They own device communication, realtime state and writes for devices assigned to them.
- Wingman records facts, serves history and coordinates replay. It is not an implicit controller and must not issue device writes outside an explicit replay target.
- A physical device has exactly one active write controller at a time.
- A Zigbee device belongs to the mesh of the coordinator to which it is paired. Homey and Zigbee2MQTT meshes are separate and never route for each other.
- Homey and Home Assistant automations must be mutually exclusive for every device or real-world outcome. Timing is not a concurrency control mechanism.

## Device Authority

Every device known to more than one system needs an explicit routing record before Wingman may dispatch commands to it. The routing record contains:

- Stable physical-device identity, independent of controller-specific ids.
- Current write controller and address used by that controller.
- Authoritative state observer.
- Controller ownership history with effective timestamps.

Device routing is versioned operational data. A replay uses the routing valid for the source event's time, not the routing currently configured. A controller migration must create a new routing version before the first write through the new controller.

Routes are managed through `PUT /api/replay/routes` and resolved through `GET /api/replay/routes?sourceSystem=<system>&deviceId=<id>&at=<timestamp>`. A resolution with zero or multiple routes is an error and skips the replay action. Homey snapshot synchronization creates the historical `homey -> homey` route for each known Homey device; no other route is inferred.

## Event Model

Every event has a physical-device identity, controller-local device id, capability, value and event timestamp. It also carries these provenance fields:

- `source_system`: system that emitted the event into Wingman, such as `homey`, `home_assistant`, `zigbee2mqtt` or `replay`.
- `source_instance`: emitting controller or service instance.
- `source_event_id`: immutable source-local event or command id.
- `author_system`: system that made the decision represented by the event. It is `null` only when unknown, never guessed.
- `event_type`: `observation` or `command`.
- `causation_id`: immediate prior Wingman event or source event that caused this event, when known.
- `correlation_id`: shared identifier for one automation, user action or replay run.
- `replay_run_id`: replay run identifier; present only for replay-generated events.

`source_system` and `author_system` are not interchangeable. For example, Homey can observe a state change caused by a Home Assistant automation: source is `homey`, author is `home_assistant`. Preserve uncertainty rather than assigning false authorship.

## Observation And Command Rules

- An `observation` reports controller-observed state and is the only event type allowed to update `state_current`.
- A `command` records an attempted or accepted write. It never proves a physical state change and never updates `state_current`.
- Commands and observations are immutable audit history. Corrections are new events, never updates or deletions.
- Command events must never be selected as replay source events.
- A controller must supply `source_event_id` whenever its API provides a stable id. Ingest is idempotent on source identity when deduplication is enabled; absent ids are treated as potentially duplicated delivery.

## Replay Rules

- Replay is deterministic, version-bound behavior. A profile or routing decision used by an active or retained run must not change retroactively.
- A replay command uses `source_system=replay`, `author_system=replay`, `event_type=command`, its run id as both `correlation_id` and `replay_run_id`, and links to its historic source event through `causation_id`.
- A replay action is dispatched only through the write controller valid for the source event's routing version. Missing or ambiguous routing skips the action and records a visible error; it must never fall back to another controller.
- The controller's subsequent observation is stored separately. It retains the replay command as causation where the controller can propagate it; otherwise its author remains unknown.

## Ingest Contract

- `POST /api/ingest` is the controller-neutral ingress endpoint. Controller-specific ingress endpoints may exist only as adapters to this contract.
- Emitters send timestamps from the source system and preserve their original ids. Wingman accepts delayed delivery; ordering is by occurred timestamp with receipt time retained for diagnosis.
- Clients read historic behavior from ordered `observation` events, not from current state and not from command audit entries.
- New controllers and emitters must conform to this document before they are connected to production Wingman ingest.
- Replay supports Homey capability writes and Home Assistant `light` `onoff` and `dim` writes. A new controller is not a replay target until it has an explicit dispatcher, capability mapping and routing records.
