# Hubert SSD- og backupmigrering

Status: backup etableret paa nuvaerende `hubert` 2026-07-12. Intern SSD-skift/ren Ubuntu restore er stadig naeste fase.

## Maal

- Etablere fungerende backup paa nuvaerende `hubert`, foer intern disk skiftes.
- Verificere at backup kan restores, foer maskinen aabnes.
- Skifte intern SSD og installere ren Ubuntu.
- Recover Homey Wingman/TimescaleDB/dashboard fra backup.

## Plan

1. Saet ekstern `2 TB` USB 3.2 disk paa nuvaerende `hubert`. Udført 2026-07-12.
2. Identificer disken sikkert med `lsblk`, UUID og filesystem-status. Udført: USB-disken er `/dev/sdb`.
3. Formatér kun efter eksplicit bekraeftelse, og mount den fast som backupdisk. Udført: `/dev/sdb1` er `ext4`, label `hubert-backup`, UUID `3040eef3-05f2-467a-bee1-750155dbca44`, mountet paa `/mnt/hubert-backup` via `/etc/fstab` med `nofail`.
4. Opsaet backup-rutine for Timescale/Postgres og relevant Docker/compose-konfiguration. Udført med `hubert-backup.timer`.
5. Koer manuel fuld backup. Udført: post-deploy backup-set `daily/20260713T064003Z`.
6. Verificer backup med restore-test, foer intern SSD skiftes. Udført for Postgres dump `20260713T064003Z`.
7. Skift intern SSD til ny `1 TB` M.2 SATA og installer ren Ubuntu.
8. Installer Docker/Compose og basisvaerktoejer paa den nye installation.
9. Genskab repo/deployment-struktur og secrets fra sikker kilde, ikke fra repo-dokumentation.
10. Restore Timescale/Postgres data fra ekstern backupdisk.
11. Start services og smoke-test ingest, dashboard, Zigbee layout, Netdata/proxy og Homey Wingman queue-drain.

## SSD-Skifte Runbook

Brug denne runbook naar den interne SSD fysisk skal skiftes. Maalet er at have en beviseligt restorable backup, lukke `hubert` kontrolleret ned, installere ren Ubuntu paa ny SSD og genskabe platformen uden at miste Postgres-historik.

### Stop/Go Foer Maskinen Aabnes

1. Bekraeft at ekstern backupdisk er mounted.

```bash
findmnt /mnt/hubert-backup
df -h /mnt/hubert-backup
```

2. Koer en frisk fuld backup.

```bash
sudo systemctl start hubert-backup.service
systemctl --no-pager --full status hubert-backup.service
```

3. Find nyeste backup-set og verificer checksums.

```bash
latest=$(sudo find /mnt/hubert-backup/hubert/daily -maxdepth 1 -mindepth 1 -type d -printf '%f\n' | sort | tail -n 1)
echo "$latest"
sudo find /mnt/hubert-backup/hubert/daily/$latest -name '*.sha256' -execdir sha256sum -c '{}' \;
```

4. Koer restore-test paa nyeste Postgres dump.

```bash
sudo /usr/local/sbin/hubert-restore-test.sh /mnt/hubert-backup/hubert/daily/$latest/postgres/homey_wingman-$latest.dump
```

5. Bekraeft restore-testens noegletal matcher backup-summary taet nok. Der kan vaere faa raekkers forskel, hvis live systemet modtager events mellem dump summary og restore-test.

```bash
sudo cat /mnt/hubert-backup/hubert/daily/$latest/postgres/homey_wingman-summary-$latest.txt
sudo tail -n 12 /mnt/hubert-backup/hubert/restore-tests/restore-test-$latest.success.log
```

6. Smoke-test at systemet stadig er sundt foer shutdown.

```bash
curl -fsS http://127.0.0.1:8788/health
curl -k -sS -o /dev/null -w 'dashboard-login=%{http_code}\n' https://home.knalloo.dk/login
docker ps --format 'table {{.Names}}\t{{.Status}}'
```

7. Stop/Go-beslutning: aabn ikke maskinen hvis backup, checksum eller restore-test fejler.

### Kontrolleret Shutdown Foer Disk-Skift

1. Stop skrivende services for at undgaa unødige queue-/databasewrites under shutdown.

