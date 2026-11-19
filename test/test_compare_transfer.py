import json
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

    def test_device_node_explained_and_shared_node_uses_chosen_dialer(self):
        corp = {'name': 'Company relay', 'type': 'http', 'server': '192.0.2.11', 'port': 8080}
        client = {'name': 'Phone Tailnet', 'type': 'tailscale', 'hostname': 'qa-phone'}
        local = {'name': 'Desktop Tailnet', 'type': 'tailscale', 'hostname': 'qa-desktop'}
        with self.store.db:
            self.store._set('customNodes', [corp, {**client, 'profileId': 'phone'}, {**local, 'profileId': 'desktop'}])
        for pid, tail, dialer in [('phone', client, {'dialer-proxy': client['name']}), ('desktop', local, {})]:
            row = self.store._row(pid)
            profile = json.loads(row['body'])
            managed = [tail['name']] if pid == 'phone' else [corp['name'], tail['name']]
            relay = {**corp, 'port': 8081} if pid == 'phone' else corp
            profile.update(groups=[group('corp', 'Company network', 'select', members=[corp['name']])],
                           nodes=[{**relay, **dialer}, tail], customNodeNames=managed,
                           rules=[rule('private', 'DOMAIN', 'private.example.invalid', 'Company network'),
                                  rule('tail', 'DOMAIN', 'tail.example.invalid', tail['name']),
                                  rule('last', 'MATCH', '', 'DIRECT')])
            self.store.save(pid, profile, row['revision'])
            self.store.publish(pid, self.store._row(pid)['revision'])

        draft = self.api.profile_status(self.store._row('desktop'))
        before = self.store.subscription('desktop')
        request = {'profileId': 'desktop', 'revision': draft['revision'], 'currentProfile': draft,
                   'sourceId': 'phone', 'sourceVersion': str(self.store._row('phone')['published'])}
        view = self.api.compare_to_draft(request)
        changes = next(section['items'] for section in view['sections'] if section['title'] == '自定义节点')
        source_node = next(item for item in changes if item['name'] == client['name'])
        target_node = next(item for item in changes if item['name'] == local['name'])
        dialer = next(item for item in changes if item.get('dialerChoice'))
        self.assertIn('只属于来源设备', source_node['applyUnavailable'])
        self.assertNotIn('applyUnavailable', target_node)
        self.assertEqual(dialer['dialerChoice']['options'], ['', local['name']])
        action = {**request, 'changeSet': view['changeSet'], 'change': dialer['restore']}
        with self.assertRaisesRegex(Problem, '只属于来源设备'):
            self.api.compare_to_draft({**action, 'change': source_node['restore']}, apply=True)
        for invalid in (None, client['name'], 'Company network'):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(Problem, '可用的前置代理'):
                self.api.compare_to_draft({**action, 'dialerReplacement': invalid}, apply=True)
        self.assertEqual(self.api.compare_to_draft({**action, 'dialerReplacement': ''}, apply=True), {'unchanged': True})
        self.assertEqual(self.store._row('desktop')['revision'], draft['revision'])
        applied = self.api.compare_to_draft({**action, 'dialerReplacement': local['name']}, apply=True)
        self.assertEqual(applied['profile']['customNodeDialers'][corp['name']], local['name'])
        self.assertEqual(next(node for node in applied['profile']['nodes'] if node['name'] == corp['name'])['port'], 8080)
        self.assertEqual(self.store.subscription('desktop'), before)
        undone = self.api.undo_compare_change({'profileId': 'desktop',
            'revision': applied['profile']['revision'], 'undoToken': applied['undoToken']})
        self.assertEqual(undone['profile']['customNodeDialers'], draft['customNodeDialers'])
