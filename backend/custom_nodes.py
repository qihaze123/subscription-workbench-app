"""Manage HTTP and SOCKS5 nodes while keeping passwords out of editor responses."""

import ipaddress
import re

from .store import Problem


PROXY_TYPES = {'http', 'socks5'}
RESERVED = {'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL'}


def public_node(node, managed):
    result = {key: node.get(key) for key in ('name', 'type')}
    if node.get('name') in managed:
        result.update(custom=True, server=node.get('server'), port=node.get('port'),
                      username=node.get('username', ''), hasPassword=bool(node.get('password')),
                      dialerProxy=node.get('dialer-proxy', ''))
    return result


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
    targets = {item['name'] for item in [*nodes, *profile['groups']]} - {name}
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
    profile['nodes'] = [updated if node is previous else node for node in nodes] if previous else [*nodes, updated]
    profile['customNodeNames'] = sorted(managed | {name})
