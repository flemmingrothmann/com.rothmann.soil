"""Regression tests for the cold-storage blueprint using synthetic HA-like states."""
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest

from jinja2 import StrictUndefined
from jinja2.nativetypes import NativeEnvironment
import yaml

ROOT = Path(os.environ.get("HA_TEST_ROOT", Path(__file__).resolve().parents[1]))


class BlueprintLoader(yaml.SafeLoader):
    pass


BlueprintLoader.add_constructor("!input", lambda loader, node: loader.construct_scalar(node))
BLUEPRINT = yaml.load(
    (ROOT / "blueprints/automation/wingman/cold-storage-temperature-alarm.yaml").read_text(encoding="utf-8"),
    Loader=BlueprintLoader,
)
HELPERS = json.loads((ROOT / "ui-helpers/cold-storage.json").read_text(encoding="utf-8"))
DASHBOARD = json.loads((ROOT / "dashboards/cold-storage.json").read_text(encoding="utf-8"))


class State:
    def __init__(self, state, attrs=None, last_updated=None, last_reported=None):
        self.state = state
        self.attributes = attrs or {}
        self.last_updated = last_updated
        self.last_reported = last_reported


class ColdStorageTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 20, 12, tzinfo=timezone.utc)
        self.states = {
            "source": State("6", last_updated=self.now, last_reported=self.now),
            "average": State("8", {"source_value_valid": True}, last_updated=self.now, last_reported=self.now),
            "temp_trend": State("on", {"gradient": 0.01, "sample_count": 2}, self.now),
            "avg_trend": State("on", {"gradient": 0.01, "sample_count": 2}, self.now),
            "latch": State("off"),
            "started": State((self.now - timedelta(hours=25)).isoformat()),
            "threshold": State("7"),
            "timeout": State("120"),
        }
        self.inputs = dict(
            temperature_sensor="source", average_sensor="average",
            temperature_trend="temp_trend", average_trend="avg_trend",
            alarm_latch="latch", started_at="started", threshold="threshold",
            source_timeout="timeout", notify_target="notify.manuel_vanding_mobilapps",
            appliance_name="Køleskab Værksted",
        )

    def context(self):
        def timestamp(value, default=None):
            try:
                if isinstance(value, datetime):
                    return value.timestamp()
                return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
            except (TypeError, ValueError):
                return default

        env = NativeEnvironment(undefined=StrictUndefined)

        class StateAccessor:
            def __init__(_, values):
                _.map = values

            def __getitem__(_, entity):
                return _.map.get(entity)

            def __call__(_, entity):
                return _.map[entity].state if entity in _.map else "unknown"

        env.globals.update(
            states=StateAccessor(self.states),
            state_attr=lambda entity, attr: self.states[entity].attributes.get(attr) if entity in self.states else None,
            is_state=lambda entity, state: entity in self.states and self.states[entity].state == state,
            is_number=_is_number,
            now=lambda: self.now,
            as_timestamp=timestamp,
            float=lambda value, default=None: _float(value, default),
            int=lambda value, default=0: _int(value, default),
        )
        context = {}
        for name, expression in BLUEPRINT["variables"].items():
            if isinstance(expression, str) and "{{" in expression:
                value = env.from_string(expression).render(**{**self.inputs, **context})
            elif isinstance(expression, str) and expression in self.inputs:
                value = self.inputs[expression]
            else:
                value = expression
            context[name] = value
        return env, context

    def render(self, template):
        env, context = self.context()
        return env.from_string(template).render(**{**self.inputs, **context})

    def alarm_allowed(self):
        tpl = BLUEPRINT["actions"][0]["choose"][0]["conditions"][0]["value_template"]
        return self.render(tpl) is True

    def test_threshold_strict_boundaries(self):
        tpl = BLUEPRINT["actions"][0]["choose"][0]["conditions"][0]["value_template"]
        for value, expected in [(7.01, True), (7, False), (6.99, False)]:
            self.states["average"].state = str(value)
            self.assertEqual(self.render(tpl) is True, expected)

    def test_each_trend_must_be_on_and_have_positive_gradient(self):
        self.assertTrue(self.alarm_allowed())
        for trend, state in [("temp_trend", "off"), ("avg_trend", "off")]:
            self.states[trend].state = state
            self.assertFalse(self.alarm_allowed())
            self.states[trend].state = "on"
        self.states["temp_trend"].attributes["gradient"] = 0
        self.assertFalse(self.alarm_allowed())

    def test_restored_trends_require_samples_and_fresh_timestamps(self):
        trend = self.states["temp_trend"]
        for count in (0, 1):
            trend.state = "on"
            trend.attributes.update(gradient=0.01, sample_count=count)
            self.assertFalse(self.alarm_allowed())
        trend.attributes["sample_count"] = 2
        trend.last_updated = self.now - timedelta(hours=1, seconds=1)
        self.assertFalse(self.alarm_allowed())
        trend.last_updated = self.now + timedelta(seconds=1)
        self.assertFalse(self.alarm_allowed())
        trend.last_updated = self.now
        self.assertTrue(self.alarm_allowed())
        del self.states["temp_trend"]
        self.assertFalse(self.alarm_allowed())
        self.states["temp_trend"] = trend
        del self.states["avg_trend"]
        self.assertFalse(self.alarm_allowed())

    def test_warmup_and_known_latch_are_required(self):
        self.states["started"].state = (self.now - timedelta(hours=23, minutes=59)).isoformat()
        self.assertFalse(self.alarm_allowed())
        self.states["started"].state = (self.now - timedelta(hours=24)).isoformat()
        self.assertTrue(self.alarm_allowed())
        for state in ("on", "unknown", "unavailable"):
            self.states["latch"].state = state
            self.assertFalse(self.alarm_allowed())

    def test_missing_stale_or_non_numeric_source_fails_closed(self):
        for value in ("unknown", "unavailable", "not-a-number"):
            self.states["source"].state = value
            self.assertFalse(self.alarm_allowed())
        self.states["source"] = State("6", last_reported=self.now - timedelta(minutes=121))
        self.assertFalse(self.alarm_allowed())
        self.states["source"] = State("6", last_reported=self.now + timedelta(seconds=1))
        self.assertFalse(self.alarm_allowed())
        self.states["source"] = State("6")
        self.assertFalse(self.alarm_allowed())
        del self.states["source"]
        self.assertFalse(self.alarm_allowed())
        self.states["source"] = State("6", last_reported=self.now)
        del self.states["average"]
        self.assertFalse(self.alarm_allowed())

    def test_invalid_average_and_latch_persist_dedupe(self):
        self.states["average"].attributes["source_value_valid"] = False
        self.assertFalse(self.alarm_allowed())
        self.states["average"].attributes["source_value_valid"] = None
        self.assertFalse(self.alarm_allowed())
        self.states["average"].attributes["source_value_valid"] = True
        self.states["average"].state = "unavailable"
        self.assertFalse(self.alarm_allowed())
        self.states["average"].state = "8"
        self.states["average"].last_reported = self.now - timedelta(minutes=121)
        self.assertFalse(self.alarm_allowed())
        self.states["average"].last_reported = self.now + timedelta(seconds=1)
        self.assertFalse(self.alarm_allowed())
        self.states["average"].last_reported = self.now
        self.states["latch"].state = "on"
        self.assertFalse(self.alarm_allowed())
        action = BLUEPRINT["actions"][0]["choose"][0]["sequence"]
        self.assertEqual(action[0]["action"], "input_boolean.turn_on")
        self.assertEqual(action[1]["action"], "notify.send_message")
        self.assertTrue(action[1]["continue_on_error"])
        self.assertIn("{{ notify_target }}", action[1]["data"]["entity_id"])

    def test_recovery_requires_fresh_data_but_not_trends(self):
        condition = BLUEPRINT["actions"][0]["choose"][1]["conditions"][0]["value_template"]
        self.states["latch"].state = "on"
        self.states["average"].state = "6"
        self.states["temp_trend"].state = "unavailable"
        self.states["avg_trend"].state = "off"
        self.states["average"].state = "8"
        self.assertFalse(self.render(condition) is True)
        for value, expected in [("6.99", True), ("7", False), ("7.01", False)]:
            self.states["average"].state = value
            self.assertEqual(self.render(condition) is True, expected)
        self.states["average"].state = "6"
        self.states["source"] = State("6", last_reported=self.now - timedelta(hours=3))
        self.assertFalse(self.render(condition) is True)
        self.states["source"] = State("6", last_reported=self.now)
        self.states["average"].state = "nan"
        self.assertFalse(self.render(condition) is True)
        self.states["average"].state = "6"
        self.states["average"].attributes["source_value_valid"] = None
        self.assertFalse(self.render(condition) is True)
        self.states["average"].attributes["source_value_valid"] = True

    def test_numeric_inputs_must_be_finite_and_timeout_positive(self):
        for entity, values in [("threshold", ("nan", "inf", "-inf")), ("timeout", ("nan", "inf", "-inf", "0", "-1"))]:
            for value in values:
                self.states[entity].state = value
                self.assertFalse(self.alarm_allowed(), (entity, value))
            self.states[entity].state = "7" if entity == "threshold" else "120"

    def test_native_helper_settings_and_dashboard_fixture(self):
        statistics = HELPERS["sensor"]
        self.assertEqual(statistics["state_characteristic"], "average_step")
        self.assertEqual(statistics["max_age"], {"hours": 24})
        self.assertEqual(statistics["precision"], 3)
        self.assertNotIn("sampling_size", statistics)
        for trend in HELPERS["binary_sensor"].values():
            self.assertEqual(trend["min_samples"], 2)
            self.assertEqual(trend["min_gradient"], 1e-8)
            self.assertEqual(trend["sample_duration"], 3600)
            self.assertEqual(trend["max_samples"], 10000)
        view = DASHBOARD["views"][0]
        self.assertEqual(view["path"], "koleskab-vaerksted")
        graph = next(card for card in view["cards"] if card["type"] == "history-graph")
        self.assertEqual(graph["hours_to_show"], 168)
        self.assertEqual(len(graph["entities"]), 2)
        self.assertEqual(HELPERS["input_number"][-1]["default_value"], 120)
        self.assertEqual(HELPERS["input_number"][0]["min"], -40)
        self.assertEqual(HELPERS["input_number"][0]["max"], 30)
        self.assertEqual(HELPERS["input_number"][2]["min"], 10)
        self.assertEqual(HELPERS["input_number"][2]["max"], 1440)
        self.assertEqual(HELPERS["input_number"][2]["step"], 5)
        self.assertFalse(HELPERS["sensor"].get("keep_last_sample", True))
        expected_entities = {
            "sensor.koleskab_vaerksted_gennemsnit_24t",
            "binary_sensor.koleskab_vaerksted_temperatur_stiger",
            "binary_sensor.koleskab_vaerksted_gennemsnit_stiger",
            "input_boolean.koleskab_vaerksted_temperaturalarm",
            "input_datetime.koleskab_vaerksted_overvaagning_startet",
            "input_number.koleskab_vaerksted_alarmgraense",
            "input_number.koleskab_vaerksted_optimal_temperatur",
            "input_number.koleskab_vaerksted_datatimeout",
        }
        configured = {
            f"sensor.{HELPERS['sensor']['unique_id']}",
            *[f"binary_sensor.{trend['unique_id']}" for trend in HELPERS["binary_sensor"].values()],
            HELPERS["input_boolean"]["entity_id"],
            HELPERS["input_datetime"]["entity_id"],
            *[helper["entity_id"] for helper in HELPERS["input_number"]],
        }
        self.assertEqual(configured, expected_entities)
        status = view["cards"][0]["content"]
        for label in ("Alarmeret", "Normal", "Indsamler data", "Datamangler"):
            self.assertIn(label, status)
        status_entities = {
            entry if isinstance(entry, str) else entry["entity"]
            for entry in view["cards"][1]["entities"]
        }
        self.assertNotIn("input_boolean.koleskab_vaerksted_temperaturalarm", status_entities)
        self.assertNotIn("input_datetime.koleskab_vaerksted_overvaagning_startet", status_entities)
        settings_entities = [
            entry if isinstance(entry, str) else entry["entity"]
            for entry in view["cards"][3]["entities"]
        ]
        self.assertIn("input_datetime.koleskab_vaerksted_overvaagning_startet", settings_entities)


def _is_number(value):
    try:
        import math
        return not isinstance(value, bool) and math.isfinite(float(value)) and value not in ("unknown", "unavailable", None)
    except (TypeError, ValueError, OverflowError):
        return False


def _float(value, default=None):
    return float(value) if _is_number(value) else default


def _int(value, default=0):
    return int(float(value)) if _is_number(value) else default


if __name__ == "__main__":
    unittest.main()
