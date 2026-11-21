---
name: Wingman deployment
description: Brug ved konkret autoriseret deployment og funktionsverifikation på private hubert. Kræver testede artefakter, backup, afgrænset rollout og kilde/runtime-kontrol.
---

# Wingman deployment

Kun brugerens private `hubert` via Wi-Fi, normalt `fro@192.168.100.67`.
Behandl den tidligere Ethernet-adresse `.66` som forældet, og brug den ikke
som fallback uden ny bekræftelse.
Alle repo-stier er relative til repo-roden. Skillen er en tjekliste, ikke
autorisation til at starte deploy, ændre infrastruktur eller sende device-kald.

## Gate før deploy

Overdragelsen skal indeholde:
- Brugerautoriseret opgave, præcis host, services og tilladte filer.
- Test-/reviewresultater for de samme artefakter.
- Filmanifest/hashes; en commit-reference er kun tilstrækkelig for et
  kontrolleret rent artefakt. Bland ikke uvedkommende working-tree-ændringer ind.
- Gennemgået deployopskrift og eksisterende compose-projekt/service.
- Backupplan, forventet applikationseffekt og konkrete efterkontroller.

Stop som BLOCKED ved mangler, hashafvigelser eller ukendt live-konfiguration.
Brug ikke denne skill til improviseret drift eller rollout af agentfiler.

## Backup og rollout

1. Kontrollér aktive services, source/image-baseline og vedvarende volumes.
   Tag aftalt backup med beskyttede filrettigheder. Print ikke secrets.
2. Overfør kun manifestets filer og kontrollér hashes før build.
   Bevar `.env`, queues, Matter-parringsdata og named volumes.
3. Build/recreate kun godkendte services på `hubert` via den gennemgåede
   opskrift. Ingen `down -v`, broad cleanup, radio-/parringsændringer,
   database-migration eller genstart af nabo-services.
4. Ved kort netværksudfald: afgrænset retry af forbindelsen og kontrol af
   faktisk tilstand før en mulig gentagelse af mutationer.

## Domænespecifik verifikation

| Ændring | Påkrævet kontrol |
| --- | --- |
| Dashboard | Komplet `dashboard/` build-context med `public/`; `node tools/verify-dashboard-assets.js`; berørt UI-funktion på hubert, ikke kun HTTP 200 |
| Ingest/inventar | Kilde/runtime-hashes, nye fejl, kødræn, frisk observation, korrekt ejer/ID, ingen dubletter og bevaret historik |
| HA-konfiguration | Læs og merge live pr. bestilt ID, bevar UI-ændringer; aftalt reload og kontrol af indlæst config, ikke kun filen |
| Energi | Bevar cutoff, autoritativ kilde, enheder og historik; ingen dobbelttælling |

For ingest må metadata ikke skabe fysisk adfærd eller opfinde observationer.
For HA viser et config-endpoint ikke nødvendigvis kørende automation-config;
brug repoets dokumenterede trace-kontrol, når relevant og bestilt.
Efter HA-volumekopi kontrolleres hash inde i containeren.

Kør kun på forhånd gennemgåede verifikationsscripts. Authentificerede
read-only-kald må bruge secrets internt uden udskrift. Browserkontrol kræver
browser-skillen og tilhørende værktøjstilladelse; ellers overdrag den til
hovedagenten, og rapportér verifikationen som manglende.
Ingen tænd/sluk-, ventil-, automation-trigger- eller andre hardwarekald.

## Fejl og afslutning

- Ved fejl: behold backup og logs, stop scope-udvidelse og rapportér faktisk
  tilstand. Rollback kræver hovedagentens nye, autoriserede overdragelse.
- **SUCCEEDED:** godkendt deploy og alle bestilte efterkontroller bestået.
- **FAILED:** fejl; angiv om/ hvad der allerede er ændret.
- **BLOCKED:** manglende forudsætning eller verifikation; angiv om deploy skete.
- Rapportér host/services, artefakthashes, backupplacering, faktiske checks og
  resterende risici. Ingen credentials, commit/push eller release-tags.
