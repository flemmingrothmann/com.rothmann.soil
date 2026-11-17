# Kontaktstatus i Wingman

- Kun enheder i det aktuelle controller-inventar vises. En slettet Homey-kontakt fjernes ved næste vellykkede fulde Wingman-synkronisering (normalt hvert femte minut), derefter ved dashboardets næste refresh. Bevaret historik/current state må ikke genskabe den.
- En eksisterende, utilgængelig kontakt vises som **Ukendt**, ikke åben eller lukket. Dens gamle åbningstid vises ikke, og den tæller ikke med som åben.
- **Åben siden** bruger starten af den seneste ubrudte række af åbne observationer. Gentagne identiske rapporter nulstiller ikke tidspunktet. Lukket eller ukendt bryder rækken. Tidspunktet kan kun bestemmes inden for den hentede historik (syv dage).
- Ved Homey → HA-migrering accepteres ny IEEE-bundet historik; ingen automatisk sammenkobling med Homey-UUID er nødvendig (brugerafklaring 16. november 2026).

## Verifikation

`node --test tests/contactDashboard.test.js`

16. november 2026: hele dashboard-contexten deployet på `hubert`. Alle Node-tests bestod lokalt, og kontaktregressionerne bestod også mod den kørende containers moduler/frontend. Autentificeret kontakt-API og serveret frontend kontrolleret; alle syv build-context-filer og seks runtime-filer matchede repoet. Sletning verificeret med testdata, ikke ved at slette en fysisk kontakt.

Backup: `/opt/soil/.backups/contact-dashboard-20261116T085744Z`.