```bash
docker compose --project-directory /opt/soil/dashboard -f /opt/soil/dashboard/compose.yaml down
docker compose --project-directory /opt/soil/replay-service -f /opt/soil/replay-service/compose.yaml down
docker compose --project-directory /opt/soil/ingest-service -f /opt/soil/ingest-service/compose.yaml down
```

2. Flush backupdisken. Lad den forblive fysisk tilsluttet under SSD-skiftet; den er den eneste restorekilde efter første boot.

```bash
sync
```

3. Luk maskinen kontrolleret.

```bash
sudo poweroff
```

4. Vent til maskinen er helt slukket, frakobl stroem, og skift intern SSD.

### Ren Ubuntu Install Paa Ny SSD

1. Installer Ubuntu paa den nye interne SSD.
2. Brug hostname `hubert`.
3. Opret bruger `fro` med SSH-adgang.
4. Konfigurer Ethernet som primaer driftforbindelse og WiFi som fallback under install eller straks efter foerste boot.
5. Kontroller lokalt at Ethernet har DHCP-adresse, og at arbejds-PC'en kan forbinde med `ssh fro@192.168.100.66`. Dette er remote-handoff punktet; naar SSH virker, kan resten af restore-forloebet gennemfoeres fra arbejds-PC'en.
6. Installer ikke Homey/Wingman-services foer backupdisken er mounted og restore-planen er klar.

### Foerste Boot Efter Ren Install

1. Opdater systemet og installer basispakker fra `Ren Ubuntu Reinstall Remedier`.
2. Konfigurer netplan med Ethernet `enp2s0` som primaer driftforbindelse og WiFi `wlp1s0` som fallback.
3. Installer Realtek WiFi remedier og `hubert-wifi-watchdog.timer`.
4. Mount ekstern backupdisk via UUID.
5. Installer Docker/Compose.
6. Genskab `/opt/soil`, `.env`-filer og compose-services.
7. Restore Postgres fra `pg_dump -Fc` dump, ikke fra live data-volume arkiv.
8. Start services og smoke-test.
9. Koer ny fuld backup og restore-test paa det genskabte system.

### Efter Restore Go/No-Go

Systemet er ikke faerdig-recovered foer alle disse er OK:

- `curl -fsS http://127.0.0.1:8788/health` returnerer OK.
- `https://home.knalloo.dk/login` returnerer HTTP `200`.
- Postgres har `timescaledb` extension og forventet `ingest_event` count/range.
- Homey Wingman queue drainer uden vedvarende fejl.
- Dashboard viser aktuelle data.
- Portainer svarer paa `https://192.168.100.66:9443/`.
- Zigbee layout/routehistorik er bevaret.
- Default route gaar via Ethernet `enp2s0`, og WiFi `wlp1s0` er aktiv fallback.
- `hubert-backup.timer` og `hubert-wifi-watchdog.timer` er active.
- Ny post-restore backup og restore-test er bestaaet.

## Ren Ubuntu Reinstall Remedier

Brug denne sektion som genopbygningscheckliste efter ny-installation. Print aldrig secrets; WiFi-password, `POSTGRES_PASSWORD`, `INGEST_TOKEN`, `HOMEY_TOKEN`, `DASHBOARD_PASSWORD` og Caddy-/DNS-secrets skal hentes fra sikker secret-kilde.

1. Installer basispakker.

```bash
sudo apt update
sudo apt install -y ca-certificates curl git openssh-server rsync jq
```

2. Installer Docker Engine og Compose plugin efter Docker's Ubuntu-vejledning. Verificer bagefter:

```bash
docker --version
docker compose version
sudo systemctl enable --now docker
```

3. Konfigurer Ethernet som primær driftforbindelse og WiFi som fallback. `enp2s0` skal være optional med lavere route metric end `wlp1s0`, så boot ikke blokerer ved kabel-/switchfejl, men Ethernet bruges som default route når linket er oppe.

```yaml
# /etc/netplan/00-installer-config.yaml
network:
  version: 2
  ethernets:
    enp2s0:
      optional: true
      dhcp4: true
      dhcp4-overrides:
        route-metric: 100
      match:
        macaddress: ec:16:55:58:6f:5c
      set-name: enp2s0
  wifis:
    wlp1s0:
      access-points:
        "Bogfinkevej 11":
          password: <wifi-password-from-secret-source>
      dhcp4: true
      dhcp4-overrides:
        route-metric: 600
```

