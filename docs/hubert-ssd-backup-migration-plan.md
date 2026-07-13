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
2. Start en frisk `timescale/timescaledb:latest-pg16` Postgres-container med `shared_preload_libraries=timescaledb`.
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
