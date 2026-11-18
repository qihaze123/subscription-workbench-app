"""On-demand HTTPS latency checks through individual proxy nodes."""
import ipaddress
import json
import re
import socket
import threading
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from scripts.isolated_flclash import IsolatedCore

from .compiler import dump_yaml, selected_nodes
from .distribution import DATA_DIR
from .local_data import hydrate
from .seed import now
from .store import Problem


TARGET = "https://www.gstatic.com/generate_204"
TIMEOUT_MS = 6000
EXIT_TARGET = "https://api64.ipify.org?format=json"
INFO_NODE = re.compile(r"剩余流量|套餐到期|到期时间|下次重置|流量重置|官网")


def probe_node(core, name):
    reply = core.call("probe", {"url": TARGET, "proxy-name": name,
                               "timeout": TIMEOUT_MS, "max-body": 1})
    if not isinstance(reply, dict):
        return {"status": "failed", "reason": "探测没有返回结果"}
    if reply.get("error") == "timeout":
        return {"status": "timeout"}
    if reply.get("error"):
        message = reply.get("message", "").lower()
        if "dns resolve" in message:
            reason = "节点地址解析失败"
        elif "reality" in message:
            reason = "REALITY 握手失败"
        elif "connection refused" in message:
            reason = "连接被拒绝"
        elif "eof" in message or "connection reset" in message:
            reason = "连接被远端关闭"
        else:
            reason = "连接或握手失败"
        return {"status": "failed", "reason": reason}
    code = reply.get("status-code")
    if code != 204:
        return {"status": "failed", "reason": f"测速目标返回 HTTP {code}"}
    if name not in reply.get("chains", []):
        return {"status": "failed", "reason": "未确认流量经过指定节点"}
    delay = reply.get("delay")
    if not isinstance(delay, int) or delay < 0:
        return {"status": "failed", "reason": "内核未返回有效延迟"}
    return {"status": "ok", "delayMs": delay}


