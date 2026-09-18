# Repository Notes

## Homey Insights
- For local Homey API calls, Insights log entries are fetched with the full log id as the `:id` path segment, not only the capability id.
- Working shape: `GET /api/manager/insights/log/<ownerUri>/<fullLogId>/entry?resolution=<resolution>`.
- Example: `GET /api/manager/insights/log/homey:device:<deviceId>/homey:device:<deviceId>:meter_water/entry?resolution=last14Days`.
- The V2-style split `GET /api/manager/insights/log/homey:device:<deviceId>/meter_water/entry` returns `404` against the tested local Homey API.
- Boolean logs such as `onoff` return raw change entries; `resolution` does not trim the returned range, so callers must filter timestamps themselves for windows like the latest 14 days.
- Numeric logs such as `meter_water` are bucketed by resolution; for `last14Days` this yielded hourly points.

## Workflow
- After making and verifying code changes in this repo, deploy them unless the user explicitly says not to.
- Home Assistant automations must be simple, visually understandable and maintainable in the HA UI. Prefer one small automation per behavior; avoid overlapping controllers, hidden YAML complexity and speculative integrations. Verify the requested physical behavior end-to-end before calling an automation complete.
- Runtime/deploy-verifikation for dashboard, Wingman ingest og mini-PC services skal ske mod `hubert` (typisk `fro@192.168.100.66`) og ikke mod lokale Docker-containere på udviklingsmaskinen.
- Netværksudfald mod `hubert` er normalt midlertidige. Ved unattended eller længerevarende arbejde: vent kort og retry forbindelsen, før du betragter det som en blocker.

## Homey Wingman Platform
- Wingman architecture rules are in `docs/wingman-architecture.md`; read them before adding a controller, ingest emitter, replay target or cross-controller automation.
- Den lokale Homey/Wingman/TimescaleDB-platform kører på `hubert`.
- Plan for ekstern backupdisk, intern SSD-skift og ren Ubuntu restore ligger i `docs/hubert-ssd-backup-migration-plan.md`.
- Ekstern backupdisk paa `hubert` er `/dev/sdb1`, `ext4`, label `hubert-backup`, UUID `3040eef3-05f2-467a-bee1-750155dbca44`, mounted paa `/mnt/hubert-backup`.
- Daglig backup paa `hubert` koeres af `hubert-backup.timer`; scripts ligger i `/usr/local/sbin/hubert-backup.sh` og `/usr/local/sbin/hubert-restore-test.sh` med kildekopier i `tools/`.
- `hubert` bruger Ethernet `enp2s0` som primaer driftforbindelse (`192.168.100.66`, DHCP route metric `100`) og WiFi `wlp1s0` som fallback (`192.168.100.67`, DHCP route metric `600`); `hubert-wifi-watchdog.timer` holder WiFi-fallbacken i live ved gateway-udfald.
- Postgres/Timescale backup skal restores fra `pg_dump -Fc` dumpet, ikke fra live data-volume arkiv. Brug Timescale `timescaledb_pre_restore()` og `timescaledb_post_restore()` ved restore.
- Seneste dokumenterede restore-test ligger i `docs/hubert-ssd-backup-migration-plan.md`; gentag restore-test med `sudo /usr/local/sbin/hubert-restore-test.sh <dump>` foer risikable disk-/OS-aendringer.
- Homey-appen `com.rothmann.homeywingman` lytter på realtime capability updates via `homey-api` og sender events til ingest-service på `http://192.168.100.66:8788/api/ingest/homey`; controller-neutrale emitters bruger `/api/ingest`.
- Wingman sender metadata snapshots til `http://192.168.100.66:8788/api/sync/homey`.
- Ingest-service kører i Docker-containeren `homey-wingman-ingest-service`.
- Home Assistant koerer som Docker-containeren `home-assistant` paa `hubert` med persistent volume `home-assistant_home-assistant-config`. Sonoff Dongle-P maa kun ejes af Zigbee2MQTT, aldrig samtidig af Home Assistant/ZHA.
- Replay af historiske Homey-enhedshandlinger koerer i den selvstaendige Docker-container `homey-replay-service`; Wingman ejer historik, replay-service ejer profiler/scheduler/runs, og dashboardet er kun UI/proxy.
- TimescaleDB kører i Docker-containeren `homey-wingman-postgres` med image `timescale/timescaledb:latest-pg16` og database `homey_wingman`.
- Gem ikke database-passwords eller andre hemmeligheder i repo-dokumentation; hent dem fra sikker secret-kilde eller brugerens eksplicitte besked ved behov.
- Vigtige drift-endpoints: dashboard `https://home.knalloo.dk`, Netdata `http://192.168.100.66:19999`, ingest health `http://192.168.100.66:8788/health`, current state API `http://192.168.100.66:8788/api/current-state`, Homey snapshot API `http://192.168.100.66:8788/api/homey/snapshot`.
- Peugeot-data hentes paa `hubert` af `peugeot-car-controller` (`flobz/psa_car_controller:v3.7.5`) i `/opt/soil/peugeot-service`; port 5000 maa kun bindes til `127.0.0.1`, og dashboardet tilgaar servicen internt paa Docker-netvaerket.
- MyPeugeot-login, tokens og bilens VIN ligger kun i Peugeot-volume/dashboardets `.env`, aldrig i repo eller logs. Brug `tools/configure-peugeot-dashboard.sh` til at overfoere VIN internt uden at printe den.
- MyPeugeot-telemetri kan vaere gammel selv efter et succesfuldt live-read. Dashboardet skal altid vise bilens datatidsstempel og markere data som stale efter 6 timer i stedet for at fremstille dem som live.
- TimescaleDB extension er aktiv, og `ingest_event` er hypertable.
- Historiske events ligger i `ingest_event`, current state i `state_current`, og metadata i `homey_device`, `homey_zone`, `homey_flow`, `homey_advanced_flow` og `homey_timer`.
- `docs/wingman-architecture.md` er source of truth for Wingman-provenance, controller-ejerskab og replay. `ingest_event` registrerer provenance via `source_system`, `source_instance`, `source_event_id`, `author_system`, `event_type`, `causation_id`, `correlation_id` og `replay_run_id`. Observationer opdaterer `state_current`; command-events er audit-log og maa ikke bruges som replay-kilde.
- Homey Wingman har persistent queue i app storage til perioder hvor ingest ikke svarer; den skal beskytte Homey mod nedetid på `hubert` og undgå tab af events så længe Wingman-appen stadig kører.
- Queue defaults: ca. `600000` events, `300 MiB`, retry/backoff starter ved `15 sek.` og maxer ved `5 min.`.
- Controller-neutrale Z2M/HA ingest-adaptere skal bruge samme write-ahead-princip: persistér observationen lokalt før Wingman-kaldet og slet først efter `202`; cached controller-state kan kun genskabe seneste state, ikke mellemliggende historik.

