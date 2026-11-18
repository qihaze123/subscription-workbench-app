"""Manage shared proxies and device-scoped Tailscale nodes."""

import ipaddress
import re
from uuid import uuid4

from .store import Problem


PROXY_TYPES = {'http', 'socks5'}
TAILSCALE_HOSTNAME = re.compile(r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?')
RESERVED = {'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL'}


def migrate_profiles(profiles, retarget):
    catalog = {}
    occupied = {item['name'] for profile in profiles
                for item in [*profile.get('nodes', []), *profile.get('groups', [])]}
    for profile in profiles:
        managed = set(profile.get('customNodeNames', []))
        renames = {}
        for node in profile.get('nodes', []):
            name = node['name']
            if name not in managed:
                continue
            definition = {key: value for key, value in node.items() if key != 'dialer-proxy'}
            if node.get('type') == 'tailscale':
                definition['profileId'] = profile['id']
            if name in catalog and catalog[name] != definition:
                index = 2
                while f'{name} ({index})' in occupied:
                    index += 1
                alias = f'{name} ({index})'
                occupied.add(alias)
                renames[name] = alias
                node['name'] = alias
                definition['name'] = alias
            catalog[definition['name']] = definition
        if renames:
            retarget(profile, renames)
            profile['customNodeNames'] = sorted(renames.get(name, name) for name in managed)
    return list(catalog.values())


def select_nodes(profile, catalog, dialers=None):
    if dialers is not None and (not isinstance(dialers, dict) or
                               any(not isinstance(value, str) for value in dialers.values())):
        raise Problem('前置代理配置无效', 422)
    managed = set(profile.get('customNodeNames', []))
    fixed = {node['name']: node for node in profile.get('nodes', []) if node['name'] not in managed}
    existing = {node['name']: node for node in profile.get('nodes', []) if node['name'] in managed}
    other_devices = {node['name'] for node in catalog if node.get('profileId') and node['profileId'] != profile['id']}
    available = {**{node['name']: subscription_node(node) for node in catalog
                    if node['name'] not in other_devices}, **existing}
    group_names = {group['name'] for group in profile['groups']}
    targets = group_names | fixed.keys() | available.keys()
    wanted = {name for group in profile['groups'] for name in group.get('members', [])}
    wanted.update(node.get('dialer-proxy') for node in fixed.values())
    for rule in profile.get('rules', []):
        wanted.add(rule.get('target'))
        if rule.get('type') == 'RAW':
            parts = rule.get('value', '').removesuffix(',no-resolve').split(',')
            wanted.add(parts[-1])

    def dns_targets(value):
        if isinstance(value, dict):
            for child in value.values():
                dns_targets(child)
        elif isinstance(value, list):
            for child in value:
                dns_targets(child)
        elif isinstance(value, str) and '#' in value:
            wanted.add(value.split('#', 1)[1].split('&', 1)[0])

    dns_targets(profile.get('network', {}).get('dns'))
    foreign = (wanted & other_devices) - targets
    if foreign:
        raise Problem(f'这些 Tailscale 节点属于其他设备配置：{"、".join(sorted(foreign))}', 422)
    selected = {}
    pending = sorted((wanted & available.keys()) - fixed.keys() - group_names, reverse=True)
    while pending:
        name = pending.pop()
        if name in selected:
            continue
        node = dict(available[name])
        previous = node.pop('dialer-proxy', '')
        dialer = previous if dialers is None else dialers.get(name, '')
        if node['type'] == 'tailscale' and dialer and previous != dialer:
            raise Problem('Tailscale 节点直接建立连接，可作为其他节点的前置代理', 422)
        if dialer:
            if dialer == name or dialer not in targets:
                raise Problem(f'「{name}」的前置代理不存在或指向自身', 422)
            node['dialer-proxy'] = dialer
            if dialer in available and dialer not in fixed and dialer not in group_names:
                pending.append(dialer)
        selected[name] = node
    # Keep the original order for comparisons and for subscribers who select by position.
    replacements = {**fixed, **selected}
    order = dict.fromkeys([*(node['name'] for node in profile.get('nodes', [])), *selected])
    profile['nodes'] = [replacements[name] for name in order if name in replacements]
    if selected or 'customNodeNames' in profile:
        profile['customNodeNames'] = sorted(selected)
    return profile


def public_node(node, managed):
    result = {key: node.get(key) for key in ('name', 'type')}
    if node.get('name') in managed:
        result['custom'] = True
        if node.get('type') == 'tailscale':
            result.update(hostname=node.get('hostname'), profileId=node.get('profileId'))
        else:
            result.update(server=node.get('server'), port=node.get('port'),
                          username=node.get('username', ''), hasPassword=bool(node.get('password')),
                          dialerProxy=node.get('dialer-proxy', ''))
    return result


def subscription_node(node):
    return {key: value for key, value in node.items() if key != 'profileId'}


def change_catalog(nodes, profiles, data):
    name = data.get('name')
    action = data.get('action')
    selected = [profile for profile in profiles if name in profile.get('customNodeNames', [])]
    if action == 'remove' and selected:
        used_by = '、'.join(profile['name'] for profile in selected)
        raise Problem(f'请先在 {used_by} 的草稿移除此节点的引用并保存', 422)
    if action == 'add' and any(item.get('name') == name for profile in profiles
                               for item in [*profile.get('nodes', []), *profile.get('groups', [])]):
        raise Problem('节点或策略组名称已存在', 422)
    if action != 'remove' and data.get('type') == 'tailscale':
        existing = next((node for node in nodes if node['name'] == name), None)
        profile_id = existing.get('profileId') if action == 'edit' and existing else data.get('profileId')
        if not isinstance(profile_id, str) or not any(profile['id'] == profile_id for profile in profiles):
            raise Problem('请选择这条 Tailscale 节点所属的设备配置', 422)
        hostname = data.get('hostname')
        if not isinstance(hostname, str) or not TAILSCALE_HOSTNAME.fullmatch(hostname):
            raise Problem('设备名须为 1–63 位字母、数字或连字符，首尾为字母或数字', 422)
        if any(node['name'] != name and node['type'] == 'tailscale'
               and node['hostname'].lower() == hostname.lower() for node in nodes):
            raise Problem('已存在同名 Tailscale 设备，请填写不同的设备名', 422)
        data = {**data, 'profileId': profile_id, 'hostname': hostname.lower()}
    catalog = {'nodes': nodes, 'groups': [], 'customNodeNames': [node['name'] for node in nodes]}
    apply_node_change(catalog, {**data, 'dialerProxy': ''})
    if action == 'edit':
        replacement = subscription_node(next(node for node in catalog['nodes'] if node['name'] == name))
        for profile in selected:
            profile['nodes'] = [
                ({**replacement, **({'dialer-proxy': node['dialer-proxy']} if node.get('dialer-proxy') else {})}
                 if node['name'] == name else node)
                for node in profile['nodes']
            ]
    return catalog['nodes']


def apply_node_change(profile, change):
    if not isinstance(change, dict) or change.get('action') not in ('add', 'edit', 'remove'):
        raise Problem('自定义节点操作无效', 422)
    name = change.get('name')
    if not isinstance(name, str) or not re.fullmatch(r'[^,#&\r\n]{1,128}', name) or name != name.strip():
        raise Problem('请输入有效的节点名称', 422)
    action = change['action']
    nodes = profile.get('nodes', [])
    managed = set(profile.get('customNodeNames', []))
    previous = next((node for node in nodes if node['name'] == name), None)
    if action == 'add':
        if previous is not None or name in RESERVED or any(group['name'] == name for group in profile['groups']):
            raise Problem('节点或策略组名称已存在', 422)
    elif previous is None or name not in managed:
        raise Problem('找不到该自定义节点', 404)

    if action == 'remove':
        if (any(name in group.get('members', []) for group in profile['groups'])
                or any(rule.get('target') == name for rule in profile.get('rules', []))
                or any(node.get('dialer-proxy') == name for node in nodes)):
            raise Problem('请先解除策略组、规则或其他节点对该节点的引用', 422)
        profile['nodes'] = [node for node in nodes if node['name'] != name]
        profile['customNodeNames'] = sorted(managed - {name})
        return

    proxy_type = change.get('type')
    if previous and (previous['type'] == 'tailscale') != (proxy_type == 'tailscale'):
        raise Problem('请新建节点以切换到或切换出 Tailscale 类型', 422)
    if proxy_type == 'tailscale':
        connection = previous if previous else {'state-dir': f'./tailscale-workbench-{uuid4().hex}', 'udp': True}
        updated = {**connection, 'name': name, 'type': 'tailscale', 'hostname': change['hostname'],
                   'profileId': change['profileId']}
    else:
        updated = update_proxy(previous, change, name, nodes, profile['groups'])
    profile['nodes'] = [updated if node is previous else node for node in nodes] if previous else [*nodes, updated]
    profile['customNodeNames'] = sorted(managed | {name})


def update_proxy(previous, change, name, nodes, groups):
    proxy_type, server, port = (change.get(key) for key in ('type', 'server', 'port'))
    if proxy_type not in PROXY_TYPES or not isinstance(server, str) or not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,253}', server):
        raise Problem('请选择 HTTP 或 SOCKS5，并填写主机名或 IP', 422)
    if ':' in server:
        try:
            ipaddress.IPv6Address(server)
        except ValueError as error:
            raise Problem('IPv6 地址格式无效', 422) from error
    if type(port) is not int or not 1 <= port <= 65535:
        raise Problem('端口须在 1 到 65535 之间', 422)
    username, password = change.get('username', ''), change.get('password', '')
    if not isinstance(username, str) or not isinstance(password, str):
        raise Problem('节点认证信息格式无效', 422)
    updated = {**(previous or {}), 'name': name, 'type': proxy_type, 'server': server, 'port': port}
    dialer = change.get('dialerProxy', '')
    targets = {item['name'] for item in [*nodes, *groups]} - {name}
    if not isinstance(dialer, str) or (dialer and dialer not in targets):
        raise Problem('前置代理不存在或指向自身', 422)
    if dialer:
        updated['dialer-proxy'] = dialer
    else:
        updated.pop('dialer-proxy', None)
    if username:
        updated['username'] = username
    else:
        updated.pop('username', None)
    if password:
        updated['password'] = password
    elif change.get('clearPassword') is True:
        updated.pop('password', None)
    return updated