```bash
sudo chmod 600 /etc/netplan/00-installer-config.yaml
sudo netplan generate
sudo netplan apply
networkctl status enp2s0 --no-pager
networkctl status wlp1s0 --no-pager
ip route | sed -n '1,6p'
```

4. Genetabler Realtek WiFi-driver remedier. Disse træder først sikkert i kraft ved næste driverindlæsning/reboot.

```bash
sudo tee /etc/modprobe.d/rtw88-hubert-stability.conf >/dev/null <<'EOF'
options rtw88_core disable_lps_deep=Y
options rtw88_pci disable_aspm=Y
EOF
```

5. Genetabler WiFi-watchdog fra repoets `tools/`.

```bash
sudo install -m 0755 tools/hubert-wifi-watchdog.sh /usr/local/sbin/hubert-wifi-watchdog.sh
sudo install -m 0644 tools/hubert-wifi-watchdog.service /etc/systemd/system/hubert-wifi-watchdog.service
sudo install -m 0644 tools/hubert-wifi-watchdog.timer /etc/systemd/system/hubert-wifi-watchdog.timer
sudo systemctl daemon-reload
sudo systemctl enable --now hubert-wifi-watchdog.timer
sudo systemctl start hubert-wifi-watchdog.service
systemctl status hubert-wifi-watchdog.service --no-pager
```

6. Mount backupdisken via UUID. Diskens kendte UUID er `3040eef3-05f2-467a-bee1-750155dbca44`, label `hubert-backup`.

```bash
sudo mkdir -p /mnt/hubert-backup
echo 'UUID=3040eef3-05f2-467a-bee1-750155dbca44 /mnt/hubert-backup ext4 defaults,nofail,x-systemd.device-timeout=10 0 2' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload
sudo mount /mnt/hubert-backup
findmnt /mnt/hubert-backup
```

7. Genetabler backup- og restore-værktøjer fra repoets `tools/`.

```bash
sudo install -m 0755 tools/hubert-backup.sh /usr/local/sbin/hubert-backup.sh
sudo install -m 0755 tools/hubert-restore-test.sh /usr/local/sbin/hubert-restore-test.sh
sudo install -m 0644 tools/hubert-backup.service /etc/systemd/system/hubert-backup.service
sudo install -m 0644 tools/hubert-backup.timer /etc/systemd/system/hubert-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now hubert-backup.timer
```

8. Genskab `/opt/soil` fra repo/deployment-kilde eller backupens `system/hubert-system-config-*.tar.gz`. Bevar `.env`-filer fra sikker secret-kilde, ikke fra repoet.

```bash
sudo mkdir -p /opt/soil
sudo chown -R fro:fro /opt/soil
```

9. Genskab Docker netværk og compose-services. `reverse-proxy` skal findes før dashboard/ingest startes.

```bash
docker network inspect reverse-proxy >/dev/null 2>&1 || docker network create reverse-proxy
docker compose --project-directory /opt/soil/ingest-service -f /opt/soil/ingest-service/compose.yaml up -d --build
docker compose --env-file /opt/soil/replay-service/.env --project-directory /opt/soil/replay-service -f /opt/soil/replay-service/compose.yaml up -d --build
docker compose --project-directory /opt/soil/proxy -f /opt/soil/proxy/docker-compose.yml up -d --build
docker compose --env-file /opt/soil/dashboard/.env --project-directory /opt/soil/dashboard -f /opt/soil/dashboard/compose.yaml up -d --build
docker compose --project-directory /opt/soil/monitoring -f /opt/soil/monitoring/compose.yaml up -d
```

10. Restore Postgres fra seneste verificerede `pg_dump -Fc` dump. Brug ikke live Postgres data-volume arkiv som primær restorekilde.

```bash
sudo /usr/local/sbin/hubert-restore-test.sh /mnt/hubert-backup/hubert/daily/<timestamp>/postgres/homey_wingman-<timestamp>.dump
```

11. Når restore-testen er grøn, restore produktionsdatabasen med Timescale restore mode som beskrevet i `Restore Procedure For Postgres` nedenfor.