## Dashboard Data Flow
- Dashboardet skal som hovedregel læse fra Wingman DB/API, ikke direkte fra Homey.
- Direkte Homey-kald bør kun bruges til write actions, f.eks. tænde/slukke lys og ændre `Vanding forbudt`.
- Current-state refresh kan være hurtig, ca. `3 sek.`, fordi data kommer fra lokal Wingman/Postgres.
- Watering refresh ligger typisk omkring `10 sek.`.
- Dashboard branding er `Bogfinkevej`.
- Under controller-migrering skal dashboardet fortsat vise Homey-sensorer som offline/fejl, mens den aktive HA/Zigbee2MQTT-enhed vises under sit HA-område. Skjul eller sammensmelt ikke controllerens reelle helbredstilstand.

## Watering Flows
- Setup contract, lifecycle statuses, per-valve duration variables and layout rules for Homey watering Advanced Flows are documented in `docs/watering-flow-architecture.md`.
- Read that document before creating or changing a watering valve, its Advanced Flow or dashboard lifecycle handling.

## Energy Data Principles
- Strøm- og energidata må ikke blindt slettes, fordi de senere skal bruges til beregning af forbrug og slutbrugerpriser.
- Udvalgte energidata skal bevares råt eller kondenseres korrekt; noisy ikke-energidata må gerne downsample/strippes hårdere.
- Retention og aggregation for energi skal analyseres før implementering.
- Prisdata bør sandsynligvis ingesteres separat fra Homey i en tabel som `price_interval` med start/end, spotpris, tariffer, afgifter, moms, effektiv slutbrugerpris DKK/kWh og prisområde.
- N1 nettarif C kan hentes fra Energidataservice `DatahubPricelist` med `GLN_Number=5790001089030`, `ChargeType=D03`, `ChargeTypeCode=CD`, `ResolutionDuration=PT1H`; brug `Price1..Price24` efter dansk lokal time.
- Elafgift kan hentes fra Energidataservice `DatahubPricelist` med `GLN_Number=5790000432752`, `ChargeType=D03`, `ChargeTypeCode=EA-001`, `TaxIndicator=1`; `ResolutionDuration=P1D` bruger `Price1` for hele dagen.
- Energinet-led til slutbrugerpris hentes fra `DatahubPricelist` med `GLN_Number=5790000432752`, `ChargeType=D03`: transmissionsnettarif `ChargeTypeCode=40000`, systemtarif `41000` og DK1-nettabstarif `40021`; brug API-værdierne for tidspunktet frem for faste observerede time-tal.
- Energidataservice har skrap rate-/genlæsningspolitik; prisimport skal kun hente manglende/ufuldstændige døgn og må ikke genlæse samme prisvindue aggressivt.
- Beregninger af elpris og forbrug bør bruge timebucket data, ikke dagsgennemsnit.
- El-aftalen bruger timebaseret pris, så beregninger skal bruge timepris/spot-timepris pr. interval og ikke fastpris eller periodegennemsnit.
- Forbrug bør helst baseres på `meter_power` delta over tid; `measure_power` er bedst til øjebliksbillede og eventuel interpolering.
- Negativt strømforbrug betyder eksport/tilbageløb og skal i omkostningsberegninger behandles som `0` pris, ikke negativ pris; indtægtsberegning er ikke nødvendig, da den er negligerbar.
- Homey/Wingman eventstream er change-based og ikke nødvendigvis regelmæssig sampling, så energiberegninger skal vælge metode bevidst: meter-delta hvor muligt, ellers power-integration med tydelige antagelser.
- Slutbrugerpris kræver korrekt tarifmodel, moms og afgifter; der er variabel el-transportafgift afhængig af tidspunkt på døgn og årstid.
- Hvis afgifter ikke kan findes via API, skal vi understøtte manuel indtastning frem for at gætte.
- Timescale continuous aggregates kan være relevante til visninger for effekt nu, kWh pr. time, pris pr. time, DKK/time og DKK pr. døgn/måned.

