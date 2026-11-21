"""Provision one UI-owned fridge monitor; run inside HA with token JSON on stdin.

Default is read-only. Never reset existing helpers or overwrite subsequent UI edits.
Assets are reference data, not an authoritative copy of live HA configuration.
"""
import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

PREFIX = "koleskab_vaerksted"
SOURCE = "sensor.0xf044d3fffe1acc2b_temperature"
TITLE = "Køleskab Værksted"
URL_PATH = "koleskab-vaerksted"
AUTOMATION_ID = "koleskab_vaerksted_temperaturalarm"
BLUEPRINT = "wingman/cold-storage-temperature-alarm.yaml"
NOTIFY = "notify.manuel_vanding_mobilapps"
ENTITIES = {
    "average_sensor": f"sensor.{PREFIX}_gennemsnit_24t",
    "temperature_trend": f"binary_sensor.{PREFIX}_temperatur_stiger",
    "average_trend": f"binary_sensor.{PREFIX}_gennemsnit_stiger",
    "alarm_latch": f"input_boolean.{PREFIX}_temperaturalarm",
    "started_at": f"input_datetime.{PREFIX}_overvaagning_startet",
    "threshold": f"input_number.{PREFIX}_alarmgraense",
    "optimal": f"input_number.{PREFIX}_optimal_temperatur",
    "source_timeout": f"input_number.{PREFIX}_datatimeout",
}
SIMPLE = {
    "alarm_latch": {"name": "temperaturalarm", "icon": "mdi:thermometer-alert"},
    "started_at": {"name": "overvågning startet", "has_date": True, "has_time": True},
    "threshold": {"name": "alarmgrænse", "min": -40, "max": 30, "step": 0.1,
                  "unit_of_measurement": "°C", "mode": "box"},
    "optimal": {"name": "optimal temperatur", "min": -40, "max": 30, "step": 0.1,
                "unit_of_measurement": "°C", "mode": "box"},
    "source_timeout": {"name": "datatimeout", "min": 10, "max": 1440, "step": 5,
                       "unit_of_measurement": "min", "mode": "box"},
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def automation():
    """Return the first appliance's blueprint instance, not a live overwrite."""
    inputs = {key: value for key, value in ENTITIES.items() if key != "optimal"}
    inputs.update(temperature_sensor=SOURCE, notify_target=NOTIFY, appliance_name=TITLE)
    return {"id": AUTOMATION_ID, "alias": f"{TITLE} – temperaturalarm",
            "description": "Alarm ved stigende døgnmiddel og stigende temperatur.",
            "use_blueprint": {"path": BLUEPRINT, "input": inputs}}


class Api:
    def __init__(self, session, token):
        self.session, self.token, self.ws, self.sequence = session, token, None, 0

    async def connect(self):
        self.ws = await self.session.ws_connect("http://127.0.0.1:8123/api/websocket")
        await self.ws.receive_json()
        await self.ws.send_json({"type": "auth", "access_token": self.token})
        if (await self.ws.receive_json()).get("type") != "auth_ok":
            raise RuntimeError("HA authentication failed")

    async def call(self, command, **fields):
        self.sequence += 1
        await self.ws.send_json({"id": self.sequence, "type": command, **fields})
        while True:
            response = await self.ws.receive_json()
            if response.get("id") != self.sequence:
                continue
            if not response.get("success"):
                raise RuntimeError(f"{command}: {response.get('error')}")
            return response.get("result")

    async def rest(self, path, data=None, method=None):
        async with self.session.request(
            method or ("GET" if data is None else "POST"),
            "http://127.0.0.1:8123" + path,
            headers={"Authorization": "Bearer " + self.token}, json=data,
        ) as response:
            if not response.ok:
                raise RuntimeError(f"{path}: HTTP {response.status}: {await response.text()}")
            return await response.json()

    async def service(self, domain, action, **data):
        return await self.rest(f"/api/services/{domain}/{action}", data)

    async def flow(self, handler, steps):
        result = await self.rest("/api/config/config_entries/flow",
                                 {"handler": handler, "show_advanced_options": True})
        for expected_step, fields in steps:
            if result.get("type") != "form" or result.get("step_id") != expected_step:
                raise RuntimeError(f"Unexpected {handler} flow step: {result.get('step_id')}")
            result = await self.rest("/api/config/config_entries/flow/" + result["flow_id"], fields)
            if result.get("errors"):
                raise RuntimeError(f"{handler} config flow: {result['errors']}")
        if result.get("type") != "create_entry":
            raise RuntimeError(f"{handler} flow did not create an entry: {result.get('type')}")
        return result["result"]["entry_id"]


async def wait_entity(api, entity_id):
    for _ in range(30):
        states = {s["entity_id"]: s for s in await api.rest("/api/states")}
        if entity_id in states:
            return states[entity_id]
        await asyncio.sleep(0.5)
    raise RuntimeError(f"Entity did not appear: {entity_id}")


def save_manifest(path, manifest):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(temp, 0o600)
    temp.replace(path)


async def create_config_helper(api, handler, key, steps, manifest, manifest_path):
    entry_id = await api.flow(handler, steps)
    manifest["entries"][key] = entry_id
    save_manifest(manifest_path, manifest)
    for _ in range(30):
        registry = await api.call("config/entity_registry/list")
        candidates = [e for e in registry if e.get("config_entry_id") == entry_id]
        if len(candidates) == 1:
            entity = candidates[0]
            await api.call("config/entity_registry/update", entity_id=entity["entity_id"],
                           new_entity_id=ENTITIES[key], name={
                               "average_sensor": "gennemsnit 24t",
                               "temperature_trend": "Temperaturen stiger",
                               "average_trend": "Gennemsnittet stiger",
                           }[key])
            break
        await asyncio.sleep(0.5)
    else:
        raise RuntimeError(f"Could not identify new {handler} entity")
    await wait_entity(api, ENTITIES[key])
    manifest["entities"][key] = ENTITIES[key]
    save_manifest(manifest_path, manifest)
    return entry_id


async def provision(api, root, assets, apply):
    states = {s["entity_id"]: s for s in await api.rest("/api/states")}
    registry = await api.call("config/entity_registry/list")
    if SOURCE not in states or states[SOURCE]["attributes"].get("device_class") != "temperature":
        raise RuntimeError("Expected physical temperature sensor not found")
    if NOTIFY not in states:
        raise RuntimeError("Shared UI notification helper is missing")
    manifest_path = root / ".cold-storage-provisioning.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {
        "version": 1, "source": SOURCE, "entities": {}, "entries": {}, "initialized": [],
    }
    if manifest.get("source") != SOURCE or manifest.get("version") != 1:
        raise RuntimeError("Unexpected provisioning manifest; no changes")
    if any(key not in manifest["entities"] for key in manifest["entries"]):
        raise RuntimeError("Interrupted config-entry creation; inspect before retrying")
    if any(key not in manifest.get("initialized", []) for key in manifest["entities"]):
        raise RuntimeError("Interrupted helper initialization; no defaults are reapplied")
    if manifest.get("dashboard") and not manifest.get("dashboard_ready"):
        raise RuntimeError("Interrupted dashboard creation; inspect before retrying")
    known = {e["entity_id"] for e in registry} | set(states)
    for key, entity_id in ENTITIES.items():
        if key in manifest["entities"]:
            if manifest["entities"][key] != entity_id or entity_id not in known:
                raise RuntimeError(f"Previously provisioned helper missing: {entity_id}; not recreated")
        elif entity_id in known:
            raise RuntimeError(f"Unowned entity collision: {entity_id}; not adopted")
    dashboards = await api.call("lovelace/dashboards/list")
    existing_dashboard = next((d for d in dashboards if d["url_path"] == URL_PATH), None)
    if existing_dashboard and not manifest.get("dashboard"):
        raise RuntimeError("Existing dashboard is not owned by this installer")
    auto_states = [s for s in states.values() if s["entity_id"].startswith("automation.")
                   and str(s.get("attributes", {}).get("id")) == AUTOMATION_ID]
    if auto_states and not manifest.get("automation"):
        raise RuntimeError("Unowned automation collision")
    if manifest.get("automation") and not auto_states:
        raise RuntimeError("Previously installed automation missing; not recreated")
    if manifest.get("dashboard") and not existing_dashboard:
        raise RuntimeError("Previously installed dashboard missing; not recreated")
    target_blueprint = root / "blueprints" / "automation" / BLUEPRINT
    source_blueprint = assets / "home-assistant/blueprints/automation" / BLUEPRINT
    if target_blueprint.exists() and digest(target_blueprint) != digest(source_blueprint):
        raise RuntimeError("Existing blueprint differs; explicit reviewed upgrade required")
    print(json.dumps({"mode": "apply" if apply else "read-only", "source": SOURCE,
                      "existing_helpers": len(manifest["entities"]),
                      "new_helpers": len(ENTITIES) - len(manifest["entities"]),
                      "dashboard": URL_PATH}, ensure_ascii=False))
    if not apply:
        return
    if (len(manifest["entities"]) == len(ENTITIES)
            and manifest.get("automation") and manifest.get("dashboard_ready")):
        print("Already provisioned; live UI configuration and helper values preserved.")
        return
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = root / "backups" / ("cold-storage-" + stamp)
    backup.mkdir(parents=True, mode=0o700, exist_ok=True)
    # Config entries can contain secrets: keep the backup private, never print contents.
    for relative in ["automations.yaml", ".storage/core.config_entries",
                     ".storage/core.entity_registry", ".storage/input_boolean",
                     ".storage/input_number", ".storage/input_datetime",
                     ".storage/lovelace_dashboards", ".cold-storage-provisioning.json"]:
        source = root / relative
        if source.exists():
            target = backup / relative.replace("/", "__")
            shutil.copy2(source, target)
            os.chmod(target, 0o600)
    print("Backup:", backup)
    save_manifest(manifest_path, manifest)
    target_blueprint.parent.mkdir(parents=True, exist_ok=True)
    if not target_blueprint.exists():
        shutil.copy2(source_blueprint, target_blueprint)
    for key, spec in SIMPLE.items():
        if key in manifest["entities"]:
            continue
        entity_id = ENTITIES[key]
        domain, identifier = entity_id.split(".", 1)
        data = {k: v for k, v in spec.items() if k != "name"}
        result = await api.call(domain + "/create", name=identifier, **data)
        if result["id"] != identifier:
            raise RuntimeError(f"Unexpected new helper id for {key}; stop without resetting it")
        # Record ownership immediately; a failed later step must not recreate this helper.
        manifest["entities"][key] = entity_id
        save_manifest(manifest_path, manifest)
        await api.call(domain + "/update", **{domain + "_id": identifier},
                       name=TITLE + " " + spec["name"], **data)
        await wait_entity(api, entity_id)
        if key in ("threshold", "optimal", "source_timeout"):
            await api.service("input_number", "set_value", entity_id=entity_id,
                              value={"threshold": 7, "optimal": 5, "source_timeout": 120}[key])
        elif key == "started_at":
            await api.service("input_datetime", "set_datetime", entity_id=entity_id,
                              timestamp=datetime.now(timezone.utc).timestamp())
        manifest["initialized"].append(key)
        save_manifest(manifest_path, manifest)
    if "average_sensor" not in manifest["entities"]:
        await create_config_helper(api, "statistics", "average_sensor", [
            ("user", {"name": TITLE + " gennemsnit 24t", "entity_id": SOURCE}),
            ("state_characteristic", {"state_characteristic": "average_step"}),
            ("options", {"max_age": {"hours": 24, "minutes": 0, "seconds": 0},
                         "keep_last_sample": False, "precision": 3}),
        ], manifest, manifest_path)
        manifest["initialized"].append("average_sensor")
        save_manifest(manifest_path, manifest)
    for key, source in [("temperature_trend", SOURCE),
                        ("average_trend", ENTITIES["average_sensor"])]:
        if key in manifest["entities"]:
            continue
        entry_id = await create_config_helper(api, "trend", key, [
            ("user", {"name": ("Temperaturen stiger" if key == "temperature_trend"
                               else "Gennemsnittet stiger"), "entity_id": source}),
            ("settings", {"invert": False}),
        ], manifest, manifest_path)
        flow = await api.rest("/api/config/config_entries/options/flow", {"handler": entry_id})
        result = await api.rest("/api/config/config_entries/options/flow/" + flow["flow_id"], {
            "invert": False, "max_samples": 10000, "min_samples": 2,
            "min_gradient": 1e-8, "sample_duration": 3600,
        })
        if result.get("type") != "create_entry":
            raise RuntimeError(f"Trend options were not saved: {result.get('errors')}")
        manifest["initialized"].append(key)
        save_manifest(manifest_path, manifest)
    if not manifest.get("automation"):
        # This HA version reloads this automation ID only, preserving other running automations.
        await api.rest("/api/config/automation/config/" + AUTOMATION_ID, automation())
        manifest["automation"] = AUTOMATION_ID
        save_manifest(manifest_path, manifest)
    if not existing_dashboard:
        dashboard = await api.call("lovelace/dashboards/create", url_path=URL_PATH,
                                   title=TITLE, icon="mdi:fridge", show_in_sidebar=True,
                                   require_admin=False, mode="storage")
        manifest["dashboard"] = dashboard["id"]
        save_manifest(manifest_path, manifest)
        config = json.loads((assets / "home-assistant/dashboards/cold-storage.json").read_text(encoding="utf-8"))
        await api.call("lovelace/config/save", url_path=URL_PATH, config=config)
        manifest["dashboard_ready"] = True
        save_manifest(manifest_path, manifest)
    # Existing UI dashboards, automations and helper settings are deliberately left unchanged.
    actual_auto = None
    for _ in range(30):
        latest = {s["entity_id"]: s for s in await api.rest("/api/states")}
        actual_auto = next((s for s in latest.values()
                            if str(s.get("attributes", {}).get("id")) == AUTOMATION_ID), None)
        if actual_auto and actual_auto["state"] in ("on", "off"):
            break
        await asyncio.sleep(0.5)
    else:
        raise RuntimeError("New automation did not load")
    print(json.dumps({"automation": actual_auto["entity_id"], "state": actual_auto["state"],
                      "helpers_present": all(e in latest for e in ENTITIES.values()),
                      "dashboard": URL_PATH, "blueprint_sha256": digest(target_blueprint)},
                     ensure_ascii=False))


async def main():
    import aiohttp

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--root", type=Path, default=Path("/config"))
    parser.add_argument("--assets", type=Path, required=True)
    args = parser.parse_args()
    token = json.load(sys.stdin)["token"]
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=90)) as session:
        api = Api(session, token)
        await api.connect()
        await provision(api, args.root, args.assets, args.apply)


if __name__ == "__main__":
    asyncio.run(main())
