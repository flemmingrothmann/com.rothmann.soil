#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

BACKUP_MOUNT=${BACKUP_MOUNT:-/mnt/hubert-backup}
BACKUP_ROOT=${BACKUP_ROOT:-$BACKUP_MOUNT/hubert}
POSTGRES_CONTAINER=${POSTGRES_CONTAINER:-homey-wingman-postgres}
POSTGRES_DB=${POSTGRES_DB:-homey_wingman}
POSTGRES_USER=${POSTGRES_USER:-homey_wingman}
POSTGRES_VOLUME=${POSTGRES_VOLUME:-ingest-service_homey-wingman-postgres-data}
LOCK_FILE=${LOCK_FILE:-/var/lock/hubert-backup.lock}

DAILY_RETENTION_DAYS=${DAILY_RETENTION_DAYS:-14}
WEEKLY_RETENTION_DAYS=${WEEKLY_RETENTION_DAYS:-56}
MONTHLY_RETENTION_DAYS=${MONTHLY_RETENTION_DAYS:-366}

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
PARTIAL_ROOT=$BACKUP_ROOT/.partial
WORK_DIR=$PARTIAL_ROOT/$STAMP
DAILY_DIR=$BACKUP_ROOT/daily/$STAMP
RUN_LOG=$BACKUP_ROOT/logs/hubert-backup-$STAMP.log

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

