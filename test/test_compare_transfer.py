import tempfile
import unittest
from pathlib import Path

from backend.seed import group, rule
from backend.store import Problem, Store
from workbench_api import WorkbenchAPI


class CompareTransferTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.store = Store(Path(temp.name) / 'workbench.sqlite3')
        self.addCleanup(self.store.close)
        self.api = WorkbenchAPI(self.store, None)

    def source(self, source_id, version, item, section, operation=None):
        current = self.api.profile_status(self.store._row('desktop'))
        request = {'profileId': 'desktop', 'revision': current['revision'], 'currentProfile': current,
                   'sourceId': source_id, 'sourceVersion': str(version)}
        view = self.api.compare_to_draft(request)
        rows = next(entry['items'] for entry in view['sections'] if entry['title'] == section)
        difference = next(row for row in rows if item in row['name'] and (not operation or row['kind'] == operation))
        return {**request, 'changeSet': view['changeSet'], 'change': difference['restore']}

    def test_cross_profile_import_prompts_for_nested_dependencies_and_undo(self):
        phone = self.api.profile_status(self.store._row('phone'))
        version = self.api.mutate_profile('publish', {
            'profileId': 'phone', 'revision': phone['revision'], 'currentProfile': {
                'groups': [
                    group('phone-outer', 'Other route', 'select', members=['Shared region']),
                    group('phone-inner', 'Shared region', 'select', members=['DIRECT']),
                ],
                'rules': [
                    rule('added', 'DOMAIN', 'merge-test.example.invalid', 'Other route'),
                    rule('default', 'MATCH', '', 'DIRECT'),
                ],
            },
        })['version']
        before = self.store.subscription('desktop')
        request = self.source('phone', version, 'merge-test.example.invalid', '分流规则', 'removed')
        plan = self.api.compare_to_draft(request, apply=True)
        self.assertEqual(plan['dependencies']['groups'], ['Other route', 'Shared region'])
        self.assertEqual(self.store._row('desktop')['revision'], request['revision'])
        result = self.api.compare_to_draft({**request, 'includeDependencies': True}, apply=True)
        self.assertEqual({g['name'] for g in result['profile']['groups']} & {'Other route', 'Shared region'},
                         {'Other route', 'Shared region'})
        rules = result['profile']['rules']
        self.assertLess(next(i for i, r in enumerate(rules) if r['id'] == 'added'),
                        next(i for i, r in enumerate(rules) if r['type'] == 'MATCH'))
        self.assertEqual(self.store.subscription('desktop'), before)
        restored = self.api.undo_compare_change({
            'profileId': 'desktop', 'revision': result['profile']['revision'], 'undoToken': result['undoToken'],
        })
        self.assertFalse(restored['profile']['hasDraft'])
        self.assertNotIn('Other route', {g['name'] for g in restored['profile']['groups']})

    def test_history_each_host_change_and_multistep_undo(self):
        current = self.api.profile_status(self.store._row('desktop'))
        baseline = {'restore.example.invalid': '192.0.2.11', 'update.example.invalid': '192.0.2.12'}
        level = self.api.mutate_profile('publish', {
            'profileId': 'desktop', 'revision': current['revision'], 'currentProfile': {'hosts': baseline},
        })
        draft = {'update.example.invalid': '192.0.2.22', 'remove.example.invalid': '192.0.2.23'}
        self.api.mutate_profile('save-draft', {
            'profileId': 'desktop', 'revision': level['profile']['revision'], 'updates': {'hosts': draft},
        })
        steps = [('restore', 'removed'), ('update', 'changed'), ('remove', 'added')]
        for item, operation in steps:
            request = self.source('desktop', level['version'], item, 'Hosts', operation)
            result = self.api.compare_to_draft(request, apply=True)
        self.assertEqual(result['profile']['hosts'], baseline)
        undo = {'profileId': 'desktop', 'revision': result['profile']['revision'], 'undoToken': result['undoToken']}
        for _ in steps:
            result = self.api.undo_compare_change(undo)
            undo.update(revision=result['profile']['revision'], undoToken=result['undoToken'])
        self.assertEqual(result['profile']['hosts'], draft)
        with self.assertRaises(Problem):
            self.api.compare_to_draft(request, apply=True)

    def test_different_ids_do_not_count_as_rule_changes(self):
        current = self.api.profile_status(self.store._row('desktop'))
        phone = self.api.profile_status(self.store._row('phone'))
        rules = [{**r, 'id': 'other-' + r['id']} for r in current['rules']]
        source = self.api.mutate_profile('publish', {
            'profileId': 'phone', 'revision': phone['revision'], 'currentProfile': {'rules': rules},
        })
        result = self.api.compare_to_draft({
            'profileId': 'desktop', 'revision': current['revision'], 'currentProfile': current,
            'sourceId': 'phone', 'sourceVersion': str(source['version']),
        })
        self.assertNotIn('分流规则', {item['title'] for item in result['sections']})
