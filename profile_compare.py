"""Read-only comparison of saved Clash configurations."""

from collections import Counter, defaultdict, deque
import copy
from difflib import SequenceMatcher
from functools import partial
import json
import re


MISSING = object()
PRIVATE_FIELD = re.compile(r'token|secret|passw?d|password|credential|key|auth|uuid|url|header|cookie', re.I)
URL = re.compile(r'[a-z][a-z0-9+.-]*://\S+', re.I)
SUBSCRIPTION_NOTICE = re.compile(r'剩余流量|套餐到期|到期时间|过期时间|下次重置|流量重置|官网')
FIELD_LABELS = {
    'tolerance': '节点切换容差', 'interval': '检测间隔', 'timeout': '检测超时',
    'url': '检测地址', 'lazy': '按需检测', 'max-failed-times': '触发重检的失败次数',
    'default-selected': '默认选中的节点', 'use': '引用的代理集合',
    'type': '协议类型', 'server': '服务器地址', 'port': '端口', 'network': '传输方式',
    'tls': 'TLS 加密', 'servername': 'TLS 服务器名称', 'sni': 'TLS 服务器名称',
    'cipher': '加密方式', 'udp': 'UDP 转发', 'disable-udp': '禁用 UDP',
    'flow': '流控方式', 'dialer-proxy': '前置代理', 'interface-name': '出站网卡',
    'fingerprint': '证书指纹', 'client-fingerprint': '客户端指纹',
    'uuid': '节点凭据', 'password': '节点密码', 'private-key': '私钥',
    'enable': '启用状态', 'ipv6': 'IPv6', 'auto-route': '自动接管系统路由',
    'strict-route': '严格路由', 'auto-detect-interface': '自动识别出站网卡',
    'route-exclude-address': '直连绕过网段', 'route-address': '代理接管网段',
    'dns-hijack': 'DNS 接管地址', 'stack': '网络栈', 'mtu': '最大传输单元',
    'enhanced-mode': '增强解析模式', 'fake-ip-range': 'Fake IP 地址范围',
    'fake-ip-filter': 'Fake IP 排除域名', 'nameserver': 'DNS 服务器', 'fallback': '备用 DNS',
    'default-nameserver': '引导 DNS 服务器', 'proxy-server-nameserver': '代理节点解析 DNS',
    'nameserver-policy': '按域名指定 DNS', 'respect-rules': 'DNS 遵循分流规则',
}
NODE_VISIBLE_FIELDS = {
    'server', 'port', 'type', 'network', 'tls', 'servername', 'sni', 'cipher', 'udp',
    'flow', 'dialer-proxy', 'interface-name', 'client-fingerprint',
}
GROUP_TYPES = {'select': '手动选择', 'url-test': '自动测速', 'fallback': '按优先级回退'}


def display(value):
    if value is MISSING:
        return None
    if isinstance(value, str):
        return URL.sub('（链接已隐藏）', value)
    return URL.sub('（链接已隐藏）', json.dumps(value, ensure_ascii=False, sort_keys=True))


def change(name, before=MISSING, after=MISSING, kind=None):
    if kind is None:
        kind = 'added' if before is MISSING else 'removed' if after is MISSING else 'changed'
    return {'name': display(name), 'kind': kind, 'before': display(before), 'after': display(after)}


def reordered(left, right):
    matcher = SequenceMatcher(None, left, right, autojunk=False)
    stable = {value for block in matcher.get_matching_blocks() for value in left[block.a:block.a + block.size]}
    return set(right) - stable


def sequence_changes(left, right, label=''):
    """Align the remaining items before reporting moves so insertions do not appear as moves."""
    def indexed(values):
        occurrences = Counter()
        index = {}
        for position, value in enumerate(values):
            key = json.dumps(value, ensure_ascii=False, sort_keys=True)
            occurrences[key] += 1
            index[(key, occurrences[key])] = (value, position)
        return index

    a, b = indexed(left), indexed(right)
    common_b = [key for key in b if key in a]
    moved = reordered([key for key in a if key in b], common_b)
    def slot(index):
        return f'第 {index + 1} 位'
    return [
        *({**change(label + display(value), before=slot(index)), 'beforeIndex': index}
          for key, (value, index) in a.items() if key not in b),
        *({**change(label + display(value), after=slot(index)), 'afterIndex': index}
          for key, (value, index) in b.items() if key not in a),
        *({**change(label + display(value), slot(a[key][1]), slot(index), 'moved'),
           'beforeIndex': a[key][1], 'afterIndex': index}
          for key, (value, index) in b.items() if key in moved),
    ]


