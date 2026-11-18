"""Resolve the test address shared by a strategy group's manual and automatic checks."""
from urllib.parse import urlsplit


DEFAULT_PROBE_URL = 'https://www.gstatic.com/generate_204'


def group_probe_url(group):
    value = (group.get('options') or {}).get('url', (group.get('extra') or {}).get('url'))
    if value is None or value == '':
        return DEFAULT_PROBE_URL
    if not isinstance(value, str) or len(value) > 2048 or any(char.isspace() for char in value):
        raise ValueError('测速地址须为完整的 HTTP 或 HTTPS 网址')
    try:
        parsed = urlsplit(value)
        if (parsed.scheme in ('http', 'https') and parsed.hostname and parsed.port != 0
                and parsed.username is None and parsed.password is None and not parsed.fragment):
            return value
    except ValueError:
        pass
    raise ValueError('测速地址须为完整的 HTTP 或 HTTPS 网址，且不能包含用户名、密码或片段')
