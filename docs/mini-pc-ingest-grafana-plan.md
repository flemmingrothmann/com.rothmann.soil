# Mini-PC Ingest og Grafana Plan

## Formaal
- Flyt historik, aggregering og prisberegninger vaek fra Homey.
- Behold Homey som datakilde og event-generator.
- Brug mini-PC/Docker som historik- og beregningsmotor.
- Brug dashboard appen til aktuel status og handlinger.
- Brug Grafana til stroemforbrug, priser og historisk analyse.
- Goer Grafana til det primaere langsigtede Insights-vaerktoej for mini-PC data.
- Behold eksisterende dashboard som hurtigt kiosk-dashboard til tablet/iPad.

## Langsigtede Maal
- Mini-PC skal kunne opbygge egne Insights uafhaengigt af Homey Insights.
- Grafana skal kunne vise historik og analyse paa tvaers af alle relevante Homey capabilities.
- Dashboard appen skal forblive rolig, hurtig og handlingsorienteret til kiosk-mode.
- Grafana kan linkes fra dashboardet for yderligere detaljer, men maa ikke vaere noedvendig for statusoverblik.
- Homey maa ikke bruges som database eller historikmotor i normal drift.
- Systemet skal kunne udvides fra jord/vanding/lys til stroem, pris, indeklima, bevaegelse og andre sensorer.
- Data skal kunne bruges til afledte maalinger, f.eks. DKK/h, aabningstid, trigger-frekvens og fugtfald pr. time.

## Arkitektur
- `ingest-service`: modtager Homey push-events og henter eksterne prisdata.
- `timescaledb/postgresql`: gemmer maalinger, events, aktuelle states og prisintervaller.
- `grafana`: viser stroem- og prisdashboards.
- `dashboard-api` eller eksisterende dashboard app: laeser kuraterede statusdata fra mini-PC.
- Homey app: sender smaa write-only events til mini-PC for alle relevante devices/capabilities.

## Mini-PC Host
- Mini-PC'en skal behandles som en lille generel server, ikke som en almindelig desktop.
- Energi, Homey-ingest og dashboard er foerste workloads, men serveren skal ogsaa kunne rumme andre services, hjemmesider og eksperimenter senere.
- Hostname skal vaere bredt nok til en generel lokal server og ikke kun jord/vanding, Homey eller energi.
- Hostname skal ogsaa fungere som et hjemmenavn: nemt at sige, ikke for teknisk, og noget resten af husstanden kan acceptere.
- Undgaa navne som `soilbox`, fordi de laaser tanken til den nuvaerende Homey-app i stedet for den bredere serverrolle.
- Undgaa navne der allerede betyder noget andet i hverdagen eller hos eksterne leverandoerer.
- Brug statisk DHCP lease i routeren frem for hardcoded IP paa maskinen, saa netvaerksstyring bliver samlet et sted.
- Installer SSH og administrer maskinen remote efter foerste opsaetning.
- Aktiver automatisk sikkerhedsopdatering, men undgaa automatiske feature-/platformsskift uden manuel kontrol.
- Gem compose-filer, konfiguration og scripts i git; gem runtime-data i Docker volumes eller dedikerede datafoldere.
- Portainer kan koeres som valgfrit administrationslag, fordi det giver nem container-/volume-/log-adgang og er kendt fra arbejdsmiljoeet.
- Portainer maa ikke vaere en hard dependency for drift; compose-filer og git skal stadig vaere sandheden for systemets konfiguration.
- Lav backup af database og Grafana-konfiguration foer systemet bliver brugt som historik-kilde.

## OS Beslutning
- Standardvalg: Linux server direkte paa maskinen, f.eks. Ubuntu Server LTS eller Debian stable.
- Begrundelse: Docker, PostgreSQL/TimescaleDB, Grafana og headless drift er enklere og mere stabile paa Linux end paa Windows med Docker Desktop/WSL.
- Windows 11 Pro boer ikke vaere standard-host for dette formaal, medmindre maskinen ogsaa skal bruges interaktivt som Windows-PC.
- Behold ikke Windows som dual boot medmindre der er et konkret Windows-behov; dual boot giver mere drift og mindre server-forudsigelighed.
- Foer Windows slettes: noter licens/produktinformation hvis muligt, og lav evt. en vendor recovery USB hvis maskinen tilbyder det.
- Hvis Home Assistant OS, flere VM'er eller snapshots bliver et tidligt krav, kan Proxmox VE vaere et alternativ til bare-metal Linux. Start da med en Docker-VM til dette system og reserver mulighed for en senere Home Assistant OS VM.

