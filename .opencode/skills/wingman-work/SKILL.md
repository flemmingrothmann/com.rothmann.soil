---
name: Wingman kodearbejde
description: Brug ved afgrænsede kodeændringer, fejlrettelser og regressionstests i Wingman/HA. Fastholder controller-ejerskab, identitet, historik og brugerens UI-indstillinger.
---

# Wingman kodearbejde

Skillen beskriver en lokal arbejdsgang, ikke ekstra rettigheder.
`wingman-worker` implementerer; hovedagenten ejer krav og arkitektur.
Alle repo-stier nedenfor er relative til repo-roden, ikke skill-mappen.

## Før ændring

1. Læs relevante `AGENTS.md`, Git-status og opgavens eksisterende diff.
   Afklar præcise krav, tilladte filer og forventet test. Bevar andet arbejde.
2. Læs relevant domænekontrakt:
   - Observation, controller, write/replay: `docs/wingman-architecture.md`.
   - Zigbee/HA-inventar: `docs/zigbee-wingman-ingest.md`.
   - Vandingsadministration: `docs/watering-circuit-administration.md`.
   - Homey-vandingsflows: `docs/watering-flow-architecture.md`.
   - Elmåler: `docs/energy-meter-ha-migration.md`.
3. Find eksisterende implementation, API-kontrakt og regressionstests.
   Nye/ændrede HTTP-kontrakter kræver hovedagentens brugerautoriserede aftale.
   En nødvendig kontrakt-/arkitekturændring er BLOCKED, ikke fri refaktorering.

## Implementér den mindste rettelse

- Genbrug eksisterende mønstre. Ret backendfejl i ejet backend, ikke med en
  skjult frontend-workaround. Vis API'ets faktiske fejl sikkert escaped i UI.
- Brug IEEE/stabilt historik-ID som identitet; navne, områder og MQTT-topics
  kan ændres. Aktuelt `haEntityId` er write-target, ikke ny historikidentitet.
- Skeln mellem inventarekskludering og beskyttelse mod cleanup. Test både
  IEEE-historik med HA-alias og legacy `light.*`-historik ved lysafstemning.
- Observationer og kommandoer er forskellige. Ukendt/offline er ikke
  slukket/nul. Lav aldrig nye fysiske observationer ud fra metadata alene.
- Bevar brugerens UI-helpers, tærskler, cooldown, automationvalg, manuelle
  layouts og eksisterende live-konfiguration. Slettede artefakter må ikke
  genskabes automatisk.
- Køhåndtering skal persistere før levering og først kvittere efter aftalt
  succes. Test fejl, genstart, forsinkede beskeder og idempotent afstemning.

## Afslutning og overdragelse

1. Tilføj en reproducerende regressionstest med syntetiske data.
2. Kør relevante sikre lokale tests efter gennemlæsning af scripts; brug
   `wingman-test`/skillen `wingman-testing` til uafhængig kontrol.
3. Rapportér filer, adfærdsændring, faktiske testresultater og åbne risici.
   Skillen giver ingen tilladelse til live-kald, commit eller deployment.
4. Hovedagenten integrerer fund, bruger `verify` før commit og overdrager
   eventuelt det testede artefakt til `wingman-deploy`.
