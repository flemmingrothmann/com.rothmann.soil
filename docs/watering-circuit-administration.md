# Vandingskredse

## Daglig brug

1. Åbn **Vanding → Administrér vandingskredse** i Wingman.
2. Se den HA-automation, ventil og de jordfugtalarmer, kredsen faktisk bruger.
3. Vælg **Opret vandingskreds**, **Redigér kreds** eller **Fjern kreds**.
4. Vælg navn, ventil og sensorer. Kontrollér ændringen og bekræft konsekvenserne.

Nye kredse starter med **Vanding forbudt**. Aktivér først vanding under Vanding,
når slanger, ventil og sensortilknytning er kontrolleret. Grænsen 0 deaktiverer
sensorens vandingsbehov. Andre sensorer i kredsen kan stadig bede om vand.

Oversigten dækker HA-kredse baseret på `wingman/labelled-pot-watering.yaml`.
Homey Advanced Flows administreres fortsat i Homey.

### Afmonteret kreds

Ved **Fjern kreds** kan du bekræfte **Kredsen er fysisk afmonteret og frakoblet
vand**. En offline ventil behøver da ikke tilsluttes igen. Kredsens
vandingsautomation skal allerede være slået fra i HA og må ikke køre. En ventil,
der fortsat melder åben, eller en anden aktiv/ukendt vandingskreds blokerer stadig.
Der foretages ingen ventilkald. Bekræftelsen gælder kun fjernelse, ikke redigering.

## Ejerskab og sikkerhed

- HA ejer labels, helpers og UI-redigerbare blueprint-instanser. Wingman er UI/proxy.
- Nye helpers oprettes via HA WebSocket CRUD, ikke YAML-packages.
- Nye automatikker, helpers og den fælles reservation får kategorien
  `Vandingskredse` i deres respektive HA-liste. Eksisterende kategorivalg bevares.
- Eksisterende helperreferencer kommer fra HA-automationen, ikke en gammel profil.
  De tidligere YAML-vandingshelpers er nu migreret/ryddet op; se
  [UI-vedligeholdelse](home-assistant-watering-ui.md).
- Navne og områder kommer fra HA, fysisk identitet fra IEEE. Sensorhelpers bruger
  det faste sensormærkat, ikke plantenavnet.
- En ventil/sensor må kun indgå i én kreds. Selvstændige automatiske alarm-ejere
  overtages ikke implicit. Tvetydige enheder afvises.
- Gem/fjern kræver en frisk forhåndsvisning og eksplicit bekræftelse. Aktive eller
  utilgængelige HA-vandingsforløb blokerer ændringer, da automation-reload kan
  afbryde andre kredse. Den fælles kapacitet skal være ledig.
  En udtrykkeligt fysisk afmonteret kreds med slukket, inaktiv automation kan
  fjernes offline; undtagelsen gælder kun den kreds, ikke øvrige kredse.
- Vanding spærres under ændringer. Eksisterende grænser, cyklusindstillinger,
  alarmstatus, historik og manuelle alarmers oprindelige aktivering bevares.
- Manuelle alarmer pauses ved tilknytning og gendannes ved frigivelse. Manglende
  manuel alarm klargøres efterfølgende af soil-provisionering; grænsen genbruges.
- Fjernelse bevarer helpers og label, men fjerner kredsens egne automatikker og
  tilknytninger. Andre labels og automatikker bevares.
- Delvist fejlede ændringer rulles tilbage. Ved ufuldstændig gendannelse forsøges
  vanding spærret, og API'et kræver manuel kontrol i HA.

Der gemmes kun én seneste recovery-snapshot i soil-volumenens
`watering-admin-recovery.json`, med private filrettigheder. Det er ikke en
revisionshistorik. Recovery indeholder konfiguration og skal behandles privat.

Gamle `apply/migrate/remove`-kald er spærret; brug den nye bekræftede arbejdsgang.
API-kontrakten findes i [OpenAPI](watering-circuits.openapi.yaml).

## Verifikation og deploy

```powershell
npm test
node --check soil-controller/server.js
node --check dashboard/public/app.js
```

Kør `home-assistant/tests/test_automatic_watering_admin.py` med Jinja2 og PyYAML.
Deploy hele soil-controllerens context samt begge berørte blueprints, og rebuild
dashboardet med hele `dashboard/`, inklusive `public/`. Brug kun `hubert`, bevar
private env-filer/volumener, og kør `node tools/verify-dashboard-assets.js`.

Kontrollér den autentificerede oversigt og en **forhåndsvisning**, inklusive
sensorvalg og mobilvisning. Start aldrig fysisk vanding for en UI-test.

## Verificeret 12. november 2026

- 135 Node-tests og 10 blueprint-tests bestod. HA's native helper-/label-CRUD
  blev desuden afprøvet med midlertidige testhelpers, som blev fjernet bagefter.
- Oversigt og sensorvalg/forhåndsvisning blev kontrolleret mod kørende services;
  mobilvisningen ved 390 px havde intet vandret overlap. Den offentlige side
  blev også kontrolleret efter genindlæsning af den tidligere åbne browserfane.
- Aktuel terrassekreds er fysisk afmonteret, og HA-/Wingman-koblinger afviger.
  Browserkontrol bekræftede, at fjernelse er spærret uden afmonteringsbekræftelse,
  men tilladt med bekræftelsen og den allerede slukkede HA-automation. Afkrydsningen
  blev nulstillet efter testen; ingen kreds blev fjernet eller fysisk vanding startet.
- Alle 22 kontrollerede produktionshelperværdier/cooldowns og hele
  `automations.yaml` var uændrede efter deploy/test. Begge services kørte uden
  genstarter/fejlloglinjer; build-context og runtime-checksummer matchede repoet.
- Nye JS-moduler/tests har ingen ESLint-fejl (linjelængdeadvarsler består).
  Fire eksisterende `no-mixed-operators`-fejl i dashboardets energiberegning er
  uden for denne ændring og ikke rettet.
- Kilde-/imagebackup: `/opt/soil/.backups/watering-admin-20261112T134331Z`.
  HA-backup: `/config/backups/watering-admin-20261112T134331Z`.
  Backup før afmonteringsrettelsen: `/opt/soil/.backups/watering-decommission-20261112T143331Z`.
