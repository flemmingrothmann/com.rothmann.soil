# Manuel vanding – notifikationer

- Blueprintet `wingman/manual-soil-moisture-alarm.yaml` bruger sensorens HA-område
  i titlen, fx `Efeu i 'Flemmings Værelse' skal vandes`. Uden område vises kun planten.
- Nye Zigbee-jordfugtsensorer klargøres automatisk af soil-adapteren, når Z2M og HA har opdaget dem.
  De får en tal-helper til alarmgrænsen, en alarmstatus og en vedvarende push-cooldown.
  Grænsen starter på 25 % og kan ændres i dashboardet eller HA's helper-UI; 0 slår alarmen fra.
  Eksisterende indstillinger og manuelle blueprint-instanser genbruges, ikke nulstilles eller duplikeres.
- Alarmen oprettes ved/under grænsen og fjernes ved grænsen + 6 procentpoint
  (maks. 95 %). Den eksisterende hysterese er uændret.
- UI-automationen **Manuel vanding push til mobilapps** sender højst én
  `manual_soil_alarm_`-push pr. sensor i et rullende vindue på **24 timer**.
  Nye og opdaterede alarmer kontrolleres; første fugtopdatering efter 24 timer
  kan sende en ny påmindelse, hvis planten fortsat er tør. HA-notifikationen opdateres løbende.
- Seneste push gemmes pr. sensor i `input_datetime.<notification_id>_last_push`.
  Også de to oprindelige helpers er nu UI-administrerede, med samme ID'er og
  bevarede tidspunkter. Reference/testdefaults ligger i
  `home-assistant/ui-helpers/legacy-watering/manual_watering_notifications.yaml`.
  Sletning/genoprettelse af en alarm nulstiller ikke cooldown.
- Cooldown kontrolleres inde i den serielle kø, og tidspunktet reserveres **før**
  mobilkaldet. Samtidige events kan derfor ikke give dobbelte push. Et fejlet
  mobilkald bruger også vinduet; der foretages ikke automatisk genforsøg samme døgn.
- Ved en ny manuel sensor oprettes dens dato/tid-helper med samme ID-konvention (automatisk for Zigbee);
  sæt første værdi til en dato mindst 24 timer tilbage, hvis første push skal sendes straks.
  Manglende/utilgængelig helper stopper push frem for at sende ubegrænset.
- Automationens modtager er den UI-administrerede notify-gruppe
  `notify.manuel_vanding_mobilapps`. Tilføj eller fjern telefoner via
  **Indstillinger → Enheder og tjenester → Hjælpere → Mobilnotifikationer**;
  vælg telefonens `notify.*`-entitet. Automationen skal ikke ændres, når telefoner skiftes.
- **Mobilnotifikationer** bruges også af kaffemaskinens færdig-push. Gruppens tekniske
  ID `notify.manuel_vanding_mobilapps` er bevaret; visningsnavnet er fælles for begge formål.
- Bevar `continue_on_error`, så en utilgængelig telefon ikke blokerer andre gruppemedlemmer.
- Push bruger alarmens ID som tag, så en ny alarm erstatter en gammel besked på telefonen.

## Verifikation

- Kør `tests/test_manual_watering_notifications.py` i HA-containeren med
  `HA_TEST_ROOT` pegende på testkopien af konfigurationen.
- Deploy kun den berørte blueprint/automation med ID `manuel_vanding_push_notifikation`;
  bevar alle øvrige live-automatikker og tag backup først. Bevar live-listen over mobilapps.
- Helpers vedligeholdes i HA UI; deploy ikke de gamle YAML-defaults. Se
  [UI-vedligeholdelse og migrering](home-assistant-watering-ui.md).
  Ved migrering sættes helperne til seneste kendte push (eller konservativt nu),
  før den ændrede push-automation aktiveres, så deploy ikke sender nye push.
- Kontrollér via `trace/get`, at den indlæste cooldown afviser gentagne events,
  også efter sletning/genoprettelse af alarmen og reload. Verificér, at ingen
  `notify.mobile_app_*`-kald udføres, og at hjælpertidspunkterne ikke flyttes.
- Test grænsen ved præcis 24 timer, uafhængige sensorer, manglende helper og
  fremtidige tidspunkter i automatiske tests. Nulstil ikke live-cooldown for at teste.
- Ved HA-restore skal `home-assistant_home-assistant-config` inkludere `.storage`
  med gendannelsesdata for dato/tid-helperne. Se den fælles backup-/recovery-runbook.

## Automatisk klargøring verificeret 2026-11-12

- Chilli og Efeu blev automatisk klargjort på `hubert`; begge eksisterende automation-ID'er blev genbrugt.
- Dashboardets grænseændring 25 → 24 % nåede HA, overlevede adaptergenstart og blev gendannet til 25 %.
- En isoleret HA-test bekræftede alarm, hysterese, omgående reevaluering ved grænseændring og deaktivering med 0; ingen mobilpush eller fysiske enhedskald.
- De eksisterende push-tidspunkter og alle 23 øvrige automatikker blev bevaret. Indlæst push-trace afviste en gentagelse i cooldown-betingelsen uden fejl.
- 100 Node-tests og 17 blueprint-/cooldown-tests bestod. Kørende adapter-/blueprintfiler og dashboardets fulde build-context blev sammenlignet med repoet.

## Verificeret 2026-11-09

- Backup før ændringen: `/config/backups/watering-rate-limit-20261109-125756` på `hubert`.
- Begge sensorer er initialiseret konservativt til seneste kendte fælles push-tidspunkt;
  deploy udsendte ingen nye push. Øvrige 22 live-automatikker og mobilhandlingerne blev bevaret.
- Automatiske tests dækker titel, filtrering, 24-timersgrænse, separate sensorer,
  manglende helper, fremtidigt tidspunkt og serialiseret reservation før mobilkald.
- Live `trace/get` og service-events bekræfter nul mobilkald ved opdatering af
  begge tørre planter, sletning/genoprettelse af alarm og helper-/automation-reload.
  Hjælpertidspunkterne blev bevaret, og grænsetilfælde blev testet i HA's template-engine.
