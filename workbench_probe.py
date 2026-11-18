"""Run optional Linux node checks in short-lived, loopback-only Mihomo instances."""

from concurrent.futures import ThreadPoolExecutor
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
import time
from urllib.error import URLError
from urllib.parse import quote, urlencode
from urllib.request import ProxyHandler, Request, build_opener
from uuid import uuid4

from backend.compiler import dump_yaml, selected_nodes
from backend.local_data import hydrate
from backend.seed import now
from backend.store import Problem


NOTICE = re.compile(r'剩余流量|套餐到期|到期时间|过期时间|下次重置|流量重置|官网')
DIRECT = build_opener(ProxyHandler({}))
WORKERS = 6


def local_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def fetch(url, token, body=None):
    request = Request(url, data=json.dumps(body).encode() if body else None,
                      headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
                      method='PUT' if body else 'GET')
    with DIRECT.open(request, timeout=8) as response:
        payload = response.read(4096)
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
            config_path = Path(directory) / 'config.yaml'
            config_path.write_text(dump_yaml(config))
            process = subprocess.Popen([self.binary, '-d', directory, '-f', str(config_path)],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                for _ in range(30):
                    try:
                        fetch(api + '/version', token)
                        break
                    except (URLError, OSError):
                        if process.poll() is not None:
                            raise RuntimeError('内核启动失败')
                        time.sleep(.12)
                else:
                    raise RuntimeError('内核启动超时')
                return self.check_node(api, selector, mixed, token, name)
            finally:
                process.terminate()
                try:
                    process.wait(3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()

    @staticmethod
    def check_node(api, selector, mixed, token, name):
        result = {'status': 'failed', 'exitStatus': 'failed', 'checkedAt': now()}
        query = urlencode({'url': 'https://www.gstatic.com/generate_204', 'timeout': 6000})
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