def pair_rules(left, right, old_keys, new_keys):
    old_by_line, old_by_matcher = defaultdict(deque), defaultdict(deque)
    for index, (line, key) in enumerate(zip(left, old_keys)):
        old_by_line[line].append(index)
        old_by_matcher[key].append(index)
    matches = {}
    for index, line in enumerate(right):
        if old_by_line[line]:
            matches[index] = old_by_line[line].popleft()
    paired = set(matches.values())
    for index, key in enumerate(new_keys):
        if index in matches:
            continue
        candidates = old_by_matcher[key]
        while candidates and candidates[0] in paired:
            candidates.popleft()
        if candidates:
            matches[index] = candidates.popleft()
            paired.add(matches[index])
    order = [matches[index] for index in sorted(matches)]
    return matches, paired, reordered(sorted(order), order)


def rules_diff(left, right):
    def rule_parts(line):
        parts = [part.strip() for part in line.split(',')]
        flags = []
        minimum = 2 if parts[0] in {'MATCH', 'FINAL'} else 3
        while len(parts) > minimum and parts[-1].lower() in {'no-resolve', 'src'}:
            flags.insert(0, parts.pop())
        if len(parts) < 2:
            return line, line
        return ','.join(parts[:-1]), ' · '.join([parts[-1], *flags])

    old_rules, new_rules = [[rule_parts(line) for line in lines] for lines in (left, right)]
    # Match identical rules before matching changed targets, including duplicate matchers.
    matches, paired, moves = pair_rules(left, right, [key for key, _ in old_rules], [key for key, _ in new_rules])
    changes = []
    for index, (matcher, target) in enumerate(new_rules):
        if index not in matches:
            item = {**change(matcher, after=target), 'afterPosition': index + 1}
        else:
            old = matches[index]
            changed = left[old] != right[index]
            moved = old in moves
            if not (changed or moved):
                continue
            item = {**change(matcher, old_rules[old][1], target, 'changed' if changed else 'moved'),
                    'beforePosition': old + 1, 'afterPosition': index + 1, 'alsoMoved': changed and moved}
        changes.append(item)
    changes.extend({**change(matcher, before=target), 'beforePosition': index + 1}
                   for index, (matcher, target) in enumerate(old_rules) if index not in paired)
    return changes


def field_changes(left, right, prefix='', *, node=False, labels=True, path=()):
    changes = []
    for key in dict.fromkeys([*left, *right]):
        a, b = left.get(key, MISSING), right.get(key, MISSING)
        if a == b:
            continue
        label = FIELD_LABELS.get(key, f'配置项 · {key}') if labels else key
        name = f'{prefix}{label}'
        if not node and (isinstance(a, dict) or isinstance(b, dict)):
            if not PRIVATE_FIELD.search(key) and all(isinstance(value, dict) or value is MISSING for value in (a, b)):
                nested = field_changes(a if a is not MISSING else {}, b if b is not MISSING else {},
                                       name + ' › ', labels=False, path=(*path, key))
                if nested:
                    changes.extend(nested)
                    continue
        def safe(value):
            if value is MISSING:
                return MISSING
            if PRIVATE_FIELD.search(key) or (node and key not in NODE_VISIBLE_FIELDS):
                return '已隐藏'
            if isinstance(value, bool):
                return '启用' if value else '关闭'
            if isinstance(value, (int, float)) and key in {'tolerance', 'timeout', 'interval'}:
                return f"{value} {'秒' if key == 'interval' else 'ms'}"
            return '内容有变动' if isinstance(value, (dict, list)) and any(isinstance(i, (dict, list)) for i in value) else value
        changes.append({**change(name, safe(a), safe(b)), 'fieldPath': [*path, key]})
    return changes


def group_selection(group):
    options = group.get('options', {})
    return (group.get('members', []), group.get('selectors', []), options.get('priority', []), options.get('excluded', []))


