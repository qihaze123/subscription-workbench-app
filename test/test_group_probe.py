import unittest
from contextlib import nullcontext
from unittest.mock import PropertyMock, patch
from urllib.error import HTTPError

from backend.probe_target import DEFAULT_PROBE_URL
from backend.store import Problem
from workbench_probe import WorkbenchProbe


class GroupProbeTest(unittest.TestCase):
    def setUp(self):
        self.probe = WorkbenchProbe(None)
        available = patch.object(WorkbenchProbe, 'available', new_callable=PropertyMock, return_value=True)
        available.start()
        self.addCleanup(available.stop)
        port = patch('workbench_probe.local_port', return_value=4000)
        port.start()
        self.addCleanup(port.stop)
        self.addCleanup(self.probe.workers.shutdown)
        self.document = {
            'proxies': [{'name': name, 'type': 'http', 'server': '192.0.2.10', 'port': 8080}
                        for name in ('one', 'two', 'three')],
            'proxy-groups': [{'name': 'Group', 'type': 'select', 'proxies': ['one', 'two', 'three']}],
        }

    def test_one_core_returns_all_requested_nodes_including_missing_results(self):
        with patch.object(self.probe, 'running_core', return_value=nullcontext()) as core, \
                patch('workbench_probe.fetch', return_value={'one': 120}) as fetch:
            result = self.probe.measure_group(self.document, 'Group', DEFAULT_PROBE_URL, ['one', 'two'])
        self.assertEqual(list(result['results']), ['one', 'two'])
        self.assertEqual(result['results']['one']['delayMs'], 120)
        self.assertEqual(result['results']['two']['status'], 'failed')
        self.assertEqual(core.call_args.args[0]['proxy-groups'][-1]['proxies'], ['one', 'two'])
        core.assert_called_once()
        fetch.assert_called_once()

    def test_all_cores_timed_out_still_returns_one_result_per_node(self):
        timeout = HTTPError('http://127.0.0.1', 504, 'Gateway Timeout', {}, None)
        with patch.object(self.probe, 'running_core', return_value=nullcontext()), \
                patch('workbench_probe.fetch', side_effect=timeout):
            result = self.probe.measure_group(self.document, 'Group', DEFAULT_PROBE_URL)
        self.assertEqual(list(result['results']), ['one', 'two', 'three'])
        self.assertTrue(all(item['status'] == 'failed' for item in result['results'].values()))

    def test_rejects_nodes_outside_the_group(self):
        with self.assertRaises(Problem) as raised:
            self.probe.measure_group(self.document, 'Group', DEFAULT_PROBE_URL, ['one', 'outside'])
        self.assertEqual(raised.exception.status, 422)
