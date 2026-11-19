import tempfile
import unittest
from pathlib import Path

from backend.compiler import parse_yaml
from backend.store import Problem, Store
from workbench_api import WorkbenchAPI


class HostsEditingTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.store = Store(Path(temp.name) / 'workbench.sqlite3')
        self.addCleanup(self.store.close)
        self.api = WorkbenchAPI(self.store, None)

    def change(self, action, pid, **fields):
        revision = self.store._row(pid)['revision']
        return self.api.mutate_profile(action, {'profileId': pid, 'revision': revision, **fields})['profile']

    def test_draft_publish_bulk_delete_and_recovery_stay_within_one_profile(self):
        desktop_before = self.store.subscription('desktop')
        phone_before = self.store.subscription('phone')
        hosts = {'*.example.invalid': ['192.0.2.11', '2001:db8::1'], 'app.example.invalid': 'intranet.example.invalid'}
        draft = self.change('save-draft', 'desktop', updates={'hosts': hosts})
        self.assertEqual(draft['hosts'], hosts)
        self.assertEqual(self.store.subscription('desktop'), desktop_before)
        version = self.change('publish', 'desktop', currentProfile=draft)['publishedVersion']
        self.assertEqual(parse_yaml(self.store.subscription('desktop'))['hosts'], hosts)
        self.change('publish', 'desktop', currentProfile={'hosts': {}})
        self.assertEqual(parse_yaml(self.store.subscription('desktop'))['hosts'], {})
        restored = self.change('rollback', 'desktop', targetVersion=version)
        self.assertEqual(restored['hosts'], hosts)
        self.assertEqual(parse_yaml(self.store.subscription('desktop'))['hosts'], {})
        self.change('publish', 'desktop', currentProfile=restored)
        self.assertEqual(parse_yaml(self.store.subscription('desktop'))['hosts'], hosts)
        self.assertEqual(self.store.subscription('phone'), phone_before)

    def test_reject_duplicate_domain_and_invalid_targets(self):
        for hosts in (
            ['192.0.2.10'],
            {'a.example.invalid': '999.1.1.1'},
            {'a.example.invalid': ['example.invalid']},
            {'a.example.invalid': '192.0.2.10', 'A.EXAMPLE.INVALID.': '192.0.2.11'},
        ):
            with self.subTest(hosts=hosts), self.assertRaises(Problem) as error:
                self.change('save-draft', 'desktop', updates={'hosts': hosts})
            self.assertEqual(error.exception.status, 422)
