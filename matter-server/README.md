# Matter on hubert

Matter over Wi-Fi runs alongside Home Assistant Container. The same Matter Server
can later handle Matter over Thread through an OpenThread Border Router (OTBR).

## Runtime

- Compose: `/opt/soil/matter-server/compose.yaml` on `hubert`.
- Container: `matter-server`, pinned to Matter.js Server `1.5.5`.
- HA connection: `ws://127.0.0.1:5580/ws` (host networking on both containers).
- Matter/mDNS interface: `wlp1s0`; IPv6 must remain enabled.
- Named volume: `matter-server_matter-server-data`, mounted at `/data`.
- WebSocket/dashboard binds to localhost only; do not expose it through Caddy.
- If hubert changes network interfaces, update `PRIMARY_INTERFACE` to the active Matter/mDNS interface and restart Matter Server; it binds to the configured interface.
- No USB access, privileged mode or host Bluetooth is needed. Commissioning uses
  the phone's Bluetooth through the Home Assistant Companion app.

Self-managed Docker is documented upstream but is not Home Assistant's officially
supported Matter installation; HA OS with its Matter Server app is the supported
path. See [upstream Docker instructions](https://github.com/matter-js/matterjs-server/blob/main/docs/docker.md).

## Deploy and verify

Run on `hubert` after copying this compose file to the runtime path:

```sh
docker compose -f /opt/soil/matter-server/compose.yaml config --quiet
docker compose -f /opt/soil/matter-server/compose.yaml up -d --wait --wait-timeout 90
docker logs --tail 40 matter-server
ss -lnt sport = :5580
```

In Home Assistant, add the **Matter** integration with the local WebSocket URL
above. Do not request installation of the HA OS app/add-on. If Matter already
exists, inspect its current connection instead of creating a duplicate.

Verify container health, HA integration status and `start_listening` in the server
log. Restart only Matter Server and verify HA reconnects without restarting HA.
Do not use `docker compose down -v`: losing the volume loses the Matter fabric
credentials and can require pairing devices again.

## First Wi-Fi device

1. Connect the phone to the same local network as hubert and the Matter device.
   Avoid guest/client isolation; IPv6 multicast and mDNS must pass between them.
2. Open the Home Assistant Companion app with Bluetooth enabled.
3. Under **Settings > Devices & services > Matter**, choose **Add device**.
4. For a new device, scan its Matter QR code. For a device already paired to
   another controller, use that controller's sharing flow/code instead.
5. Verify availability, physical control and state updates in HA. Server health
   alone does not verify device commissioning or Wi-Fi multicast end-to-end.

## Backup and restore

`hubert-backup.timer` automatically includes the named volume in the daily
non-Postgres volume archives, and `/opt/soil` includes the compose configuration.
Matter fabric data contains secrets: never commit it or print its contents.

For a consistent manual backup before upgrades or migration, stop only
`matter-server`, archive the volume with ownership preserved, then start it again.
Validate the archive and checksum. Restore into an empty volume with Matter Server
stopped, preserve UID/GID `1000:1000`, and use the matching compose/image version.
Do not run two active servers with the same restored fabric.

Initial stopped-server backup, archive listing and checksums verified on
2026-11-09:
`/mnt/hubert-backup/hubert/manual/matter-setup-20261109T070219Z`.
This was not a full restore test. Daily backup inclusion is configured by the
existing volume enumeration; its first scheduled run remains to be verified.

Deployment verification on 2026-11-09: container healthy; HA Matter entry loaded;
HA automatically reconnected after a stopped-server backup/restart; the same
operational fabric advertisement persisted. No Matter devices paired yet, so
physical commissioning/control remains unverified. HA and Zigbee2MQTT were not
restarted.

## Thread later (not deployed)

- The user's **Sonoff Dongle-E** is not connected and is reserved for Thread.
- Confirm exact hardware and existing firmware before flashing compatible
  OpenThread RCP firmware. Do not use simultaneous Zigbee/Thread multiprotocol.
- Add a separate OTBR service using the Dongle-E's stable `/dev/serial/by-id/...`
  path; keep the existing Zigbee2MQTT-owned **Sonoff Dongle-P** untouched.
- Configure HA's OTBR/Thread integration and synchronize Thread credentials with
  the phone before commissioning a Matter-over-Thread device.
- Recheck IPv6 routes, forwarding/firewall and multicast for OTBR at that time.
  Hubert uses systemd-networkd, which handles router advertisements itself; do
  not infer broken IPv6 from kernel `accept_ra=0` or blindly change sysctls.
- Matter Server and its existing fabric/volume stay in place.
