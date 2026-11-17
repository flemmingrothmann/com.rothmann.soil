# Jordfugt: navne der følger enheden

## Sådan bruges det

- Omdøb MQTT-enheden i HA, fx til **Elefantfod - Z-3**. Det brugerbestemte HA-navn har førsteprioritet; ellers bruges det aktuelle Z2M-navn.
- Inden for cirka ét minut følger dens tre hjælpere og individuelle manuelle alarm med:
  - `Elefantfod - Z-3 jordfugtgrænse`
  - `Elefantfod - Z-3 vandalarm`
  - `Elefantfod - Z-3 seneste vandingspush`
  - `Elefantfod - Z-3 jordfugt alarm`
- Nye sensorer får navngivningen fra start. Senere omdøbninger kræver ikke genstart eller ny parring.
- Et særnavn på selve helperen/automatiseringen bevares. Automatisk navngivning overtager ikke en ukendt brugerdefineret titel.

## Identitet og indstillinger bevares

- IEEE og eksisterende entity-ID'er er fortsat stabile tekniske nøgler. De ændres ikke, selv om ID-kolonnen derfor stadig kan indeholde en adresse.
- Grænser, alarmstatus, push-cooldown, historik, blueprint-inputs, automations-ID'er og aktivering bevares.
- Eksisterende navne synkroniseres med HA's `config/entity_registry/update` og feltet `name`. Automatiseringernes oprindelige alias/config og helper-definitioner omskrives ikke. Der foretages ingen eksplicit automation-reload, trigger eller ventilhandling.
- `soilNames.js` genkender de gamle genererede IEEE-/mærkatnavne. Profilens kompakte `managedSoilNames` gemmer seneste genererede navn og oprindeligt navn, så efterfølgende brugerændringer kan skelnes fra navnesynkronisering. Det er ejerskabsmetadata, ikke navnehistorik.
- Hvis helperens/automatiseringens egen editor ændrer det oprindelige navn til et særnavn, fjernes kun vores eget hidtidige visningsnavn, så særnavnet bliver synligt. Brugerens særskilte entity-registry-navn overskrives ikke.
- Manglende/slettede hjælpere eller automatikker genoprettes ikke for at få et navn. En manglende cooldown blokerer ikke omdøbning af de øvrige eksisterende artefakter. Eksplicitte vandingskredse og fælles automatikker overtages ikke.

## Test og drift

```sh
node --test tests/soilNames.test.js tests/soilProvisioning.test.js
```

Deploy hele soil-adapterens build-context, inklusive `soilNames.js` i Dockerfile. Bevar live `config/`, privat `.env` og named volume. Kun soil-adapteren skal genoprettes; HA og Z2M behøver ikke genstart.

Backup før deploy 15. november 2026: `/opt/soil/.backups/soil-names-20261115T195542Z`. Den indeholder tidligere kilde/Dockerfile, profiler, image-ID, HA's entity-registry og den uændrede automation-fil.

Verificeret på `hubert` samme dag:

- 23 eksisterende hjælpere og syv eksisterende manuelle automatikker har korrekte visningsnavne; 27 navne blev ændret, tre var allerede korrekte.
- En rigtig HA-enheds-omdøbning af Z-4 slog automatisk igennem på tre hjælpere og automatikken. Endnu en omdøbning bevarede et midlertidigt særnavn på tal-helperen. Alle testnavne blev efterfølgende gendannet.
- Alle berørte entity-ID'er, unique-ID'er, helperværdier, cooldown-tidspunkter og automatik-aktiveringer er identiske med før deploy. Automation-filens SHA-256 er uændret. Den tidligere slettede Z-2-cooldown er ikke genoprettet.
- Alle 159 Node-tests består; de otte målrettede navnetests består også mod modulet i den kørende container. Målrettet lint har ingen fejl; to eksisterende advarsler er uændrede. Deployede modul-checksummer matcher kildefilerne.
