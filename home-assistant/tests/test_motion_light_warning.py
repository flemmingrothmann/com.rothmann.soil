"""Exercise blueprint action sequences with a deterministic clock, no devices."""
import os
from pathlib import Path
import unittest

import yaml

ROOT = Path(os.environ.get('HA_TEST_ROOT', Path(__file__).resolve().parents[1]))
PATH = ROOT / 'blueprints/automation/wingman/motion-light-warning.yaml'


class BlueprintLoader(yaml.SafeLoader):
    pass


BlueprintLoader.add_constructor('!input', lambda loader, node: loader.construct_scalar(node))
BLUEPRINT = yaml.load(PATH.read_text(encoding='utf-8'), Loader=BlueprintLoader)


class MotionLightWarningTests(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.state = 'unknown'
        self.pending = []
        self.due = None
        self.calls = []
        self.inputs = {key: value.get('default') for key, value in BLUEPRINT['blueprint']['input'].items()}

    def run_actions(self):
        while self.pending:
            step = self.pending.pop(0)
            if 'delay' in step:
                self.due = self.now + sum(self.inputs[value] * (60 if unit == 'minutes' else 1)
                                          for unit, value in step['delay'].items())
                return
            if 'condition' in step and step['state'] != self.state:
                self.pending = []
                return
            if 'action' in step:
                brightness = step.get('data', {}).get('brightness_pct')
                self.calls.append((self.now, step['action'], self.inputs.get(brightness)))
        self.due = None

    def change(self, state):
        if self.state == state:
            return
        self.state = state
        self.pending = []
        self.due = None
        for branch in BLUEPRINT['actions'][0]['choose']:
            if branch['conditions'][0]['state'] == state:
                self.pending = list(branch['sequence'])
                self.run_actions()
                break

    def advance(self, seconds):
        end = self.now + seconds
        while self.due is not None and self.due <= end:
            self.now = self.due
            self.due = None
            self.run_actions()
        self.now = end

    def test_ha_schema(self):
        # Run in the HA container to validate selectors and the resolved action schema.
        from homeassistant.components.automation.config import AUTOMATION_BLUEPRINT_SCHEMA, PLATFORM_SCHEMA
        from homeassistant.components.blueprint.models import Blueprint
        from homeassistant.util import yaml as ha_yaml

        blueprint = Blueprint(ha_yaml.load_yaml(str(PATH)), schema=AUTOMATION_BLUEPRINT_SCHEMA,
                              expected_domain='automation')
        self.assertIsNone(blueprint.validate())
        inputs = dict(self.inputs, motion_sensor='binary_sensor.test', lights=['light.test'])
        resolved = ha_yaml.substitute(blueprint.data, inputs)
        resolved.pop('blueprint')
        PLATFORM_SCHEMA(resolved)

    def test_restart_on_state_changes_only(self):
        self.assertEqual(BLUEPRINT['mode'], 'restart')
        self.assertEqual(BLUEPRINT['triggers'], [dict(trigger='state', entity_id='motion_sensor', to=None)])

    def test_default_warning_then_off(self):
        self.change('on')
        self.advance(600)
        self.assertEqual(self.calls, [(0, 'light.turn_on', 100)])
        self.change('off')
        self.advance(299)
        self.assertEqual(len(self.calls), 1)
        self.advance(1)
        self.assertEqual(self.calls[-1], (900, 'light.turn_on', 30))
        self.advance(29)
        self.assertEqual(len(self.calls), 2)
        self.advance(1)
        self.assertEqual(self.calls[-1], (930, 'light.turn_off', None))

    def test_motion_cancels_both_waiting_phases(self):
        for elapsed in (100, 310, 329):
            with self.subTest(elapsed=elapsed):
                self.setUp()
                self.change('off')
                self.advance(elapsed)
                self.change('on')
                self.assertEqual(self.calls[-1][1:], ('light.turn_on', 100))
                self.advance(1000)
                self.assertFalse(any(call[1] == 'light.turn_off' for call in self.calls))
                self.change('off')
                self.advance(330)
                self.assertEqual(self.calls[-1][1], 'light.turn_off')

    def test_sensor_failure_cancels_countdown(self):
        for state in ('unknown', 'unavailable'):
            for elapsed in (100, 310):
                with self.subTest(state=state, elapsed=elapsed):
                    self.setUp()
                    self.change('off')
                    self.advance(elapsed)
                    self.change(state)
                    before = list(self.calls)
                    self.advance(1000)
                    self.assertEqual(self.calls, before)

    def test_custom_room_settings(self):
        self.inputs.update(normal_brightness=80, warning_brightness=15,
                           inactivity_minutes=0.5, warning_seconds=10)
        self.change('on')
        self.change('off')
        self.advance(40)
        self.assertEqual(self.calls, [(0, 'light.turn_on', 80), (30, 'light.turn_on', 15),
                                     (40, 'light.turn_off', None)])


if __name__ == '__main__':
    unittest.main()
