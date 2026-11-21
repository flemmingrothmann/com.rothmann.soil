"""Offline safety tests for fridge helper ownership and repeat provisioning."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("cold_storage_setup", ROOT / "tools/configure-cold-storage.py")
SETUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SETUP)


class ReadOnlyApi:
    """Fail immediately on any mutation so preservation tests prove no writes."""

    def __init__(self):
        self.states = [
            {"entity_id": SETUP.SOURCE, "state": "3.2",
             "attributes": {"device_class": "temperature"}},
            {"entity_id": SETUP.NOTIFY, "state": "unknown", "attributes": {}},
        ]
        self.registry = []
        self.dashboards = []
        self.mutations = []

    async def rest(self, path, data=None, method=None):
        if path == "/api/states" and data is None and method is None:
            return copy.deepcopy(self.states)
        self.mutations.append(path)
        raise AssertionError(f"Unexpected mutation/API: {path}")

    async def call(self, command, **fields):
        if command == "config/entity_registry/list":
            return copy.deepcopy(self.registry)
        if command == "lovelace/dashboards/list":
            return copy.deepcopy(self.dashboards)
        self.mutations.append(command)
        raise AssertionError(f"Unexpected mutation/API: {command}")


class CreatingApi(ReadOnlyApi):
    """Synthetic config-flow and helper server; never connects to HA."""

    def __init__(self):
        super().__init__()
        self.fail_service = False
        self.automation_delay = 0
        self.pending_automation = None

    async def flow(self, handler, steps):
        self.mutations.append(("flow", handler, copy.deepcopy(steps)))
        entry_id = f"entry_{len(self.registry)}"
        domain = "sensor" if handler == "statistics" else "binary_sensor"
        entity_id = f"{domain}.new_{len(self.registry)}"
        self.registry.append({"entity_id": entity_id, "config_entry_id": entry_id})
        self.states.append({"entity_id": entity_id, "state": "3.2", "attributes": {}})
        return entry_id

    async def call(self, command, **fields):
        if command in ("config/entity_registry/list", "lovelace/dashboards/list"):
            return await super().call(command, **fields)
        self.mutations.append((command, copy.deepcopy(fields)))
        domain, action = command.split("/", 1)
        if domain.startswith("input_") and action == "create":
            self.states.append({"entity_id": domain + "." + fields["name"],
                                "state": "off" if domain == "input_boolean" else "0",
                                "attributes": {}})
            return {"id": fields["name"]}
        if domain.startswith("input_") and action == "update":
            if domain == "input_datetime" and not (fields.get("has_date") or fields.get("has_time")):
                raise RuntimeError("Datetime update requires explicit date/time flags")
            return fields
        if command == "config/entity_registry/update":
            for entry in self.registry + self.states:
                if entry["entity_id"] == fields["entity_id"]:
                    entry["entity_id"] = fields["new_entity_id"]
            return fields
        if command == "lovelace/dashboards/create":
            dashboard = {"id": "new_panel", **fields}
            self.dashboards.append(dashboard)
            return dashboard
        if command == "lovelace/config/save":
            return None
        raise AssertionError(f"Unexpected API: {command}")

    async def rest(self, path, data=None, method=None):
        if path == "/api/states":
            if self.pending_automation is not None:
                if self.automation_delay == 0:
                    self.states.append(self.pending_automation)
                    self.pending_automation = None
                else:
                    self.automation_delay -= 1
            return await super().rest(path, data, method)
        self.mutations.append((path, copy.deepcopy(data)))
        if path == "/api/config/config_entries/options/flow":
            return {"type": "form", "flow_id": "options", "step_id": "init"}
        if path == "/api/config/config_entries/options/flow/options":
            return {"type": "create_entry"}
        if path == "/api/config/automation/config/" + SETUP.AUTOMATION_ID:
            self.pending_automation = {"entity_id": "automation.new_fridge", "state": "on",
                                       "attributes": {"id": data["id"]}}
            return {}
        raise AssertionError(f"Unexpected REST: {path}")

    async def service(self, domain, action, **data):
        self.mutations.append((domain + "." + action, copy.deepcopy(data)))
        if self.fail_service:
            raise RuntimeError("Synthetic service failure")
        state = next(s for s in self.states if s["entity_id"] == data["entity_id"])
        state["state"] = str(data.get("value", data.get("timestamp", "off")))
        return []


class ProvisioningSafetyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.api = ReadOnlyApi()
        self.manifest = {
            "version": 1, "source": SETUP.SOURCE,
            "entities": {}, "entries": {}, "initialized": [],
        }

    def persist(self):
        SETUP.save_manifest(self.root / ".cold-storage-provisioning.json", self.manifest)

    async def test_new_dry_run_has_no_writes(self):
        await SETUP.provision(self.api, self.root, ROOT, False)
        self.assertFalse(list(self.root.iterdir()))
        self.assertFalse(self.api.mutations)

    async def test_collision_in_registry_even_when_no_state(self):
        self.api.registry = [{"entity_id": SETUP.ENTITIES["threshold"]}]
        with self.assertRaisesRegex(RuntimeError, "collision"):
            await SETUP.provision(self.api, self.root, ROOT, True)
        self.assertFalse(self.api.mutations)

    async def test_missing_previously_owned_helper_is_not_recreated(self):
        self.manifest["entities"]["threshold"] = SETUP.ENTITIES["threshold"]
        self.manifest["initialized"] = ["threshold"]
        self.persist()
        with self.assertRaisesRegex(RuntimeError, "not recreated"):
            await SETUP.provision(self.api, self.root, ROOT, True)
        self.assertFalse(self.api.mutations)

    async def test_interrupted_initialization_does_not_reset_defaults(self):
        self.manifest["entities"]["threshold"] = SETUP.ENTITIES["threshold"]
        self.persist()
        with self.assertRaisesRegex(RuntimeError, "no defaults are reapplied"):
            await SETUP.provision(self.api, self.root, ROOT, True)
        self.assertFalse(self.api.mutations)

    async def test_interrupted_entry_is_not_created_twice(self):
        self.manifest["entries"]["average_sensor"] = "existing_entry"
        self.persist()
        with self.assertRaisesRegex(RuntimeError, "Interrupted config-entry"):
            await SETUP.provision(self.api, self.root, ROOT, True)
        self.assertFalse(self.api.mutations)

    async def test_owned_values_and_ui_automation_dashboard_preserved(self):
        self.manifest.update(
            entities=copy.deepcopy(SETUP.ENTITIES),
            initialized=list(SETUP.ENTITIES),
            automation=SETUP.AUTOMATION_ID, dashboard="owned_panel",
            dashboard_ready=True,
        )
        self.persist()
        for entity_id in SETUP.ENTITIES.values():
            self.api.states.append({"entity_id": entity_id, "state": "9.5", "attributes": {}})
        self.api.states.append({
            "entity_id": "automation.user_renamed_fridge", "state": "off",
            "attributes": {"id": SETUP.AUTOMATION_ID},
        })
        self.api.dashboards = [{"id": "owned_panel", "url_path": SETUP.URL_PATH}]
        await SETUP.provision(self.api, self.root, ROOT, True)
        self.assertFalse(self.api.mutations)
        saved = json.loads((self.root / ".cold-storage-provisioning.json").read_text())
        self.assertEqual(saved, self.manifest)

    async def test_deleted_owned_dashboard_not_recreated(self):
        self.manifest.update(dashboard="owned_panel", dashboard_ready=True)
        self.persist()
        with self.assertRaisesRegex(RuntimeError, "dashboard missing"):
            await SETUP.provision(self.api, self.root, ROOT, True)
        self.assertFalse(self.api.mutations)

    async def test_unowned_dashboard_not_overwritten(self):
        self.api.dashboards = [{"id": "someone_else", "url_path": SETUP.URL_PATH}]
        with self.assertRaisesRegex(RuntimeError, "not owned"):
            await SETUP.provision(self.api, self.root, ROOT, True)
        self.assertFalse(self.api.mutations)

    def test_automation_links_existing_sensor_and_shared_notify(self):
        definition = SETUP.automation()
        inputs = definition["use_blueprint"]["input"]
        self.assertEqual(inputs["temperature_sensor"], SETUP.SOURCE)
        self.assertEqual(inputs["notify_target"], "notify.manuel_vanding_mobilapps")
        self.assertNotIn("optimal", inputs)
        self.assertNotIn("initial", json.dumps(SETUP.SIMPLE))

    async def test_complete_creation_and_repeat_preserve_user_values(self):
        api = CreatingApi()
        await SETUP.provision(api, self.root, ROOT, True)
        manifest = json.loads((self.root / ".cold-storage-provisioning.json").read_text())
        self.assertEqual(set(manifest["initialized"]), set(SETUP.ENTITIES))
        self.assertTrue(manifest["dashboard_ready"])
        backups = list((self.root / "backups").iterdir())
        self.assertEqual(len(backups), 1)
        threshold = next(s for s in api.states if s["entity_id"] == SETUP.ENTITIES["threshold"])
        self.assertEqual(threshold["state"], "7")
        threshold["state"] = "8.5"  # Subsequent deliberate user UI change.
        mutation_count = len(api.mutations)
        await SETUP.provision(api, self.root, ROOT, True)
        self.assertEqual(len(api.mutations), mutation_count)
        self.assertEqual(threshold["state"], "8.5")
        statistics = next(item for item in api.mutations
                          if item[0] == "flow" and item[1] == "statistics")
        options = statistics[2][-1][1]
        self.assertEqual(options["max_age"]["hours"], 24)
        self.assertEqual(options["keep_last_sample"], False)
        self.assertNotIn("sampling_size", options)

    async def test_failed_initialization_blocks_next_apply_without_resets(self):
        api = CreatingApi()
        api.fail_service = True
        with self.assertRaisesRegex(RuntimeError, "Synthetic service failure"):
            await SETUP.provision(api, self.root, ROOT, True)
        count = len(api.mutations)
        with self.assertRaisesRegex(RuntimeError, "no defaults are reapplied"):
            await SETUP.provision(api, self.root, ROOT, True)
        self.assertEqual(len(api.mutations), count)

    async def test_id_scoped_reload_can_finish_after_save_returns(self):
        api = CreatingApi()
        api.automation_delay = 3
        with patch.object(SETUP.asyncio, "sleep", new_callable=AsyncMock) as sleep:
            await SETUP.provision(api, self.root, ROOT, True)
        self.assertIsNone(api.pending_automation)
        self.assertGreaterEqual(sleep.await_count, 3)


class ConfigFlowContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_step_validation_and_entry_result(self):
        api = SETUP.Api(None, "not-a-real-token")
        calls = []

        async def rest(path, data=None):
            calls.append((path, data))
            return [
                {"type": "form", "step_id": "user", "flow_id": "example"},
                {"type": "create_entry", "result": {"entry_id": "created"}},
            ][len(calls) - 1]

        api.rest = rest
        result = await api.flow("trend", [("user", {"name": "example"})])
        self.assertEqual(result, "created")
        self.assertEqual(calls[0][1]["handler"], "trend")

    async def test_unexpected_step_stops_instead_of_guessing(self):
        api = SETUP.Api(None, "not-a-real-token")

        async def rest(path, data=None):
            return {"type": "form", "step_id": "different", "flow_id": "example"}

        api.rest = rest
        with self.assertRaisesRegex(RuntimeError, "Unexpected"):
            await api.flow("trend", [("user", {})])


if __name__ == "__main__":
    unittest.main()
