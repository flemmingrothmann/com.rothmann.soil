# Homey Replay Service

Selvstaendig scheduler til at afspille historiske capability-aendringer fra Wingman.

## Ansvar

- Gemmer replay-profiler og aktive runs i Docker-volume.
- Mapper et historisk kildetidspunkt til nu, som standard praecis syv dage tilbage.
- Afspiller `onoff`, `dim` og `light_*` for lys.
- Afspiller kun `onoff` for oevrige eksplicit valgte enheder.
- Fortsaetter et aktivt run efter containergenstart ved hjaelp af persistente capability-checkpoints.

Dashboardet er klient/proxy. Wingman er historikkilde, og Homey udfoerer writes. Hvert replay-write registreres i Wingman som et `command`-event med `source_system=replay`, `replay_run_id` og reference til kildeeventet. Command-events bruges ikke som replay-kilde.

Replay slår target-controlleren op i Wingmans tidsversionerede device-route på handlingens kildetidspunkt. Homey-enheder får automatisk en `homey -> homey` route ved snapshot-sync. Manglende eller tvetydig route skipper handlingen; replay falder aldrig stiltiende tilbage til Homey.

## Konfiguration

Opret en lokal `.env`, som ikke committes:

```text
HOMEY_URL=http://192.168.100.45
HOMEY_TOKEN=...
HOME_ASSISTANT_URL=http://homeassistant.local:8123
HOME_ASSISTANT_TOKEN=...
WINGMAN_URL=http://homey-wingman-ingest-service:8788
INGEST_TOKEN=...
REPLAY_TOKEN=...
```

`REPLAY_TOKEN` skal vaere den samme i replay-service og dashboard.

## Drift

```sh
docker compose up -d --build
docker compose logs -f replay-service
```

Health endpointet er `GET /health`. Alle `/api/replay` endpoints kraever bearer-token.
