# Manuel vanding – notifikationer

- Blueprintet `wingman/manual-soil-moisture-alarm.yaml` bruger sensorens HA-område
  i titlen, fx `Efeu i 'Flemmings Værelse' skal vandes`. Uden område vises kun planten.
- Alarmen oprettes ved/under grænsen og fjernes ved grænsen + 6 procentpoint
  (maks. 95 %). Den eksisterende hysterese er uændret.
- UI-automationen **Manuel vanding push til mobilapps** sender højst én
  `manual_soil_alarm_`-push pr. sensor i et rullende vindue på **24 timer**.
  Nye og opdaterede alarmer kontrolleres; første fugtopdatering efter 24 timer
  kan sende en ny påmindelse, hvis planten fortsat er tør. HA-notifikationen opdateres løbende.
- Seneste push gemmes pr. sensor i `input_datetime.<notification_id>_last_push`.
  Helperne ligger i `home-assistant/packages/manual_watering_notifications.yaml`,
  uden `initial`, så tidspunktet bevares ved reload/genstart. Sletning/genoprettelse
  af en alarm nulstiller ikke cooldown. Begge aktuelle sensorer har hver sin helper.
- Cooldown kontrolleres inde i den serielle kø, og tidspunktet reserveres **før**
  mobilkaldet. Samtidige events kan derfor ikke give dobbelte push. Et fejlet
  mobilkald bruger også vinduet; der foretages ikke automatisk genforsøg samme døgn.
- Ved en ny manuel sensor oprettes dens dato/tid-helper med samme ID-konvention;
  sæt første værdi til en dato mindst 24 timer tilbage, hvis første push skal sendes straks.
  Manglende/utilgængelig helper stopper push frem for at sende ubegrænset.
- Aktuelt er `notify.mobile_app_flemmings_s23` den eneste registrerede mobilapp.
  Når nye telefoner tilknyttes, skal deres `notify.mobile_app_*`-handling tilføjes
  i automationen. Bevar `continue_on_error`, så én utilgængelig telefon ikke blokerer andre.
- Push bruger alarmens ID som tag, så en ny alarm erstatter en gammel besked på telefonen.

## Verifikation

- Kør `tests/test_manual_watering_notifications.py` i HA-containeren med
  `HA_TEST_ROOT` pegende på testkopien af konfigurationen.
- Deploy kun helperpakken og automationen med ID `manuel_vanding_push_notifikation`;
  bevar alle øvrige live-automatikker og tag backup først. Bevar live-listen over mobilapps.
- Kør HA-konfigurationskontrol, `input_datetime.reload` og `automation.reload`.
  Ved migrering sættes helperne til seneste kendte push (eller konservativt nu),
  før den ændrede push-automation aktiveres, så deploy ikke sender nye push.
- Kontrollér via `trace/get`, at den indlæste cooldown afviser gentagne events,
  også efter sletning/genoprettelse af alarmen og reload. Verificér, at ingen
  `notify.mobile_app_*`-kald udføres, og at hjælpertidspunkterne ikke flyttes.
- Test grænsen ved præcis 24 timer, uafhængige sensorer, manglende helper og
  fremtidige tidspunkter i automatiske tests. Nulstil ikke live-cooldown for at teste.
- Ved HA-restore skal `home-assistant_home-assistant-config` inkludere `.storage`
  med gendannelsesdata for dato/tid-helperne. Se den fælles backup-/recovery-runbook.

## Verificeret 2026-11-09

- Backup før ændringen: `/config/backups/watering-rate-limit-20261109-125756` på `hubert`.
- Begge sensorer er initialiseret konservativt til seneste kendte fælles push-tidspunkt;
  deploy udsendte ingen nye push. Øvrige 22 live-automatikker og mobilhandlingerne blev bevaret.
- Automatiske tests dækker titel, filtrering, 24-timersgrænse, separate sensorer,
  manglende helper, fremtidigt tidspunkt og serialiseret reservation før mobilkald.
- Live `trace/get` og service-events bekræfter nul mobilkald ved opdatering af
  begge tørre planter, sletning/genoprettelse af alarm og helper-/automation-reload.
  Hjælpertidspunkterne blev bevaret, og grænsetilfælde blev testet i HA's template-engine.
