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
- Runtime/deploy-verifikation for dashboard, Wingman ingest og mini-PC services skal ske mod `hubert` (typisk `fro@192.168.100.66`) og ikke mod lokale Docker-containere på udviklingsmaskinen.

## Homey Wingman Platform
- Den lokale Homey/Wingman/TimescaleDB-platform kører på `hubert`.
- Homey-appen `com.rothmann.homeywingman` lytter på realtime capability updates via `homey-api` og sender events til ingest-service på `http://192.168.100.66:8788/api/ingest/homey`.
- Wingman sender metadata snapshots til `http://192.168.100.66:8788/api/sync/homey`.
- Ingest-service kører i Docker-containeren `homey-wingman-ingest-service`.
- TimescaleDB kører i Docker-containeren `homey-wingman-postgres` med image `timescale/timescaledb:latest-pg16` og database `homey_wingman`.
- Gem ikke database-passwords eller andre hemmeligheder i repo-dokumentation; hent dem fra sikker secret-kilde eller brugerens eksplicitte besked ved behov.
- Vigtige drift-endpoints: dashboard `https://home.knalloo.dk`, Netdata `http://192.168.100.66:19999`, ingest health `http://192.168.100.66:8788/health`, current state API `http://192.168.100.66:8788/api/current-state`, Homey snapshot API `http://192.168.100.66:8788/api/homey/snapshot`.
- TimescaleDB extension er aktiv, og `ingest_event` er hypertable.
- Historiske events ligger i `ingest_event`, current state i `state_current`, og metadata i `homey_device`, `homey_zone`, `homey_flow`, `homey_advanced_flow` og `homey_timer`.
- Homey Wingman har persistent queue i app storage til perioder hvor ingest ikke svarer; den skal beskytte Homey mod nedetid på `hubert` og undgå tab af events så længe Wingman-appen stadig kører.
- Queue defaults: ca. `600000` events, `300 MiB`, retry/backoff starter ved `15 sek.` og maxer ved `5 min.`.

## Dashboard Data Flow
- Dashboardet skal som hovedregel læse fra Wingman DB/API, ikke direkte fra Homey.
- Direkte Homey-kald bør kun bruges til write actions, f.eks. tænde/slukke lys og ændre `Vanding forbudt`.
- Current-state refresh kan være hurtig, ca. `3 sek.`, fordi data kommer fra lokal Wingman/Postgres.
- Watering refresh ligger typisk omkring `10 sek.`.
- Dashboard branding er `Bogfinkevej`.

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
