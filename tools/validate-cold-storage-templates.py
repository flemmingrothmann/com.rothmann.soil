"""Validate fridge templates in a separate, synthetic HA process; no live API calls.

Run using the installed HA Python and pass the staged repository root as argument.
The temporary HomeAssistant object is never started or connected to any devices.
"""
import asyncio
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import sys
import tempfile

import yaml

from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.script_variables import ScriptVariables
from homeassistant.helpers.template import Template


class Input(str):
    """A blueprint input, distinct from a literal scalar."""


class Loader(yaml.SafeLoader):
    """Load blueprint inputs without executing YAML constructors."""


Loader.add_constructor("!input", lambda loader, node: Input(loader.construct_scalar(node)))


def substitute(value, inputs):
    if isinstance(value, Input):
        return inputs[str(value)]
    if isinstance(value, dict):
        return {key: substitute(item, inputs) for key, item in value.items()}
    if isinstance(value, list):
        return [substitute(item, inputs) for item in value]
    return value


async def validate(root):
    spec = importlib.util.spec_from_file_location("cold_storage", root / "tools/configure-cold-storage.py")
    setup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(setup)
    blueprint = yaml.load(
        (root / "home-assistant/blueprints/automation" / setup.BLUEPRINT).read_text(encoding="utf-8"),
        Loader=Loader,
    )
    definition = substitute(blueprint, setup.automation()["use_blueprint"]["input"])
    import json

    dashboard = json.loads((root / "home-assistant/dashboards/cold-storage.json").read_text(encoding="utf-8"))
    summary = dashboard["views"][0]["cards"][0]["content"]
    with tempfile.TemporaryDirectory(prefix="cold-storage-synthetic-") as directory:
        hass = HomeAssistant(directory)
        prepared = cv.template_complex(definition["variables"])
        variables = ScriptVariables(prepared)
        now = datetime.now(timezone.utc)

        def populate(average="8", latch="off", age_hours=25, source="6"):
            hass.states.async_set(setup.SOURCE, source)
            hass.states.async_set(setup.ENTITIES["average_sensor"], average,
                                  {"source_value_valid": True})
            hass.states.async_set(setup.ENTITIES["alarm_latch"], latch)
            hass.states.async_set(setup.ENTITIES["started_at"],
                                  (now - timedelta(hours=age_hours)).isoformat())
            hass.states.async_set(setup.ENTITIES["threshold"], "7")
            hass.states.async_set(setup.ENTITIES["source_timeout"], "120")
            for key in ("temperature_trend", "average_trend"):
                hass.states.async_set(setup.ENTITIES[key], "on",
                                      {"sample_count": 2, "gradient": 0.001})

        def conditions():
            values = variables.async_render(hass, {})
            return [
                Template(branch["conditions"][0]["value_template"], hass).async_render(values)
                for branch in definition["actions"][0]["choose"]
            ]

        cases = [
            ({"average": "8", "latch": "off"}, [True, False]),
            ({"average": "7", "latch": "off"}, [False, False]),
            ({"average": "7", "latch": "on"}, [False, False]),
            ({"average": "6.99", "latch": "on"}, [False, True]),
            ({"average": "8", "latch": "on"}, [False, False]),
            ({"average": "8", "age_hours": 0}, [False, False]),
            ({"average": "6", "latch": "on", "source": "unavailable"}, [False, False]),
            ({"average": "unavailable", "latch": "on"}, [False, False]),
            ({"average": "nan", "latch": "on"}, [False, False]),
        ]
        for values, expected in cases:
            populate(**values)
            actual = conditions()
            assert actual == expected, (values, actual, expected, variables.async_render(hass, {}))
        populate(age_hours=0)
        rendered = Template(summary, hass).async_render()
        assert "Indsamler data" in rendered, rendered
        populate(source="unavailable")
        rendered = Template(summary, hass).async_render()
        assert "Datamangler" in rendered, rendered
        populate(latch="on")
        rendered = Template(summary, hass).async_render()
        assert "Alarmeret" in rendered, rendered
        populate()
        hass.states.async_remove(setup.SOURCE)
        assert conditions() == [False, False]
        print("Native HA template validation PASS: 9 alarm/recovery cases, missing source, 3 status cards.")


if __name__ == "__main__":
    asyncio.run(validate(Path(sys.argv[1])))
