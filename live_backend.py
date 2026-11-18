"""Use the workspace's validated Clash parser and compiler for the local live-data preview."""

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from yaml import YAMLError

from backend.compiler import compile_profile, dump_yaml, parse_yaml, resolve_group_members, selected_nodes
from backend.subscription_parser import parse_source_nodes
from profile_compare import compare_profiles


RELAY_FETCH = '''
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import sys
from urllib.request import Request, urlopen

name, fingerprint = sys.argv[1:]
path = Path.home() / 'subscription-workbench/data/workbench.sqlite3'
with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as database:
    sources = json.loads(database.execute("SELECT value FROM meta WHERE key='sources'").fetchone()[0])
url = next((source.get('url') for source in sources if source['id'] == name), None)
if not url or sha256(url.encode('utf-8')).hexdigest() != fingerprint:
    sys.exit(2)
with urlopen(Request(url, headers={'User-Agent': 'clash-meta/subscription-workbench'}), timeout=8) as response:
    sys.stdout.buffer.write(response.read(2_000_001))
'''


def fetch_through_relay(source):
    relay = os.environ.get('WORKBENCH_SOURCE_RELAY', '')
    if not re.fullmatch(r'[a-zA-Z0-9_-]+@[a-zA-Z0-9.:-]+', relay):
        raise ValueError('TLS 连接中断')
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', source['id']):
        raise ValueError('来源标识无效')
    digest = hashlib.sha256(source['url'].encode('utf-8')).hexdigest()
    try:
        remote = subprocess.run(
            ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5',
             relay, 'python3', '-', source['id'], digest],
            input=RELAY_FETCH.encode(), capture_output=True, timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError('TLS 连接中断，订阅服务器回退暂不可用') from None
    if remote.returncode == 2:
        raise ValueError('TLS 连接中断，订阅服务器没有匹配的来源')
    if remote.returncode != 0:
        raise ValueError('TLS 连接中断，订阅服务器也无法拉取')
    return remote.stdout


def resolve_references(value, references, missing):
    if isinstance(value, dict):
        return {key: resolve_references(item, references, missing) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve_references(item, references, missing) for item in value]
    if isinstance(value, str) and value.startswith('local-ref://'):
        if value in references:
            return references[value]
        missing.add(value)
    return value


def inventory(source):
    nodes, origins = selected_nodes({'sourceIds': [source['id']]}, [{**source, 'enabled': True}])
    types = {node['name']: node['type'] for node in nodes}
    return [{'name': name, 'rawName': raw, 'type': types[name]} for raw, name in origins[source['id']]]


def profile_from_row(row, references):
    profile = resolve_references(json.loads(row['body']), references, set())
    profile['hosts'] = profile.get('extras', {}).get('hosts', {})
    return profile