class NodeProbes:
    def __init__(self, store, binary, source_loader=None, environment="工作台所在主机", allowed_sources=None, interface=None):
        self.store = store
        self.binary = Path(binary) if binary else None
        self.source_loader = source_loader
        self.environment = environment
        self.allowed_sources = allowed_sources
        self.interface = interface
        self.lock = threading.Lock()
        self.active = None

    def _history(self, source_id, revision):
        row = self.store.db.execute("SELECT value FROM meta WHERE key=?",
                                    ("nodeProbeHistory:" + source_id,)).fetchone()
        if not row:
            return []
        return [run for run in json.loads(row[0]) if run["sourceRevision"] == revision
                and run["environment"] == self.environment]

    def result(self, source_id):
        with self.lock, self.store.lock:
            revision = self.store._get("sourcesRevision")
            previous = self._saved("nodeProbe:" + source_id, revision)
            active = self.active if self.active and self.active["sourceId"] == source_id else None
            if active and active["sourceRevision"] != revision:
                active = None
            run = active or previous
            fallback = None
            if active:
                fallback = (previous if previous and previous["state"] == "done" else
                            self._saved("nodeProbeComplete:" + source_id, revision))
            elif run and run["state"] == "failed":
                fallback = self._saved("nodeProbeComplete:" + source_id, revision)
            stability = {}
            for completed in self._history(source_id, revision):
                for name, item in completed["items"].items():
                    if item["status"] == "skipped":
                        continue
                    summary = stability.setdefault(name, {"samples": 0, "ok": 0})
                    summary["samples"] += 1
                    summary["ok"] += item["status"] == "ok"
            return {"available": self.available(source_id), "target": TARGET, "timeoutMs": TIMEOUT_MS,
                    "stability": stability, "exitTarget": EXIT_TARGET,
                    "environment": self.environment, "run": json.loads(json.dumps(run)) if run else None,
                    "previous": fallback}

    def _saved(self, key, revision):
        record = self.store.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        value = json.loads(record[0]) if record else None
        return value if value and value.get("sourceRevision") == revision and value.get("environment") == self.environment else None

    def available(self, source_id):
        return bool(self.binary and self.binary.is_file() and
                    (self.allowed_sources is None or source_id in self.allowed_sources))

    def start(self, source_id):
        if not self.available(source_id):
            raise Problem("该来源暂未配置测速", 503)
        with self.lock, self.store.lock:
            if self.active:
                if self.active["sourceId"] == source_id:
                    return
                raise Problem("另一个来源正在测速，请稍后再试", 409)
            source = next((item for item in self.store._get("sources") if item["id"] == source_id), None)
            if not source or not source.get("enabled"):
                raise Problem("该订阅来源不可用", 404)
            self.active = {
                "id": uuid4().hex, "sourceId": source_id, "sourceRevision": self.store._get("sourcesRevision"),
                "state": "running", "startedAt": now(), "items": {}, "total": 0,
                "environment": self.environment,
            }
            run = self.active
        threading.Thread(target=self._run, args=(source, run), daemon=True).start()

    def _run(self, configured, run):
        try:
            source = self.source_loader(configured) if self.source_loader else configured
            nodes, _ = selected_nodes({"sourceIds": [source["id"]]}, [source])
            names = {node["name"] for node in selected_nodes(
                {"sourceIds": [configured["id"]]}, [configured],
            )[0]}
            nodes = [node for node in nodes if node["name"] in names]
            candidates = [node for node in nodes if not INFO_NODE.search(node["name"])]
            if not candidates or any(not node.get("server") or not node.get("port") for node in candidates):
                raise Problem("订阅缺少可测试的实际节点配置")
            candidates = hydrate(candidates)
            with self.lock:
                run["total"] = len(nodes)
                for node in nodes:
                    if INFO_NODE.search(node["name"]):
                        run["items"][node["name"]] = {"status": "skipped"}
            if self.interface:
                candidates = self._resolve_endpoints(candidates, run)
            if candidates:
                self._measure(candidates, run)
            state, error = "done", ""
        except Problem as exc:
            state, error = "failed", str(exc)
        except (OSError, ValueError):
            state, error = "failed", "未能读取实际节点配置或启动测速内核，请重试"
        except Exception:
            state, error = "failed", "测速中断，请重试"
        finally:
            with self.lock:
                run.update(state=state, finishedAt=now())
                if error:
                    run["error"] = error
                try:
                    with self.store.lock, self.store.db:
                        if self.store._get("sourcesRevision") == run["sourceRevision"]:
                            source_id = run["sourceId"]
                            self.store._set("nodeProbe:" + source_id, run)
                            if state == "done":
                                self.store._set("nodeProbeComplete:" + source_id, run)
                                history = self._history(source_id, run["sourceRevision"])
                                self.store._set("nodeProbeHistory:" + source_id, [*history, run][-10:])
                finally:
                    self.active = None

    def _resolve_endpoints(self, nodes, run):
        # Resolve using the host's DNS. Do not send node-address lookups through the probe tunnel.
        resolved = {}
        candidates = []
        for node in nodes:
            host = node["server"]
            port = node["port"]
            key = (host, port)
            if key not in resolved:
                try:
                    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
                    resolved[key] = next((item[4][0] for item in addresses if item[0] == socket.AF_INET),
                                         addresses[0][4][0])
                except OSError:
                    resolved[key] = None
            address = resolved[key]
            if address is None:
                with self.lock:
                    run["items"][node["name"]] = {"status": "failed", "reason": "节点地址解析失败"}
                continue
            node["server"] = address
            if node.get("tls") and not (node.get("servername") or node.get("sni")):
                node["servername"] = host
            candidates.append(node)
        return candidates

    def exit_ip(self, source_id, name):
        if not self.available(source_id):
            raise Problem("此来源暂未配置节点检测", 503)
        with self.store.lock:
            source = next((item for item in self.store._get("sources")
                           if item["id"] == source_id and item.get("enabled")), None)
        if source is None:
            raise Problem("订阅来源不可用", 404)
        nodes, _ = selected_nodes({"sourceIds": [source_id]}, [source])
        node = next((item for item in nodes if item["name"] == name
                     and not INFO_NODE.search(name)), None)
        if not node or not node.get("server") or not node.get("port"):
            raise Problem("该节点无法进行出口 IP 检测", 404)
        try:
            nodes = hydrate([node])
            if self.interface:
                nodes = self._resolve_endpoints(nodes, {"items": {}})
            if not nodes:
                raise Problem("节点地址解析失败", 502)
            with self._isolated_core(nodes) as core:
                reply = core.call("probe", {"url": EXIT_TARGET, "proxy-name": name,
                                            "timeout": TIMEOUT_MS, "max-body": 1024})
                if not isinstance(reply, dict) or reply.get("status-code") != 200 or name not in reply.get("chains", []):
                    raise Problem("未能通过指定节点取得出口 IP", 502)
                body = reply.get("body")
                if isinstance(body, dict):
                    result = body
                else:
                    result = json.loads(body or "{}")
                address = str(ipaddress.ip_address(result.get("ip")))
                return {"ip": address, "checkedAt": now(), "environment": self.environment}
        except (ValueError, TypeError, OSError, EOFError, RuntimeError) as exc:
            raise Problem("节点出口 IP 检测失败，请重试", 502) from exc

    @contextmanager
    def _isolated_core(self, nodes):
        private = DATA_DIR / "private"
        private.mkdir(mode=0o700, parents=True, exist_ok=True)
        with TemporaryDirectory(prefix="node-probe-", dir=private) as directory:
            home = Path(directory)
            (home / "FlClashCore").symlink_to(self.binary.resolve())
            config = home / "config.yaml"
            config.touch(mode=0o600)
            settings = {"mode": "rule", "proxies": nodes, "rules": ["MATCH,REJECT"],
                                         "tun": {"enable": False}, "mixed-port": 0, "allow-lan": False,
                        "dns": {"enable": True, "nameserver": ["system"]}}
            if self.interface:
                settings["interface-name"] = self.interface
                for node in nodes:
                    node["interface-name"] = self.interface
            config.write_text(dump_yaml(settings))
            core = IsolatedCore(home)
            try:
                core.call("initClash", {"home-dir": str(home), "version": 0})
                status = core.call("setupConfig", {"selected-map": {}, "test-url": TARGET,
                                                   "skip-cert-verify": False})
                config.unlink()
                if status not in (None, "", True):
                    raise Problem("测速内核无法加载这份节点配置")
                core.call("startListener")
                yield core
            finally:
                core.close()

    def _measure(self, nodes, run):
        with self._isolated_core(nodes) as core:
            for node in nodes:
                result = probe_node(core, node["name"])
                with self.lock:
                    run["items"][node["name"]] = result