cleanup_partial() {
  if [[ -d "$WORK_DIR" ]]; then
    rm -rf -- "$WORK_DIR"
  fi
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

write_sha256() {
  local file=$1
  local dir
  local name

  dir=$(dirname -- "$file")
  name=$(basename -- "$file")
  (cd "$dir" && sha256sum "$name" > "$name.sha256")
}

write_restore_notes() {
  local target=$1

  cat > "$target/RESTORE.md" <<'EOF'
# Hubert Backup Restore Notes

This backup set is intended for restoring the Hubert Homey Wingman platform.

## PostgreSQL / TimescaleDB

1. Start a fresh `timescale/timescaledb:2.28.2-pg16` container with `shared_preload_libraries=timescaledb`.
2. Create the target database/user through compose or restore the `postgres/*-globals.sql.gz` file if needed.
3. Run `CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();` in the target database.
4. Restore `postgres/*.dump` with `pg_restore`.
5. Run `SELECT timescaledb_post_restore();` in the target database.
6. Verify key tables, especially `ingest_event`, before starting ingest again.

Use `/usr/local/sbin/hubert-restore-test.sh <dump-file>` for a non-production restore test.

## Other data

- `docker-volumes/*.tar.gz` contains named Docker volumes except the live Postgres data volume.
- `system/*system-config*.tar.gz` contains `/opt/soil`, selected systemd config and fstab for rebuild guidance.
- `system/docker-*.json` and `system/docker-*.txt` contain container, network, volume and compose metadata for rebuild guidance.
- Backups may contain secrets. Keep the disk physically protected.
EOF
}

run_postgres_backup() {
  local pg_dir=$WORK_DIR/postgres
  local dump_file=$pg_dir/$POSTGRES_DB-$STAMP.dump
  local globals_file=$pg_dir/$POSTGRES_DB-globals-$STAMP.sql.gz
  local summary_file=$pg_dir/$POSTGRES_DB-summary-$STAMP.txt

  mkdir -p "$pg_dir"

  log "Writing Postgres custom-format dump"
  docker exec "$POSTGRES_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$dump_file.tmp"
  mv -- "$dump_file.tmp" "$dump_file"
  write_sha256 "$dump_file"

  log "Writing Postgres globals dump"
  docker exec "$POSTGRES_CONTAINER" pg_dumpall -U "$POSTGRES_USER" --globals-only | gzip -c > "$globals_file.tmp"
  mv -- "$globals_file.tmp" "$globals_file"
  write_sha256 "$globals_file"

  log "Writing Postgres summary"
  {
    printf 'timestamp_utc=%s\n' "$STAMP"
    docker exec "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select 'database_size|' || pg_size_pretty(pg_database_size(current_database()));"
    docker exec "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select 'extensions|' || string_agg(extname, ',' order by extname) from pg_extension;"
    docker exec "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select 'ingest_event_count|' || count(*) from ingest_event;"
    docker exec "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select 'ingest_event_range|' || min(event_time) || '|' || max(event_time) from ingest_event;"
  } > "$summary_file"
}

run_docker_volume_backup() {
  local volume_dir=$WORK_DIR/docker-volumes
  mkdir -p "$volume_dir"

  log "Archiving non-Postgres Docker volumes"
  docker volume ls --format '{{.Name}}' | sort | while IFS= read -r volume; do
    [[ -n "$volume" ]] || continue
    if [[ "$volume" == "$POSTGRES_VOLUME" ]]; then
      log "Skipping live Postgres volume $volume; logical dump is used instead"
      continue
    fi

    if [[ "$volume" =~ ^[0-9a-f]{64}$ ]] && ! docker ps -aq --filter volume="$volume" | grep -q .; then
      log "Skipping unattached anonymous Docker volume $volume"
      continue
    fi

    local source=/var/lib/docker/volumes/$volume/_data
    local archive=$volume_dir/$volume-$STAMP.tar.gz
    if [[ ! -d "$source" ]]; then
      log "Skipping volume $volume; source path is missing"
      continue
    fi

    if ! tar --xattrs --acls --one-file-system --ignore-failed-read -C "$source" -czf "$archive.tmp" .; then
      fail "Failed to archive Docker volume $volume"
    fi
    mv -- "$archive.tmp" "$archive"
    write_sha256 "$archive"
  done
}

run_system_backup() {
  local system_dir=$WORK_DIR/system
  local manifest=$system_dir/manifest-$STAMP.txt
  local container_list=$system_dir/docker-containers-$STAMP.txt
  local compose_paths=$system_dir/docker-compose-paths-$STAMP.txt
  local container_inspect=$system_dir/docker-container-inspect-$STAMP.json
  local network_inspect=$system_dir/docker-network-inspect-$STAMP.json
  local volume_inspect=$system_dir/docker-volume-inspect-$STAMP.json
  local archive=$system_dir/hubert-system-config-$STAMP.tar.gz
  local items=()
  local containers=()
  local networks=()
  local volumes=()

  mkdir -p "$system_dir"

  log "Writing system manifest"
  {
    printf 'timestamp_utc=%s\n' "$STAMP"
    hostnamectl || true
    printf '\n[findmnt]\n'
    findmnt --real -o TARGET,SOURCE,FSTYPE,OPTIONS || true
    printf '\n[lsblk]\n'
    lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,UUID,MOUNTPOINTS,MODEL,SERIAL,TRAN || true
    printf '\n[df]\n'
    df -h || true
    printf '\n[docker-containers]\n'
    docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' || true
    printf '\n[docker-volumes]\n'
    docker volume ls || true
  } > "$manifest"

  log "Writing Docker restore manifests"
  docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' > "$container_list" || true
  docker ps -a --format '{{.Names}}' | while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    printf '%s|' "$container"
    docker inspect "$container" --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}|{{ index .Config.Labels "com.docker.compose.project.config_files" }}' || true
  done > "$compose_paths"

  mapfile -t containers < <(docker ps -aq)
  if ((${#containers[@]} > 0)); then
    docker inspect "${containers[@]}" > "$container_inspect"
  fi

  mapfile -t networks < <(docker network ls -q)
  if ((${#networks[@]} > 0)); then
    docker network inspect "${networks[@]}" > "$network_inspect"
  fi

  mapfile -t volumes < <(docker volume ls -q)
  if ((${#volumes[@]} > 0)); then
    docker volume inspect "${volumes[@]}" > "$volume_inspect"
  fi

  for item in opt/soil etc/fstab etc/systemd/system etc/docker; do
    if [[ -e "/$item" ]]; then
      items+=("$item")
    fi
  done

  if ((${#items[@]} > 0)); then
    log "Archiving system config"
    tar --xattrs --acls --one-file-system -C / -czf "$archive.tmp" "${items[@]}"
    mv -- "$archive.tmp" "$archive"
    write_sha256 "$archive"
  fi
}

rotate_old_backups() {
  log "Applying retention policy"
  find "$BACKUP_ROOT/daily" -mindepth 1 -maxdepth 1 -type d -mtime +"$DAILY_RETENTION_DAYS" -exec rm -rf -- {} +
  find "$BACKUP_ROOT/weekly" -mindepth 1 -maxdepth 1 -type d -mtime +"$WEEKLY_RETENTION_DAYS" -exec rm -rf -- {} +
  find "$BACKUP_ROOT/monthly" -mindepth 1 -maxdepth 1 -type d -mtime +"$MONTHLY_RETENTION_DAYS" -exec rm -rf -- {} +
  find "$PARTIAL_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +1 -exec rm -rf -- {} +
}

create_periodic_links() {
  local day_of_week day_of_month
  day_of_week=$(date -u +%u)
  day_of_month=$(date -u +%d)

  if [[ "$day_of_week" == "7" ]]; then
    log "Creating weekly hard-linked snapshot"
    cp -al "$DAILY_DIR" "$BACKUP_ROOT/weekly/$STAMP"
  fi

  if [[ "$day_of_month" == "01" ]]; then
    log "Creating monthly hard-linked snapshot"
    cp -al "$DAILY_DIR" "$BACKUP_ROOT/monthly/$STAMP"
  fi
}

main() {
  exec 9>"$LOCK_FILE"
  flock -n 9 || fail "Another backup run is already active"

  require_command docker
  require_command findmnt
  require_command sha256sum
  require_command tar
  require_command gzip
  require_command tee

  mountpoint -q "$BACKUP_MOUNT" || fail "$BACKUP_MOUNT is not mounted"
  docker inspect "$POSTGRES_CONTAINER" >/dev/null 2>&1 || fail "Postgres container $POSTGRES_CONTAINER is not available"

  mkdir -p "$BACKUP_ROOT/daily" "$BACKUP_ROOT/weekly" "$BACKUP_ROOT/monthly" "$BACKUP_ROOT/logs" "$PARTIAL_ROOT"
  chmod 700 "$BACKUP_ROOT"
  touch "$RUN_LOG"
  chmod 600 "$RUN_LOG"
  exec > >(tee -a "$RUN_LOG") 2>&1

  trap cleanup_partial ERR INT TERM
  rm -rf -- "$WORK_DIR"
  mkdir -p "$WORK_DIR"

  log "Starting Hubert backup $STAMP"
  run_postgres_backup
  run_docker_volume_backup
  run_system_backup
  write_restore_notes "$WORK_DIR"

  mv -- "$WORK_DIR" "$DAILY_DIR"
  trap - ERR INT TERM

  create_periodic_links
  rotate_old_backups

  log "Backup complete: $DAILY_DIR"
  log "Run log: $RUN_LOG"
}

main "$@"
