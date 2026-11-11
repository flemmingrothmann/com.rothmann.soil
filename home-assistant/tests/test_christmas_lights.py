"""Fast contract/threshold tests. Run with Python, PyYAML and Jinja2."""
import os
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

from jinja2 import Environment
import yaml

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_PATH = Path(os.environ.get('CHRISTMAS_PACKAGE', ROOT / 'packages/christmas_lights.yaml'))
PERSONAL_PACKAGE_PATH = Path(os.environ.get('PERSONAL_HOLIDAYS_PACKAGE', ROOT / 'packages/personal_holidays.yaml'))
CONTROLS = json.loads(Path(os.environ.get('CHRISTMAS_CONTROLS_HELPERS', ROOT / 'ui-helpers/christmas-controls.json')).read_text())
AUTOMATIONS = yaml.safe_load(Path(os.environ.get('CHRISTMAS_AUTOMATIONS', ROOT / 'christmas-automations.yaml')).read_text())
SCRIPTS = yaml.safe_load(Path(os.environ.get('CHRISTMAS_SCRIPTS', ROOT / 'scripts.yaml')).read_text())
DAYLIGHT = json.loads(Path(os.environ.get('CHRISTMAS_DAYLIGHT_HELPERS', ROOT / 'ui-helpers/christmas-daylight.json')).read_text())
DARKNESS = json.loads(Path(os.environ.get('CHRISTMAS_DARKNESS_HELPERS', ROOT / 'ui-helpers/christmas-darkness.json')).read_text())


def render(template, values=None, hour=18, trigger_id=None):
    values = values or {}
    env = Environment()
    def is_number(value):
        try:
            return float('-inf') < float(value) < float('inf')
        except (ValueError, TypeError):
            return False
    env.globals.update(
        states=lambda key: values.get(key, 'unknown'),
        is_state=lambda key, value: values.get(key) == value,
        is_number=is_number,
        now=lambda: SimpleNamespace(hour=hour),
        trigger=SimpleNamespace(id=trigger_id),
    )
    return env.from_string(template).render().strip() == 'True'


