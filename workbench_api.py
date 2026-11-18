"""Serve the workbench UI from the production SQLite store."""

import copy
import gzip
import json
import time
import urllib.parse
from pathlib import Path
from uuid import uuid4

from backend.compiler import compile_profile as compile_clash, parse_yaml
from backend.custom_nodes import change_catalog, migrate_profiles, public_node, select_nodes
from backend.distribution import public_metadata
from backend.local_data import hydrate
from backend.probe_target import DEFAULT_PROBE_URL, group_probe_url
from backend.rule_templates import catalog, load_template
from backend.seed import now
from backend.store import Problem, clean_profile, js
from backend.subscription_parser import parse_source_nodes
from live_backend import inventory, prepare_profile
from profile_compare import compare_profiles, make_draft_review
from workbench_probe import WorkbenchProbe


def compile_profile(profile, sources, company):
    return compile_clash(prepare_profile(profile, sources), sources, company)


def normalize_profile(profile):
    result = copy.deepcopy(profile)
    result['hosts'] = result.get('extras', {}).get('hosts', {})
    return result


def reconcile_group_names(profile, *baselines):
    groups = profile.get('groups', [])
    names = {group['id']: group.get('name') for group in groups if group.get('id')}
    active_names = {item.get('name') for item in [*groups, *profile.get('nodes', [])]}
    renames = {}
    for baseline in baselines:
        for group in (baseline or {}).get('groups', []):
            old = group.get('name')
            new = names.get(group.get('id'))
            if old and new and old not in active_names:
                renames[old] = new
    if not renames:
        return profile
    return retarget_references(copy.deepcopy(profile), renames)


def retarget_references(profile, renames):
    def target(name):
        return renames.get(name, name) if isinstance(name, str) else name

    for group in profile.get('groups', []):
        if isinstance(group.get('members'), list):
            group['members'] = [target(name) for name in group['members']]
        options = group.get('options') or {}
        for key in ('excluded', 'priority'):
            if isinstance(options.get(key), list):
                options[key] = [target(name) for name in options[key]]
    for rule in profile.get('rules', []):
        if isinstance(rule.get('target'), str) and rule['target'] in renames:
            rule['target'] = target(rule['target'])
        if rule.get('type') == 'RAW' and isinstance(rule.get('value'), str):
            parts = rule['value'].split(',')
            index = len(parts) - (2 if parts[-1] == 'no-resolve' else 1)
            if index > 0 and parts[index] in renames:
                parts[index] = target(parts[index])
                rule['value'] = ','.join(parts)
    for node in profile.get('nodes', []):
        if 'dialer-proxy' in node:
            node['dialer-proxy'] = target(node['dialer-proxy'])

    def dns_target(value):
        if isinstance(value, list):
            return [dns_target(child) for child in value]
        if isinstance(value, dict):
            return {key: dns_target(child) for key, child in value.items()}
        if not isinstance(value, str) or '#' not in value:
            return value
        address, options = value.split('#', 1)
        group, separator, settings = options.partition('&')
        return address + '#' + target(group) + separator + settings

    network = profile.get('network') or {}
    if 'dns' in network:
        network['dns'] = dns_target(network['dns'])
    return profile


def public_profile(profile):
    result = normalize_profile(profile)
    result.pop('extras', None)
    managed = set(result.pop('customNodeNames', []))
    result['customNodeDialers'] = {node['name']: node['dialer-proxy'] for node in result.get('nodes', [])
                                   if node['name'] in managed and node.get('dialer-proxy')}
    result['nodes'] = [public_node(node, managed) for node in result.get('nodes', [])]
    for group in result.get('groups', []):
        previous = (group.get('extra') or {}).get('tolerance')
        if 'url' not in (group.get('options') or {}) and (group.get('extra') or {}).get('url'):
            group['probeUrlHint'] = group['extra']['url']
        if type(previous) is int and 'tolerance' not in group.get('options', {}):
            group['toleranceHint'] = previous
        group.pop('extra', None)
    return result


