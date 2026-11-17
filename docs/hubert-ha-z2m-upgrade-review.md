# Hubert: HA og Zigbee2MQTT – opdateringsvurdering

Godkendt og gennemført på `hubert` 13. november 2026. Ingen OS-, Mosquitto-, Matter Server- eller dongle-firmwareopgradering.

| Komponent | Før | Kører nu, eksplicit pinnet |
| --- | --- | --- |
| Home Assistant Container | 2026.9.1 | 2026.11.1 |
| Zigbee2MQTT | 2.14.1 | 2.14.3 |

Hubert kører x86_64; Z2M's varslede udfasning af 32-bit er ikke relevant her.

## Zigbee2MQTT: tilpassede converters

- Kandidaten bruger `zigbee-herdsman-converters` **26.125.0**.
- `CS-201Z` / `ZG-303Z`-definitionen er flyttet fra `devices/tuya` til `devices/hobeian`. `hobeian-zg-303z-battery.mjs` er rettet til den nye placering og bevarer sensorens datapoints, bortset fra at standardbatteriet erstatter Tuya-batteriværdien.
- Arteco-udvidelsen arver nu den indbyggede `ZS-300Z`-definition i stedet for at kopiere gamle datapoints. Dermed bevares upstream-rettelser til signed kalibrering, skaleret lyskalibrering og adskillelsen mellem jordfugt-advarsel og dens grænse.
- Begge matcher kun de inspicerede model-/producent-fingerprints og bruger version `1.0.0`, så den nye batteriopsætning forsøges ved næste fysiske besked fra en tidligere konfigureret sensor.
- Upstream erstatter fire Arteco-`number.*_soil_warning`-entiteter med separate `soil_moisture_warning`-statusser og `soil_moisture_warning_threshold`-indstillinger. Ingen referencer til de gamle tal-entiteter blev fundet i aktive automatikker/scripts eller dashboard-config. HA's softwaregrænser er bevaret; måle-/batteri-/kalibrerings-entiteters identiteter er uændrede.
- Bevar IEEE-identiteter, entity-ID'er, parringer, netværksnøgler og manuelt route-layout. Kontrollér sensorprofiler/alarmgrænser mod de ændrede exposes; HA ejer stadig alarmmotoren.
- Ny software er ikke i sig selv dokumentation for, at Z-3's batterirapportering fysisk er konfigureret.

## Home Assistant: væsentlige kontrolpunkter

- **2026.11 ændrer navnesammensætning**. Egne navne migreres; entity-ID'er bevares. Kontrollér plantenavne, områder, beskeder og dashboards. `friendly_name` er varslet udfaset, ikke fjernet her.
- **HACS bliver Marketplace** og migreres. Installerede custom components er `hacs` 2.0.5, `adaptive_lighting` 1.31.0 og `homey_p1` 0.6.1. De sidste to skal kompatibilitetskontrolleres særskilt; især P1 er hovedmålerens autoritative energikilde.
- Oktober strammer valideringen af state conditions med `for` kombineret med attributter/lister/andre entiteter. Kontrollér aktive automatikker/scripts og blueprints før opgradering.
- Oktober kræver admin til brugerinitieret `mqtt.publish`/`mqtt.dump`; selvkørende automatikker er ikke berørt. November ændrer fortolkningen af visse sol-/kalender-offsets uden eksplicit `offset_type`. Kontrollér julelys og kalenderregler.
- Aktiv HTTP-konfiguration er læst via WebSocket: `use_x_forwarded_for=true`, `trusted_proxies=[172.18.0.3/32]`, ingen pending ændringer. Bevar og verificér både LAN- og proxylogin efter opgradering.
- Baseline: HA `RUNNING`; MQTT, Matter, Google, Hue og de tre custom components er indlæst. Bluetooth, Brother og IPP stod allerede i `setup_retry`; ZHA er ikke indlæst og skal fortsat ikke eje Dongle-P.

## Gennemført og verificeret