## Foerste Installation
- Den koebte 16 GB RAM mini-PC beholdes; 16 GB er nok til foerste fase med Linux, Docker, Portainer, dashboard, PostgreSQL/TimescaleDB, Grafana, ingest og mindre hjemmesider.
- Opgrader eller udskift kun senere, hvis reelt RAM-forbrug viser behovet.
- Saet hostname til `hubert`.
- Bootstrap kraever HDMI-skaerm, HDMI-kabel, stroem, USB-installationsstick, kablet USB-tastatur og helst Ethernet-kabel.
- Bluetooth-tastatur/-mus maa ikke forventes at virke i BIOS eller under OS-installation, medmindre de har egen USB-dongle der opfoerer sig som almindeligt USB-udstyr.
- Opret en normal admin-bruger og deaktiver password-login over SSH, naar noeglelogin virker.
- Installer Docker Engine og Docker Compose plugin.
- Installer evt. Portainer efter Docker, saa containerdrift kan administreres via web UI.
- Installer `git`, `curl`, `jq`, `ufw` og basis diagnostic-vaerktoejer.
- Aabn kun noedvendige porte paa lokalnettet, f.eks. SSH, dashboard, Grafana og senere ingest-endpoint.
- Opret en mappe til drift, f.eks. `/opt/homey-wingman`, med compose-projekter og `.env` filer.
- Brug hemmeligheder i lokale `.env` filer eller Docker secrets; commit aldrig tokens.
- Start med dashboardet og en tom database/Grafana stack, foer Homey begynder at pushe mange events.

## UI Rollefordeling
- Eksisterende dashboard app:
  - Tablet/iPad kiosk-mode.
  - Aktuel status og tydelige handlinger.
  - Jord, vanding, kontakt, motion, lys og evt. kort stroemstatus.
  - Skal vaere hurtig, rolig og uden tunge historikqueries.
  - Kan linke til Grafana panels for detaljer.
- Grafana:
  - Historik, zoom og analyse.
  - Seneste 7/12/24 timer, dage, uger og maaneder.
  - Stroempris, DKK/h, periodeomkostninger og sammenligning.
  - Egen Insights-flade for alle mini-PC data.
  - Ikke primaer kiosk/statusflade.
- Netdata:
  - Lokalt server-performance UI paa hubert.
  - Bruges til samlet CPU/RAM/disk/netvaerk og Docker/container-load.
  - Maa ikke router-forwardes eller eksponeres offentligt.
  - Lokal adgang: `http://192.168.100.66:19999`.

## Data Fra Homey
- Primaer strategi er Homey push-events, ikke polling.
- Homey app sender events, naar en relevant capability rapporterer eller aendrer state.
- Mini-PC gemmer aktuelle device states.
- Mini-PC gemmer numeriske maalinger som samples.
- Mini-PC gemmer boolske aendringer som events.
- Mini-PC gemmer availability/fejl.
- Langsom reconcile-polling bruges kun som fallback, f.eks. hvert 5-15 minut.
- Reconcile maa ikke overlappe, og skal backoffe ved langsomme Homey-svar.
- Ved Wingman/server-offline laves lightweight catchup via device snapshot ved opstart og periodisk sync.
- Catchup opdaterer `state_current` og skriver syntetiske `snapshot` events for capability-vaerdier, der har aendret sig siden seneste kendte state.
- Catchup er ikke fuld historisk replay af alle transitions under nedetid; det ville kraeve Homey Insights eller anden historikkilde og skal behandles som en separat, tungere reconcile-opgave.

Relevante domainer:
- Jordfugt og vandalarm.
- Vanding og vandmaaler.
- Kontakt, motion og lys.
- Stroemforbrug, effekt og energimaalere.
- Alle sensorer og Zigbee-enheder med relevante capabilities.

## Event Scope
- Maalet er at kunne bygge egne Insights paa mini-PC'en.
- Send events for alle relevante Homey devices, ikke kun eksisterende dashboardkort.
- Start med Zigbee-enheder og sensorer, men design schemaet generisk.
- Hver event skal indeholde device-id, capability, value, timestamp og metadata nok til senere analyse.

Minimum payload:
- `time`
- `homey_device_id`
- `homey_zone_id`
- `device_name`
- `driver_id`
- `device_class`
- `capability`
- `value`
- `unit`
- `available`

Eventtyper:
- Numeriske samples, f.eks. fugt, temperatur, W, kWh, vandmaaler.
- Boolean state changes, f.eks. onoff, kontakt, motion, alarm_water.
- Availability og fejlstatus.
- Device metadata snapshots ved opstart og periodisk reconcile.

Homey push skal vaere:
- Fire-and-forget.
- Kort timeout.
- Ikke-blokerende for device handling.
- Med lille payload.
- Med lokal persistent bounded queue og retry/backoff, hvis mini-PC er nede.
- Queue maa have faste maksimumgraenser, saa Homey ikke kan fyldes eller gaa ned under lang servernedetid.
- Aktuel Wingman-default er 600000 events og 300 MiB, cirka 3 dages buffer ved den maalte eventrate paa hubert.
- Uden krav om tung respons fra mini-PC.

## Prisdata
- Ingest elpriser separat fra Homey.
- Gem prisintervaller pr. time.
- Modellér samlet effektiv pris pr. kWh.

Prisfelter:
- Spotpris.
- Nettarif.
- Afgifter.
- Moms.
- Effektiv DKK/kWh.