def public_source(source, measured=None):
    result = {key: source[key] for key in ('id', 'name', 'prefix', 'enabled', 'status', 'updatedAt') if key in source}
    result['nodes'] = inventory(source)
    result['rawUrlStored'] = bool(source.get('url'))
    result['nodeCount'] = len(result['nodes'])
    result['lastRefreshError'] = source.get('error', '')
    if measured and measured.get('sourceUpdatedAt') == source.get('updatedAt'):
        result['lastMeasurement'] = {'finishedAt': measured['finishedAt']}
        for node in result['nodes']:
            if node['name'] in measured['items']:
                node['measurement'] = measured['items'][node['name']]
    return result


def gzip_for_ui(method, path, kind, accept_encoding, body):
    if method != 'GET' or len(body) < 1024:
        return body, {}
    if not (path in {'/api/data', '/api/history', '/api/profile/published', '/api/public-rules'} or
            kind.split(';', 1)[0] in {'text/html', 'text/javascript', 'application/javascript', 'text/css'}):
        return body, {}
    qualities = {}
    for item in accept_encoding.lower().split(','):
        encoding, *parameters = item.split(';')
        quality = 1
        for parameter in parameters:
            key, _, value = parameter.strip().partition('=')
            if key.strip() == 'q':
                try:
                    quality = float(value)
                except ValueError:
                    quality = 0
        qualities[encoding.strip()] = quality
    headers = {'Vary': 'Accept-Encoding'}
    if qualities.get('gzip', qualities.get('*', 0)) > 0:
        headers['Content-Encoding'] = 'gzip'
        body = gzip.compress(body, compresslevel=6, mtime=0)
    return body, headers