12. Smoke-test efter restore og service-start.

```bash
curl -fsS http://127.0.0.1:8788/health
curl -k -sS -o /dev/null -w 'dashboard-login=%{http_code}\n' https://home.knalloo.dk/login
curl -fsS http://192.168.100.66:19999/api/v1/info >/dev/null
curl -k -fsS https://192.168.100.66:9443/ >/dev/null
systemctl is-active hubert-backup.timer
systemctl is-active hubert-wifi-watchdog.timer
docker ps --format 'table {{.Names}}\t{{.Status}}'
```

Hvis `hubert-netdata` er healthy, men `http://192.168.100.66:19999` ikke svarer efter reboot, tjek at Docker viser portbindingen `192.168.100.66:19999->19999/tcp`. Mangler den, recreate kun Netdata-containeren efter at `enp2s0` har faaet `192.168.100.66`:

```bash
docker compose --project-directory /opt/soil/monitoring -f /opt/soil/monitoring/compose.yaml up -d --force-recreate --no-deps netdata
```

Portainer bruger ogsaa en IP-specifik Docker-portbinding. Hvis `portainer` koerer, men `https://192.168.100.66:9443/` ikke svarer og `docker ps` ikke viser `192.168.100.66:9443->9443/tcp`, genskab containeren med samme `portainer_data` volume efter at `enp2s0` har faaet `192.168.100.66`:

```bash
old=portainer-replaced-$(date -u +%Y%m%dT%H%M%SZ)
docker stop portainer
docker rename portainer "$old"
docker run -d --name portainer --restart=unless-stopped -p 192.168.100.66:9443:9443 -v /var/run/docker.sock:/var/run/docker.sock -v portainer_data:/data portainer/portainer-ce:lts
```

13. Kør en ny fuld backup efter systemet er genskabt.

```bash
sudo systemctl start hubert-backup.service
latest=$(sudo find /mnt/hubert-backup/hubert/daily -maxdepth 1 -mindepth 1 -type d -printf '%f\n' | sort | tail -n 1)
sudo find /mnt/hubert-backup/hubert/daily/$latest -name '*.sha256' -execdir sha256sum -c '{}' \;
sudo /usr/local/sbin/hubert-restore-test.sh /mnt/hubert-backup/hubert/daily/$latest/postgres/homey_wingman-$latest.dump
```

14. Verificer at WiFi-remedier er aktive efter første reboot.

```bash
cat /sys/module/rtw88_core/parameters/disable_lps_deep
cat /sys/module/rtw88_pci/parameters/disable_aspm
journalctl -b -u hubert-wifi-watchdog.service --no-pager
journalctl -b --no-pager | grep -E 'CTRL-EVENT-DISCONNECTED|Connection to AP|WPA: 4-Way Handshake failed' | tail -n 50
```

## Aktuel Backupopsætning

- Backupdisk: `/dev/sdb1`, `ext4`, label `hubert-backup`, UUID `3040eef3-05f2-467a-bee1-750155dbca44`.
- Mount: `/mnt/hubert-backup`.
- Backup root: `/mnt/hubert-backup/hubert` med root-only adgang.
- Script: `/usr/local/sbin/hubert-backup.sh`, kildekopi i `tools/hubert-backup.sh`.
- Restore-test script: `/usr/local/sbin/hubert-restore-test.sh`, kildekopi i `tools/hubert-restore-test.sh`.
- Systemd timer: `hubert-backup.timer`, dagligt omkring `03:15 UTC` med op til `20 min` randomized delay og `Persistent=true`.
- Postgres backup er logical-first: `pg_dump -Fc` plus `pg_dumpall --globals-only`.
- Den live Postgres data-volume arkiveres ikke som filkopi; den erstattes af logical dump for at undgaa inkonsistente Postgres-datafiler.
- Ikke-Postgres Docker-volumener arkiveres som `tar.gz` under `docker-volumes/`.
- System-/deploy-konfiguration arkiveres under `system/`, inklusive `/opt/soil`, `/etc/fstab`, `/etc/systemd/system` og `/etc/docker` hvis den findes.
- Docker restore-manifester arkiveres under `system/` som `docker-containers-*.txt`, `docker-compose-paths-*.txt`, `docker-container-inspect-*.json`, `docker-network-inspect-*.json` og `docker-volume-inspect-*.json`.
- Backup-run logs gemmes under `/mnt/hubert-backup/hubert/logs/`.
- Hver backupfil har en relativ `.sha256`, saa den kan verificeres fra backupmappen med `sha256sum -c`.

