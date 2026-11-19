"""Resolve the configuration dependencies of a single comparison change."""

import copy
from uuid import uuid4

from backend.compiler import BUILTIN_MEMBERS, selected_nodes
from backend.custom_nodes import subscription_node
from backend.store import Problem


def raw_rule_parts(value):
    parts = [item.strip() for item in value.split(',')]
    minimum = 2 if parts[0] in {'MATCH', 'FINAL'} else 3
    while len(parts) > minimum and parts[-1].lower() in {'no-resolve', 'src'}:
        parts.pop()
    return parts


def rule_policy(rule):
    if rule.get('type') != 'RAW' or not isinstance(rule.get('value'), str):
        return rule.get('type'), rule.get('target')
    parts = raw_rule_parts(rule['value'])
    return parts[0], parts[-1]


def group_refs(group):
    settings = {**(group.get('extra') or {}), **(group.get('options') or {})}
    return {*group.get('members', []), settings.get('empty-fallback')} - {None, ''}


def shared_node_names(catalog):
    return {node['name'] for node in catalog if not node.get('profileId') and node['type'] != 'tailscale'}


def comparison_node_actions(comparison, draft, source, catalog):
    """Describe cross-device node actions before the user clicks them."""
    blocked, choices = {}, {}
    if draft['id'] == source['id']:
        return blocked, choices

    section = next((entry for entry in comparison['sections'] if entry['title'] == '自定义节点'), None)
    if not section:
        return blocked, choices
    shared = shared_node_names(catalog)
    originals = {node['name']: node for node in source.get('nodes', [])}
    target_nodes = {node['name']: node for node in catalog if node.get('profileId') in (None, draft['id'])}
    target_nodes.update({node['name']: node for node in draft.get('nodes', [])})
    target_groups = {group['name']: group for group in draft.get('groups', [])}
    source_groups = {group['name']: group for group in source.get('groups', [])}
    graph = {name: {node['dialer-proxy']} if node.get('dialer-proxy') else set() for name, node in target_nodes.items()}
    graph.update({name: group_refs(group) for name, group in target_groups.items()})

    def reaches(current, target, visited):
        if current == target:
            return True
        if current in visited:
            return False
        visited.add(current)
        return any(reaches(name, target, visited) for name in graph.get(current, ()))

    def transferable(name, target, visited):
        if name in graph:
            return not reaches(name, target, set())
        if name in BUILTIN_MEMBERS or name in visited:
            return True
        if name not in source_groups:
            return name not in originals
        visited.add(name)
        return all(transferable(ref, target, visited) for ref in group_refs(source_groups[name]))

    for item in section['items']:
        name, action = item['nodeName'], item.get('restore')
        original = originals.get(name)
        if not action or original is None:
            continue  # A target-only row can still be removed from the target.
        if name not in shared or original.get('type') == 'tailscale':
            reason = ('Tailscale 节点只属于来源设备，不能复制到这份订阅。' if original.get('type') == 'tailscale'
                      else '这是来源订阅的独立节点。请先在目标订阅配置自己的节点。')
            item['applyUnavailable'] = blocked[action] = reason
            continue

        dialer = original.get('dialer-proxy')
        if not dialer:
            continue
        usable = sorted(candidate for candidate in graph if not reaches(candidate, name, set()))
        if dialer in usable or (dialer in source_groups and dialer not in graph and
                                transferable(dialer, name, set())):
            continue
        item['dialerChoice'] = choices[action] = {
            'node': name, 'source': dialer, 'current': target_nodes.get(name, {}).get('dialer-proxy', ''),
            'options': ['', *usable],
        }
    return blocked, choices


def refs(profile, dns_names):
    names = {rule_policy(rule)[1] for rule in profile.get('rules', []) if rule.get('enabled', True)}
    names.update(node.get('dialer-proxy') for node in profile.get('nodes', []))
    for group in profile.get('groups', []):
        names.update(group_refs(group))

    def dns_refs(value):
        if isinstance(value, dict):
            for child in value.values():
                dns_refs(child)
        elif isinstance(value, list):
            for child in value:
                dns_refs(child)
        elif isinstance(value, str):
            target = value.partition('#')[2].split('&', 1)[0]
            if target in dns_names:
                names.add(target)

    dns_refs(profile.get('network', {}).get('dns'))
    return names - {None, ''}


