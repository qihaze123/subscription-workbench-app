"""A separate loopback, read-only gateway for tailnet subscription downloads."""
import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get('WORKBENCH_DATA_DIR', ROOT / 'data')).expanduser()
CONFIG = Path(os.environ.get('WORKBENCH_DISTRIBUTION_CONFIG', DATA_DIR / 'private/distribution.json')).expanduser()
PROFILE_ID = re.compile(r'[A-Za-z0-9_-]{1,80}\Z')


def load_config(path=CONFIG):
    if not Path(path).is_file():
        return None
    config = json.loads(Path(path).read_text())
    if not isinstance(config, dict) or not isinstance(config.get('enabled'), bool):
        raise ValueError('发布入口设置无效')
    if not config['enabled']:
        return None
    if not re.fullmatch(r'[a-z0-9.-]+\.ts\.net', config.get('hostname', '')):
        raise ValueError('订阅发布仅使用当前 Tailscale 域名')
    if not re.fullmatch(r'[a-f0-9]{64}', config.get('secret', '')):
        raise ValueError('发布令牌设置无效')
    if 'desktopToken' in config and not re.fullmatch(r'[a-f0-9]{64}', config['desktopToken']):
        raise ValueError('电脑迁移令牌无效')
    for key in ['httpsPort', 'listenPort']:
        if not isinstance(config.get(key), int) or not 1024 <= config[key] <= 65535:
            raise ValueError('发布端口无效')
    return config


def initialize(hostname, listen_port=18862, https_port=8443, path=CONFIG):
    path = Path(path)
    if path.exists():
        config = load_config(path)
        if not config or (config['hostname'], config['listenPort'], config['httpsPort']) != (hostname, listen_port, https_port):
            raise ValueError('已有发布设置与请求不一致，未覆盖现有令牌')
        return config
    config = dict(enabled=True, hostname=hostname, listenPort=listen_port,
                  httpsPort=https_port, secret=secrets.token_hex(32))
    # Validate before creating any file.
    if not re.fullmatch(r'[a-z0-9.-]+\.ts\.net', hostname):
        raise ValueError('请使用当前 Tailscale 域名')
    for port in (listen_port, https_port):
        if not isinstance(port, int) or not 1024 <= port <= 65535:
            raise ValueError('发布端口无效')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(config, stream)
    return config


def token_for(config, profile_id):
    if profile_id == 'desktop' and config.get('desktopToken'):
        return config['desktopToken']
    return hmac.new(bytes.fromhex(config['secret']), profile_id.encode(), hashlib.sha256).hexdigest()


def url_for(config, profile_id):
    if not PROFILE_ID.fullmatch(profile_id):
        raise ValueError('配置 ID 无效')
    return f"https://{config['hostname']}:{config['httpsPort']}/s/{profile_id}/{token_for(config, profile_id)}.yaml"


def public_metadata(config, store, prefer_tailnet=False):
    if not config:
        return {'enabled': False, 'links': {}, 'scope': 'local'}
    with store.lock:
        ids = [row[0] for row in store.db.execute('SELECT id FROM profiles WHERE published IS NOT NULL')]
    local_ids = ids
    if prefer_tailnet:
        local_ids = []
    elif os.environ.get('WORKBENCH_REMOTE_DOWNLOADS') == '1':
        local_ids = [pid for pid in ids if pid == 'desktop' and config.get('desktopToken')]
    local = {pid: f"http://127.0.0.1:{config['listenPort']}/s/{pid}/{token_for(config, pid)}.yaml"
             for pid in local_ids}
    if config.get('isolated'):
        return {'enabled': True, 'scope': 'local', 'readOnly': True, 'links': local, 'localLinks': local}
    return {'enabled': True, 'scope': 'tailnet', 'readOnly': True,
            'links': {pid: url_for(config, pid) for pid in ids}, 'localLinks': local}


def handler_for(store, config):
    class DownloadHandler(BaseHTTPRequestHandler):
        server_version = 'SubscriptionDownload/1'

        def log_message(self, *args):
            pass  # Never log subscription tokens, paths or configuration bodies.

        def reply(self, status, body=b'', content_type='text/plain; charset=utf-8', head=False):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('X-Frame-Options', 'DENY')
            self.end_headers()
            if not head:
                self.wfile.write(body)

        def download(self, head=False):
            try:
                host = urllib.parse.urlsplit('http://' + self.headers.get('Host', '')).hostname
                if host not in {'127.0.0.1', 'localhost', config['hostname']}:
                    return self.reply(404, head=head)
                origin = self.headers.get('Origin')
                if origin and origin != f"https://{config['hostname']}:{config['httpsPort']}":
                    return self.reply(403, head=head)
                parts = urllib.parse.urlsplit(self.path).path.split('/')
                if len(parts) != 4 or parts[:2] != ['', 's'] or not PROFILE_ID.fullmatch(parts[2]) or not parts[3].endswith('.yaml'):
                    return self.reply(404, head=head)
                pid, token = parts[2], parts[3][:-5]
                if not re.fullmatch(r'[a-f0-9]{64}', token) or not hmac.compare_digest(token, token_for(config, pid)):
                    return self.reply(404, head=head)
                body = store.subscription(pid).encode('utf-8')
                return self.reply(200, body, 'application/yaml; charset=utf-8', head)
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception as exc:
                if getattr(exc, 'status', None) == 404:
                    return self.reply(404, head=head)
                return self.reply(503, '订阅暂不可用；请保留客户端现有配置。'.encode(), head=head)

        def do_GET(self):
            self.download()

        def do_HEAD(self):
            self.download(head=True)

        def deny_write(self):
            self.reply(405)

        do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_TRACE = deny_write

    return DownloadHandler


def start_server(store, config):
    server = ThreadingHTTPServer(('127.0.0.1', config['listenPort']), handler_for(store, config))
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['init'])
    parser.add_argument('--hostname', required=True)
    parser.add_argument("--listen-port", type=int, default=18862)
    parser.add_argument("--https-port", type=int, default=8443)
    args = parser.parse_args()
    initialize(args.hostname, listen_port=args.listen_port, https_port=args.https_port)
    print('只读订阅入口已配置；独立令牌仅保存在本机私有设置中。')


if __name__ == '__main__':
    main()
