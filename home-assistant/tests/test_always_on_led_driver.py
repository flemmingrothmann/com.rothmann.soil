import os
from pathlib import Path
import unittest

import yaml

ROOT = Path(os.environ.get('HA_TEST_ROOT', Path(__file__).resolve().parents[1]))
AUTOMATIONS = yaml.safe_load((ROOT / 'automations.yaml').read_text(encoding='utf-8'))
AUTOMATION = next(item for item in AUTOMATIONS
                  if item.get('id') == 'sovevaerelse_skab_led_driver_always_on')
ENTITY = 'switch.sovevaerelse_skab_led_driver'


class AlwaysOnLedDriverTests(unittest.TestCase):
    def test_restores_power_after_off_and_home_assistant_start(self):
        self.assertIn(
            {'trigger': 'state', 'entity_id': ENTITY, 'to': 'off'},
            AUTOMATION['triggers'],
        )
        self.assertIn({'trigger': 'homeassistant', 'event': 'start'}, AUTOMATION['triggers'])
        self.assertEqual(AUTOMATION['conditions'][0]['entity_id'], ENTITY)
        self.assertEqual(AUTOMATION['conditions'][0]['state'], 'off')
        self.assertEqual(AUTOMATION['actions'][0]['action'], 'switch.turn_on')
        self.assertEqual(AUTOMATION['actions'][0]['target']['entity_id'], ENTITY)


if __name__ == '__main__':
    unittest.main()
