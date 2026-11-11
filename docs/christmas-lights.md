# Julelys i Home Assistant

Hele julelys-/fridagsopsætningen vedligeholdes i **HA's UI**. Åbn **Julelys →
Hjælp** for ændringsvejledning og fejlfinding med genveje til Hjælpere,
Automatikker og Scripts. Der kræves ingen filredigering til normal vedligeholdelse.

## Betjening

- **Juletid** er master. Fra slukker alt julelys og spærrer manuel tænd.
- **Julelys manuel tænd sluk** viser lysets faktiske status og styrer inde/ude.
  Manuel tænd virker også efter godnat og tidsgrænsen. Næste automatiske sluk
  slukker lyset, og kontakten følger automatisk med til fra.
- Manuel sluk pauser automatisk tænd indtil næste morgen-/aftenperiode.
- **Luxgrænse:** Indstillinger → Enheder og tjenester → Hjælpere →
  **Julelys dagslys** → skabelonindstillinger. Betingelsen kan redigeres dér.
- **Ventetid:** Helperen **Julelys dagslys ventetid**, også vist på dashboardet.
  Standard er 30 minutter. Sluk- og morgenreglen bruger samme indstilling.
- **Mørke:** Helperen **Julelys mørkt** indeholder luxbetingelsen.
  **Julelys mørke ventetid** styrer de 2 minutter og vises på dashboardet.
  Aften-triggeren og betingelsen ved master-tænd bruger samme ventetid.
- Tildel **Julelys Ude** eller **Julelys Inde** på enheden eller lys-entiteten.
  Området har ingen betydning. Fjern gamle subtype-labels, når enheden flyttes.
- Stikkontakter skal have en **Skift enhedstype → Lys**-helper. Handlingerne
  bruger `light.turn_on/off`, så enhedens indstillingskontakter ikke påvirkes.
- **Julelys** er fælleslabel. Godnat/master/tidsgrænse slukker alle tre labels.
  Indendørs har endnu ingen automatisk tænding.

## Udendørs regler

- Begge sensorer under **400 lux i 2 minutter**: tænd efter middag, før
  tidsgrænsen og kun hvis godnat/manuel sluk ikke har pauset automatikken.
  Mørke-helperen viser selve luxbetingelsen straks; ventetiden ligger i
  **Julelys ude tænd ved mørke**, ikke i en skjult YAML-sensor.
- Arbejdsdag: tænd **kl. 07.00**. Fridag: tænd **ved solopgang**.
- Begge sensorer over **550 lux i 30 sammenhængende minutter**: sluk udendørs.
  **Julelys dagslys** tænder straks ved opfyldt luxbetingelse; selve ventetiden
  ligger i triggerens **For** under **Julelys ude sluk efter dagslys**.
- Seneste sluk: **23.00 før arbejdsdage**, **01.00 på fridage**.
- `light.natlys_zone` fra tændt til slukket mellem 21 og 06: fælles godnat.
- Defekte/manglende luxværdier tæller hverken som mørke eller dagslys.
- Tidsgrænse/master/godnat virker uafhængigt af luxsensorernes tilgængelighed.

Sensorer:

- `sensor.terrasse_sensor_ved_terassedor_belysningsstyrke`
- `sensor.indkorsel_sensor_i_gardsplads_belysningsstyrke`

## Fridage og Google Kalender

Danske weekender/helligdage kommer fra Workday med land DK og offset 0/1.
De fravælger lørdag, søndag og officielle helligdage; valgfrie mærkedage
er ikke automatisk fridage.

Personlige fridage læses fra Google-hovedkalenderen `calendar.hovedkaldender`
(HA-navnet er stavet sådan). `ferie` skal blot indgå **et vilkårligt sted** i
titlen, uanset store/små bogstaver, fx `Sommerferie` eller `Flemming har FERIE`.

- Alle overlappende events læses via `calendar.get_events`, ikke kun kalenderens
  enkeltstående state/message. Der oprettes eller ændres ingen Google-events.
- En dag med et ferie-event tæller som fridag, også ved et tidsafgrænset event.
  Flerdagesferie tæller alle omfattede dage; slutdato ved midnat er eksklusiv.
- Ferie i dag og i morgen opdateres ved HA-start, hvert kvarter og eventstart/-slut.
  Dermed får aftenen før ferie sen slukketid, og feriemorgener bruger solopgang.
- De fælles helpers `input_boolean.ferie_i_dag`, `input_boolean.ferie_i_morgen`
  og `input_datetime.ferie_kalenderdato` kan genbruges af andre automatikker.
- Ved kalenderfejl beholdes seneste vellykkede resultat. Resultater fra tidligere
  datoer ignoreres af julelyset; weekend/danske helligdage virker stadig.
  Datoen i dashboardet gør forældede kalenderdata synlige.

## Filer og deploy

- Alle helpers er UI-administrerede: master/pause, manuel kontakt, mørke/dagslys,
  ventetider, ferie i dag/i morgen, kalenderdato og fridagsberegning.
- Der findes ingen aktive julelys-/fridags-packages. Genopret ikke de pensionerede
  `christmas_lights.yaml`/`personal_holidays.yaml` ved et fremtidigt deploy.
- `home-assistant/ui-helpers/christmas-{controls,daylight,darkness}.json` er kun
  oprettelsesdefaults/testdata. **HA's gemte UI-indstillinger er autoritative**;
  defaults må aldrig overskrive efterfølgende brugerændringer.
- Dagslys-helperens historiske ID er stadig
  `binary_sensor.julelys_lyst_i_30_minutter`, men navnet er **Julelys dagslys**.
  Den indeholder ikke længere en skjult `delay_on` i YAML.
- UI-redigerbart sluk-script: `home-assistant/scripts.yaml`, indlæst via
  `script: !include scripts.yaml`. Merge kun `julelys_sluk` ind i live-filen;
  bevar andre scripts. Scripts i packages kan ikke redigeres fra HA's UI.
- Små UI-redigerbare automatikker: `home-assistant/christmas-automations.yaml`.
  Merge kun disse `julelys_*`-ID'er ind i den **aktuelle** `/config/automations.yaml`.
  Overskriv ikke live-filen med repoets ældre automatikliste.
- UI-redigerbar kalenderautomation: `home-assistant/calendar-automations.yaml`;
  merge kun `ferie_fra_hovedkalender` ind i live `automations.yaml`.
- Backup, kopi, config-check og reload/restart sker på `hubert`.
  Verificér filhash inde i containeren og den indlæste config via automation-traces.
- Mørke- og dagslys-triggernes `for` begynder forfra ved
  relevant reload/HA-genstart. Ventetiden evalueres ved overgang til dagslys;
  ændres tallet under en aktiv ventetid, bruges det nye tal ved næste overgang.
- UI-helpers, integrationer og dashboard gemmes i HA's persistente config-volume
  og er med i den eksisterende backup. Bevar volumen ved opdateringer.

Tests med PyYAML/Jinja2 installeret:

```text
python -m unittest discover -s home-assistant/tests -p "test_*.py"
```