def import_store(export_path, target_path, fixture_path):
    exported = json.loads(export_path.read_text())
    fixture = json.loads(fixture_path.read_text())
    references = exported['references']
    sources = json.loads(exported['meta']['sources'])
    known_sources = {source['id']: source for source in fixture['sources']}
    for source in sources:
        source['cache'] = resolve_references(source.get('cache', []), references, set())
        source['nodes'] = inventory(source)
        previously_measured = known_sources.get(source['id'], {})
        old_nodes = {node['name']: node for node in previously_measured.get('nodes', [])}
        if source.get('updatedAt') == previously_measured.get('updatedAt'):
            for node in source['nodes']:
                for field in ('measurement', 'samples'):
                    if field in old_nodes.get(node['name'], {}):
                        node[field] = old_nodes[node['name']][field]
            source['lastMeasurement'] = previously_measured.get('lastMeasurement')
    profiles, history = [], {}
    for row in exported['profiles']:
        profile = profile_from_row(row, references)
        profile.update(id=row['id'], publishedVersion=row['published'], updatedAt=row['updated'])
        versions = []
        for entry in sorted(exported['versions'], key=lambda entry: entry['version'], reverse=True):
            if entry['profile_id'] != row['id']:
                continue
            missing = set()
            document = resolve_references(parse_yaml(entry['yaml']), references, missing)
            snapshot = profile_from_row(entry, references)
            snapshot.update(id=row['id'], publishedVersion=entry['version'], publishedAt=entry['created'], hasDraft=False)
            version = dict(version=entry['version'], publishedAt=entry['created'], profile=snapshot,
                           effectiveRules=document.get('rules', []), nodeCount=len(document.get('proxies', [])))
            if missing:
                version['downloadUnavailable'] = True
            else:
                version['frozenYaml'] = dump_yaml(document)
            if entry['version'] == row['published']:
                if missing:
                    raise ValueError('当前发布版本缺少必要的节点配置')
                profile['publishedAt'] = entry['created']
                profile['hasDraft'] = json.loads(row['body']) != json.loads(entry['body'])
            versions.append(version)
        profiles.append(profile)
        history[row['id']] = versions
    company = json.loads(exported['meta']['company'])
    company['autoPublish'] = False
    store = dict(liveData=True, profiles=profiles, history=history, sources=sources, company=company,
                 publicRuleLibrary=fixture['publicRuleLibrary'])
    os.umask(0o077)
    target_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with target_path.open('x', encoding='utf-8') as output:
        json.dump(store, output, ensure_ascii=False)
    print(json.dumps({'profiles': [(p['id'], p['publishedVersion']) for p in profiles],
                      'sources': [(s['id'], len(s['nodes']), bool(s.get('url'))) for s in sources]}, ensure_ascii=False))


def prepare_profile(profile, sources):
    from backend.probe_target import DEFAULT_PROBE_URL
    profile = copy.deepcopy(profile)
    extras = profile.setdefault('extras', {})
    extras['hosts'] = profile.get('hosts', extras.get('hosts', {}))
    for rule in profile.get('rules', []):
        snapshot = rule.get('publicSet')
        if rule.get('type') != 'GEOSITE' or rule.get('enabled') is False or not snapshot:
            continue
        provider = f"workbench-domain-{snapshot['version']}"
        providers = extras.setdefault('rule-providers', {})
        definition = {'type': 'inline', 'behavior': 'domain', 'format': 'yaml', 'payload': snapshot['entries']}
        if providers.setdefault(provider, definition) != definition:
            raise ValueError(f'规则集名称冲突：{provider}')
        rule.update(type='RULE-SET', value=provider)
    notice = re.compile(r'剩余流量|套餐到期|到期时间|过期时间|下次重置|流量重置|官网')
    nodes_by_source = {source['id']: source.get('nodes', []) for source in sources}
    notices = {node['name'] for nodes in nodes_by_source.values() for node in nodes
               if notice.search(node.get('rawName') or node['name'])}
    _, by_source = selected_nodes(profile, sources)
    for group in profile.get('groups', []):
        options = group.setdefault('options', {})
        excluded = set(options.pop('excluded', [])) | notices
        priority = options.pop('priority', [])
        kind = group.get('type')
        defaults = {}
        if kind in ('fallback', 'url-test'):
            if 'url' in options:
                options['url'] = options['url'] or DEFAULT_PROBE_URL
            if options.get('url', DEFAULT_PROBE_URL) != DEFAULT_PROBE_URL and 'expected-status' not in (group.get('extra') or {}):
                options.setdefault('expected-status', '200-399')
            defaults = {'url': DEFAULT_PROBE_URL, 'interval': 120 if kind == 'fallback' else 600}
        else:
            options.pop('url', None)
        if kind == 'url-test':
            defaults['tolerance'] = 50
        legacy = group.get('extra') or {}
        for key, value in defaults.items():
            if key not in legacy:
                options.setdefault(key, value)
        group['members'] = [name for name in group.get('members', []) if name not in excluded]
        for selector in group.get('selectors', []):
            available = nodes_by_source.get(selector['sourceId'], [])
            excluded_here = {node['name'] for node in available}.intersection(excluded)
            if excluded_here:
                selector['excludeNames'] = sorted(set(selector.get('excludeNames', [])) | excluded_here)
        if isinstance(priority, list) and priority and kind != 'url-test':
            members, _, _, _ = resolve_group_members(group, by_source, profile.get('sourceIds', []), 'group')
            available = set(members)
            ordered = list(dict.fromkeys(name for name in priority if name in available))
            preferred = set(ordered)
            group['members'] = ordered + [name for name in members if name not in preferred]
    return profile


