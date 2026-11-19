import tempfile
import unittest
from pathlib import Path

from backend.compiler import parse_yaml
from backend.seed import group, rule
from backend.store import Problem, Store
from workbench_api import WorkbenchAPI


class GroupDeletionTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.store = Store(Path(temp.name) / 'workbench.sqlite3', seed_demo=False)
        self.addCleanup(self.store.close)
        self.api = WorkbenchAPI(self.store, None)

    def test_delete_removes_direct_raw_and_nested_references(self):
        profile = self.store.create({
            'id': 'delete-group',
            'name': 'Test',
            'device': 'desktop',
            'groups': [
                group('old', 'Old', 'select', members=['DIRECT']),
                group('parent', 'Parent', 'select', members=['Old', 'DIRECT']),
            ],
            'rules': [
                rule('domain', 'DOMAIN-SUFFIX', 'example.invalid', 'Old'),
                rule('raw', 'RAW', 'IP-CIDR,198.51.100.0/24,Old,no-resolve', 'DIRECT'),
                rule('last', 'MATCH', '', 'Parent'),
            ],
        })
        published = self.api.mutate_profile('publish', {
            'profileId': profile['id'], 'revision': profile['revision'], 'currentProfile': profile,
        })
        old_yaml = self.store.subscription(profile['id'])
        draft = self.api.mutate_profile('save-draft', {
            'profileId': profile['id'], 'revision': published['profile']['revision'],
            'updates': {'groups': profile['groups'][1:]},
        })['profile']
        self.assertEqual([item['id'] for item in draft['rules']], ['last'])
        self.assertEqual(draft['groups'][0]['members'], ['DIRECT'])
        self.assertEqual(self.store.subscription(profile['id']), old_yaml)
        self.api.mutate_profile('publish', {
            'profileId': profile['id'], 'revision': draft['revision'], 'currentProfile': draft,
        })
        self.assertEqual(parse_yaml(self.store.subscription(profile['id']))['rules'], ['MATCH,Parent'])

    def test_delete_requires_replacement_for_match_dns_and_dialer(self):
        profile = self.store.create({
            'id': 'replace-group',
            'name': 'Test',
            'device': 'desktop',
            'groups': [group('old', 'Old', 'select', members=['DIRECT'])],
            'rules': [rule('last', 'RAW', 'MATCH,Old', 'Old')],
            'nodes': [{
                'name': 'Test relay', 'type': 'http', 'server': '192.0.2.10',
                'port': 8080, 'dialer-proxy': 'Old',
            }],
            'network': {'dns': {'enable': True, 'nameserver': ['https://dns.example.invalid/dns-query#Old&h3=true']}},
        })
        request = {'profileId': profile['id'], 'revision': profile['revision'], 'updates': {'groups': []}}
        with self.assertRaisesRegex(Problem, '兜底规则选择替代目标'):
            self.api.mutate_profile('save-draft', request)
        with self.assertRaisesRegex(Problem, '前置代理或策略组回退'):
            self.api.mutate_profile('save-draft', {**request, 'updates': {'groups': [], 'rules': []}})
        request['updates']['groupDeletionTargets'] = {'Old': 'DIRECT'}
        draft = self.api.mutate_profile('save-draft', request)['profile']
        self.assertEqual(draft['rules'][0]['value'], 'MATCH,DIRECT')
        self.assertEqual(draft['nodes'][0]['dialer-proxy'], 'DIRECT')
        self.assertEqual(draft['network']['dns']['nameserver'], ['https://dns.example.invalid/dns-query#DIRECT&h3=true'])
