#!/usr/bin/env bash
set -Eeuo pipefail

INTERFACE=${INTERFACE:-wlp1s0}
GATEWAY=${GATEWAY:-192.168.100.1}
PING_COUNT=${PING_COUNT:-3}
PING_TIMEOUT_SECONDS=${PING_TIMEOUT_SECONDS:-2}
LOG_TAG=${LOG_TAG:-hubert-wifi-watchdog}

log() {
  logger -t "$LOG_TAG" -- "$*"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

can_reach_gateway() {
  ping -I "$INTERFACE" -c "$PING_COUNT" -W "$PING_TIMEOUT_SECONDS" "$GATEWAY" >/dev/null 2>&1
}

main() {
  if can_reach_gateway; then
    exit 0
  fi

  log "Gateway $GATEWAY is unreachable on $INTERFACE; attempting WiFi reconnect"
  wpa_cli -i "$INTERFACE" status 2>&1 | logger -t "$LOG_TAG" || true
  wpa_cli -i "$INTERFACE" reconnect >/dev/null 2>&1 || true
  sleep 10
  networkctl renew "$INTERFACE" >/dev/null 2>&1 || true

  if can_reach_gateway; then
    log "Gateway $GATEWAY is reachable after wpa_cli reconnect"
    exit 0
  fi

  log "Reconnect did not recover $INTERFACE; restarting netplan WPA service"
  systemctl restart "netplan-wpa-$INTERFACE.service" >/dev/null 2>&1 || systemctl restart wpa_supplicant.service >/dev/null 2>&1 || true
  sleep 15
  networkctl renew "$INTERFACE" >/dev/null 2>&1 || true

  if can_reach_gateway; then
    log "Gateway $GATEWAY is reachable after WPA service restart"
    exit 0
  fi

  log "Gateway $GATEWAY is still unreachable after WiFi recovery attempts"
  exit 1
}

main "$@"
