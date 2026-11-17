"""Migrate only the legacy watering packages to HA's UI, preserving IDs/values.

Run inside the HA container. Default is read-only; --apply changes configuration.
Pass {"token": "..."} on stdin. Never logs or stores the token.
"""
import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
import json
import math
import re
from pathlib import Path
import sys

import aiohttp
import yaml

DOMAINS = ("input_number", "input_boolean", "input_select", "input_datetime")
PACKAGES = (
    "gardsplads_soil_sensors.yaml", "manual_watering_notifications.yaml",
    "terrasse_potter.yaml", "terrasse_soil_sensors.yaml", "watering_capacity.yaml",
    "wingman_watering_vanding_terasse_potter.yaml",
)
CAPACITY_SCRIPT = "ha_watering_capacity_acquire"
MANUAL = "wingman/manual-soil-moisture-alarm.yaml"
AUTO = "wingman/soil-moisture-alarm.yaml"
WATERING = "wingman/labelled-pot-watering.yaml"


def value_payload(domain, state):
    """Return an exact native-service value without interpreting offline as zero."""
    value = state["state"]
    if value in ("unknown", "unavailable"):
        raise ValueError(f"Cannot preserve unavailable helper {state['entity_id']}")
    if domain == "input_number":
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("Non-finite helper value")
        return "set_value", {"value": number}
    if domain == "input_boolean":
        if value not in ("on", "off"):
            raise ValueError("Invalid boolean helper state")
        return "turn_on" if value == "on" else "turn_off", {}
    if domain == "input_select":
        if value not in state["attributes"]["options"]:
            raise ValueError("Invalid select helper state")
        return "select_option", {"option": value}
    attributes = state["attributes"]
    field = "datetime" if attributes["has_date"] and attributes["has_time"] else "date" if attributes["has_date"] else "time"
    return "set_datetime", {field: value}


def helper_fields(domain, config, state):
    """Omit startup overrides, preserving the live helper's display/configuration."""
    allowed = {
        "input_number": ("min", "max", "step", "mode", "unit_of_measurement", "icon"),
        "input_boolean": ("icon",), "input_select": ("options", "icon"),
        "input_datetime": ("has_date", "has_time", "icon"),
    }[domain]
    return {key: state["attributes"].get(key, config[key]) if key in config else state["attributes"][key]
            for key in allowed if key in config or key in state["attributes"]}


def plan_packages(root, states, registry):
    helpers, sources, scripts = [], {}, {}
    for name in PACKAGES:
        path = root / "packages" / name
        if not path.exists():
            continue
        source = path.read_text(encoding="utf-8")
        package = yaml.safe_load(source) or {}
        if set(package) - {*DOMAINS, "script"}:
            raise ValueError(f"Unexpected content in {name}; no package is removed")
        if set(package.get("script", {})) - {CAPACITY_SCRIPT}:
            raise ValueError(f"Unrelated script in {name}; no package is removed")
        sources[name] = source
        scripts.update(package.get("script", {}))
        for domain in DOMAINS:
            for key, config in package.get(domain, {}).items():
                entity_id = f"{domain}.{key}"
                if entity_id not in states or states[entity_id]["attributes"].get("editable") is not False:
                    raise ValueError(f"{entity_id} is not a loaded YAML helper; investigate before migrating")
                state = states[entity_id]
                value_payload(domain, state)
                helpers.append({"domain": domain, "key": key, "entity_id": entity_id,
                                "config": config, "state": state, "registry": registry.get(entity_id)})
    if len({h["entity_id"] for h in helpers}) != len(helpers):
        raise ValueError("Duplicate YAML helper definitions")
    return helpers, sources, scripts


