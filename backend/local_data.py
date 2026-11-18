"""Read local configuration while keeping credentials out of the platform database."""
import base64
import copy
import hashlib
import ipaddress
import json
import os
import re
import sqlite3
from pathlib import Path

import yaml

from .compiler import SENSITIVE
from .seed import now

FILE_VARIABLES = {
    'desktop': 'WORKBENCH_DESKTOP_CONFIG',
    'phone': 'WORKBENCH_PHONE_CONFIG',
    'kitty': 'WORKBENCH_KITTY_CONFIG',
}
FILES = {name: Path(value).expanduser() for name, variable in FILE_VARIABLES.items()
         if (value := os.environ.get(variable))}
MOVPN = Path(value).expanduser() if (value := os.environ.get('WORKBENCH_MOVPN_DB')) else None
MARK = 'local-ref://'


def protect(value, source, path=()):
    if isinstance(value, dict):
        return {k: protect(v, source, (*path, k)) for k, v in value.items()}
    if isinstance(value, list):
        return [protect(v, source, (*path, i)) for i, v in enumerate(value)]
    sensitive = path and SENSITIVE.search(str(path[-1]))
    if sensitive and value not in ('', None):
        token = base64.urlsafe_b64encode(json.dumps(list(path)).encode()).decode().rstrip('=')
        fingerprint = hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()[:16]
        return f'{MARK}{source}/{token}/{fingerprint}'
    return value


def hydrate(value, files=None, cache=None):
    files = FILES if files is None else files
    cache = {} if cache is None else cache
    if isinstance(value, dict):
        return {k: hydrate(v, files, cache) for k, v in value.items()}
    if isinstance(value, list):
        return [hydrate(v, files, cache) for v in value]
    if not isinstance(value, str) or not value.startswith(MARK):
        return value
    try:
        source, token, fingerprint = value[len(MARK):].split('/')
        if source not in cache:
            cache[source] = yaml.safe_load(Path(files[source]).read_text())
        current = cache[source]
        for key in json.loads(base64.urlsafe_b64decode(token + '=' * (-len(token) % 4))):
            current = current[key]
        actual = hashlib.sha256(json.dumps(current, sort_keys=True).encode()).hexdigest()[:16]
        if actual != fingerprint:
            raise ValueError('changed credential')
        return copy.deepcopy(current)
    except Exception as exc:
        raise ValueError('本地凭据引用已失效或来源文件已变化；请重新核对来源，未输出不完整订阅。') from exc


def company_from_movpn(path=MOVPN):
    if path is None:
        raise ValueError('请配置 WORKBENCH_MOVPN_DB')
    with sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True) as db:
        active = db.execute("SELECT value FROM settings WHERE key='active_id'").fetchone()
        rows = db.execute('SELECT id,name,routes FROM profiles WHERE id=?', (int(active[0]),)).fetchall() if active else db.execute('SELECT id,name,routes FROM profiles').fetchall()
    if len(rows) != 1:
        raise ValueError('MoVPN 当前配置不明确，保留上次有效网段')
    pid, name, raw = rows[0]
    routes = json.loads(raw)
    if not isinstance(routes, list) or not routes:
        raise ValueError('MoVPN 网段为空，保留上次有效网段')
    cidrs = []
    for item in routes:
        net = ipaddress.ip_network(item, strict=True)
        if net.prefixlen == 0:
            raise ValueError('公司共享规则不能接管默认路由')
        if str(net) not in cidrs:
            cidrs.append(str(net))
    return {'cidrs': cidrs, 'origin': f'MoVPN · {name}', 'sourcePath': str(path),
            'profileId': pid, 'updatedAt': now(), 'checkedAt': now(), 'connected': True, 'error': ''}