## Beregninger
- Aktuel prisbelastning:
  - `DKK/h = W / 1000 * DKK/kWh`
- Periodepris:
  - `sum(kWh_delta_i * price_i)`
- Undgaa at beregne historisk pris som dags-kWh gange gennemsnitspris, naar timebucket-data findes.

## Datamodel
- `homey_device`, `homey_zone`, `homey_flow`, `homey_advanced_flow`, `homey_timer`: relationel inventory/current metadata.
- `state_current`: seneste kendte capability-state pr. device/capability.
- `ingest_event`: TimescaleDB hypertable for historiske Homey capability-events.
- Senere: `price_interval`, `derived_measurement` og eventuelle continuous aggregates til Grafana.

Timescale hypertables:
- `ingest_event` er aktiv hypertable i drift.
- Senere kan numeriske derived measurements flyttes til egne hypertables, hvis de ikke passer i det generiske eventskema.

## Storage Strategi
- Drift bruger PostgreSQL + TimescaleDB, fordi det passer godt til tidsserier, SQL views og Grafana.
- Modellen er hybrid: relationelle tabeller til metadata/current state og Timescale hypertables til historik.
- Docker-image for Wingman DB skal vaere TimescaleDB for PostgreSQL 16, og eksisterende volumener skal starte Postgres med `shared_preload_libraries=timescaledb`.
- Storage-valget skal revurderes loebende i planlaegningsfasen.
- Revurder ud fra:
  - antal events pr. dag
  - retention-behov
  - query-kompleksitet
  - Grafana-integration
  - backup/restore
  - drift paa mini-PC
  - relationer mellem devices, capabilities, priser og derived metrics
- Alternativer der skal holdes aabne:
  - PostgreSQL uden TimescaleDB
  - TimescaleDB
  - InfluxDB
  - VictoriaMetrics
  - SQLite kun til prototype eller meget lille setup
- Beslutningen maa ikke laases foer eventvolumen, querybehov og driftkrav er bedre kendt.
- Uanset storage skal datamodellen understotte:
  - raw events/samples
  - current state
  - metadata snapshots
  - price intervals
  - derived measurements
  - Grafana-venlige views eller tilsvarende queries

## Grafana Views
Lav SQL views eller materialized views, saa Grafana queries er simple.

Forslag:
- `v_power_current`
- `v_power_hourly`
- `v_power_daily`
- `v_energy_cost_hourly`
- `v_energy_cost_daily`
- `v_energy_cost_monthly`
- `v_tariff_current`
- `v_price_interval`

## Dashboard App Rolle
- Aktuel status.
- Kiosk/iPad-overblik.
- Handlinger, f.eks. sluk lys.
- Kuraterede kort for jord, vanding, kontakt, motion og lys.
- Evt. kort stroemstatus, men ikke dyb historisk analyse.

## Grafana Rolle
- Stroemgrafer.
- Historiske datoer og tidslinjer.
- Seneste 7/12/24 timer.
- Dag, uge og maaned.
- Sammenligning og analyse.
- Forskellig skalering og zoom.
- Langsigtet egen Insights-flade for Homey/mini-PC data.

Eksempler paa Grafana insights:
- Hvilke jordfugtsensorer falder hurtigst.
- Hvor laenge vinduer/doere staar aabne.
- Hvor ofte motion trigger pr. rum.
- Hvilke lys staar laengst taendt.
- Aktuel og historisk DKK/h.
- Dags-, uge- og maanedspris for stroem.
- Sammenhaeng mellem forbrug, pris og tidspunkt.

## Principper
- Undgaa tunge Homey Insights-kald i live-dashboardet.
- Brug event-first fra Homey appen.
- Brug kun langsom polling som reconcile/fallback.
- Poll aldrig Homey som var den en database.
- Ingen parallelle Homey API-kald som standard.
- Insights maa kun bruges til backfill/reconcile, ikke livevisning.
- Backfill skal vaere rate-limited, kunne pauses og helst koere uden for kritiske perioder.
- Gem alle relevante capabilities, saa mini-PC'en kan bygge egne Insights.
- Gem aendringer og periodiske samples, ikke unoedvendig stoey.
- Mini-PC skal kunne genstarte og selv indhente aktuel state igen.
- Homey skal behandles som en saarbar realtidscontroller, ikke som historikmotor.

## Foerste Milepael
- Docker compose med TimescaleDB og ingest-service.
- Mini-PC endpoint til Homey push-events med token-auth.
- Homey app sender events for jordfugt som foerste domain.
- Udvid event-sending til alle relevante Zigbee/sensor capabilities.
- Langsom reconcile-poll for device metadata og seneste states.
- Gem samples for stroem, jordfugt og oevrige sensorer.
- Ingest timebaserede elpriser.
- Beregn aktuel DKK/h.
- Lav foerste Grafana dashboard for stroem:
  - aktuel W
  - aktuel DKK/h
  - seneste 24 timer kWh
  - seneste 24 timer DKK
  - timepris
