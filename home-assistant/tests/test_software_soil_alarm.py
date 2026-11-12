"""Test software thresholds and hysteresis without phone or valve calls."""
import os
from pathlib import Path
import unittest

from jinja2.nativetypes import NativeEnvironment
import yaml

ROOT = Path(os.environ.get('HA_TEST_ROOT', Path(__file__).resolve().parents[1]))


class BlueprintLoader(yaml.SafeLoader):
    pass


BlueprintLoader.add_constructor('!input', lambda loader, node: loader.construct_scalar(node))
BLUEPRINT = yaml.load((ROOT / 'blueprints/automation/wingman/manual-soil-moisture-alarm.yaml').read_text(), Loader=BlueprintLoader)


class SoftwareSoilAlarmTests(unittest.TestCase):
    def render(self, source, **values):
        env = NativeEnvironment()
        env.globals.update(states=lambda entity: values.get('helper_state', '25'))
        return env.from_string(source).render(**values)

    def test_existing_fixed_threshold_remains_supported(self):
        source = BLUEPRINT['variables']['threshold']
        self.assertEqual(self.render(source, threshold_helper='', fixed_threshold=32), 32)
        self.assertEqual(self.render(source, threshold_helper='input_number.threshold', fixed_threshold=32, helper_state='20'), 20)
        self.assertIsNone(self.render(source, threshold_helper='input_number.threshold', fixed_threshold=32, helper_state='unavailable'))

    def test_alarm_threshold_and_hysteresis_boundaries(self):
        branches = BLUEPRINT['actions'][0]['choose']
        dry = branches[0]['conditions'][0]['value_template']
        wet = branches[1]['conditions'][0]['value_template']
        for moisture in [0, 24.9, 25]:
            self.assertTrue(self.render(dry, moisture=moisture, threshold=25))
        for moisture in [25.1, 28, 30.9]:
            self.assertFalse(self.render(dry, moisture=moisture, threshold=25))
            self.assertFalse(self.render(wet, moisture=moisture, threshold=25, upper_threshold=31))
        self.assertTrue(self.render(wet, moisture=31, threshold=25, upper_threshold=31))

    def test_zero_disables_alarm_even_at_zero_moisture(self):
        branches = BLUEPRINT['actions'][0]['choose']
        self.assertFalse(self.render(branches[0]['conditions'][0]['value_template'], moisture=0, threshold=0))
        self.assertTrue(self.render(branches[1]['conditions'][0]['value_template'], moisture=0, threshold=0, upper_threshold=6))

    def test_unavailable_readings_or_helpers_never_trigger_alarm(self):
        source = BLUEPRINT['conditions'][0]['value_template']
        for moisture, threshold in [(None, 25), (20, None), (20, -1), (20, 91)]:
            self.assertFalse(self.render(source, moisture=moisture, threshold=threshold))

    def test_stable_notification_key_survives_entity_renaming(self):
        source = BLUEPRINT['variables']['notification_id']
        before = self.render(source, notification_key='ieee_abcd', moisture_sensor='sensor.old_pot')
        after = self.render(source, notification_key='ieee_abcd', moisture_sensor='sensor.new_pot')
        self.assertEqual(before, after)
        self.assertEqual(before, 'manual_soil_alarm_ieee_abcd')
        self.assertEqual(self.render(source, notification_key='', moisture_sensor='sensor.old_pot'), 'manual_soil_alarm_sensor_old_pot')

    def test_threshold_helper_has_an_explicit_trigger(self):
        self.assertIn({'trigger': 'event', 'event_type': 'state_changed', 'event_data': {'entity_id': 'threshold_helper'}}, BLUEPRINT['triggers'])

    def test_no_valve_or_device_write_is_part_of_the_blueprint(self):
        source = str(BLUEPRINT)
        for forbidden in ['switch.turn_on', 'valve.open_valve', 'zigbee2mqtt/', 'light.turn_on']:
            self.assertNotIn(forbidden, source)
        self.assertIn('input_boolean.turn_on', source)
        self.assertIn('mqtt.publish', source)


if __name__ == '__main__':
    unittest.main()
