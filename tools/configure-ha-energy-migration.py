"""Configure Hubert's energy cutover without printing credentials. Run with sudo."""
import datetime
import json
import os
import pathlib
import subprocess
import sys

OLD_ID = "9369fb97-310f-4105-92a2-5a285f14ab00"
NEW_ID = "home_assistant:energy_main"

def inspect(name):
    return json.loads(subprocess.check_output(["docker", "inspect", name]))[0]

def update_env(container, values):
    directory = pathlib.Path(inspect(container)["Config"]["Labels"]["com.docker.compose.project.working_dir"])
    if not str(directory).startswith("/opt/soil/"):
        raise RuntimeError("Unexpected compose directory")
    path = directory / ".env"
    lines = path.read_text().splitlines() if path.exists() else []
    if path.exists():
        backup = path.with_name(".env.before-ha-energy-migration")
        if not backup.exists():
            backup.write_bytes(path.read_bytes())
            os.chmod(backup, 0o600)
    lines = [line for line in lines if line.partition("=")[0] not in values]
    lines.extend(f"{key}='{value}'" for key, value in values.items())
    path.write_text("\n".join(lines) + "\n")
    os.chmod(path, 0o600)
    print("Configured", directory.name, ", keys:", ", ".join(values))

if sys.argv[1] == "observer":
    env = dict(item.split("=", 1) for item in inspect("soil-dashboard")["Config"]["Env"])
    config = pathlib.Path(next(m["Source"] for m in inspect("home-assistant")["Mounts"] if m["Destination"] == "/config"))
    entities = json.loads((config / ".storage/core.entity_registry").read_text())["data"]["entities"]
    devices = json.loads((config / ".storage/core.device_registry").read_text())["data"]["devices"]
    areas = json.loads((config / ".storage/core.area_registry").read_text())["data"]["areas"]
    entity = next(e for e in entities if e["entity_id"] == "sensor.electricity_meter_energy_import_total")
    device = next(d for d in devices if d["id"] == entity["device_id"])
    area_id = entity.get("area_id") or device.get("area_id")
    area = next((a for a in areas if a["id"] == area_id), {"id": "home", "name": "Hjem"})
    update_env("home-assistant-wingman-ingest-service", {
        "HA_ENERGY_ENABLED": "true", "HOME_ASSISTANT_URL": env["HOME_ASSISTANT_URL"],
        "HOME_ASSISTANT_TOKEN": env["HOME_ASSISTANT_TOKEN"],
        "HA_ENERGY_ZONE_ID": area["id"], "HA_ENERGY_ZONE_NAME": area["name"],
    })
    print("Energy meter HA area:", area["name"])
elif sys.argv[1] == "cutover":
    # Explicit timestamp chosen after HA ingest is verified; immutable after activation.
    timestamp = sys.argv[2]
    datetime.datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    runtime = dict(item.split("=", 1) for item in inspect("homey-wingman-ingest-service")["Config"]["Env"])
    existing = json.loads(runtime.get("ENERGY_METER_MIGRATIONS_JSON", "[]"))
    desired = [{"previousId": OLD_ID, "currentId": NEW_ID, "switchedAt": timestamp}]
    if existing and existing != desired:
        raise RuntimeError("An energy cutover is already active; preserve it on redeploy")
    update_env("homey-wingman-ingest-service", {"ENERGY_METER_MIGRATIONS_JSON": json.dumps([
        {"previousId": OLD_ID, "currentId": NEW_ID, "switchedAt": timestamp}
    ], separators=(",", ":"))})
    update_env("soil-dashboard", {"ENERGY_MAIN_DEVICE_ID": NEW_ID, "ENERGY_USAGE_DEVICE_ID": OLD_ID})
    print("Cutover timestamp:", timestamp)
else:
    raise RuntimeError("Use observer or cutover <UTC timestamp>")