def transfer_dependencies(before, target, source, sources, catalog):
    groups = {group['name']: group for group in source.get('groups', [])}
    target_groups = {group['name'] for group in target.get('groups', [])}
    own_nodes = {node['name'] for node in before.get('nodes', [])}
    source_nodes = {node['name']: node for node in source.get('nodes', [])}
    device_nodes = {node['name'] for node in catalog if node.get('profileId') == target['id']}
    shared_names = shared_node_names(catalog)
    shared = {node['name']: node for node in catalog if node['name'] in shared_names}
    foreign = {node['name'] for node in catalog if node.get('profileId') and node['profileId'] != target['id']}
    # A node from a different profile cannot carry its Local VPN identity or fixed credentials.
    if source['id'] != target['id']:
        for index, node in enumerate(target.get('nodes', [])):
            name = node['name']
            old = next((item for item in before.get('nodes', []) if item['name'] == name), None)
            if old == node:
                continue
            if name not in shared or node.get('type') == 'tailscale':
                raise Problem(f'「{name}」属于来源设备，请先在目标订阅选择自己的自定义节点。', 422)
            if old and {**old, 'dialer-proxy': node.get('dialer-proxy')} == {**node, 'dialer-proxy': node.get('dialer-proxy')}:
                continue
            shared_node = subscription_node(shared[name])
            if node.get('dialer-proxy'):
                shared_node['dialer-proxy'] = node['dialer-proxy']
            target['nodes'][index] = shared_node

    active_sources = {entry['id']: entry for entry in sources if entry.get('enabled', True)}
    _, by_source = selected_nodes({'sourceIds': list(active_sources)}, sources)
    node_sources = {name: sid for sid, inventory in by_source.items() for _, name in inventory}
    include = set(target.get('sourceIds', []))
    added_sources = {}
    added_groups = {}
    available = target_groups | own_nodes | shared.keys() | device_nodes | BUILTIN_MEMBERS
    dns_names = groups.keys() | source_nodes.keys() | available

    def need_source(sid):
        if sid in include:
            return
        entry = active_sources.get(sid)
        if not entry:
            raise Problem('来源策略组使用的订阅源已停用或不存在，请先在「订阅源与节点」处理。', 422)
        added_sources[sid] = entry['name']
        include.add(sid)

    def need_target(name):
        if name in available:
            return
        if name in groups:
            group = copy.deepcopy(groups[name])
            used_ids = {item.get('id') for item in target['groups']} | {item['id'] for item in added_groups.values()}
            if not group.get('id') or group['id'] in used_ids:
                group['id'] = 'merged-' + uuid4().hex[:12]
            available.add(name)
            added_groups[name] = group
            for selector in group.get('selectors', []):
                need_source(selector.get('sourceId'))
            for member in sorted(group_refs(group)):
                need_target(member)
        elif name in node_sources:
            need_source(node_sources[name])
        elif name in foreign or name in source_nodes:
            raise Problem(f'「{name}」只能在来源设备使用，请给目标订阅配置相应的节点后再应用。', 422)
        else:
            raise Problem(f'缺少目标「{name}」，来源版本也没有可带入的策略组或节点。', 422)

    def selector_sources(profile):
        return {selector.get('sourceId') for group in profile.get('groups', []) for selector in group.get('selectors', [])}

    for sid in selector_sources(target) - selector_sources(before):
        need_source(sid)
    for name in sorted(refs(target, dns_names) - refs(before, dns_names)):
        need_target(name)
    target.setdefault('sourceIds', []).extend(added_sources)
    target.setdefault('groups', []).extend(added_groups.values())
    return {'groups': list(added_groups), 'sources': list(added_sources.values())}
