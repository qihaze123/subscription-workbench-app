"""Run optional Linux node checks in short-lived, loopback-only Mihomo instances."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import copy
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import sqlite3
import subprocess
import tempfile
from threading import BoundedSemaphore
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import ProxyHandler, Request, build_opener
from uuid import uuid4

from backend.compiler import dump_yaml, selected_nodes
from backend.local_data import hydrate
from backend.probe_target import DEFAULT_PROBE_URL
from backend.seed import now
from backend.store import Problem


NOTICE = re.compile(r'剩余流量|套餐到期|到期时间|过期时间|下次重置|流量重置|官网')
DIRECT = build_opener(ProxyHandler({}))
WORKERS = 6
GROUP_PROBE_TIMEOUT_MS = 9000


def local_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def fetch(url, token, body=None, response_limit=4096, timeout=8):
    request = Request(url, data=json.dumps(body).encode() if body else None,
                      headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
                      method='PUT' if body else 'GET')
    with DIRECT.open(request, timeout=timeout) as response:
        payload = response.read(response_limit)
    return json.loads(payload) if payload else {}


class WorkbenchProbe:
    def __init__(self, store):
        self.store = store
        self.binary = os.environ.get('WORKBENCH_MIHOMO', '')
        self.jobs = {}
        self.tasks = {}
        self.workers = ThreadPoolExecutor(max_workers=WORKERS)
        self.active = 0
        self.last_batch_start = {}
        self.batch_sequence = 0
        self.group_slot = BoundedSemaphore(1)

    @property
    def available(self):
        return bool(self.binary and os.access(self.binary, os.X_OK))

    def read(self):
        with self.store.lock:
            return {
                'jobs': copy.deepcopy(list(self.jobs.values())),
                'tasks': [{'sourceId': sid, 'sourceUpdatedAt': revision, 'name': name, 'status': task['status']}
                          for (sid, revision, name), task in self.tasks.items()]
            }

    def measurements(self):
        row = self.store.db.execute("SELECT value FROM meta WHERE key='workbenchNodeMeasurements'").fetchone()
        return json.loads(row[0]) if row else {}

    def start(self, scope):
        if not self.available:
            raise Problem('测速内核未启用', 503)
        with self.store.lock:
            sources = {s['id']: s for s in self.store._get('sources') if s.get('enabled', True) and s.get('cache')}
            selected = {}
            selection = scope.get('selection')
            source_id = scope.get('sourceId')
            if selection is not None:
                if not isinstance(selection, list) or not selection or len(selection) > len(sources):
                    raise Problem('请选择有效的测速范围', 422)
                for item in selection:
                    if item['sourceId'] in selected or not isinstance(item['nodes'], list) or not item['nodes']:
                        raise Problem('请选择有效的测速范围', 422)
                    selected[item['sourceId']] = (item['sourceUpdatedAt'], set(item['nodes']))
            elif source_id:
                selected[source_id] = (scope.get('sourceUpdatedAt'), {scope['nodeName']} if scope.get('nodeName') else None)
            else:
                selected = {sid: (source['updatedAt'], None) for sid, source in sources.items()}
            tasks, targets = {}, {}
            for sid, (revision, names) in selected.items():
                source = sources.get(sid)
                if source is None or source.get('updatedAt') != revision:
                    raise Problem('节点列表已更新，请重新打开本页后测速', 409)
                inventory, raw = selected_nodes({'sourceIds': [sid]}, [source])
                notices = {name for raw_name, name in raw[sid] if NOTICE.search(raw_name)}
                nodes = [node for node in inventory if node['name'] not in notices and (names is None or node['name'] in names)]
                if names is not None and names != {node['name'] for node in nodes}:
                    raise Problem('有所选节点不可测速', 422)
                if nodes:
                    targets[sid] = {'sourceUpdatedAt': revision, 'nodes': [node['name'] for node in nodes]}
                    for node in nodes:
                        tasks[(sid, revision, node['name'])] = node
            if not tasks:
                raise Problem('没有可测速的节点', 422)
            signature = json.dumps(scope, sort_keys=True)
            if any(job['status'] == 'running' and json.dumps(job['scope'], sort_keys=True) == signature for job in self.jobs.values()):
                return self.read()
            jid = uuid4().hex
            single = bool(scope.get('nodeName'))
            # Resolve all new nodes before mutating the shared queue.
            new_nodes = {key: hydrate(node) for key, node in tasks.items() if key not in self.tasks}
            finished = [key for key, job in self.jobs.items() if job['status'] != 'running']
            for key in finished[:-15]:
                del self.jobs[key]
            self.jobs[jid] = {'id': jid, 'status': 'running', 'scope': scope, 'startedAt': now(),
                              'targets': targets, 'total': len(tasks), 'completed': 0, 'results': {}}
            for key in tasks:
                if key not in self.tasks:
                    self.tasks[key] = {'node': new_nodes[key], 'status': 'queued', 'single': single, 'jobs': []}
                task = self.tasks[key]
                task['single'] |= single
                task['jobs'].append(jid)
            self.schedule()
            return self.read()

    def schedule(self):
        while self.active < WORKERS:
            queued = [key for key, task in self.tasks.items() if task['status'] == 'queued']
            key = next((key for key in queued if self.tasks[key]['single']), None)
            if key is None:
                # Keep one slot available for an explicitly requested node during a batch.
                if not queued or self.active >= WORKERS - 1:
                    break
                key = min(queued, key=lambda item: self.last_batch_start.get(item[0], 0))
                self.batch_sequence += 1
                self.last_batch_start[key[0]] = self.batch_sequence
            task = self.tasks[key]
            task['status'] = 'running'
            self.active += 1
            self.workers.submit(self.run, key, task['node'])

    def run(self, key, node):
        sid, revision, name = key
        try:
            result = self.measure(node)
        except Exception:
            result = {'status': 'failed', 'exitStatus': 'failed', 'checkedAt': now(), 'reason': '测速内核启动或请求失败'}
        with self.store.lock:
            saved = True
            try:
                with self.store.db:
                    sources = self.store._get('sources')
                    if any(s['id'] == sid and s.get('updatedAt') == revision for s in sources):
                        measurements = self.measurements()
                        previous = measurements.get(sid, {})
                        retained = previous['items'] if previous.get('sourceUpdatedAt') == revision else {}
                        measurements[sid] = {'sourceUpdatedAt': revision, 'finishedAt': now(), 'items': {**retained, name: result}}
                        self.store._set('workbenchNodeMeasurements', measurements)
            except sqlite3.Error:
                saved = False
            for jid in self.tasks.pop(key)['jobs']:
                job = self.jobs[jid]
                job['results'].setdefault(sid, {})[name] = result
                job['completed'] += 1
                if not saved:
                    job['error'] = '有测速结果未能保存'
                if job['completed'] == job['total']:
                    job['status'] = 'failed' if job.get('error') else 'done'
            self.active -= 1
            self.schedule()

    def measure(self, node):
        token = secrets.token_hex(20)
        with tempfile.TemporaryDirectory(prefix='probe-') as directory:
            ports = {local_port()}
            while len(ports) < 2:
                ports.add(local_port())
            control, mixed = ports
            api = f'http://127.0.0.1:{control}'
            group = '__workbench_exit_' + token[:8]
            selector = ('/proxies/' + quote(group, safe=''))
            name = 'probe-node'
            config = {'external-controller': f'127.0.0.1:{control}', 'secret': token, 'mixed-port': mixed,
                      'allow-lan': False, 'bind-address': '127.0.0.1', 'log-level': 'error', 'mode': 'rule',
                      'authentication': ['probe:' + token], 'ipv6': True,
                      'proxies': [{**node, 'name': name}],
                      'proxy-groups': [{'name': group, 'type': 'select', 'proxies': [name]}],
                      'rules': ['MATCH,' + group]}
            with self.running_core(config, directory, api, token):
                return self.check_node(api, selector, mixed, token, name)

    @contextmanager
    def running_core(self, config, directory, api, token):
        config_path = Path(directory) / 'config.yaml'
        config_path.write_text(dump_yaml(config))
        config_path.chmod(0o600)
        process = subprocess.Popen([self.binary, '-d', directory, '-f', str(config_path)],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(30):
                try:
                    fetch(api + '/version', token)
                    break
                except (URLError, OSError):
                    if process.poll() is not None:
                        raise RuntimeError('测速内核启动失败')
                    time.sleep(.12)
            else:
                raise RuntimeError('测速内核启动超时')
            yield
        finally:
            process.terminate()
            try:
                process.wait(3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    def measure_group(self, document, group_name, url, node_names=None):
        if not self.available:
            raise Problem('测速内核未启用', 503)
        nodes = {item['name']: item for item in document['proxies']}
        groups = {item['name']: item for item in document['proxy-groups']}
        root = groups[group_name]
        names = root.get('proxies', [])
        if node_names is not None:
            if (not isinstance(node_names, list) or not node_names
                    or any(not isinstance(name, str) or name not in names for name in node_names)
                    or len(set(node_names)) != len(node_names)):
                raise Problem('请选择本组当前可用的候选节点', 422)
            names = node_names
        if not names:
            raise Problem('本组没有可测速的候选节点', 422)
        if not self.group_slot.acquire(blocking=False):
            raise Problem('另一个策略组正在测速，请稍后重试', 409)
        try:
            return self._measure_group(nodes, groups, root, names, url)
        except (OSError, ValueError, RuntimeError) as exc:
            raise Problem('测速内核未能完成组内测试', 502) from exc
        finally:
            self.group_slot.release()

    def _measure_group(self, nodes, groups, root, names, url):
        dependencies = {}
        pending = list(names)
        while pending:
            name = pending.pop()
            if name in dependencies:
                continue
            if name in nodes:
                dependencies[name] = nodes[name]
                if dialer := nodes[name].get('dialer-proxy'):
                    pending.append(dialer)
            elif name in groups:
                group = groups[name]
                members = group.get('proxies', [])
                if not members:
                    raise Problem(f'策略组「{name}」没有可独立测速的候选节点', 422)
                dependencies[name] = dict(group)
                dependencies[name].pop('use', None)
                pending.extend(members)

        token = secrets.token_hex(20)
        control = local_port()
        api = f'http://127.0.0.1:{control}'
        probe_group = '__workbench_probe_' + token[:8]
        config = {'external-controller': f'127.0.0.1:{control}', 'secret': token,
                  'allow-lan': False, 'log-level': 'error', 'mode': 'rule', 'ipv6': True,
                  'proxies': [node for name, node in dependencies.items() if name in nodes],
                  'proxy-groups': [group for name, group in dependencies.items() if name in groups] +
                                  [{'name': probe_group, 'type': 'select', 'proxies': names}],
                  'rules': ['MATCH,' + probe_group]}
        params = {'url': url, 'timeout': GROUP_PROBE_TIMEOUT_MS,
                  'expected': str(root.get('expected-status', '204' if url == DEFAULT_PROBE_URL else '200-399'))}
        with tempfile.TemporaryDirectory(prefix='group-probe-') as directory:
            with self.running_core(hydrate(config), directory, api, token):
                path = '/group/' + quote(probe_group, safe='') + '/delay?' + urlencode(params)
                try:
                    delays = fetch(api + path, token, response_limit=262144, timeout=GROUP_PROBE_TIMEOUT_MS / 1000 + 2)
                except HTTPError as error:
                    if error.code != 504:
                        raise
                    # Mihomo returns 504 when none of the requested nodes respond.
                    delays = {}
        checked_at = now()
        return {'url': url, 'results': {name: {
            'status': 'ok' if type(delays.get(name)) is int and delays[name] > 0 else 'failed',
            'delayMs': delays.get(name), 'checkedAt': checked_at,
        } for name in names}}

    @staticmethod
    def check_node(api, selector, mixed, token, name):
        result = {'status': 'failed', 'exitStatus': 'failed', 'checkedAt': now()}
        query = urlencode({'url': DEFAULT_PROBE_URL, 'timeout': 6000})
        try:
            delay = fetch(f'{api}/proxies/{quote(name, safe="")}/delay?{query}', token).get('delay')
            if isinstance(delay, int):
                result.update(status='ok', delayMs=delay)
        except URLError as error:
            if getattr(error, 'code', None) in {408, 504} or isinstance(error.reason, TimeoutError):
                result['status'] = 'timeout'
        except (ValueError, OSError):
            pass
        try:
            fetch(api + selector, token, {'name': name})
            response = subprocess.run(['curl', '--silent', '--fail', '--max-time', '6', '--max-filesize', '4096',
                '--noproxy', '', '--proxy', f'http://127.0.0.1:{mixed}', '--proxy-user', 'probe:' + token,
                'https://api64.ipify.org?format=json'], capture_output=True, timeout=8)
            if response.returncode == 28:
                result['exitStatus'] = 'timeout'
            elif response.returncode == 0:
                result.update(exitStatus='ok', exitIp=str(ipaddress.ip_address(json.loads(response.stdout)['ip'])))
        except (ValueError, KeyError, subprocess.TimeoutExpired, OSError):
            pass
        return result
