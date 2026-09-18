#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_ROOT=${BACKUP_ROOT:-/mnt/hubert-backup/hubert}
TEST_CONTAINER=${TEST_CONTAINER:-homey-wingman-restore-test}
TEST_DB=${TEST_DB:-homey_wingman_restore}
TEST_IMAGE=${TEST_IMAGE:-timescale/timescaledb:2.28.2-pg16}
KEEP_RESTORE_TEST=${KEEP_RESTORE_TEST:-0}

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

find_latest_dump() {
  find "$BACKUP_ROOT/daily" -path '*/postgres/*.dump' -type f -printf '%T@ %p\n' \
    | sort -n \
    | tail -n 1 \
    | cut -d' ' -f2-
}

cleanup() {
  if [[ "$KEEP_RESTORE_TEST" != "1" ]]; then
    docker rm -fv "$TEST_CONTAINER" >/dev/null 2>&1 || true
  fi
}

wait_for_postgres() {
  local saw_init_complete=0

  for _ in {1..120}; do
    if docker logs "$TEST_CONTAINER" 2>&1 | grep -q 'PostgreSQL init process complete'; then
      saw_init_complete=1
      break
    fi
    sleep 1
  done

  if [[ "$saw_init_complete" != "1" ]]; then
    log "WARNING: container init-complete marker was not observed; waiting on pg_isready anyway"
  fi

  for _ in {1..60}; do
    if docker exec "$TEST_CONTAINER" pg_isready -U postgres -d "$TEST_DB" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  docker exec "$TEST_CONTAINER" pg_isready -U postgres -d "$TEST_DB" >/dev/null
}

main() {
  local dump_file=${1:-}

  if [[ -z "$dump_file" ]]; then
    dump_file=$(find_latest_dump)
  fi

  [[ -n "$dump_file" ]] || { log "ERROR: No dump file found"; exit 1; }
  [[ -f "$dump_file" ]] || { log "ERROR: Dump file does not exist: $dump_file"; exit 1; }

  trap cleanup EXIT
  docker rm -f "$TEST_CONTAINER" >/dev/null 2>&1 || true

  log "Starting temporary restore container"
  docker run -d \
    --name "$TEST_CONTAINER" \
    -e POSTGRES_PASSWORD=restore-test-only \
    -e POSTGRES_DB="$TEST_DB" \
    "$TEST_IMAGE" \
    postgres -c shared_preload_libraries=timescaledb >/dev/null

  wait_for_postgres

  log "Preparing TimescaleDB restore mode"
  docker exec "$TEST_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();" >/dev/null

  log "Restoring dump into temporary database"
  cat "$dump_file" | docker exec -i "$TEST_CONTAINER" pg_restore -U postgres -d "$TEST_DB" --no-owner --no-privileges

  log "Leaving TimescaleDB restore mode"
  docker exec "$TEST_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 -c "SELECT timescaledb_post_restore();" >/dev/null

  log "Restore verification summary"
  docker exec "$TEST_CONTAINER" psql -U postgres -d "$TEST_DB" -Atc "select 'database_size|' || pg_size_pretty(pg_database_size(current_database()));"
  docker exec "$TEST_CONTAINER" psql -U postgres -d "$TEST_DB" -Atc "select 'extensions|' || string_agg(extname, ',' order by extname) from pg_extension;"
  docker exec "$TEST_CONTAINER" psql -U postgres -d "$TEST_DB" -Atc "select 'ingest_event_count|' || count(*) from ingest_event;"
  docker exec "$TEST_CONTAINER" psql -U postgres -d "$TEST_DB" -Atc "select 'ingest_event_range|' || min(event_time) || '|' || max(event_time) from ingest_event;"

  log "Restore test passed for $dump_file"
}

main "$@"
