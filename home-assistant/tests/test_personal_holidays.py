"""Exercise actual HA calendar templates without touching real calendar events."""
from datetime import datetime, timedelta
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from zoneinfo import ZoneInfo

from jinja2 import Environment, StrictUndefined
import yaml

ROOT = Path(__file__).resolve().parents[1]
AUTOMATION = yaml.safe_load(Path(os.environ.get('HOLIDAY_AUTOMATIONS', ROOT / 'calendar-automations.yaml')).read_text())[0]
CONTROLS = json.loads(Path(os.environ.get('CHRISTMAS_CONTROLS_HELPERS', ROOT / 'ui-helpers/christmas-controls.json')).read_text())
ZONE = ZoneInfo('Europe/Copenhagen')


def environment(today):
    env = Environment(undefined=StrictUndefined)
    env.globals.update(
        now=lambda: today,
        today_at=lambda time: datetime.combine(today.date(), datetime.strptime(time, '%H:%M').time(), ZONE),
        as_datetime=datetime.fromisoformat,
        as_local=lambda value: value.astimezone(ZONE),
        timedelta=timedelta,
    )
    return env


class PersonalHolidayTests(unittest.TestCase):
    def matches(self, events, day='2026-11-09', offset=0):
        today = datetime.fromisoformat(day).replace(hour=12, tzinfo=ZONE)
        env = environment(today)
        variables = {'dagens_start': today.replace(hour=0).isoformat(), 'repeat': SimpleNamespace(item=offset), 'ferie_events': {'calendar.hovedkaldender': {'events': events}}}
        definitions = AUTOMATION['actions'][2]['repeat']['sequence'][0]['variables']
        for key, template in definitions.items():
            variables[key] = env.from_string(template).render(**variables).strip()
        return variables['ferie'] == 'True'

    def event(self, title, start='2026-11-09', end='2026-11-10'):
        return {'summary': title, 'start': start, 'end': end}

    def test_case_insensitive_substring_anywhere(self):
        for title in ['ferie', 'Sommerferie', 'Flemming har FERIE i Spanien', 'EfterårsFERIE', 'Ferie i Spanien']:
            with self.subTest(title=title):
                self.assertTrue(self.matches([self.event(title)]))
        self.assertFalse(self.matches([self.event('Arbejde')]))

    def test_all_overlapping_events_not_just_calendar_message(self):
        self.assertTrue(self.matches([self.event('Arbejde'), self.event('Min ferie'), self.event('Tandlæge')]))
        self.assertFalse(self.matches([]))

    def test_multiday_event_and_exclusive_end(self):
        event = self.event('Vinterferie', '2026-11-08', '2026-11-11')
        self.assertTrue(self.matches([event]))
        self.assertTrue(self.matches([event], offset=1))
        self.assertFalse(self.matches([event], day='2026-11-11'))
        self.assertFalse(self.matches([event], day='2026-11-07'))

    def test_tomorrow_and_midnight_boundaries(self):
        event = self.event('Ferie', '2026-11-10T00:00:00+01:00', '2026-11-11T00:00:00+01:00')
        self.assertFalse(self.matches([event]))
        self.assertTrue(self.matches([event], offset=1))
        self.assertFalse(self.matches([event], day='2026-11-11'))

    def test_partial_day_and_cross_midnight(self):
        event = self.event('Ferie fra frokost', '2026-11-09T12:00:00+01:00', '2026-11-10T01:00:00+01:00')
        self.assertTrue(self.matches([event]))
        self.assertTrue(self.matches([event], offset=1))

    def test_timezone_and_daylight_saving(self):
        event = self.event('Ferie', '2026-11-09T23:30:00Z', '2026-11-10T01:00:00Z')
        self.assertFalse(self.matches([event]))
        self.assertTrue(self.matches([event], offset=1))
        for day, expected in [('2026-03-28', '2026-03-30T00:00:00+02:00'), ('2026-10-24', '2026-10-26T00:00:00+01:00')]:
            today = datetime.fromisoformat(day).replace(tzinfo=ZONE)
            env = environment(today)
            template = AUTOMATION['actions'][1]['data']['end_date_time']
            self.assertEqual(env.from_string(template).render(dagens_start=today.isoformat()), expected)

    def test_fridag_uses_holidays_or_fresh_personal_holiday_only(self):
        env = environment(datetime(2026, 11, 9, 12, tzinfo=ZONE))
        for suffix in ['i_dag', 'i_morgen']:
            sensor = next(s for s in CONTROLS['template'] if s['entity_id'] == 'binary_sensor.julelys_fridag_' + suffix)
            values = {'binary_sensor.arbejdsdag_danmark_' + suffix: 'on', 'input_boolean.ferie_' + suffix: 'on', 'input_datetime.ferie_kalenderdato': '2026-11-09'}
            env.globals.update(states=lambda key: values.get(key, 'unknown'), is_state=lambda key, value: values.get(key) == value)
            template = env.from_string(sensor['state'])
            self.assertEqual(template.render().strip(), 'True')
            values['input_datetime.ferie_kalenderdato'] = '2026-11-08'
            self.assertEqual(template.render().strip(), 'False')
            values['binary_sensor.arbejdsdag_danmark_' + suffix] = 'off'
            self.assertEqual(template.render().strip(), 'True')

    def test_calendar_failures_do_not_clear_existing_results(self):
        fetch = AUTOMATION['actions'][1]
        self.assertNotIn('continue_on_error', fetch)
        self.assertEqual(AUTOMATION['actions'][-1]['target']['entity_id'], 'input_datetime.ferie_kalenderdato')


if __name__ == '__main__':
    unittest.main()
