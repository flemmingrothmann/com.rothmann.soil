"""Exercise native migration/rollback in a temporary config without HA/network."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

import yaml

SCRIPT = Path(os.environ.get('WATERING_MIGRATION_SCRIPT', Path(__file__).resolve().parents[2] / 'tools/migrate-watering-ui.py'))
SPEC = importlib.util.spec_from_file_location('watering_migration', SCRIPT)
migration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(migration)


class FakeApi:
    def __init__(self, root):
        self.root, self.states, self.registry, self.native, self.categories = root, {}, {}, {}, {}
        self.calls, self.fail_command = [], None
        self.dashboards = {}
        for domain in migration.DOMAINS:
            self.load_yaml(domain)
        self.put('automation.manual', 'on', {'id': 'manual', 'current': 0})
        self.put('script.ha_watering_capacity_acquire', 'off', {'current': 0})

    def put(self, entity_id, state, attributes):
        self.states[entity_id] = {'entity_id': entity_id, 'state': str(state), 'attributes': attributes}
        self.registry.setdefault(entity_id, {'entity_id': entity_id, 'labels': ['existing-label'], 'categories': {'other_scope': 'existing-category'}, 'name': None})

    def load_yaml(self, domain):
        for entity_id in list(self.states):
            if entity_id.startswith(domain + '.') and entity_id not in self.native:
                del self.states[entity_id]
        for path in (self.root / 'packages').glob('*.yaml'):
            config = yaml.safe_load(path.read_text()) or {}
            for key, fields in config.get(domain, {}).items():
                entity_id = domain + '.' + key
                initial = fields.get('initial', 'off' if domain == 'input_boolean' else fields.get('min', fields.get('options', ['2000-01-01 00:00:00'])[0]))
                self.put(entity_id, initial, {**fields, 'friendly_name': fields['name'], 'editable': False})

    async def rest(self, path, data=None):
        if path == '/api/states':
            return copy.deepcopy(list(self.states.values()))
        if path.startswith('/api/config/script/config/'):
            return yaml.safe_load((self.root / 'scripts.yaml').read_text())[path.split('/')[-1]]
        if path.startswith('/api/config/automation/config/') and data:
            path = self.root / 'automations.yaml'
            automations = yaml.safe_load(path.read_text())
            automations.append(copy.deepcopy(data))
            path.write_text(yaml.safe_dump(automations))
            self.put('automation.' + data['id'], 'off', {'id': data['id'], 'current': 0})
            return {}
        raise AssertionError(path)

    async def delete_automation(self, identifier):
        path = self.root / 'automations.yaml'
        path.write_text(yaml.safe_dump([a for a in yaml.safe_load(path.read_text()) if str(a['id']) != identifier]))
        entity_id = 'automation.' + identifier
        self.states.pop(entity_id, None)
        self.registry.pop(entity_id, None)

    async def call(self, command, **fields):
        self.calls.append((command, copy.deepcopy(fields)))
        if self.fail_command == command:
            self.fail_command = None
            raise RuntimeError('Simulated failure')
        if command == 'config/entity_registry/list':
            return copy.deepcopy(list(self.registry.values()))
        if command == 'config/entity_registry/get':
            return copy.deepcopy(self.registry[fields['entity_id']])
        if command == 'config/entity_registry/remove':
            self.registry.pop(fields['entity_id'])
            self.states.pop(fields['entity_id'], None)
            return None
        if command == 'config/entity_registry/update':
            entity = self.registry[fields.pop('entity_id')]
            categories = fields.pop('categories', {})
            for scope, category in categories.items():
                if category is None:
                    entity['categories'].pop(scope, None)
                else:
                    entity['categories'][scope] = category
            entity.update(fields)
            return copy.deepcopy(entity)
        if command == 'config/category_registry/list':
            return copy.deepcopy(self.categories.get(fields['scope'], []))
        if command == 'config/category_registry/create':
            entry = {'category_id': fields['scope'] + '_' + fields['name'], 'name': fields['name']}
            self.categories.setdefault(fields['scope'], []).append(entry)
            return copy.deepcopy(entry)
        if command == 'lovelace/config':
            return copy.deepcopy(self.dashboards[fields['url_path']])
        if command == 'lovelace/config/save':
            self.dashboards[fields['url_path']] = copy.deepcopy(fields['config'])
            return None
        domain, action = command.split('/')
        if domain in migration.DOMAINS:
            if action == 'create':
                key = fields['name']
                entity_id = domain + '.' + key
                if entity_id in self.states:
                    raise RuntimeError('ID still owned by YAML')
                self.native[entity_id] = copy.deepcopy(fields)
                initial = 'off' if domain == 'input_boolean' else fields.get('min', fields.get('options', ['2000-01-01 00:00:00'])[0])
                self.put(entity_id, initial, {**fields, 'has_date': fields.get('has_date', False), 'has_time': fields.get('has_time', False), 'editable': True})
                return {'id': key}
            key = fields.pop(domain + '_id')
            entity_id = domain + '.' + key
            if action == 'update':
                self.native[entity_id].update(fields)
                self.states[entity_id]['attributes'].update(fields)
                self.states[entity_id]['attributes']['friendly_name'] = fields['name']
                return {}
            if action == 'delete':
                self.native.pop(entity_id)
                self.states.pop(entity_id, None)
                return {}
        raise AssertionError(command)

    async def service(self, domain, action, **data):
        self.calls.append((domain + '.' + action, copy.deepcopy(data)))
        if action == 'reload':
            if domain in migration.DOMAINS:
                self.load_yaml(domain)
            return []
        entity_id = data['entity_id']
        state = self.states[entity_id]
        if action in ('turn_on', 'turn_off'):
            state['state'] = 'on' if action == 'turn_on' else 'off'
        elif action == 'set_value':
            state['state'] = str(float(data['value']))
        elif action == 'select_option':
            state['state'] = data['option']
        elif action == 'set_datetime':
            state['state'] = data.get('datetime') or data.get('date') or data['time']
        else:
            raise AssertionError((domain, action, data))
        return []


class WateringUiMigrationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'packages').mkdir()
        config = {
            'input_number': {'threshold': {'name': 'Threshold', 'min': 0, 'max': 90, 'step': 1, 'mode': 'box'}},
            'input_boolean': {'alarm': {'name': 'Alarm'}},
            'input_select': {'status': {'name': 'Status', 'options': ['idle', 'waiting_result'], 'initial': 'idle'}},
            'input_datetime': {'manual_soil_alarm_sensor_soil_last_push': {'name': 'Last push', 'has_date': True, 'has_time': True}},
        }
        self.package = self.root / 'packages/terrasse_potter.yaml'
        self.package.write_text(yaml.safe_dump(config), encoding='utf-8')
        capacity = {'script': {'ha_watering_capacity_acquire': {'alias': 'Reserve', 'mode': 'queued', 'sequence': []}}}
        (self.root / 'packages/watering_capacity.yaml').write_text(yaml.safe_dump(capacity))
        (self.root / 'scripts.yaml').write_text('unrelated_script:\n  alias: Keep me\n  sequence: []\n')
        automations = [{'id': 'manual', 'alias': 'Manual', 'use_blueprint': {'path': migration.MANUAL, 'input': {'moisture_sensor': 'sensor.soil', 'threshold_helper': 'input_number.threshold', 'water_alarm': 'input_boolean.alarm'}}}]
        (self.root / 'automations.yaml').write_text(yaml.safe_dump(automations))
        self.api = FakeApi(self.root)
        self.api.states['input_number.threshold']['state'] = '40.0'
        self.api.states['input_boolean.alarm']['state'] = 'on'
        self.api.states['input_select.status']['state'] = 'waiting_result'
        self.api.states['input_datetime.manual_soil_alarm_sensor_soil_last_push']['state'] = '2026-11-12 13:11:38'

    async def test_preview_performs_no_writes(self):
        await migration.migrate(self.root, self.api, False)
        self.assertTrue(self.package.exists())
        self.assertFalse(self.api.native)
        self.assertEqual([c for c, _ in self.api.calls], ['config/entity_registry/list'])

    async def test_native_conversion_preserves_ids_values_scripts_and_other_categories(self):
        before = copy.deepcopy(self.api.states)
        automation_bytes = (self.root / 'automations.yaml').read_bytes()
        script_prefix = (self.root / 'scripts.yaml').read_bytes()
        await migration.migrate(self.root, self.api, True)
        self.assertFalse(self.package.exists())
        self.assertEqual(len(self.api.native), 4)
        for entity_id in self.api.native:
            self.assertTrue(self.api.states[entity_id]['attributes']['editable'])
            self.assertEqual(migration.value_payload(entity_id.split('.')[0], self.api.states[entity_id]), migration.value_payload(entity_id.split('.')[0], before[entity_id]))
            self.assertEqual(self.api.registry[entity_id]['categories']['other_scope'], 'existing-category')
            self.assertEqual(self.api.registry[entity_id]['labels'], ['existing-label'])
        self.assertEqual(self.api.states['automation.manual']['state'], 'on')
        self.assertEqual((self.root / 'automations.yaml').read_bytes(), automation_bytes)
        self.assertTrue((self.root / 'scripts.yaml').read_bytes().startswith(script_prefix.rstrip()))
        self.assertFalse(any(command.startswith(('switch.', 'notify.')) for command, _ in self.api.calls))
        self.assertNotIn('initial', self.api.native['input_select.status'])
        # The native object can now be deleted without any YAML recreating it.
        await self.api.call('input_boolean/delete', input_boolean_id='alarm')
        await self.api.service('input_boolean', 'reload')
        self.assertNotIn('input_boolean.alarm', self.api.states)

    async def test_failed_create_rolls_back_yaml_values_script_and_activation(self):
        sources = {p.name: p.read_bytes() for p in (self.root / 'packages').glob('*.yaml')}
        values = {key: state['state'] for key, state in self.api.states.items()}
        scripts = (self.root / 'scripts.yaml').read_bytes()
        self.api.fail_command = 'input_boolean/create'
        with self.assertRaisesRegex(RuntimeError, 'Simulated failure'):
            await migration.migrate(self.root, self.api, True)
        self.assertFalse(self.api.native)
        self.assertEqual({p.name: p.read_bytes() for p in (self.root / 'packages').glob('*.yaml')}, sources)
        self.assertEqual((self.root / 'scripts.yaml').read_bytes(), scripts)
        for key, value in values.items():
            if key.startswith('input_number.'):
                self.assertEqual(float(self.api.states[key]['state']), float(value))
            else:
                self.assertEqual(self.api.states[key]['state'], value)

    async def test_unavailable_value_and_unrelated_package_content_fail_before_writes(self):
        self.api.states['input_number.threshold']['state'] = 'unavailable'
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            await migration.migrate(self.root, self.api, True)
        self.api.states['input_number.threshold']['state'] = '40'
        self.package.write_text(self.package.read_text() + '\nlight: {}\n')
        with self.assertRaisesRegex(ValueError, 'Unexpected content'):
            await migration.migrate(self.root, self.api, True)
        self.assertFalse(self.api.native)
        self.assertFalse((self.root / 'backups').exists())

    def add_obsolete_alarm(self):
        package = yaml.safe_load(self.package.read_text())
        package['input_number']['obsolete_threshold'] = {'name': 'Obsolete', 'min': 0, 'max': 90}
        self.package.write_text(yaml.safe_dump(package))
        self.api.load_yaml('input_number')
        self.api.states['input_number.threshold']['state'] = '40.0'
        path = self.root / 'automations.yaml'
        automations = yaml.safe_load(path.read_text())
        automations.append({'id': 'obsolete', 'alias': 'Old alarm', 'use_blueprint': {'path': migration.AUTO, 'input': {'moisture_sensor': 'sensor.0x9999999999999999_soil_moisture', 'threshold': 'input_number.obsolete_threshold'}}})
        path.write_text(yaml.safe_dump(automations))
        self.api.put('automation.obsolete', 'on', {'id': 'obsolete', 'current': 0})

    async def test_cleanup_removes_only_unreferenced_legacy_artifacts_and_missing_sensor_alarm(self):
        self.add_obsolete_alarm()
        self.api.put('input_boolean.user_helper', 'on', {'editable': True})
        self.api.native['input_boolean.user_helper'] = {'name': 'User helper'}
        await migration.migrate(self.root, self.api, True, cleanup_unused=True, inventory_ieees=set())
        self.assertNotIn('input_number.obsolete_threshold', self.api.states)
        self.assertNotIn('input_select.status', self.api.states)
        self.assertNotIn('automation.obsolete', self.api.states)
        self.assertEqual(self.api.states['input_boolean.user_helper']['state'], 'on')
        self.assertEqual(self.api.states['input_number.threshold']['state'], '40.0')
        self.assertEqual(len(self.api.native), 4)
        self.assertEqual([a['id'] for a in yaml.safe_load((self.root / 'automations.yaml').read_text())], ['manual'])

    async def test_cleanup_does_not_retire_an_offline_but_still_registered_sensor(self):
        self.add_obsolete_alarm()
        self.api.registry['sensor.0x9999999999999999_soil_moisture'] = {'entity_id': 'sensor.0x9999999999999999_soil_moisture', 'categories': {}}
        await migration.migrate(self.root, self.api, True, cleanup_unused=True, inventory_ieees=set())
        self.assertIn('automation.obsolete', self.api.states)
        self.assertIn('input_number.obsolete_threshold', self.api.native)

    async def test_failed_cleanup_restores_removed_automation_without_overwriting_other_configs(self):
        self.add_obsolete_alarm()
        self.api.fail_command = 'input_boolean/create'
        with self.assertRaisesRegex(RuntimeError, 'Simulated failure'):
            await migration.migrate(self.root, self.api, True, cleanup_unused=True, inventory_ieees=set())
        self.assertEqual([a['id'] for a in yaml.safe_load((self.root / 'automations.yaml').read_text())], ['manual', 'obsolete'])
        self.assertEqual(self.api.states['automation.obsolete']['state'], 'on')
        self.assertTrue(self.package.exists())

    def add_retired_dashboard(self):
        storage = self.root / '.storage'
        storage.mkdir()
        (storage / 'lovelace_dashboards').write_text(json.dumps({'data': {'items': [{'id': 'dashboard_test', 'mode': 'storage', 'url_path': 'dashboard-test'}]}}))
        dashboard = {'views': [{'sections': [{'cards': [
            {'type': 'history-graph', 'entities': ['sensor.temperature']},
            {'type': 'tile', 'entity': 'switch.physical_valve'},
            {'type': 'entities', 'title': 'Vanding af terrassepotter', 'entities': ['automation.no_longer_exists', 'input_select.status']},
        ]}]}]}
        (storage / 'lovelace.dashboard_test').write_text(json.dumps({'data': {'config': dashboard}}))
        self.api.dashboards['dashboard-test'] = copy.deepcopy(dashboard)
        return dashboard

    async def test_only_obsolete_control_card_is_removed_and_its_unused_helpers_are_not_migrated(self):
        original = self.add_retired_dashboard()
        await migration.migrate(self.root, self.api, True, cleanup_unused=True, inventory_ieees=set())
        self.assertEqual(self.api.dashboards['dashboard-test']['views'][0]['sections'][0]['cards'], original['views'][0]['sections'][0]['cards'][:2])
        self.assertNotIn('input_select.status', self.api.states)

    async def test_failed_migration_restores_the_original_dashboard_through_the_api(self):
        original = self.add_retired_dashboard()
        self.api.fail_command = 'input_boolean/create'
        with self.assertRaisesRegex(RuntimeError, 'Simulated failure'):
            await migration.migrate(self.root, self.api, True, cleanup_unused=True, inventory_ieees=set())
        self.assertEqual(self.api.dashboards['dashboard-test'], original)

    async def test_live_controller_profile_references_are_kept_even_without_an_automation_reference(self):
        await migration.migrate(self.root, self.api, True, cleanup_unused=True, inventory_ieees=set(), protected_helpers={'input_select.status'})
        self.assertIn('input_select.status', self.api.native)
        self.assertEqual(self.api.states['input_select.status']['state'], 'waiting_result')

    async def test_a_renamed_sensor_keeps_its_automatic_alarm_by_stable_ieee_identity(self):
        self.add_obsolete_alarm()
        self.api.registry['sensor.renamed_plant'] = {'entity_id': 'sensor.renamed_plant', 'unique_id': '0x9999999999999999_soil_moisture_zigbee2mqtt', 'categories': {}}
        await migration.migrate(self.root, self.api, True, cleanup_unused=True, inventory_ieees=set())
        self.assertIn('automation.obsolete', self.api.states)
        self.assertIn('input_number.obsolete_threshold', self.api.native)

    def test_only_unreferenced_restored_registry_artifacts_owned_by_legacy_watering_are_removed(self):
        states = {
            'automation.retired': {'attributes': {'restored': True, 'id': 'wingman_vanding_terasse_potter_watering'}},
            'input_boolean.efeu_water_alarm': {'attributes': {'restored': True}},
            'automation.live': {'attributes': {'id': 'wingman_vanding_terasse_potter_live'}},
            'automation.user_entity': {'attributes': {'restored': True, 'id': 'user_entity'}},
        }
        registry = {eid: {'entity_id': eid} for eid in states}
        candidates = migration.obsolete_registry_entries(states, registry, 'input_boolean.efeu_water_alarm')
        self.assertEqual([entry['entity_id'] for entry in candidates], ['automation.retired'])


if __name__ == '__main__':
    unittest.main()