## Hubert Netværksstabilitet

- `hubert` bruger Ethernet `enp2s0` som primær driftforbindelse (`192.168.100.66`, DHCP route metric `100`) og WiFi `wlp1s0` som fallback (`192.168.100.67`, DHCP route metric `600`).
- Observeret udfald 2026-07-13 skyldtes WiFi `wlp1s0`, ikke reboot, Postgres eller Docker: logs viste gentagne `CTRL-EVENT-DISCONNECTED`, `Connection to AP lost` og `WPA: 4-Way Handshake failed`.
- Der er opsat `hubert-wifi-watchdog.timer`, som hvert minut pinger gateway `192.168.100.1` via `wlp1s0` og forsøger `wpa_cli reconnect`/WPA-service restart ved manglende forbindelse, saa WiFi-fallbacken holdes klar.
- Realtek-driveren `rtw88_8822ce` har persistent modprobe-konfiguration for at deaktivere deep power save og PCI ASPM ved næste driverindlæsning/reboot.

## Verificeret Restore

Seneste Postgres restore-test er koert 2026-07-13 mod dumpet:

```bash
sudo /usr/local/sbin/hubert-restore-test.sh /mnt/hubert-backup/hubert/daily/20260713T064003Z/postgres/homey_wingman-20260713T064003Z.dump
```

Resultat fra restore-test:

```text
database_size|1134 MB
extensions|plpgsql,timescaledb
ingest_event_count|1266847
ingest_event_range|2025-11-29 12:10:55.418+00|2026-07-13 06:39:50.248+00
Restore test passed
```

Restore-test log er gemt paa backupdisken:

```text
/mnt/hubert-backup/hubert/restore-tests/restore-test-20260713T064003Z.success.log
```

## Restore Procedure For Postgres

1. Installer Docker/Compose og genskab `/opt/soil` fra `system/hubert-system-config-*.tar.gz` eller repo/deployment-kilde.
2. Start en frisk `timescale/timescaledb:2.28.2-pg16` Postgres-container med `shared_preload_libraries=timescaledb`. Brug ikke en flydende `latest`-tag; TimescaleDB-katalogversionen skal være kompatibel med dumpet.
3. Stop ingest-service, saa der ikke skrives nye events under restore.
4. Genskab roller/database fra compose secrets eller `postgres/*-globals.sql.gz` efter behov.
5. Koer i target-databasen: `CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();`.
6. Restore dumpet med `pg_restore` til `homey_wingman`.
7. Koer i target-databasen: `SELECT timescaledb_post_restore();`.
8. Verificer mindst `timescaledb` extension, `ingest_event` count/range og relevante metadata-tabeller.
9. Start ingest-service og smoke-test `http://127.0.0.1:8788/health`.

Ikke-produktions restore-test kan altid gentages med:

```bash
sudo /usr/local/sbin/hubert-restore-test.sh <path-to-postgres-dump>
```

Checksum-verifikation for et backup-set:

```bash
sudo find /mnt/hubert-backup/hubert/daily/<timestamp> -name '*.sha256' -execdir sha256sum -c '{}' \;
```

## Backup Retention Forslag

- Daglige backups: behold `14` dage.
- Ugentlige backups: behold `8` uger.
- Maanedlige backups: behold `12` maaneder.
- Komprimer database dumps.
- Lav jævnligt restore-test, ikke kun backup-test.

## Husk

- Print aldrig database-passwords, Homey tokens eller `INGEST_TOKEN` i logs eller dokumentation.
- Timescale/Postgres data er vigtigste persistente data.
- `state_current` kan genskabes fra eventstream/snapshot, men historiske `ingest_event` og Zigbee route history skal recoveres fra backup, hvis de skal bevares.
- Ekstern backupdisk skal kunne frakobles og opbevares separat efter fuld backup, hvis vi vil beskytte mod hardwarefejl under SSD-skift.
