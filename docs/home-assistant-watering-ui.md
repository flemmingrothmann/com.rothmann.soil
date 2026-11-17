# Vanding: vedligeholdelse i HA

## Hvor findes tingene?

- **Automatiseringer:** `Manuel jordfugt` til plantealarmer og `Vandingskredse`
  til automatik oprettet af kredsadministrationen.
- **Hjælpere:** samme kategorinavne i hjælperlisten. Alle aktive vandingshelpers
  er UI-administrerede og kan redigeres/slettes dér.
- **Scripts:** den fælles kapacitetsreservation ligger i `scripts.yaml`, kan
  redigeres/slettes i UI og har kategorien `Vandingskredse`.

HA har separate kategorier pr. liste: `automation`, `helpers` og `script`.
Det er ikke labels eller entitetens tekniske `entity_category`.

Kredsadministrationen tildeler kun kategori, hvis entiteten ikke allerede har
en kategori i den relevante liste. Dine efterfølgende kategoriændringer bevares.
Nye manuelle sensorhelpers bruger det faste sensormærkat i navnet.

## Fjerne noget selv

1. Fjern en kreds via Wingmans bekræftede kredsadministration, hvis den stadig er
   tilknyttet der. Afmonterede kredse kan fjernes offline med særskilt bekræftelse.
2. Slet en manuel alarm under Automatiseringer, hvis den ikke længere ønskes.
   Soil-adapteren genopretter ikke en kendt alarm, der bevidst er slettet.
3. Slet derefter kun de helpers, der ikke længere bruges af andre automatikker.

En slettet eller utilgængelig helper erstattes ikke med en ny standardværdi.
Reparér eventuelt en stadig aktiv alarms helperbinding i HA UI. Den fælles
kapacitetsstatus og reservation bruges af kommende kredse; de er ikke rester
fra den afmonterede terrassekreds.

## Migrering og oprydning, 12. november 2026

De seks gamle vandingspakker blev afmonteret fra den aktive HA-konfiguration:

- Fire nødvendige YAML-helpers blev flyttet til native UI-storage med uændrede
  entitets-ID'er, grænseværdi og push-tidspunkter.
- 23 ubrugte helpers og Garage-alarmen uden sensor i både HA og frisk Z2M-inventory
  blev fjernet. Tre gamle, gendannede registreringsrester blev ryddet op.
- Ét forældet kontrolkort blev fjernet fra Atelier-dashboardet via Lovelace API.
  Temperaturgrafer og den fysiske enhed blev bevaret.
- Kapacitetsscriptet blev flettet ind i live `scripts.yaml`; Julelys-scriptet og
  alle øvrige automatikker blev bevaret. Ingen ventil- eller mobilkald indgår i
  migrationen. Der blev ikke slettet historik.
- To pensionerede sensorprofiler fik fjernet bindingsreferencer til de slettede
  helpers. De fysiske sensor-ID'er og historikken blev bevaret.

De gamle repo-pakker er flyttet til `home-assistant/ui-helpers/legacy-watering/`
som reference/testdefaults. **Kopiér dem aldrig tilbage til `packages/`**, og brug
dem aldrig til at overskrive efterfølgende UI-valg.

Migreringsværktøj: `tools/migrate-watering-ui.py`. Det er read-only som standard.
`--apply --cleanup-unused` kræver eksplicit aftale; autentifikation og frisk
inventory gives via stdin, ikke kommandolinje eller repo. Aktive profilreferencer
kan beskyttes via `protected_helpers`. Værktøjet bevarer brugerændringer ved
konflikter og har kontrolleret rollback. Det må ikke bruges til generel oprydning.

Recovery:
- HA: `/config/backups/watering-native-ui-20261112T151240Z`.
- Før-snapshot: `/config/backups/watering-ui-preflight-20261112T151239Z`.
- Kilde/profiler: `/opt/soil/.backups/watering-native-ui-20261112T151239Z`.

Backupmapperne er private. Kopiér aldrig token-/credentialværdier ind i dem.

Verifikation: 142 Node-tests og 32 Python-tests bestod. Alle 10 tilbageværende
vandingshelpers var UI-redigerbare med uændrede værdier/cooldowns. De tre planters
grænser 25/30/35 % blev også kontrolleret gennem Wingmans dashboard-API. Øvrige
HA-automatikker og Julelys-scriptet var uændrede, og aktuelle dashboard-/kreds-API'er
svarede korrekt efter deploy på `hubert`.