- **Backup:** `/mnt/hubert-backup/hubert/manual/ha-z2m-upgrade-20261113T220615Z`. HA-config inkl. `.storage`/database og Z2M-data inkl. parringer/converters er arkiveret, mens den respektive service var stoppet. Begge arkivers SHA-256 er kontrolleret; HA's recorder-database er desuden udlæst til en isoleret midlertidig mappe og bestod SQLite `quick_check`. Tidligere compose-filer, image-ID'er og soil-profiler er gemt samme beskyttede sted.
- Opgraderet én komponent ad gangen; kun image-reference og de to converters er ændret i de aktive service-konfigurationer. Private indstillinger og named volumes er bevaret.
- **Tests:** 149 Node-tests, 58 HA-tests i et isoleret HA 2026.11.1-image og otte converter-tests i både kandidat- og runtime-imaget består. Converter-testene kontrollerer også `prepareDefinition`, præcis matchning, standardbatteriskalering og upstreams signed kalibrering/advarselssplit.
- Kopi af aktiv HA-config bestod kandidatens config-check uden netværk/radio før opgraderingen; aktiv config bestod igen efter opgraderingen. 11 YAML-/blueprint-filer blev også kontrolleret for de relevante nye state-/offset-regler uden fund.
- **Identitet:** Alle 27 Zigbee-databaseidentiteter bevaret. Efter Z2M's forventede expose-migrering havde HA 282 MQTT-entiteter; alle disse entity-ID'er/unique-ID'er samt navne/områder er bevaret gennem HA-opgraderingen. Alle 36 automatikkers til/fra-status er uændret.
- **Data:** Friske P1-observationer er verificeret med HA-provenance i Wingman og beregnede kWh/DKK i dashboardets oversigt og energiside. Hovedmålerens cutoff og historik er ikke ændret/genopbygget.
- **HA:** `RUNNING`; MQTT, Matter, Google, Hue, Adaptive Lighting 1.31.0 og Homey P1 0.6.1 indlæst. HACS 2.0.5 er automatisk migreret til Marketplace. De øvrige custom integrations er ikke opdateret som sideopgave.
- **Betjening:** Lokal WebSocket, autentificeret HTTPS REST/WebSocket og loginfrontenden virker. Trusted proxy er bevaret, ingen pending HTTP-config; direkte LAN-request med ubetroet forwarded-header afvises med 400.
- **Matter/kalender:** De otte aktive Matter-entiteter er tilgængelige. Google-hovedkalenderens event-opslag virker. Julelys/fridags-helpers og kalenderdato er genindlæst; startup-opdateringen af kalenderhelpers har kørt.
- **Vanding/kalibrering:** Kreds-API og jordfugtdashboard fungerer; eksisterende softwaregrænser og alle fem kalibreringsværdier er bevaret. Eksisterende offline sensorer vises fortsat offline. Ingen ventiler er aktiveret eller åbnet under verifikationen.
- **Layout/køer:** Zigbee-manual-layout er uændret, SHA-256 `266c4cda659ea661ffb8499d4691c1706f51b2c30f2976225b057c70a3663ec5` for selve layoutobjektet. Soil- og generel ingest-kø samt Zigbee pending-kø er tømt. HA/Z2M/Matter/Mosquitto har nul automatiske container-restarts efter opgraderingen.
- **Kendte eksisterende forhold:** Bluetooth-integrationen og printerintegrationerne var allerede fejlende/afventende før opgraderingen. Bluetooth-loggen viser en scannerfejl ved en inaktiv host-Bluetooth-service; disse integrationer er ikke aktiveret/deaktiveret eller repareret som sideopgave. Den tidligere Z-2-cooldown-helperadvarsel er heller ikke nulstillet. En dansk oversættelsesadvarsel fra Adaptive Lighting 1.31.0 ændrer ikke den indlæste integrationsstatus.

Z-3 blev observeret i yderligere ti minutter efter opgraderingen uden bekræftet fysisk batterirapportering. Batteriopsætningen er versionsmærket og kan forsøges ved næste fysiske besked; dette punkt er fortsat afventende. En værdi genudsendt fra Z2M-cache efter HA-genstart er **ikke** en ny fysisk batteriaflæsning.

## Ved en senere opgradering

1. Gennemfør ovenstående kompatibilitetskontroller; tilpas/test converters mod 2.14.3 uden adgang til Zigbee-radioen.
2. Tag beskyttet backup af HA-config inkl. `.storage`/database, Z2M-data inkl. converters/parringsdatabase og route-layout. Bevar gamle image-ID'er og named volumes. Den daglige `hubert-backup.timer` er aktiv; kontrollér frisk backup før ændringen.
3. Opgradér én komponent ad gangen til eksplicit versionsnummer, ikke et ubestemt nyt `stable`/`latest`. Ingen dongle-firmware-, OS- eller Mosquitto-opgradering i samme ændring.
4. Verificér HA-login, MQTT-discovery, aktuelle fysiske observationer og kalibrering/batteri, P1-energi, Matter, julelys/fridage, vandingsalarmer og uændret route-layout. Ingen teståbning af ventiler.
5. Rollback skal omfatte tidligere config/data ved inkompatible migrationer, ikke blot gammelt image. Brug aldrig `down -v`.

## Kalibreringsstandard deployet separat

`soil-controller` sætter nu `soil_calibration=0` én gang ved ny understøttet manuel sensortilmelding gennem HA. Alle 149 repo-tests bestod; seks målrettede tests bestod også mod modulet i den deployede container. Modul-checksum matchede, kreds-API svarede 200, og alle fem eksisterende kalibreringsværdier var uændrede. Ingen eksisterende profiler fik initialiseringsmarkør. En ny fysisk tilmelding er endnu ikke afprøvet.

Backup før adapterændringen: `/opt/soil/.backups/soil-calibration-20261113T152330Z` (tidligere kildefil, README, profiler og image-ID). Den eksisterende advarsel om manglende cooldown-helper for Z-2 var til stede før deploy og er ikke ændret/genoprettet.

## Kilder

- [HA stable-versioner](https://version.home-assistant.io/stable.json)
- [HA oktober](https://www.home-assistant.io/blog/2026/10/07/release-202610/)
- [HA november](https://www.home-assistant.io/blog/2026/11/04/release-202611/)
- [Z2M 2.14.3](https://github.com/Koenkk/zigbee2mqtt/releases/tag/2.14.3)
- [Kandidatens afhængigheder](https://github.com/Koenkk/zigbee2mqtt/blob/2.14.3/package.json)
- [HOBEIAN-kandidatdefinitioner](https://github.com/Koenkk/zigbee-herdsman-converters/blob/v26.125.0/src/devices/hobeian.ts)
- [Tuya/Arteco-kandidatdefinitioner](https://github.com/Koenkk/zigbee-herdsman-converters/blob/v26.125.0/src/devices/tuya.ts)