def category_targets(automations, helpers):
    """Categorize actual references, not friendly-name or room guesses."""
    targets = {h["entity_id"]: ("helpers", "Vandingskredse") for h in helpers}
    automation_categories = {}
    for automation in automations:
        blueprint = automation.get("use_blueprint", {})
        path = blueprint.get("path")
        if path not in (MANUAL, AUTO, WATERING) and automation.get("id") != "manuel_vanding_push_notifikation":
            continue
        manual = path == MANUAL or automation.get("id") == "manuel_vanding_push_notifikation"
        name = "Manuel jordfugt" if manual else "Vandingskredse"
        automation_categories[str(automation["id"])] = name
        inputs = blueprint.get("input", {})
        for field in ("threshold_helper", "water_alarm", "threshold", "cycle_duration", "pause_duration",
                      "maximum_cycles", "cycle_number", "watering_error", "watering_forbidden", "lifecycle_status", "capacity_busy"):
            entity_id = inputs.get(field)
            if isinstance(entity_id, str) and entity_id.split(".")[0] in DOMAINS:
                targets[entity_id] = ("helpers", name)
        if path == MANUAL:
            key = inputs.get("notification_key") or inputs["moisture_sensor"].replace(".", "_")
            targets[f"input_datetime.manual_soil_alarm_{key}_last_push"] = ("helpers", name)
    return targets, automation_categories


class Api:
    def __init__(self, session, token):
        self.session, self.token, self.ws, self.next_id = session, token, None, 0

    async def connect(self):
        self.ws = await self.session.ws_connect("http://127.0.0.1:8123/api/websocket")
        await self.ws.receive_json()
        await self.ws.send_json({"type": "auth", "access_token": self.token})
        if (await self.ws.receive_json())["type"] != "auth_ok":
            raise RuntimeError("HA authentication failed")

    async def call(self, command, **fields):
        self.next_id += 1
        await self.ws.send_json({"id": self.next_id, "type": command, **fields})
        while True:
            result = await self.ws.receive_json()
            if result.get("id") == self.next_id:
                if not result.get("success"):
                    raise RuntimeError(f"{command}: {result.get('error')}")
                return result.get("result")

    async def rest(self, path, data=None):
        async with self.session.request("GET" if data is None else "POST", "http://127.0.0.1:8123" + path, json=data) as response:
            if not response.ok:
                raise RuntimeError(f"HA {path} returned {response.status}: {await response.text()}")
            return await response.json()

    async def service(self, domain, action, **data):
        return await self.rest(f"/api/services/{domain}/{action}", data)

    async def delete_automation(self, identifier):
        path = "/api/config/automation/config/" + identifier
        async with self.session.delete("http://127.0.0.1:8123" + path) as response:
            if not response.ok:
                raise RuntimeError(f"HA automation deletion failed: {response.status}")
            await response.read()


async def assign_category(api, entity_id, scope, name, cache):
    entity = await api.call("config/entity_registry/get", entity_id=entity_id)
    if entity.get("categories", {}).get(scope):
        return
    if (scope, name) not in cache:
        entries = await api.call("config/category_registry/list", scope=scope)
        entry = next((e for e in entries if e["name"].casefold() == name.casefold()), None)
        if entry is None:
            entry = await api.call("config/category_registry/create", scope=scope, name=name, icon="mdi:watering-can")
        cache[scope, name] = entry["category_id"]
    await api.call("config/entity_registry/update", entity_id=entity_id, categories={scope: cache[scope, name]})


async def obsolete_control_cards(root, api, legacy_ids, actor_references, states, registry):
    """Remove only obsolete legacy control cards, not physical devices or history graphs."""
    manifest = root / ".storage/lovelace_dashboards"
    if not manifest.exists():
        return []
    changes = []
    for dashboard in json.loads(manifest.read_text())["data"]["items"]:
        if dashboard.get("mode") != "storage":
            continue
        old = await api.call("lovelace/config", url_path=dashboard["url_path"])
        new = json.loads(json.dumps(old))
        removed = 0
        for view in new.get("views", []):
            for section in view.get("sections", []):
                retained = []
                for card in section.get("cards", []):
                    if card.get("type") != "entities" or card.get("title") != "Vanding af terrassepotter" or set(card) - {"type", "title", "entities", "show_header_toggle"}:
                        retained.append(card)
                        continue
                    references = [entry if isinstance(entry, str) else entry.get("entity") for entry in card.get("entities", [])]
                    unused = lambda eid: isinstance(eid, str) and ((eid in legacy_ids and eid not in actor_references) or
                              (eid.startswith("automation.") and eid not in actor_references and (eid not in states or states[eid]["attributes"].get("restored"))))
                    if references and any(eid in legacy_ids for eid in references) and all(unused(eid) for eid in references):
                        removed += 1
                    else:
                        retained.append(card)
                if "cards" in section:
                    section["cards"] = retained
        if removed:
            changes.append({"url_path": dashboard["url_path"], "storage_name": "lovelace." + dashboard["id"], "old": old, "new": new, "removed_cards": removed})
    return changes


