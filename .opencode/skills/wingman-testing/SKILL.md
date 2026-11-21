---
name: Wingman test
description: Brug ved lokal testplan, regressionstestkørsel og dækningskontrol af Wingman, HA, dashboard og ingest. Offline, uden koderettelser eller driftskald.
---

# Wingman test

Alle repo-stier er relative til repo-roden. Skillen giver ikke ret til
ændringer, installation eller netværkskald. `wingman-test` rapporterer fund;
implementeringsagenten retter dem.

## Testgrundlag

1. Notér bestilte krav, filer og base/delta. En tom Git-diff er ikke i sig selv
   bevis på noget. Kontrollér staged/unstaged og relevante untracked filer.
2. Læs berørte scripts, package-hooks og tests før udførelse.
   Hent ikke dependencies. Manglende runtime/dependencies giver BLOCKED.
3. Udled relevante tilfælde:

| Område | Minimum at overveje |
| --- | --- |
| Lys/inventar | IEEE vs HA-alias, rename, fjernet enhed, legacy historik-ID, ignored/disabled, andre controllers |
| Observation/kø | offline/null, gentagelser, rækkefølge, genstart, afbrudt levering, bevaret historik |
| Dashboard | korrekte værdier, fejl fra API, escaping, tom/ukendt/offline, mobil-layout |
| HA/vanding | brugerændrede helpers, slettet automation, cooldown, spærret/aktiv/ukendt ventil |
| Energi | autoritativ cutoff, units, import/eksport og bevaret energihistorik |

Kun relevante rækker behøver tests; markér konkrete huller, ikke generelle
ønskelister. Fysiske handlinger må ikke udføres som lokal test.

## Sikre lokale kontroller

Efter scriptgennemgang kan følgende bruges fra repo-roden:

```powershell
npm test
git diff --check
git diff --cached --check
```

- Start gerne med `node --test` og præcise relevante testfiler i `tests/`.
- Kør `node --check` med de enkelte ændrede JavaScript-filer.
- HA's Python-tests ligger i `home-assistant/tests/`; læs testens imports og
  opsætning og vælg de relevante unittest-filer frem for live-verifiers.
- Lint kun berørte filer uden fix. `npm run lint -- <filer>` indsnævrer ikke
  nødvendigvis repoets script, hvis det allerede indeholder `.`.
- Adskil eksisterende lintfejl fra nye fund. Skjul ikke fejl, men kræv heller
  ikke uvedkommende repo-oprydning for at beskrive opgavens resultat.
- Ingen `.local`-scripts, netværk, SSH, Docker, HA/Homey/MQTT eller database.
  Runtime-/UI-kontrol på `hubert` hører til en særskilt autoriseret overdragelse.

## Resultat

- **PASS:** nødvendige lokale checks bestået, ingen konkrete blokeringer.
- **FAIL:** konstateret fejl/regression med fil/linje og reproduktion.
- **BLOCKED:** nødvendig kontrol kunne ikke udføres; angiv præcis mangel.

Medtag kommando, arbejdsmappe, exitkode og testantal. Kontrollér Git-status
bagefter; rapportér utilsigtede ændringer uden at gendanne/slette dem.
Lokal PASS er hverken deploygodkendelse eller bevis på fysisk funktion.
Det globale `verify`-review før commit gælder stadig.
