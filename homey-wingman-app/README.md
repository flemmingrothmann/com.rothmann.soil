# Homey Wingman

Generel lokal Homey event bridge til mini-PC ingest.

## Runtime

- Lytter paa realtime capability updates for Homey devices via `homey-api` app session.
- Sender kun aendrede capability-vaerdier til ingest-endpointet.
- Bruger kort timeout og persistent, bounded koe, saa Homey ikke blokeres af mini-PC/netvaerk.
- Hvis ingest ikke svarer, bliver events i Homey app storage og flushes med backoff, naar endpointet er tilbage.
- Default koegrænser er 600000 events og 300 MiB, cirka 3 dages buffer ved den maalte eventrate; de aeldste events droppes foerst, hvis graensen rammes.
- Koeen kan justeres med `MAX_QUEUE_EVENTS` og `MAX_QUEUE_BYTES` i `env.json` eller app settings.

## Lokal Env

Opret `env.json` lokalt, ikke commit:

```json
{
  "INGEST_URL": "http://192.168.100.66:8788/api/ingest/homey",
  "INGEST_TOKEN": "..."
}
```