def obsolete_registry_entries(states, registry, reference_text):
    retired_ids = {"myggeplante_soil_moisture_alarm", "garage_vaegpotte_soil_moisture_alarm", "terrasse_potter_labelled_watering", "terrasse_potter_vanding"}
    result = []
    for entity_id, entry in registry.items():
        state = states.get(entity_id)
        if not state or not state["attributes"].get("restored") or entity_id in reference_text:
            continue
        identifier = entry.get("unique_id") or state["attributes"].get("id", "")
        owned = entity_id == "input_boolean.efeu_water_alarm" or (entity_id.startswith("automation.") and (identifier in retired_ids or identifier.startswith("wingman_vanding_terasse_potter_")))
        if owned:
            result.append({"entity_id": entity_id, "registry": entry, "state": state})
    return result


async def migrate(root, api, apply, cleanup_unused=False, inventory_ieees=None, protected_helpers=()):
    if cleanup_unused and inventory_ieees is None:
        raise ValueError("Live Zigbee2MQTT inventory is required before retiring missing-sensor alarms")
    states = {s["entity_id"]: s for s in await api.rest("/api/states")}
    registry = {e["entity_id"]: e for e in await api.call("config/entity_registry/list")}
    helpers, sources, scripts = plan_packages(root, states, registry)
    automation_bytes = (root / "automations.yaml").read_bytes()
    automations = yaml.safe_load(automation_bytes) or []
    obsolete_automations = []
    if cleanup_unused:
        for automation in automations:
            blueprint = automation.get("use_blueprint", {})
            sensor = blueprint.get("input", {}).get("moisture_sensor")
            identity = re.fullmatch(r"sensor\.(0x[0-9a-f]{16})_soil_moisture", sensor or "")
            ieee = identity.group(1) if identity else None
            mapped = any(e.get("unique_id") == f"{ieee}_soil_moisture_zigbee2mqtt" for e in registry.values()) if ieee else True
            if blueprint.get("path") == AUTO and ieee and ieee not in inventory_ieees and not mapped and sensor not in registry and (sensor not in states or states[sensor]["attributes"].get("restored")):
                obsolete_automations.append(automation)
    remaining_automations = [a for a in automations if a not in obsolete_automations]
    unused = []
    dashboard_changes = []
    ghosts = []
    if cleanup_unused:
        # Only prune the explicit watering-package helpers, never arbitrary user helpers.
        reference_text = json.dumps(remaining_automations) + json.dumps(scripts)
        dashboard_changes = await obsolete_control_cards(root, api, {h["entity_id"] for h in helpers}, reference_text, states, registry)
        dashboard_replacements = {change["storage_name"]: json.dumps(change["new"]) for change in dashboard_changes}
        for path in [*root.glob("*.yaml"), *(root / "packages").glob("*.yaml"), *(root / ".storage").glob("lovelace*")]:
            if path.name == "automations.yaml" or path.parent == root / "packages" and path.name in PACKAGES:
                continue
            reference_text += dashboard_replacements.get(path.name, path.read_text(encoding="utf-8"))
        reserved = {"input_boolean.ha_watering_capacity_busy"}
        reserved.update(protected_helpers)
        # Cooldown IDs are constructed from notification_key, not present literally in YAML.
        reserved.update(category_targets(remaining_automations, [])[0])
        unused = [h for h in helpers if h["entity_id"] not in reference_text and h["entity_id"] not in reserved]
        helpers = [h for h in helpers if h not in unused]
        ghosts = obsolete_registry_entries(states, registry, reference_text)
    targets, automation_categories = category_targets(remaining_automations, helpers)
    affected_ids = set(automation_categories) | {str(a["id"]) for a in obsolete_automations}
    affected = {eid: state for eid, state in states.items() if eid.startswith("automation.")
                and str(state.get("attributes", {}).get("id")) in affected_ids
                and state["state"] in ("on", "off")}
    if any(state["attributes"].get("current", 0) for state in affected.values()):
        raise RuntimeError("A watering/notification automation is running; retry after it finishes")
    watering_ids = {str(a["id"]) for a in automations if a.get("use_blueprint", {}).get("path") == WATERING}
    if any(str(state["attributes"].get("id")) in watering_ids and state["state"] != "off" for state in affected.values()):
        raise RuntimeError("Disable automatic watering in HA before migrating its helpers")
    if states.get("input_boolean.ha_watering_capacity_busy", {}).get("state") == "on":
        raise RuntimeError("Watering capacity is busy; no migration performed")
    if states.get(f"script.{CAPACITY_SCRIPT}", {}).get("attributes", {}).get("current", 0):
        raise RuntimeError("Watering capacity script is running")
    scripts_path = root / "scripts.yaml"
    script_bytes = scripts_path.read_bytes() if scripts_path.exists() else b""
    existing_scripts = yaml.safe_load(script_bytes) or {}
    for key, value in scripts.items():
        if key in existing_scripts and existing_scripts[key] != value:
            raise RuntimeError(f"Different script already exists in scripts.yaml: {key}")
    print(json.dumps({"apply": apply, "yaml_helpers": len(helpers), "packages": list(sources),
                      "scripts_to_move": list(scripts), "watering_automations": len(affected),
                      "unused_helpers": [h["entity_id"] for h in unused],
                      "obsolete_dashboard_cards": sum(change["removed_cards"] for change in dashboard_changes),
                      "obsolete_registry_entries": [entry["entity_id"] for entry in ghosts],
                      "obsolete_automations": [{"id": a["id"], "alias": a.get("alias")} for a in obsolete_automations]}, ensure_ascii=True))
    if not apply:
        return
    backup = root / "backups" / ("watering-native-ui-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    backup.mkdir(mode=0o700, parents=True)
    disabled = backup / "disabled-packages"
    disabled.mkdir(mode=0o700)
    (backup / "manifest.json").write_text(json.dumps({"helpers": helpers, "unused_helpers": unused, "obsolete_automations": obsolete_automations, "obsolete_registry_entries": ghosts, "dashboard_changes": dashboard_changes, "automation_states": affected,
                                                     "registry": {eid: registry[eid] for eid in targets if eid in registry}}, ensure_ascii=True), encoding="utf-8")
    (backup / "scripts.yaml").write_bytes(script_bytes)
    created, moved = [], []
    domains = sorted({h["domain"] for h in helpers})
    frozen = []
    scripts_written = None
    deleted_automations = []
    saved_dashboards = []
    committed = False
    try:
        for entity_id, state in affected.items():
            frozen.append((entity_id, state["state"]))
            await api.service("automation", "turn_off", entity_id=entity_id, stop_actions=True)
        if (root / "automations.yaml").read_bytes() != automation_bytes:
            raise RuntimeError("automations.yaml changed before migration; user edits were preserved")
        for automation in obsolete_automations:
            await api.delete_automation(str(automation["id"]))
            deleted_automations.append(automation)
        if deleted_automations:
            deleted_ids = {str(a["id"]) for a in deleted_automations}
            for entity_id, state in affected.items():
                if str(state["attributes"]["id"]) not in deleted_ids:
                    await api.service("automation", "turn_off", entity_id=entity_id, stop_actions=True)
        for change in dashboard_changes:
            if await api.call("lovelace/config", url_path=change["url_path"]) != change["old"]:
                raise RuntimeError("A dashboard changed during migration; user edits were preserved")
            saved_dashboards.append(change)
            await api.call("lovelace/config/save", url_path=change["url_path"], config=change["new"])
        for name, source in sources.items():
            path = root / "packages" / name
            if path.read_text(encoding="utf-8") != source:
                raise RuntimeError(f"Package changed during migration: {name}")
            path.rename(disabled / name)
            moved.append(name)
        additions = {key: value for key, value in scripts.items() if key not in existing_scripts}
        if additions:
            if scripts_path.exists() and scripts_path.read_bytes() != script_bytes:
                raise RuntimeError("scripts.yaml changed during migration")
            scripts_written = script_bytes.rstrip() + (b"\n\n" if script_bytes.strip() else b"") + yaml.safe_dump(additions, allow_unicode=True, sort_keys=False).encode("utf-8")
            scripts_path.write_bytes(scripts_written)
        for domain in domains:
            await api.service(domain, "reload")
        for helper in helpers:
            domain, key = helper["domain"], helper["key"]
            fields = helper_fields(domain, helper["config"], helper["state"])
            entry = await api.call(f"{domain}/create", name=key, **fields)
            created.append((domain, entry["id"]))
            if entry["id"] != key:
                raise RuntimeError(f"HA allocated a different helper ID for {helper['entity_id']}")
            await api.call(f"{domain}/update", **{f"{domain}_id": key, "name": helper["state"]["attributes"].get("friendly_name", helper["config"]["name"]), **fields})
            action, data = value_payload(domain, helper["state"])
            await api.service(domain, action, entity_id=helper["entity_id"], **data)
            original_registry = helper["registry"] or {}
            fields = {key: original_registry[key] for key in ("name", "icon", "labels", "area_id", "aliases", "categories") if key in original_registry}
            if fields:
                await api.call("config/entity_registry/update", entity_id=helper["entity_id"], **fields)
        if scripts:
            await api.service("script", "reload")
        refreshed = {s["entity_id"]: s for s in await api.rest("/api/states")}
        for helper in helpers:
            state = refreshed.get(helper["entity_id"])
            if not state or state["attributes"].get("editable") is not True:
                raise RuntimeError(f"Helper is not UI-editable: {helper['entity_id']}")
            if value_payload(helper["domain"], state) != value_payload(helper["domain"], helper["state"]):
                raise RuntimeError(f"Helper value changed: {helper['entity_id']}")
        if CAPACITY_SCRIPT in scripts:
            config = await api.rest(f"/api/config/script/config/{CAPACITY_SCRIPT}")
            if config.get("sequence") != scripts[CAPACITY_SCRIPT]["sequence"]:
                raise RuntimeError("Capacity script is not available unchanged through the UI config API")
        cache = {}
        current_registry_ids = {e["entity_id"] for e in await api.call("config/entity_registry/list")}
        for entity_id, (scope, name) in targets.items():
            if entity_id in refreshed and entity_id in current_registry_ids:
                await assign_category(api, entity_id, scope, name, cache)
        for entity_id, state in affected.items():
            identifier = str(state["attributes"]["id"])
            if identifier in automation_categories:
                await assign_category(api, entity_id, "automation", automation_categories[identifier], cache)
        if f"script.{CAPACITY_SCRIPT}" in refreshed:
            await assign_category(api, f"script.{CAPACITY_SCRIPT}", "script", "Vandingskredse", cache)
        current_automations = yaml.safe_load((root / "automations.yaml").read_bytes()) or []
        if current_automations != remaining_automations:
            raise RuntimeError("The automation file changed during migration; investigate before resuming")
        if cleanup_unused:
            for helper in unused:
                current_registry = {e["entity_id"]: e for e in await api.call("config/entity_registry/list")}
                if helper["entity_id"] in current_registry:
                    await api.call("config/entity_registry/remove", entity_id=helper["entity_id"])
        committed = True
        for entity_id, state in frozen:
            if state == "on" and entity_id not in {eid for eid, old in affected.items() if str(old["attributes"]["id"]) in {str(a["id"]) for a in obsolete_automations}}:
                await api.service("automation", "turn_on", entity_id=entity_id)
        removed_ghosts = 0
        current_states = {s["entity_id"]: s for s in await api.rest("/api/states")}
        current_registry = {e["entity_id"]: e for e in await api.call("config/entity_registry/list")}
        allowed_ghosts = {entry["entity_id"] for entry in obsolete_registry_entries(current_states, current_registry, reference_text)} if cleanup_unused else set()
        for entry in ghosts:
            if entry["entity_id"] in allowed_ghosts:
                await api.call("config/entity_registry/remove", entity_id=entry["entity_id"])
                removed_ghosts += 1
        print(json.dumps({"migrated_helpers": len(helpers), "removed_unused_helpers": len(unused), "removed_obsolete_automations": len(deleted_automations), "removed_dashboard_cards": sum(c["removed_cards"] for c in saved_dashboards), "removed_registry_ghosts": removed_ghosts, "ui_script": bool(scripts), "backup": str(backup),
                          "automation_sha256": hashlib.sha256(automation_bytes).hexdigest(), "no_actuator_calls": True}))
    except Exception:
        if committed:
            raise RuntimeError("Helpers migrated successfully, but final activation/cleanup was incomplete. Check HA; no actuator calls were made.") from None
        failures = []
        for domain, identifier in reversed(created):
            try:
                await api.call(f"{domain}/delete", **{f"{domain}_id": identifier})
            except Exception as error:
                failures.append(str(error))
        for name in moved:
            path = root / "packages" / name
            if path.exists():
                failures.append(f"Package was concurrently recreated: {name}")
            else:
                (disabled / name).rename(path)
        if scripts_written is not None:
            if scripts_path.read_bytes() == scripts_written:
                scripts_path.write_bytes(script_bytes)
            else:
                failures.append("scripts.yaml was concurrently changed; user edits were preserved")
        for automation in deleted_automations:
            try:
                current = yaml.safe_load((root / "automations.yaml").read_bytes()) or []
                if not any(str(a.get("id")) == str(automation["id"]) for a in current):
                    await api.rest("/api/config/automation/config/" + str(automation["id"]), automation)
                else:
                    failures.append("A deleted automation was concurrently recreated; user edits were preserved")
            except Exception as error:
                failures.append(str(error))
        for change in reversed(saved_dashboards):
            try:
                if await api.call("lovelace/config", url_path=change["url_path"]) == change["new"]:
                    await api.call("lovelace/config/save", url_path=change["url_path"], config=change["old"])
                else:
                    failures.append("Dashboard was concurrently edited; user edits were preserved")
            except Exception as error:
                failures.append(str(error))
        for domain in domains:
            try:
                await api.service(domain, "reload")
            except Exception as error:
                failures.append(str(error))
        if scripts:
            try:
                await api.service("script", "reload")
            except Exception as error:
                failures.append(str(error))
        for helper in helpers + unused:
            try:
                action, data = value_payload(helper["domain"], helper["state"])
                await api.service(helper["domain"], action, entity_id=helper["entity_id"], **data)
                original = helper["registry"] or {}
                fields = {key: original[key] for key in ("name", "icon", "labels", "area_id", "aliases", "categories") if key in original}
                if fields:
                    await api.call("config/entity_registry/update", entity_id=helper["entity_id"], **fields)
            except Exception as error:
                failures.append(str(error))
        if not failures:
            for entity_id, state in frozen:
                if state == "on":
                    await api.service("automation", "turn_on", entity_id=entity_id)
        if failures:
            raise RuntimeError(f"Migration rollback incomplete; watering automations remain off. Recovery: {backup}") from None
        raise


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--root", type=Path, default=Path("/config"))
    parser.add_argument("--cleanup-unused", action="store_true")
    args = parser.parse_args()
    credentials = json.load(sys.stdin)
    token = credentials["token"]
    async with aiohttp.ClientSession(headers={"Authorization": "Bearer " + token}, timeout=aiohttp.ClientTimeout(total=30)) as session:
        api = Api(session, token)
        await api.connect()
        try:
            await migrate(args.root, api, args.apply, args.cleanup_unused, set(credentials["inventory_ieees"]) if "inventory_ieees" in credentials else None, credentials.get("protected_helpers", ()))
        finally:
            await api.ws.close()


if __name__ == "__main__":
    asyncio.run(main())