## Energy Capability Analysis
- Relevante capability-typer til elpris/forbrug: `measure_power`, `measure_power.phase1`, `measure_power.phase2`, `measure_power.phase3`, `meter_power`, `meter_power.imported`, `meter_power.exported`, `meter_power.imported_today`, `meter_power.exported_today`, `measure_current.*`, `measure_voltage.*` og `measure_phase_load.*`.
- Smart plugs bruger typisk `measure_power` og `meter_power`.
- Kendte energienheder fra data/logs inkluderer `Homey Energy Dongle`, `Kontor PC`, `Video ++ Outdoor Plug (B)`, `Køkken Kaffemaskine A1Z`, `Køl&Frys Værksted` og `Kontor Audio Udstyr`; find flere i `homey_device` og `state_current`.
- Start støj-/energi-analyse med capability-counts i `ingest_event`, top devices pr. capability og aktuelle energistates i `state_current`.

## Dashboard Performance
- Browser-dashboardet skal starte konservativt med ca. 30 sekunders refresh, undgå netværks-refresh mens siden er skjult og først hente igen, når browseren bliver synlig.
- Når dashboardets reads kommer fra lokal Wingman/Postgres og ikke direkte fra Homey, må current-state views refreshe hurtigt, typisk ca. 2-5 sekunder, mens historiktunge views stadig bør være mere konservative.
- Ved Homey-performanceproblemer skal vi først skære ned i antal viste/hentede informationer og måle igen, før vi indfører bred cache.
- Langsigtet dashboard-arkitektur: Homey skal være data-generator, mens mini-PC/Docker skal ingestere, aggregere og servere dashboarddata. Undgå at lægge tunge historik-/analysejobs i Homey appen.
- Brug ikke `soil` som navn for den generelle mini-PC/Homey-platform. `soil` er kun jord-/plante-domænet; generel ingest/platform bør bruge et mere abstrakt navn som `homey-wingman`.

## Visualizations
- Overlap tolereres ikke i visuelle kort/diagrammer: labels, zonebokse, noder og forbindelser skal layoutes, filtreres eller skjules, saa resultatet er laesbart frem for bare teknisk korrekt.
- Zigbee routekortets manuelle layout maa aldrig nulstilles automatisk ved zone-, device-, navne- eller route-aendringer. Bevar kendte nodepositioner og placer kun nye/manglende noder lokalt, saa timer af manuelt layoutarbejde ikke gaar tabt.
- Zigbee routekortets routehistorik skal vises som rullende `7` dage. Linjetykkelse er baseret paa observationer i dette vindue, og linjer uden kommunikation i mere end `48 timer` markeres som ubrugt.
- Zigbee routekortet maa ikke lade route-only placeholders leve videre som `Ukendt` efter genparring/udskiftning. Hvis historikken kender nodens tidligere enhed, vis den som `fjernet`; hvis der kun findes ukendt placeholder-data, skjul noden/linjen, saa den udgaar med det rullende historikvindue.
- Zigbee routekortets zonebokse skal indeholde baade routere og end devices i deres respektive zoner. Root-zonen `Hjem`, `Controller` og `Ukendt zone` skal ikke vises som zonebokse.
