# Hubert monitoring

## Beszel pilot

- Hub: `http://192.168.100.67:8090`, pinned to
  `henrygd/beszel:0.21.2`. The first administrator was created while the
  service was loopback-only; it is now available on the home network.
- Agent: `henrygd/beszel-agent:0.21.2`, run in the `beszel-agent` Compose
  profile with Hub-generated `BESZEL_KEY` and `BESZEL_TOKEN`.
- The agent uses a local Unix socket shared with the Hub and mounts Docker's
  socket read-only to report per-container CPU, memory and network metrics.
- Add the system in the Hub using `/beszel_socket/beszel.sock`. Keep generated
  credentials in `/opt/soil/monitoring/.env`; never commit or print them.
- Netdata remains available at `http://192.168.100.67:19999` during the pilot.
  Compare load and per-container metrics before deciding whether to remove it.
- Named volumes are `monitoring_beszel-data`, `monitoring_beszel-agent-data`,
  and `monitoring_beszel-socket`. Preserve them on redeploy; never use `down -v`.

Beszel documentation: [Getting Started](https://beszel.dev/guide/getting-started),
[Security](https://beszel.dev/guide/security), and
[Agent Installation](https://beszel.dev/guide/agent-installation).

## Deploy the Beszel Hub pilot

Target only `beszel-hub` and, after its credentials are configured,
`beszel-agent` in Compose project `monitoring` on `fro@192.168.100.67`. Preserve
Netdata and all existing named volumes.

1. Back up `/opt/soil/monitoring/compose.yaml` to a mode-`0700` directory under
   `/opt/soil/.backups/beszel-pilot-<UTC>/`.
2. Transfer and verify the agreed `infra/monitoring/compose.yaml` artifact hash;
   run `docker compose -p monitoring -f /opt/soil/monitoring/compose.yaml
   config --quiet` before applying it.
3. Pull only the pinned Beszel Hub image, then recreate only
   `docker compose -p monitoring -f /opt/soil/monitoring/compose.yaml up -d
   --no-deps --pull never beszel-hub`.
4. Verify the Hub's image and `.67:8090` binding. Confirm Netdata stayed
   healthy with the same container start time and volumes.
5. Only after the admin and `Hubert` system exist, write the generated agent
   credentials to `/opt/soil/monitoring/.env` with mode `0600`; never print or
   commit the file. Pull only the pinned agent image declared in Compose, then
   start only the agent with
   `docker compose --profile beszel-agent -p monitoring -f
   /opt/soil/monitoring/compose.yaml up -d --no-deps --pull never beszel-agent`.
   Verify `Hubert` becomes online and reports host and container metrics.

Do not use `down -v` or start the agent before credentials are configured. If
the Beszel data volume is ever replaced, bind the Hub to
loopback first and create the first administrator through the local SSH tunnel;
never expose the initial account-creation page to the LAN. The current admin
account was created under that loopback-only setup.