def selector_labels(selectors, source_names):
    labels = []
    for selector in selectors:
        label = source_names.get(selector.get('sourceId'), selector.get('sourceId'))
        terms = [f'{title} {display(selector[key])}' for key, title in
                 [('include', '包含'), ('exclude', '排除'), ('names', '指定节点'), ('excludeNames', '排除节点')]
                 if selector.get(key)]
        labels.append(' · '.join([label, *terms]))
    return labels


def groups_diff(left, right, left_doc, right_doc, source_names):
    a, b = ({group['name']: group for group in profile.get('groups', [])} for profile in (left, right))
    exact = left_doc is not None and right_doc is not None
    by_name = [{group['name']: group for group in doc.get('proxy-groups', [])} for doc in (left_doc, right_doc)] if exact else None
    items = sequence_changes(list(a), list(b))
    for name in b:
        if name not in a:
            continue
        before, after = a[name], b[name]
        first, second = group_selection(before), group_selection(after)
        details = sequence_changes(first[0], second[0], '固定候选 · ')
        details.extend(sequence_changes(selector_labels(first[1], source_names), selector_labels(second[1], source_names), '订阅筛选 · '))
        details.extend(sequence_changes(first[2], second[2], '优先级 · '))
        details.extend(sequence_changes(first[3], second[3], '排除候选 · '))
        before_type, after_type = before.get('type'), after.get('type')
        if before_type != after_type:
            details.append(change('策略组类型', GROUP_TYPES.get(before_type, before_type), GROUP_TYPES.get(after_type, after_type)))
        if by_name and name in by_name[0] and name in by_name[1]:
            emitted = [groups[name] for groups in by_name]
            heads = [next(iter(group.get('proxies', [])), MISSING) for group in emitted]
            if first != second and after_type in {'select', 'fallback'} and heads[0] != heads[1]:
                details.insert(0, change('首个候选', *heads))
            settings = [{k: v for k, v in group.items() if k not in {'name', 'type', 'proxies'}} for group in emitted]
        else:
            settings = [{k: v for k, v in {**(group.get('extra') or {}), **group.get('options', {})}.items()
                         if k not in {'priority', 'excluded'}} for group in (before, after)]
        details.extend(field_changes(*settings))
        if details:
            items.append({**change(name, kind='changed'), 'details': details})
    return items


def nodes_diff(a, b, *, ignore_notices=False):
    # Airport notices are advertised as nodes, but comparing them adds rollover noise.
    old, new = ({node['name']: node for node in nodes
                 if not ignore_notices or not SUBSCRIPTION_NOTICE.search(node['name'])} for nodes in (a, b))
    items = [{**change(name, after=new[name].get('type') or '已加入'), 'nodeName': name} for name in new if name not in old]
    items.extend({**change(name, before=old[name].get('type') or '已移除'), 'nodeName': name} for name in old if name not in new)
    for name in new:
        if name not in old:
            continue
        changes = field_changes(old[name], new[name], node=True)
        if len(changes) == 1:
            item = changes[0]
            items.append({**item, 'name': f"{display(name)} · {item['name']}", 'nodeName': name})
        elif changes:
            items.append({**change(name, kind='changed'), 'details': changes, 'detailsLabel': '连接设置变动', 'nodeName': name})
    return items


def label_public_rule_sets(changes, profiles):
    titles = {}
    for profile in profiles:
        for rule in profile.get('rules', []):
            snapshot = rule.get('publicSet')
            if snapshot:
                value = rule.get('value', '')
                titles[f"RULE-SET,workbench-domain-{snapshot['version']}"] = {
                    'openai': 'OpenAI', 'anthropic': 'Anthropic', 'github': 'GitHub',
                }.get(value, value)
    for item in changes:
        if item['name'] in titles:
            item['name'] = '公共规则集 · ' + titles[item['name']]
    return changes