def main():
    action = sys.argv[1]
    if action == 'import':
        import_store(*(Path(value) for value in sys.argv[2:]))
        return
    request = json.load(sys.stdin)
    if action in {'parse', 'fetch'}:
        source = request['source']
        if action == 'fetch':
            try:
                upstream = Request(source['url'], headers={'User-Agent': 'clash-meta/subscription-workbench'})
                with urlopen(upstream, timeout=8) as response:
                    payload = response.read(2_000_001)
            except HTTPError as exc:
                raise ValueError(f'上游返回 HTTP {exc.code}') from None
            except URLError as exc:
                reason = str(exc.reason)
                if 'SSL' in type(exc.reason).__name__ or 'TLS' in reason:
                    payload = fetch_through_relay(source)
                elif 'timed out' in reason.lower():
                    raise ValueError('连接超时') from None
                else:
                    raise ValueError('无法连接订阅上游') from None
        else:
            payload = request['body'].encode('utf-8')
        source['cache'] = parse_source_nodes(payload)
        print(json.dumps({'cache': source['cache'], 'nodes': inventory(source)}, ensure_ascii=False))
    elif action == 'public-rule-detail':
        from backend.rule_templates import load_template
        from backend.store import Problem
        try:
            detail = load_template(request['id'])
        except Problem as error:
            raise ValueError(str(error)) from None
        print(json.dumps(detail, ensure_ascii=False))
    elif action == 'custom-nodes':
        from backend.custom_nodes import change_catalog, migrate_profiles, select_nodes
        from backend.store import Problem
        from workbench_api import retarget_references
        operation = request['operation']
        try:
            if operation == 'migrate':
                profiles = request['profiles']
                output = {'nodes': migrate_profiles(profiles, retarget_references), 'profiles': profiles}
            elif operation == 'change':
                profiles = request['profiles']
                output = {'nodes': change_catalog(request['nodes'], profiles, request['change']), 'profiles': profiles}
            elif operation == 'select':
                output = select_nodes(request['profile'], request['nodes'], request.get('dialers'))
            else:
                raise ValueError('不支持的自定义节点操作')
        except Problem as error:
            raise ValueError(str(error)) from None
        print(json.dumps(output, ensure_ascii=False))
    elif action == 'compare':
        def compile_draft(profile, sources, company):
            result, document = compile_profile(prepare_profile(profile, sources), sources, company)
            if not result['ok']:
                return None
            unresolved = set()
            resolve_references(document, {}, unresolved)
            return None if unresolved else document

        comparison = compare_profiles(request['left'], request['right'], request['sources'],
                                      request['company'], parse_yaml, compile_draft)
        print(json.dumps(comparison, ensure_ascii=False))
    elif action == 'compile':
        sources = request['sources']
        profile = prepare_profile(request['profile'], sources)
        result, document = compile_profile(profile, sources, request['company'])
        if not result['ok']:
            raise ValueError(result['errors'][0]['message'])
        unresolved = set()
        resolve_references(document, {}, unresolved)
        if unresolved:
            raise ValueError('此配置包含未解析的历史节点凭据，请刷新节点后重试')
        print(json.dumps({'yaml': result['yaml'], 'rules': document['rules'], 'nodeCount': len(document['proxies'])}, ensure_ascii=False))
    else:
        raise ValueError('不支持的配置操作')


if __name__ == '__main__':
    try:
        main()
    except YAMLError:
        print(json.dumps({'error': '订阅内容不是可解析的 Clash YAML'}, ensure_ascii=False))
        sys.exit(1)
    except (ValueError, OSError, KeyError) as exc:
        print(json.dumps({'error': str(exc).splitlines()[0][:180]}, ensure_ascii=False))
        sys.exit(1)
