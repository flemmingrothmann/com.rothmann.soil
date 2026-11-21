# Køleovervågning

Køleovervågningens blueprint lægges i `home-assistant/blueprints/automation/wingman/cold-storage-temperature-alarm.yaml`. Den første instans er **Køleskab Værksted**. Fremtidige køleskabe/frysere kan bruge samme blueprint med særskilte hjælpere og paneler; der oprettes ingen sensorer for dem på forhånd.

## Opsætning

Opret UI-hjælperne fra `home-assistant/ui-helpers/cold-storage.json` og tilføj blueprint-automatikken. Vælg temperaturføler, gennemsnit, trends, alarm-latch, starttidspunkt, alarmgrænse og timeout samt notifikationsmål `notify.manuel_vanding_mobilapps`. Repoets JSON er defaults/testdata og må aldrig overskrive brugerens UI-værdier.

Ved tilmelding sættes starttidspunktet én gang til aktuel dato og tid. Alarm kan først aktiveres efter mindst 24 timer; data fra den indledende indsamlingsperiode vurderes ikke som fuld overvågning. Statistikken bruger `average_step` med 24 timers vindue: tidsvægtet gennemsnit af tilgængelige observationer, ikke `average_timeless`. Trends anvender lineær regression over én time, minimum to samples og positiv hældning.

Standard timeout er 120 minutter og kan justeres i UI (10–1440 minutter i trin på 5). Både aktuel kilde og gennemsnit skal have frisk `last_reported`; gennemsnittets `source_value_valid` skal være sand. Begge trends skal have mindst to samples, positiv gradient og frisk `last_updated` inden for én time. Dette blokerer genskabt trendstatus uden samples og trends, der ikke er blevet opdateret. Lige præcis alarmgrænsen holder eksisterende status. Alarm indtræffer kun når gennemsnittet er over grænsen, begge trends stiger og latch er slukket. Genopretning kræver frisk gyldig kilde og gennemsnit under grænsen; trends indgår ikke. Ukendt/offline eller datamangler ændrer aldrig latch. En vedvarende latch sættes før ét notifikationsforsøg pr. episode. `notify.send_message` accepteres uden garanti for pushlevering eller modtagelse.

Dashboardets native history graph viser temperatur og 24-timers gennemsnit over 168 timer.

## Drift og vedligeholdelse

- Panel: **Køleskab Værksted** i HA's sidemenu, lokalt på
  `http://192.168.100.67:8123/koleskab-vaerksted`.
- Grænser ændres i panelets **Indstillinger**. Hjælpere og statistik-/trendvinduer
  findes under **Indstillinger → Enheder og tjenester → Hjælpere**.
- Automatikken **Køleskab Værksted – temperaturalarm** bruger blueprintet
  **Køleovervågning** og kan redigeres i HA. Ændr ikke alarmstatus manuelt.
- Starttidspunktet bevares over genstart; det må ikke nulstilles ved almindelig
  vedligeholdelse. Alarmvurderingen begynder 21. november 2026 kl. 20:52 dansk tid.
- Kommende køleskab/fryser får egne hjælpere, grænser, blueprint-instans og panel.
  Fryserens temperaturgrænser aftales ved tilmelding; brug ikke køleskabets 7 °C.

`tools/configure-cold-storage.py --assets <staged-repository>` køres inde i HA-
containeren. Standard er read-only; `--apply` kræver konkret godkendelse.
Token gives som JSON på stdin, aldrig som kommandolinjeargument eller i logs.
Scriptet bevarer eksisterende UI-værdier, automatik og dashboard og afviser
kollisioner, slettede tidligere tilmeldte hjælpere og ufuldstændig initialisering.
Det er ikke et værktøj til at overskrive senere brugerændringer.

Backup før oprettelse: `/config/backups/cold-storage-20261120T195132Z/`.
Backup og tilmeldingsmanifest indeholder driftsdata og må ikke committes.
HA's config-endpoint indlæser kun det nye automation-ID; de øvrige 36
automatikker er sammenlignet med backup og er uændrede.

## Verifikation 20. november 2026

- 23 isolerede lokale tests bestået, inklusive grænser, datamangler, genstartstrends,
  notifikationsrækkefølge og bevarelse ved gentagen provisionering.
- `tools/validate-cold-storage-templates.py <staged-repository>` er bestået i
  installeret HA-Python med en separat syntetisk HA-instans, uden live-API/devicekald.
- Live: otte UI-hjælpere, korrekt statistik-/trendkonfiguration, aktiv automatik
  og afsluttet trace med den indlæste blueprint-konfiguration.
- Begge grafserier har recorder-historik. Aktuel temperatur og det foreløbige
  gennemsnit var 3,2 °C; panelet samler data til første døgn.
- En reel varm/kold alarmepisode og modtagelse på telefonen er endnu ikke
  observeret. Ingen temperaturer er simuleret i den aktive HA-instans.
- Dashboardkonfiguration og data er verificeret via API; visuel browserkontrol
  af det indloggede panel er ikke udført.

## HA 2026.11 API-faldgruber

- Jinja bruger `states[entity_id]`, ikke `states.get(...)`. `last_reported` er
  en egenskab på state-objektet, ikke en entity-attribut.
- `input_datetime/update` skal have `has_date`/`has_time` med, også ved navngivning
  af en ny helper; udeladte felter får ellers falske standardværdier.
- `POST /api/config/automation/config/<id>` genindlæser kun dette ID asynkront.
  Vent på den indlæste entity, og kontrollér nyeste trace; HTTP-succes alene
  beviser ikke, at automatikken er klar.
- History-API'et kræver eksplicit `end_time` for en ugeforespørgsel; ellers
  hentes som udgangspunkt kun et døgn fra det angivne starttidspunkt.