def compare_profiles(left, right, sources, company, parse, compile_draft):
    def materialize(side):
        if side.get('document') is not None:
            return side['document']
        if side.get('yaml'):
            return parse(side['yaml'])
        if side['version'] == 'draft':
            return compile_draft(side['profile'], sources, company)
        return None

    a_doc, b_doc = materialize(left), materialize(right)
    exact = a_doc is not None and b_doc is not None
    a, b = left['profile'], right['profile']
    cfg_a, cfg_b = (a_doc, b_doc) if exact else (a, b)
    source_names = {s['id']: s['name'] for s in sources}
    sections = []

    def section(title, items):
        if items:
            sections.append({'title': title, 'items': items})

    section('策略组', groups_diff(a, b, a_doc, b_doc, source_names))
    custom_a, custom_b = (profile.get('nodes', []) for profile in (a, b))
    section('自定义节点', nodes_diff(custom_a, custom_b))
    upstream = []
    if exact:
        custom_names = {node['name'] for node in (*custom_a, *custom_b)}
        upstream = nodes_diff(*([node for node in doc.get('proxies', []) if node['name'] not in custom_names]
                                for doc in (a_doc, b_doc)), ignore_notices=True)
    a_rules = a_doc.get('rules') if a_doc is not None else left.get('effectiveRules')
    b_rules = b_doc.get('rules') if b_doc is not None else right.get('effectiveRules')
    if a_rules is None or b_rules is None:
        def definitions(profile):
            return [', '.join(str(rule.get(key, '')) for key in ('type', 'value', 'target')).replace(', ,', ',')
                    + (' · 停用' if rule.get('enabled') is False else '')
                    + (' · no-resolve' if rule.get('noResolve') else '')
                    + (f" · 规则集 {rule['publicSet']['version']}" if rule.get('publicSet') else '')
                    for rule in profile.get('rules', [])]
        section('分流规则', sequence_changes(definitions(a), definitions(b)))
    else:
        section('分流规则', label_public_rule_sets(rules_diff(a_rules, b_rules), (a, b)))
    settings_a, settings_b = (a_doc, b_doc) if exact else (a.get('network', {}), b.get('network', {}))
    for title, key in [('DNS', 'dns'), ('TUN', 'tun')]:
        section(title, field_changes(settings_a.get(key, {}) or {}, settings_b.get(key, {}) or {}))
    section('Hosts', field_changes(cfg_a.get('hosts', {}) or {}, cfg_b.get('hosts', {}) or {}, labels=False))
    section('订阅来源', sequence_changes([source_names.get(s, s) for s in a.get('sourceIds', [])],
                                         [source_names.get(s, s) for s in b.get('sourceIds', [])]))
    return {'sections': sections, 'upstream': upstream, 'complete': [a_doc is not None, b_doc is not None]}


def set_from_baseline(target, baseline, path):
    ref = baseline
    for key in path:
        ref = ref.get(key, MISSING) if isinstance(ref, dict) else MISSING
    parent = target
    for key in path[:-1]:
        if ref is MISSING and not isinstance(parent.get(key), dict):
            return
        parent = parent.setdefault(key, {})
    if ref is MISSING:
        parent.pop(path[-1], None)
    else:
        parent[path[-1]] = copy.deepcopy(ref)


def restore_list_item(values, baseline, old, new, positions):
    if new is not None:
        values.pop(new)
    if old is not None:
        index = old if positions or new is None else new
        values.insert(min(index, len(values)), copy.deepcopy(baseline[old]))


def rule_review_rows(before, after):
    def identity(rule):
        return rule.get('type'), rule.get('value')

    def summary(rule):
        if rule is None:
            return MISSING
        tags = [rule.get('target', ''), '启用' if rule.get('enabled', True) else '停用']
        if rule.get('noResolve'):
            tags.append('跳过 DNS 解析')
        snapshot = rule.get('publicSet')
        if snapshot:
            tags.append('规则集 ' + snapshot['version'][:10])
        return ' · '.join(tags)

    a, b = [[json.dumps(rule, sort_keys=True, ensure_ascii=False) for rule in rules] for rules in (before, after)]
    matches, paired, moved = pair_rules(a, b, list(map(identity, before)), list(map(identity, after)))
    indices = [(matches.get(index), index) for index in range(len(after))]
    indices += [(index, None) for index in range(len(before)) if index not in paired]
    for old, new in indices:
        previous = before[old] if old is not None else None
        current = after[new] if new is not None else None
        moved_only = old in moved and previous == current
        if not moved_only and previous == current:
            continue
        kind, value = identity(current or previous)
        label = '公司共享网段' if kind == 'COMPANY' else '兜底规则' if kind == 'MATCH' else ' · '.join(filter(None, (kind, value)))
        item = change(label, summary(previous), summary(current), 'moved' if moved_only else None)
        item['beforePosition'] = old + 1 if old is not None else None
        item['afterPosition'] = new + 1 if new is not None else None
        item['alsoMoved'] = old in moved and not moved_only
        yield item, old, new, old in moved


