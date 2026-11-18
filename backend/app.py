#!/usr/bin/env python3
"""Local-only preview server. Does not reconfigure any running proxy or VPN."""
import argparse
import json
import mimetypes
import os
import re
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import yaml

from . import ip_reputation

from .compiler import compile_profile, dump_yaml, import_config, parse_yaml, selector_regex_matches, summarize_group_members
from .store import Problem, Store
from .distribution import DATA_DIR, load_config, public_metadata, share_state, start_server
from .rule_templates import catalog, load_template, refresh_catalog
from workbench_api import WorkbenchAPI, gzip_for_ui


ROOT = Path(__file__).resolve().parent.parent


def handler_for(store, static_dir=None, distribution=None, tailnet_admin=None, node_probes=None):
    static_dir = Path(static_dir or ROOT / "public").resolve()
    api = WorkbenchAPI(store, distribution)
    if tailnet_admin:
        admin_origin, admin_logins = tailnet_admin
        if isinstance(admin_logins, str):
            admin_logins = (admin_logins,)

    class Handler(BaseHTTPRequestHandler):
        server_version = "SubscriptionWorkbench/0.1"

        def log_message(self, fmt, *args):
            # Never log paths, subscription URLs, request bodies or configuration values.
            pass

        def send_body(self, body, kind="application/json; charset=utf-8", code=200):
            if isinstance(body, str):
                body = body.encode()
            body, encoding_headers = gzip_for_ui(self.command, urllib.parse.urlsplit(self.path).path,
                kind, self.headers.get("Accept-Encoding", ""), body)
            self.send_response(code)
            for key, value in encoding_headers.items():
                self.send_header(key, value)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store" if tailnet_admin or "/api/" in self.path else "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "DENY")
            self.end_headers()
            self.wfile.write(body)

        def json(self, value, code=200):
            self.send_body(json.dumps(value, ensure_ascii=False, allow_nan=False), code=code)

        def data(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length < 0 or length > 2_000_000:
                raise Problem("请求大小超过 2MB", 413)
            value = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(value, dict):
                raise Problem("请求必须是 JSON 对象", 422)
            return value

        def do_GET(self):
            self.handle_request("GET")

        def do_POST(self):
            self.handle_request("POST")

        def do_PUT(self):
            self.handle_request("PUT")

        def do_DELETE(self):
            self.handle_request("DELETE")

        def do_OPTIONS(self):
            self.json({"error": "不提供跨站访问"}, 403)

        def handle_request(self, method):
            try:
                origin = self.headers.get("Origin")
                if tailnet_admin:
                    authority = urllib.parse.urlsplit(admin_origin).netloc
                    identity = self.headers.get_all("Tailscale-User-Login", [])
                    if (self.headers.get_all("Host", []) != [authority]
                            or len(identity) != 1 or identity[0] not in admin_logins):
                        raise Problem("此入口仅允许授权的 Tailscale 账户访问", 403)
                    if (method != "GET" or origin is not None) and origin != admin_origin:
                        raise Problem("拒绝跨站请求", 403)
                else:
                    host = self.headers.get("Host", "").split(":")[0]
                    if host not in {"127.0.0.1", "localhost"}:
                        raise Problem("本机管理入口仅支持回环地址", 403)
                    local_origins = {
                        f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}",
                        "http://127.0.0.1:4178", "http://localhost:4178",
                    }
                    if origin and origin not in local_origins:
                        raise Problem("拒绝跨站请求", 403)
                path = urllib.parse.urlsplit(self.path).path
                parts = [urllib.parse.unquote(p) for p in path.strip("/").split("/") if p]
                data = self.data() if method != "GET" else {}
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                if api.handle(self, method, path, query, data, tailnet_admin):
                    return
                if path == "/api/distribution" and method == "GET":
                    return self.json(public_metadata(distribution, store, prefer_tailnet=bool(tailnet_admin)))
                if path == "/api/distribution/share":
                    if method == "GET":
                        return self.json(share_state(store, distribution, query.get("profileId", [""])[0]))
                    if method == "POST":
                        enabled = data.get("enabled")
                        if type(enabled) is not bool:
                            raise Problem("请提供有效的外发开关状态", 422)
                        return self.json(share_state(store, distribution, data.get("profileId"), enabled))
                if path == "/api/bootstrap" and method == "GET":
                    return self.json(store.bootstrap())
                if parts == ["api", "rule-templates"] and method == "GET":
                    return self.json(catalog())
                if parts == ["api", "rule-templates", "refresh"] and method == "POST":
                    return self.json(refresh_catalog())
                if len(parts) == 3 and parts[:2] == ["api", "rule-templates"] and method == "GET":
                    return self.json(load_template(parts[2]))
                if len(parts) == 4 and parts[:2] == ["api", "sources"] and parts[3] == "node-probes" and method in {"GET", "POST"}:
                    if node_probes is None:
                        if method == "GET":
                            return self.json({"available": False, "run": None})
                        raise Problem("此工作台尚未配置测速内核", 503)
                    if method == "POST":
                        node_probes.start(parts[2])
                    return self.json(node_probes.result(parts[2]), 202 if method == "POST" else 200)
                if len(parts) == 4 and parts[:2] == ["api", "sources"] and parts[3] == "exit-ip" and method == "POST":
                    if node_probes is None:
                        raise Problem("此工作台尚未配置检测内核", 503)
                    name = data.get("name")
                    if not isinstance(name, str) or not name or len(name) > 512:
                        raise Problem("节点名称无效", 422)
                    return self.json(node_probes.exit_ip(parts[2], name))
                if path == "/api/ip-reputation" and method == "GET":
                    return self.json({"available": ip_reputation.available()})
                if path == "/api/ip-reputation" and method == "POST":
                    return self.json(ip_reputation.lookup(data.get("ip")))
                if path == "/api/routing-order" and method == "POST":
                    with store.lock:
                        sources, company = store._get("sources"), store._get("company")
                    result, compiled = compile_profile(data.get("profile"), sources, company)
                    return self.json({"rules": compiled.get("rules", []) if result["ok"] else [],
                                      "errors": result["errors"]})
                if path == "/api/group-members" and method == "POST":
                    profile = data.get("profile")
                    if not isinstance(profile, dict):
                        raise Problem("策略组数据无效", 422)
                    with store.lock:
                        sources = store._get("sources")
                    groups, errors = summarize_group_members(profile, sources)
                    if errors:
                        raise Problem("策略组数据无效", 422, errors=errors)
                    return self.json({"groups": groups})
                if path == "/api/selector-matches" and method == "POST":
                    filters = data.get("filters")
                    if not isinstance(filters, list) or len(filters) > 150 or any(
                        not isinstance(item, dict) or not item.get("sourceId") or any(
                            not isinstance(item.get(key, ""), str) or len(item.get(key, "")) > 4096
                            for key in ("sourceId", "include", "exclude")
                        ) for item in filters
                    ):
                        raise Problem("节点筛选配置无效", 422)
                    with store.lock:
                        source_nodes = {
                            source["id"]: [(node["rawName"], node["name"]) for node in source["nodeInventory"]]
                            for source in store.sources() if source["enabled"]
                        }
                    matches = []
                    for item in filters:
                        try:
                            eligible = selector_regex_matches(item, source_nodes.get(item["sourceId"], []))
                            matches.append({"names": eligible})
                        except re.error:
                            matches.append({"error": "正则语法无效"})
                    return self.json({"matches": matches})
                if path == "/api/profiles" and method == "POST":
                    return self.json(store.create(data.get("profile")), 201)
                if path == "/api/sources" and method == "PUT":
                    return self.json(store.save_sources(data.get("sources"), data.get("revision")))
                if path == "/api/compare" and method == "POST":
                    return self.json(store.compare(data))
                if path == '/api/company' and method == 'GET':
                    with store.lock:return self.json(store._get('company'))
                if path == "/api/import" and method == "POST":
                    return self.json(import_config(data.get("text", ""), data.get("name") or "导入配置"))
                if parts[:2] == ["api", "yaml"] and method == "POST":
                    if parts[2:] == ["parse"]:
                        return self.json({"value": parse_yaml(data.get("text", ""))})
                    if parts[2:] == ["stringify"]:
                        return self.json({"text": dump_yaml(data.get("value"))})
                if parts[:2] == ["api", "profiles"] and len(parts) >= 3:
                    pid = parts[2]
                    action = parts[3] if len(parts) == 4 else ""
                    if len(parts) == 3 and method == "PUT":
                        return self.json(store.save(pid, data.get("profile"), data.get("revision")))
                    if len(parts) == 3 and method == "DELETE":
                        return self.json(store.delete(pid, data.get("revision")))
                    if action in {"validate", "preview"} and method == "POST":
                        return self.json(store.validate(data.get("profile")))
                    if action == "publish" and method == "POST":
                        return self.json(store.publish(pid, data.get("revision")))
                    if action == "history" and method == "GET":
                        return self.json(store.history(pid))
                    if action == "routing-order" and method == "GET":
                        return self.json(store.published_routing_order(pid))
                    if action == "restore" and method == "POST":
                        return self.json(store.restore(pid, data.get("version"), data.get("revision")))
                if len(parts) == 4 and parts[:2] == ["api", "sources"] and parts[3] == "refresh" and method == "POST":
                    return self.json(store.refresh(parts[2]), 202)
                if len(parts) == 3 and parts[:2] == ["api", "jobs"] and method == "GET":
                    return self.json(store.job(parts[2]))
                if len(parts) == 2 and parts[0] == "subscriptions" and parts[1].endswith(".yaml") and method == "GET":
                    return self.send_body(store.subscription(parts[1][:-5]), "application/yaml; charset=utf-8")
                if parts and parts[0] == "api":
                    raise Problem("接口不存在", 404)
                if method != "GET":
                    raise Problem("接口不存在", 404)
                target = (static_dir / path.lstrip("/")).resolve()
                if not target.is_relative_to(static_dir):
                    raise Problem("路径不允许", 403)
                if path == "/":
                    target = static_dir / "index.html"
                if not target.is_file():
                    raise Problem("页面尚未构建，请先运行 frontend npm run build", 404)
                return self.send_body(target.read_bytes(), mimetypes.guess_type(str(target))[0] or "application/octet-stream")
            except Problem as exc:
                self.json({"error": str(exc), **exc.detail}, exc.status)
            except yaml.YAMLError as exc:
                mark = getattr(exc, 'problem_mark', None)
                position = f'第 {mark.line + 1} 行，第 {mark.column + 1} 列' if mark else ''
                self.json({"error": f"YAML 语法错误：{position}。{getattr(exc, 'problem', '')}"}, 422)
            except (ValueError, TypeError, KeyError, RecursionError):
                self.json({"error": "数据格式无效，请检查 YAML / JSON、字段类型和引用；原配置未被覆盖。"}, 422)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as exc:
                print(f"request error: {type(exc).__name__}", file=sys.stderr)
                self.json({"error": "服务处理失败，已保留上次发布配置。"}, 500)

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18861)
    parser.add_argument("--admin-port", type=int, default=18863)
    parser.add_argument("--data", type=Path, default=DATA_DIR / "workbench.sqlite3")
    parser.add_argument("--empty", action="store_true", help="初始化空数据库")
    args = parser.parse_args()
    distribution = load_config()
    funnel = distribution.get("funnel") if distribution else None
    if funnel and funnel["listenPort"] in {args.port, args.admin_port}:
        parser.error("公网订阅与管理入口必须使用不同的监听端口")
    admin_path = Path(os.environ.get("WORKBENCH_ADMIN_CONFIG", DATA_DIR / "private/tailnet-admin.json")).expanduser()
    tailnet_admin = None
    if admin_path.is_file():
        admin = json.loads(admin_path.read_text())
        https_port = admin.get("httpsPort", 9443)
        if funnel and funnel["httpsPort"] == https_port:
            parser.error("公网订阅与管理入口必须使用不同的 HTTPS 端口")
        additional_logins = admin.get("additional_logins", [])
        if not isinstance(additional_logins, list):
            raise ValueError("Tailscale 管理入口配置无效")
        logins = [admin["login"], *additional_logins]
        if not distribution or type(https_port) is not int or not 1 <= https_port <= 65535 or any(
            not isinstance(login, str) or not re.fullmatch(r"[^\s\x00-\x1f]{1,256}", login) for login in logins
        ):
            raise ValueError("Tailscale 管理入口配置无效")
        tailnet_admin = (f"https://{distribution['hostname']}:{https_port}", frozenset(logins))
    store = Store(args.data, seed_demo=not args.empty)
    node_probes = None
    if probe_core := os.environ.get("WORKBENCH_FLCLASH_CORE"):
        from .node_probe import NodeProbes
        node_probes = NodeProbes(store, probe_core)
    download_server=start_server(store,distribution) if distribution else None
    funnel_server = start_server(store, distribution, public=True) if funnel else None
    download_servers = [listener for listener in (download_server, funnel_server) if listener]
    for listener in download_servers:
        threading.Thread(target=listener.serve_forever, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler_for(store, distribution=distribution, node_probes=node_probes))
    admin_server = None
    if tailnet_admin:
        admin_server = ThreadingHTTPServer(
            ("127.0.0.1", args.admin_port), handler_for(store, distribution=distribution, tailnet_admin=tailnet_admin, node_probes=node_probes)
        )
        threading.Thread(target=admin_server.serve_forever, daemon=True).start()
    print(f"本地订阅工作台：http://127.0.0.1:{args.port} ", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for listener in download_servers:
            listener.shutdown()
            listener.server_close()
        if admin_server:
            admin_server.shutdown()
            admin_server.server_close()
        server.server_close()
        store.close()


if __name__ == "__main__":
    main()
