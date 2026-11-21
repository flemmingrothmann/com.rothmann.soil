# Home Assistant – fjernadgang og loginbeskyttelse

## Drift

- `https://ha.knalloo.dk` → Caddy → `192.168.100.67:8123` på `hubert`.
- ASUS RT-AC68U: de kontrollerede manuelle viderestillinger er TCP 80 og 443
  til `192.168.100.67`. UPnP, DMZ og WAN-administration er endnu ikke verificeret.
- Ejeren har bekræftet fungerende MFA. MFA kræver ikke et cloud-abonnement.
- HTTP-konfiguration ejes fra HA 2026.8 af **Indstillinger → System → Netværk**,
  ikke af `configuration.yaml`. Manglende `http:` i YAML betyder ikke, at
  proxybeskyttelse er slået fra.

## Ønskede HTTP-indstillinger

- `use_x_forwarded_for: true`
- `trusted_proxies: [172.18.0.3/32]` – kun den aktuelle Caddy-container.
- `ip_ban_enabled: true`
- `login_attempts_threshold: 30` – aftalt for at mindske risikoen for egen blokering.
- Bevar øvrige eksisterende indstillinger, herunder port 8123 og CORS til Cast.

Caddys kildeadresse `172.18.0.3` er verificeret med netværkstrafik på `hubert`.
Adressen er aktuelt dynamisk tildelt af Docker. Ved genskabelse af proxy-containeren
skal adressen kontrolleres, og trusted proxy opdateres ved ændring. Almindelig
genstart ændrer ikke containerens netværkstildeling. Fejl giver afvist proxyadgang,
ikke åben adgang. Brug lokal adgang/SSH til recovery.

## Sikker ændring og verifikation

1. Tag beskyttet backup af `/config/.storage/http` og `configuration.yaml`.
2. Hent aktiv konfiguration via WebSocket `http/config`.
3. Brug `http/config/configure` med eksisterende indstillinger og de aftalte ændringer.
   API'et validerer og genstarter HA. Skriv ikke manuelt i `.storage` under drift.
4. Test lokal og HTTPS-autentificeret REST- og WebSocket-adgang efter genstart.
5. Test at direkte kald fra en ikke-betroet klient med `X-Forwarded-For` afvises.
6. Bekræft med `http/config/promote` inden fem minutter; ellers ruller HA tilbage.
7. Kontrollér `stable`, at `pending` er tom, og at der ikke er nye proxyfejl.

Ved en reel IP-blokering findes adressen i `/config/ip_bans.yaml`. Fjern kun den
berørte adresse og genstart HA. Afprøv ikke gentagne fejllogins fra ejerens IP,
da det kan blokere både browser og mobilapp. Blokeringer udløber ikke automatisk.

UFW er aktuelt inaktiv, og flere tjenester lytter på LAN. Host-firewall, Docker-
portbindinger og routerens øvrige sikkerhedsindstillinger er separate opgaver.

## Verificeret 2026-11-09

- Backup: `/config/backups/http-security-20261109-123724` på `hubert`.
- HA-konfigurationskontrol gennemført før ændringen; HA tilbage i `RUNNING` efter genstart.
- Lokal og HTTPS-autentificeret REST samt HTTPS/WebSocket fungerer.
- API uden login afvises med 401; direkte LAN-kald med forfalsket
  `X-Forwarded-For` afvises med 400.
- Aktiv MFA bekræftet via API. Nye HTTP-indstillinger findes i `stable`,
  uden `pending`-ændring eller rollback-timer.
- Blokeringsgrænsen er verificeret i aktiv konfiguration, ikke ved at fremprovokere
   gentagne fejllogins fra ejerens adresse.
- Grænsen er efter aftale hævet fra 10 til **30**. Backup før ændringen:
  `/config/backups/http-threshold30-20261109-124750`. Efter genstart er 30
  verificeret og bekræftet i `stable`; lokal REST, HTTPS/REST, HTTPS/WebSocket,
  MFA og afvisning af ikke-betroede forwarded-IP-kald er kontrolleret igen.