def make_draft_review(comparison, published, current, frozen):
    """Attach restore operations to writable draft rows, using the server's published baseline."""
    baseline = copy.deepcopy(published)
    compiled_groups = {group['name']: group for group in frozen.get('proxy-groups', [])}
    for group in baseline.get('groups', []):
        emitted = compiled_groups.get(group['name'], {})
        options = group.setdefault('options', {})
        extras = group.get('extra') or {}
        if 'tolerance' in emitted and emitted['tolerance'] != options.get('tolerance', extras.get('tolerance')):
            options['tolerance'] = emitted['tolerance']

    actions = {}

    def assign(item, identity, apply, label='恢复此项'):
        key = json.dumps(identity, ensure_ascii=False, separators=(',', ':'))
        item.update(restore=key, restoreLabel=label)
        actions[key] = apply

    def list_action(item, field, old, new, *, positions=True, label='恢复此项'):
        def apply(draft):
            restore_list_item(draft.setdefault(field, []), baseline.get(field, []), old, new, positions)
            if field == 'nodes':
                managed = set(draft.get('customNodeNames', []))
                name = item['nodeName']
                if name in baseline.get('customNodeNames', []):
                    managed.add(name)
                else:
                    managed.discard(name)
                if managed or 'customNodeNames' in draft:
                    draft['customNodeNames'] = sorted(managed)
        assign(item, (field, old, new), apply, label)

    if published.get('name') != current.get('name'):
        item = change('配置名称', published.get('name'), current.get('name'))
        assign(item, ('name',), partial(set_from_baseline, baseline=baseline, path=('name',)))
        comparison['sections'].insert(0, {'title': '配置名称', 'items': [item]})

    old_rules, new_rules = [profile.get('rules', []) for profile in (baseline, current)]
    authored_rules = []
    for item, old, new, moved in rule_review_rows(old_rules, new_rules):
        list_action(item, 'rules', old, new, positions=moved, label='恢复此规则')
        authored_rules.append(item)
    if authored_rules:
        rules_section = next((section for section in comparison['sections'] if section['title']=='分流规则'), None)
        if rules_section:
            rules_section['items'] = authored_rules
        else:
            comparison['sections'].append({'title':'分流规则', 'items':authored_rules})

    old_groups, new_groups = [{group['name']: index for index, group in enumerate(profile.get('groups', []))}
                             for profile in (baseline, current)]
    old_nodes, new_nodes = [{node['name']: index for index, node in enumerate(profile.get('nodes', []))}
                           for profile in (baseline, current)]
    for section in comparison['sections']:
        title = section['title']
        for item in section['items']:
            if title == '策略组':
                name = item['name']
                old, new = old_groups.get(name), new_groups.get(name)
                if old is None and new is None:
                    continue
                list_action(item, 'groups', old, new, positions=item['kind']=='moved', label='恢复此组')
                if old is None or new is None:
                    continue
                base_group = baseline['groups'][old]
                for child in item.get('details', []):
                    path = child.get('fieldPath', [])
                    if len(path) != 1 or path[0] not in {'tolerance', 'interval', 'url', 'lazy', 'timeout', 'disable-udp'}:
                        continue
                    key = path[0]
                    def apply(draft, index=new, former=base_group, field=key):
                        group = draft['groups'][index]
                        options = group.setdefault('options', {})
                        extras = group.get('extra') or {}
                        values = compiled_groups.get(former['name'], {**(former.get('extra') or {}), **former.get('options', {})})
                        if field in values:
                            options[field] = copy.deepcopy(values[field])
                        else:
                            options.pop(field, None)
                            extras.pop(field, None)
                    assign(child, ('group-option', old, new, key), apply)
            elif title in {'DNS', 'TUN', 'Hosts'} and item.get('fieldPath'):
                prefix = ('extras', 'hosts') if title == 'Hosts' else ('network', title.lower())
                path = (*prefix, *item['fieldPath'])
                assign(item, path, partial(set_from_baseline, baseline=baseline, path=path))
            elif title == '订阅来源':
                old, new = item.get('beforeIndex'), item.get('afterIndex')
                list_action(item, 'sourceIds', old, new)
            elif title == '自定义节点':
                name = item['nodeName']
                list_action(item, 'nodes', old_nodes.get(name), new_nodes.get(name), positions=False, label='恢复此节点')
    return baseline, actions