class WorkbenchAPI:
    def __init__(self, store, distribution):
        self.store = store
        self.distribution = distribution
        with store.lock, store.db:
            if store.db.execute("SELECT 1 FROM meta WHERE key='customNodes'").fetchone() is None:
                profiles = [json.loads(row['body']) for row in store.db.execute('SELECT body FROM profiles ORDER BY rowid')]
                before = {profile['id']: js(profile) for profile in profiles}
                store._set('customNodes', migrate_profiles(profiles, retarget_references))
                store._set('customNodesRevision', 1)
                for profile in profiles:
                    if js(profile) != before[profile['id']]:
                        store.db.execute('UPDATE profiles SET body=?,revision=revision+1 WHERE id=?',
                                         (js(profile), profile['id']))
        if not hasattr(store, 'workbench_probe'):
            store.workbench_probe = WorkbenchProbe(store)
        self.probe = store.workbench_probe
        self.public_rules = catalog()['templates']

    def profile_status(self, row):
        record = self.store._record(row)
        if row['published']:
            frozen = self.store._version(row['id'], row['published'])
            baseline = json.loads(frozen['body'])
            current = json.loads(row['body'])
            edited = current != baseline
            draft = reconcile_group_names(current, baseline)
            record = {**draft, **{key: record[key] for key in (
                'revision', 'updatedAt', 'publishedVersion', 'publishedAt', 'hasDraft'
            )}}
            record['hasPendingSourceChanges'] = record['hasDraft'] and not edited
            record['hasDraft'] = edited
            if edited or record['hasPendingSourceChanges']:
                comparison, _, _ = self.review_difference(row, draft)
                record['hasPendingConfiguration'] = bool(comparison['sections'])
            else:
                record['hasPendingConfiguration'] = False
        return public_profile(record)

    def snapshot(self, pid, version):
        if version == 'draft':
            row = self.store._row(pid)
            current = json.loads(row['body'])
            published = json.loads(self.store._version(pid, row['published'])['body']) if row['published'] else None
            return {'version': 'draft', 'profile': normalize_profile(reconcile_group_names(current, published))}
        if not isinstance(version, str) or not version.isdecimal():
            raise Problem('所选版本已不存在，请重新选择。', 404)
        row = self.store._version(pid, int(version))
        raw = parse_yaml(row['yaml'])
        try:
            resolved = hydrate(raw)
        except ValueError:
            resolved = None
        return {'profile': normalize_profile(json.loads(row['body'])), 'version': row['version'],
                'effectiveRules': raw.get('rules', []), 'document': resolved}

    def draft_document(self, profile, sources, company):
        result, document = compile_profile(profile, sources, company)
        if result['ok']:
            try:
                return hydrate(document)
            except ValueError:
                pass
        return None

    def review_difference(self, row, draft):
        version = row['published']
        sources, company = self.store._get('sources'), self.store._get('company')
        frozen = self.store._version(row['id'], version)
        baseline = json.loads(frozen['body'])
        comparison = compare_profiles(self.snapshot(row['id'], str(version)),
                                      {'version': 'draft', 'profile': normalize_profile(draft)},
                                      sources, company, parse_yaml, self.draft_document)
        restore_profile, actions = make_draft_review(comparison, baseline, draft, parse_yaml(frozen['yaml']))
        comparison['canRestoreAll'] = bool(actions)
        return comparison, restore_profile, actions

    def review_draft(self, data, restore=False):
        store = self.store
        with store.lock, store.db:
            row = store._row(data.get('profileId'))
            store._check_revision(row, data.get('revision'))
            if not row['published'] or row['published'] != data.get('publishedVersion'):
                raise Problem('当前发布版本已变化，请刷新后再查看变更。', 409)
            published = json.loads(store._version(row['id'], row['published'])['body'])
            target = self.merge_draft(json.loads(row['body']), data.get('currentProfile'), published)
            comparison, baseline, actions = self.review_difference(row, target)
            if not restore:
                return comparison
            requested = data.get('restore')
            if requested == 'all' and actions:
                target = baseline
            elif requested in actions:
                actions[requested](target)
            else:
                raise Problem('这项变动已更新，请重新查看后再恢复。', 409)
            if target != json.loads(row['body']):
                store.save(row['id'], target, row['revision'])
            return {'profile': self.profile_status(store._row(row['id']))}

    @staticmethod
    def public_snapshot(row):
        document = parse_yaml(row['yaml'])
        profile = public_profile(json.loads(row['body']))
        return {'version': row['version'], 'publishedAt': row['created'],
                'profile': {**profile, 'publishedVersion': row['version'], 'publishedAt': row['created']},
                'effectiveRules': document.get('rules', []), 'nodeCount': len(document.get('proxies', []))}

    def history_metadata(self):
        with self.store.lock:
            history = {}
            for row in self.store.db.execute('SELECT profile_id, version, created, stats FROM versions ORDER BY version DESC'):
                history.setdefault(row['profile_id'], []).append({'version': row['version'],
                    'publishedAt': row['created'], 'ruleCount': json.loads(row['stats']).get('rules')})
            return history

    def bootstrap(self, tailnet_admin, compact=False):
        with self.store.lock:
            rows = list(self.store.db.execute('SELECT * FROM profiles ORDER BY rowid'))
            profiles = [self.profile_status(row) for row in rows]
            measurements = self.probe.measurements()
            data = {'liveData': True, 'profiles': profiles, 'company': self.store._get('company'),
                    **self.custom_nodes_data(),
                    'sources': [public_source(source, measurements.get(source['id'])) for source in self.store._get('sources')],
                    'nodeProbeAvailable': self.probe.available, 'groupProbeAvailable': self.probe.available,
                    'defaultProbeUrl': DEFAULT_PROBE_URL, 'draftReviewAvailable': True,
                    'distribution': public_metadata(self.distribution, self.store, prefer_tailnet=bool(tailnet_admin))}
            if compact:
                counts = {row['profile_id']: row['count'] for row in self.store.db.execute(
                    'SELECT profile_id, count(*) AS count FROM versions GROUP BY profile_id')}
                return {**data, 'historyCounts': counts, 'publicRuleCount': len(self.public_rules)}
            history = {profile['id']: [] for profile in profiles}
            for row in self.store.db.execute('SELECT * FROM versions ORDER BY version DESC'):
                history[row['profile_id']].append(self.public_snapshot(row))
            return {**data, 'history': history, 'publicRuleLibrary': self.public_rules}

    @staticmethod
    def merge(current, updates, published=None):
        if not isinstance(updates, dict):
            raise Problem('缺少配置内容', 422)
        result = {**current, **{key: updates[key] for key in ('name', 'groups', 'rules', 'network', 'sourceIds') if key in updates}}
        extras = {group.get('id'): group.get('extra', {}) for group in current.get('groups', [])}
        result['groups'] = [{**{key: value for key, value in group.items() if key not in {'toleranceHint', 'probeUrlHint', 'extra'}},
                             'extra': extras.get(group.get('id'), {})} for group in result.get('groups', [])]
        for group in result['groups']:
            options = group.get('options') or {}
            if 'tolerance' in options and (type(options['tolerance']) is not int or not 0 <= options['tolerance'] <= 65535):
                raise Problem('节点切换容差必须是 0 到 65535 的整数，单位 ms。', 422)
            if 'url' in options:
                try:
                    group_probe_url(group)
                except ValueError as error:
                    raise Problem(f'{group["name"]}：{error}', 422) from None
        if 'hosts' in updates:
            result['extras'] = {**result.get('extras', {}), 'hosts': updates['hosts']}
        for rule in result.get('rules', []):
            if 'publicSet' not in rule:
                continue
            snapshot = rule['publicSet']
            entries = snapshot.get('entries', [])
            if rule.get('type') != 'GEOSITE' or not isinstance(entries, list) or not entries or any(
                not isinstance(entry, str) or not entry or ',' in entry or '\n' in entry for entry in entries
            ):
                raise Problem('公共规则快照格式无效', 422)
        return reconcile_group_names(result, published, current)

    def mutate_profile(self, action, data):
        pid = data.get('profileId')
        store = self.store
        with store.lock, store.db:
            if 'nodeChange' in data:
                raise Problem('请在「订阅源与节点」管理自定义节点', 422)
            if action == 'create':
                name = str(data.get('name', '')).strip()
                if not name:
                    raise Problem('请输入配置名称', 422)
                row = store.create({'name': name, 'device': data.get('device', 'desktop'), 'sourceIds': [],
                                    'nodes': [], 'groups': [], 'rules': [{'type': 'MATCH', 'target': 'DIRECT', 'value': '', 'enabled': True}],
                                    'network': {'dns': {'enable': True, 'ipv6': False, 'enhanced-mode': 'fake-ip'}}})
                return {'profile': public_profile(row)}
            if action == 'duplicate':
                source = json.loads(store._row(data.get('sourceProfileId'))['body'])
                source.pop('id', None)
                source['name'] = str(data.get('newName') or source['name']).strip()
                pid = 'profile-' + uuid4().hex[:12]
                source['id'] = pid
                sources, company = store._get('sources'), store._get('company')
                compiled, value = compile_profile(source, sources, company)
                if not compiled['ok']:
                    raise Problem('副本校验失败', 422, details=[error['message'] for error in compiled['errors']])
                hydrate(value)
                stamp = now()
                store.db.execute('INSERT INTO profiles VALUES(?,?,?,?,?)', (pid, js(source), 1, stamp, 1))
                store.db.execute('INSERT INTO versions VALUES(?,?,?,?,?,?,?,?)',
                    (pid, 1, stamp, js(source), compiled['yaml'], js(compiled['stats']), js(sources), js(company)))
                return {'profile': public_profile(store._record(store._row(pid)))}
            row = store._row(pid)
            store._check_revision(row, data.get('revision'))
            current = json.loads(row['body'])
            if action in {'discard-draft', 'rollback'}:
                version = row['published'] if action == 'discard-draft' else data.get('targetVersion')
                restored = json.loads(store._version(pid, version)['body'])
                store.save(pid, restored, row['revision'])
                return {'profile': self.profile_status(store._row(pid)),
                        'message': '已载入历史版本的草稿'}
            published = json.loads(store._version(pid, row['published'])['body']) if row['published'] else None
            updates = data.get('updates') if action == 'save-draft' else data.get('currentProfile')
            target = self.merge_draft(current, updates, published)
            if action == 'save-draft':
                store.save(pid, target, row['revision'])
                return {'profile': self.profile_status(store._row(pid))}
            sources, company = store._get('sources'), store._get('company')
            compiled, document = compile_profile(target, sources, company)
            if not compiled['ok']:
                raise Problem('发布校验失败', 422, details=[error['message'] for error in compiled['errors']])
            hydrate(document)
            stamp = now()
            version = store.db.execute('SELECT coalesce(max(version),0)+1 FROM versions WHERE profile_id=?', (pid,)).fetchone()[0]
            store.db.execute('INSERT INTO versions VALUES(?,?,?,?,?,?,?,?)',
                (pid, version, stamp, js(clean_profile(target)), compiled['yaml'], js(compiled['stats']), js(sources), js(company)))
            store.db.execute('UPDATE profiles SET body=?,published=?,updated=?,revision=revision+1 WHERE id=?',
                (js(clean_profile(target)), version, stamp, pid))
            return {'profile': self.profile_status(store._row(pid)), 'version': version,
                    'publishedAt': stamp, 'effectiveRules': document['rules'], 'nodeCount': len(document['proxies'])}

    def merge_draft(self, current, updates, published):
        target = self.merge(current, updates, published)
        return select_nodes(target, self.store._get('customNodes'), updates.get('customNodeDialers'))

    def custom_nodes_data(self):
        nodes = self.store._get('customNodes')
        names = {node['name'] for node in nodes}
        return {'customNodes': [public_node(node, names) for node in nodes],
                'customNodesRevision': self.store._get('customNodesRevision')}

    def mutate_custom_nodes(self, data):
        store = self.store
        with store.lock, store.db:
            revision = store._get('customNodesRevision')
            if data.get('revision') != revision:
                raise Problem('自定义节点已在其他页面更新，请刷新再试。', 409)
            rows = list(store.db.execute('SELECT * FROM profiles'))
            profiles = [json.loads(row['body']) for row in rows]
            store._set('customNodes', change_catalog(store._get('customNodes'), profiles, data))
            store._set('customNodesRevision', revision + 1)
            changed = []
            for row, profile in zip(rows, profiles):
                if profile != json.loads(row['body']):
                    store.db.execute('UPDATE profiles SET body=?,updated=?,revision=revision+1 WHERE id=?',
                                     (js(profile), now(), row['id']))
                    changed.append({'previousRevision': row['revision'],
                                    'profile': self.profile_status(store._row(row['id']))})
            return {**self.custom_nodes_data(), 'changedProfiles': changed}

    def mutate_source(self, action, data):
        store = self.store
        sid = data.get('sourceId')
        if action == 'refresh':
            job = store.refresh(sid)
            for _ in range(130):
                result = store.job(job['jobId'])
                if result['status'] != 'running':
                    break
                time.sleep(0.2)
            if result['status'] != 'done':
                raise Problem(result.get('error', '订阅刷新仍在进行，请稍后查看。'), 422)
            with store.lock:
                source = next((source for source in store._get('sources') if source['id'] == sid), None)
                if source is None:
                    raise Problem('订阅来源不存在', 404)
                return {'source': public_source(source), 'message': '来源已刷新'}
        with store.lock, store.db:
            sources = store._get('sources')
            source = next((source for source in sources if source['id'] == sid), None)
            if source is None and (sid or action == 'manage'):
                raise Problem('订阅来源不存在', 404)
            if action == 'manage':
                operation = data.get('action')
                if operation == 'delete':
                    profiles = [json.loads(row[0]) for row in store.db.execute('SELECT body FROM profiles')]
                    used_by = [p['name'] for p in profiles if sid in p.get('sourceIds', []) or any(
                        selector.get('sourceId') == sid for group in p.get('groups', []) for selector in group.get('selectors', []))]
                    if used_by:
                        raise Problem(f'「{"、".join(used_by)}」仍在使用此来源，可先停用。', 409)
                    store._set('sources', [item for item in sources if item['id'] != sid])
                    store._set('sourcesRevision', store._get('sourcesRevision') + 1)
                    return {'message': '来源已删除'}
                if operation not in {'enable', 'disable'}:
                    raise Problem('未知来源操作', 422)
                source['enabled'] = operation == 'enable'
                message = '来源已启用' if source['enabled'] else '来源已停用'
            else:
                name = str(data.get('name', '')).strip()
                if not name:
                    raise Problem('请输入来源名称', 422)
                if source is None:
                    source = {'id': 'src-' + uuid4().hex, 'prefix': name[:4], 'enabled': True, 'cache': [], 'status': 'empty'}
                    sources.append(source)
                source['name'] = name
                url = str(data.get('url') or '').strip()
                if url and (urllib.parse.urlsplit(url).scheme not in {'http', 'https'} or not urllib.parse.urlsplit(url).hostname):
                    raise Problem('订阅地址仅支持 HTTP / HTTPS', 422)
                if url and url != source.get('url'):
                    source.update(url=url, status='pending', error='')
                if raw := str(data.get('rawContent') or '').strip():
                    source.update(cache=parse_source_nodes(raw.encode()), status='ready', updatedAt=now(), error='')
                message = '来源已保存'
            store._set('sources', sources)
            store._set('sourcesRevision', store._get('sourcesRevision') + 1)
            return {'source': public_source(source), 'message': message}

    def handle(self, handler, method, path, query, data, tailnet_admin):
        if method == 'POST' and path == '/api/group-probe':
            with self.store.lock:
                row = self.store._row(data.get('profileId'))
                self.store._check_revision(row, data.get('revision'))
                draft = json.loads(row['body'])
                published = json.loads(self.store._version(row['id'], row['published'])['body']) if row['published'] else None
                target = self.merge_draft(draft, data.get('updates'), published)
                group = next((group for group in target['groups'] if group.get('id') == data.get('groupId')), None)
                if group is None:
                    raise Problem('策略组不存在', 404)
                result, document = compile_profile(target, self.store._get('sources'), self.store._get('company'))
                if not result['ok']:
                    raise Problem(result['errors'][0]['message'], 422)
            try:
                url = group_probe_url(group)
            except ValueError as error:
                raise Problem(str(error), 422) from None
            return handler.json(self.probe.measure_group(document, group['name'], url, data.get('nodeNames'))) or True
        if method == 'POST' and path == '/api/custom-nodes':
            return handler.json(self.mutate_custom_nodes(data)) or True
        if method == 'GET' and path == '/api/data':
            return handler.json(self.bootstrap(tailnet_admin, compact=query.get('view') == ['bootstrap'])) or True
        if method == 'GET' and path == '/api/history':
            return handler.json({'history': self.history_metadata()}) or True
        if method == 'GET' and path == '/api/public-rules':
            return handler.json({'publicRuleLibrary': self.public_rules}) or True
        if method == 'GET' and path == '/api/profile/published':
            with self.store.lock:
                profile = self.store._row(query.get('profileId', [''])[0])
                if not profile['published']:
                    raise Problem('找不到当前发布版本', 404)
                snapshot = self.public_snapshot(self.store._version(profile['id'], profile['published']))
            return handler.json({'snapshot': snapshot}) or True
        if method == 'GET' and path == '/api/public-rule-detail':
            return handler.json(load_template(query.get('id', [''])[0])) or True
        if path == '/api/node-probe' and method in {'GET', 'POST'}:
            snapshot = self.probe.start(data) if method == 'POST' else self.probe.read()
            return handler.json(snapshot, 202 if method == 'POST' else 200) or True
        if method == 'GET' and path == '/api/profile/compare':
            left, left_version, right, right_version = (query.get(key, [''])[0] for key in ('left', 'leftVersion', 'right', 'rightVersion'))
            with self.store.lock:
                a, b = self.snapshot(left, left_version), self.snapshot(right, right_version)
                sources, company = self.store._get('sources'), self.store._get('company')
            result = compare_profiles(a, b, sources, company, parse_yaml, self.draft_document)
            return handler.json(result) or True
        if method == 'POST' and path.startswith('/api/profile/'):
            action = path.rsplit('/', 1)[-1]
            if action in {'review', 'restore-change'}:
                return handler.json(self.review_draft(data, restore=action == 'restore-change')) or True
            if action in {'create', 'duplicate', 'save-draft', 'discard-draft', 'rollback', 'publish'}:
                return handler.json(self.mutate_profile(action, data)) or True
        if method == 'POST' and path.startswith('/api/source/'):
            action = path.rsplit('/', 1)[-1]
            if action in {'refresh', 'update-or-import', 'manage'}:
                return handler.json(self.mutate_source(action, data)) or True
        return False