class ChristmasTests(unittest.TestCase):
    def setUp(self):
        self.sensors = {}
        dark = DARKNESS['binary_sensor']
        self.sensors['julelys_moerkt'] = {
            'state': dark['state'],
            'availability': dark['additional_options']['availability'],
        }
        helper = DAYLIGHT['binary_sensor']
        self.sensors['julelys_lyst_i_30_minutter'] = {
            'state': helper['state'],
            'availability': helper['additional_options']['availability'],
        }
        self.automations = {a['id']: a for a in AUTOMATIONS}

    def lux(self, terrace, courtyard):
        return {
            'sensor.terrasse_sensor_ved_terassedor_belysningsstyrke': terrace,
            'sensor.indkorsel_sensor_i_gardsplads_belysningsstyrke': courtyard,
        }

    def test_both_sensors_must_be_dark(self):
        template = self.sensors['julelys_moerkt']['state']
        for a, b, expected in [(399, 399, True), (399, 400, False), (400, 399, False), (200, 800, False), ('unknown', 100, False)]:
            with self.subTest(a=a, b=b):
                self.assertEqual(render(template, self.lux(a, b)), expected)

    def test_both_sensors_must_be_bright(self):
        template = self.sensors['julelys_lyst_i_30_minutter']['state']
        for a, b, expected in [(551, 551, True), (551, 550, False), (550, 551, False), (100, 900, False), ('unavailable', 900, False)]:
            with self.subTest(a=a, b=b):
                self.assertEqual(render(template, self.lux(a, b)), expected)
        duration = self.automations['julelys_ude_dagslys']['triggers'][0]['for']
        self.assertEqual(duration, {'minutes': "{{ states('input_number.julelys_dagslys_ventetid') | float(30) }}"})
        self.assertEqual(DAYLIGHT['input_number']['default_value'], 30)

    def test_missing_sensor_never_counts_as_darkness_or_daylight(self):
        for sensor in ['julelys_moerkt', 'julelys_lyst_i_30_minutter']:
            for value in ['unknown', 'unavailable', 'nan']:
                self.assertFalse(render(self.sensors[sensor]['availability'], self.lux(value, 200)))

    def test_cutoff_uses_tomorrow_before_midnight_today_after_midnight(self):
        template = self.automations['julelys_seneste_sluk']['conditions'][0]['value_template']
        for day_off in [False, True]:
            values = {'binary_sensor.julelys_fridag_i_morgen': 'on' if day_off else 'off'}
            self.assertEqual(render(template, values, trigger_id='before_workday'), not day_off)
            values = {'binary_sensor.julelys_fridag_i_dag': 'on' if day_off else 'off'}
            self.assertEqual(render(template, values, trigger_id='day_off'), day_off)

    def test_morning_selection(self):
        template = self.automations['julelys_ude_morgen']['conditions'][0]['value_template']
        for day_off in [False, True]:
            values = {'binary_sensor.julelys_fridag_i_dag': 'on' if day_off else 'off'}
            self.assertEqual(render(template, values, trigger_id='workday'), not day_off)
            self.assertEqual(render(template, values, trigger_id='day_off'), day_off)

    def test_manual_on_has_no_night_or_lux_restriction(self):
        actions = next(x for x in CONTROLS['template'] if x['template_type'] == 'switch')['turn_on']
        self.assertEqual(actions[0], {'condition': 'state', 'entity_id': 'input_boolean.juletid', 'state': 'on'})
        self.assertEqual(actions[1]['action'], 'light.turn_on')
        self.assertEqual(len(actions), 2)

    def test_label_actions_never_toggle_plug_settings(self):
        actions = [SCRIPTS['julelys_sluk']['sequence'][0]]
        actions.extend(a for automation in AUTOMATIONS for a in automation['actions'] if a.get('action', '').startswith('light.'))
        for action in actions:
            self.assertIn('label_id', action['target'])
            self.assertNotIn('area_id', action['target'])

    def test_evening_cannot_restart_after_godnat(self):
        conditions = self.automations['julelys_ude_aften']['conditions']
        self.assertIn({'condition': 'state', 'entity_id': 'input_boolean.julelys_natpause', 'state': 'off'}, conditions)

    def test_scripts_are_ui_editable(self):
        self.assertFalse(PACKAGE_PATH.exists())
        self.assertIn('julelys_sluk', SCRIPTS)
        config = Path(os.environ.get('CHRISTMAS_CONFIGURATION', ROOT / 'configuration.yaml')).read_text()
        self.assertIn('script: !include scripts.yaml', config)

    def test_daylight_is_not_defined_in_yaml_and_morning_uses_same_duration(self):
        self.assertFalse(PACKAGE_PATH.exists())
        conditions = self.automations['julelys_ude_morgen']['actions']
        daytime_guard = next(action for action in conditions if action.get('condition') == 'not')
        self.assertEqual(daytime_guard['conditions'][0]['for'], self.automations['julelys_ude_dagslys']['triggers'][0]['for'])

    def test_darkness_is_ui_owned_and_master_enable_also_requires_duration(self):
        self.assertFalse(PACKAGE_PATH.exists())
        evening = self.automations['julelys_ude_aften']
        duration = {'minutes': "{{ states('input_number.julelys_morke_ventetid') | float(2) }}"}
        self.assertEqual(evening['triggers'][0]['for'], duration)
        guard = next(x for x in evening['conditions'] if x.get('entity_id') == 'binary_sensor.julelys_morkt')
        self.assertEqual(guard['for'], duration)
        self.assertEqual(DARKNESS['input_number']['default_value'], 2)

    def test_all_remaining_controls_are_ui_helpers_without_initial_state_override(self):
        self.assertFalse(PACKAGE_PATH.exists())
        self.assertFalse(PERSONAL_PACKAGE_PATH.exists())
        definitions = CONTROLS['input_boolean'] + CONTROLS['input_datetime'] + CONTROLS['template']
        self.assertEqual(len(definitions), 8)
        self.assertEqual(len({x['entity_id'] for x in definitions}), 8)
        for helper in CONTROLS['input_boolean'] + CONTROLS['input_datetime']:
            self.assertNotIn('initial', helper)


if __name__ == '__main__':
    unittest.main()
