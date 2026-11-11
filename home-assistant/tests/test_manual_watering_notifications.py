"""Verify area titles and push filtering without sending phone notifications."""
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
import unittest

from jinja2 import Environment, StrictUndefined
import yaml

ROOT = Path(os.environ.get('HA_TEST_ROOT', Path(__file__).resolve().parents[1]))


class BlueprintLoader(yaml.SafeLoader):
    pass


BlueprintLoader.add_constructor('!input', lambda loader, node: loader.construct_scalar(node))
BLUEPRINT = yaml.load((ROOT / 'blueprints/automation/wingman/manual-soil-moisture-alarm.yaml').read_text(), Loader=BlueprintLoader)
PUSH = next(item for item in yaml.safe_load((ROOT / 'automations.yaml').read_text()) if item.get('id') == 'manuel_vanding_push_notifikation')
HELPERS = yaml.safe_load((ROOT / 'packages/manual_watering_notifications.yaml').read_text())['input_datetime']


class ManualWateringNotificationTests(unittest.TestCase):
    def render(self, template, **variables):
        return Environment(undefined=StrictUndefined).from_string(template).render(**variables)

    def test_title_with_area_and_trimmed_plant(self):
        template = BLUEPRINT['actions'][0]['choose'][0]['sequence'][0]['data']['title']
        self.assertEqual(self.render(template, plant_name=' Efeu ', plant_area='Flemmings Værelse'), "Efeu i 'Flemmings Værelse' skal vandes")

    def test_missing_area_does_not_print_none(self):
        template = BLUEPRINT['actions'][0]['choose'][0]['sequence'][0]['data']['title']
        self.assertEqual(self.render(template, plant_name='Efeu', plant_area=''), 'Efeu skal vandes')

    def test_notifications_can_remind_after_cooldown(self):
        self.assertEqual(PUSH['triggers'], [{'trigger': 'persistent_notification', 'update_type': ['added', 'updated']}])

    def cooldown(self, elapsed=None, state=None):
        current = datetime(2026, 11, 9, 12, tzinfo=timezone.utc)
        value = state if state is not None else (current - timedelta(seconds=elapsed)).isoformat()
        env = Environment(undefined=StrictUndefined)
        env.globals.update(states=lambda entity: value, now=lambda: current, as_timestamp=lambda value, default=0: datetime.fromisoformat(value).timestamp() if isinstance(value, str) else value.timestamp())
        return env.from_string(PUSH['actions'][1]['value_template']).render(last_push_helper='input_datetime.sensor_last_push') == 'True'

    def test_exact_rolling_24_hour_boundary(self):
        for seconds in [0, 1, 3600, 86399, 86399.9]:
            self.assertFalse(self.cooldown(seconds))
        self.assertTrue(self.cooldown(86400))
        self.assertTrue(self.cooldown(172800))

    def test_missing_helper_fails_closed(self):
        for state in ['unknown', 'unavailable']:
            self.assertFalse(self.cooldown(state=state))

    def test_future_timestamp_does_not_send(self):
        self.assertFalse(self.cooldown(-60))

    def test_sensors_have_independent_persistent_timestamps(self):
        self.assertEqual(len(HELPERS), 2)
        for helper in HELPERS.values():
            self.assertTrue(helper['has_date'])
            self.assertTrue(helper['has_time'])
            self.assertNotIn('initial', helper)
        self.assertFalse(self.cooldown(30))
        self.assertTrue(self.cooldown(86401))

    def test_cooldown_is_checked_and_reserved_inside_serial_queue(self):
        self.assertEqual(PUSH['mode'], 'queued')
        self.assertEqual(PUSH['actions'][1]['condition'], 'template')
        self.assertEqual(PUSH['actions'][2]['action'], 'input_datetime.set_datetime')
        self.assertEqual(PUSH['actions'][2]['target']['entity_id'], '{{ last_push_helper }}')
        self.assertIn("round(0, 'ceil')", PUSH['actions'][2]['data']['timestamp'])

    def test_only_manual_watering_notifications_generate_push(self):
        template = PUSH['conditions'][0]['value_template']
        for notification_id, expected in [('manual_soil_alarm_sensor_efeu', 'True'), ('other_alarm', 'False')]:
            trigger = SimpleNamespace(notification=SimpleNamespace(notification_id=notification_id))
            self.assertEqual(self.render(template, trigger=trigger), expected)

    def test_push_preserves_notification_title_message_and_tag(self):
        notification = SimpleNamespace(title="Efeu i 'Flemmings Værelse' skal vandes", message='Jordfugt er 20 %. Grænsen er 25 %.', notification_id='manual_soil_alarm_efeu')
        trigger = SimpleNamespace(notification=notification)
        for action in PUSH['actions'][3:]:
            self.assertTrue(action['action'].startswith('notify.mobile_app_'))
            self.assertEqual(self.render(action['data']['title'], trigger=trigger), notification.title)
            self.assertEqual(self.render(action['data']['message'], trigger=trigger), notification.message)
            self.assertEqual(self.render(action['data']['data']['tag'], trigger=trigger), notification.notification_id)


if __name__ == '__main__':
    unittest.main()
