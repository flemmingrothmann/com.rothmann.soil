"""Safety contracts for native-UI watering circuit administration."""
import os
from pathlib import Path
import unittest

from jinja2.nativetypes import NativeEnvironment
import yaml

ROOT = Path(os.environ.get('HA_TEST_ROOT', Path(__file__).resolve().parents[1]))


class BlueprintLoader(yaml.SafeLoader):
    pass


BlueprintLoader.add_constructor('!input', lambda loader, node: loader.construct_scalar(node))


def load(name):
    return yaml.load((ROOT / 'blueprints/automation/wingman' / name).read_text(encoding='utf-8'), Loader=BlueprintLoader)


class AutomaticWateringAdminTests(unittest.TestCase):
    def test_zero_threshold_disables_automatic_alarm(self):
        alarm = load('soil-moisture-alarm.yaml')
        env = NativeEnvironment()
        for moisture in [0, 10, 90]:
            values = dict(lower=0, upper=6, moisture=moisture, water_alarm='input_boolean.test')
            env.globals['is_state'] = lambda entity, value: value == 'off'
            dry = alarm['action'][0]['choose'][0]['conditions'][0]['value_template']
            self.assertFalse(env.from_string(dry).render(**values))
            env.globals['is_state'] = lambda entity, value: value == 'on'
            wet = alarm['action'][0]['choose'][1]['conditions'][0]['value_template']
            self.assertTrue(env.from_string(wet).render(**values))

    def test_automatic_alarm_preserves_hysteresis(self):
        alarm = load('soil-moisture-alarm.yaml')
        env = NativeEnvironment()
        env.globals['is_state'] = lambda entity, value: True
        dry = env.from_string(alarm['action'][0]['choose'][0]['conditions'][0]['value_template'])
        wet = env.from_string(alarm['action'][0]['choose'][1]['conditions'][0]['value_template'])
        self.assertTrue(dry.render(lower=25, moisture=25, water_alarm='x'))
        self.assertFalse(dry.render(lower=25, moisture=26, water_alarm='x'))
        self.assertFalse(wet.render(lower=25, upper=31, moisture=30, water_alarm='x'))
        self.assertTrue(wet.render(lower=25, upper=31, moisture=31, water_alarm='x'))
        self.assertNotIn('switch.turn_on', str(alarm))

    def test_allowing_watering_reevaluates_demand_but_retains_the_gate(self):
        watering = load('labelled-pot-watering.yaml')
        self.assertIn({'platform': 'state', 'entity_id': 'watering_forbidden', 'to': 'off'}, watering['trigger'])
        self.assertIn({'condition': 'state', 'entity_id': 'watering_forbidden', 'state': 'off'}, watering['condition'])
        self.assertIn("is_state(watering_forbidden, 'off')", str(watering['action']))


if __name__ == '__main__':
    unittest.main()
