"""Measure the current local subscription inventory without changing client VPNs."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import sys
from tempfile import NamedTemporaryFile
from threading import Lock

ROOT = Path(__file__).resolve().parent
PRIVATE = Path(os.environ.get("WORKBENCH_DATA_DIR", ROOT / "data")).expanduser() / "private"
EXPIRATION_NOTICE = re.compile(r"过期时间")
CORE = Path(os.environ["WORKBENCH_FLCLASH_CORE"]).expanduser() if os.environ.get("WORKBENCH_FLCLASH_CORE") else None

from backend import node_probe
from backend.compiler import selected_nodes
from backend.local_data import hydrate
from backend.seed import now


def probe_exit(core, name):
    reply = core.call("probe", {
        "url": node_probe.EXIT_TARGET,
        "proxy-name": name,
        "timeout": node_probe.TIMEOUT_MS,
        "max-body": 1024,
    })
    if reply.get("error") == "timeout":
        return {"exitStatus": "timeout"}
    if reply.get("status-code") != 200 or name not in reply.get("chains", []):
        return {"exitStatus": "failed"}
    body = reply.get("body")
    if not isinstance(body, dict):
        body = json.loads(body)
    return {"exitStatus": "ok", "exitIp": str(ipaddress.ip_address(body.get("ip")))}


def measure_chunk(tester, nodes, record):
    completed = set()
    try:
        with tester._isolated_core(nodes) as core:
            for node in nodes:
                name = node["name"]
                try:
                    latency = node_probe.probe_node(core, name)
                except (OSError, RuntimeError, ValueError, EOFError):
                    latency = {"status": "failed", "reason": "测速内核未返回响应"}
                try:
                    exit_result = probe_exit(core, name)
                except (OSError, RuntimeError, ValueError, TypeError, AttributeError, EOFError):
                    exit_result = {"exitStatus": "failed"}
                completed.add(name)
                record(name, {**latency, **exit_result})
    except (OSError, RuntimeError, ValueError, EOFError, node_probe.Problem):
        pending = [node for node in nodes if node["name"] not in completed]
        if len(pending) > 1:
            split = len(pending) // 2
            measure_chunk(tester, pending[:split], record)
            measure_chunk(tester, pending[split:], record)
        else:
            for node in pending:
                record(node["name"], {
                    "status": "failed", "exitStatus": "failed",
                    "reason": "测速内核未能加载节点",
                })


def save(file, results):
    with NamedTemporaryFile(mode="w", dir=file.parent, delete=False, encoding="utf-8") as handle:
        pending = Path(handle.name)
        json.dump(results, handle, ensure_ascii=False)
    pending.replace(file)


def targets(store, scope):
    selected = {}
    selection = {item["sourceId"]: item for item in scope.get("selection", [])}
    for source in store["sources"]:
        source_id = source["id"]
        if not source.get("enabled", True) or (scope.get("sourceId") not in (None, source_id)):
            continue
        if selection and source_id not in selection:
            continue
        request = selection.get(source_id, scope)
        if request.get("sourceId") and request.get("sourceUpdatedAt") != source.get("updatedAt"):
            raise node_probe.Problem("节点列表已更新，请重新打开本页后测速")
        requested_names = set(request.get("nodes", []))
        nodes, _ = selected_nodes({"sourceIds": [source_id]}, [source])
        candidates = [
            node for node in nodes if scope.get("nodeName") in (None, node["name"])
            and (not requested_names or node["name"] in requested_names)
            and not node_probe.INFO_NODE.search(node["name"])
            and not EXPIRATION_NOTICE.search(node["name"])
        ]
        if requested_names and len(candidates) != len(requested_names):
            raise node_probe.Problem("部分候选已变化，请重新打开本页后测速")
        if candidates:
            selected[source_id] = (source.get("updatedAt"), candidates)
    if selection and selected.keys() != selection.keys():
        raise node_probe.Problem("节点列表已更新，请重新打开本页后测速")
    if not selected:
        raise node_probe.Problem("这个范围没有可测速的节点")
    return selected


def measure(file, selected, emit):
    if file.exists():
        results = json.loads(file.read_text())
    else:
        results = {"sources": {}, "environment": "本机 Mac · en0", "timeoutMs": node_probe.TIMEOUT_MS}
    tester = node_probe.NodeProbes(None, CORE, interface=os.environ.get("WORKBENCH_PROBE_INTERFACE", ""))
    lock = Lock()
    started_at = now()
    emit("start", targets={
        sid: {"sourceUpdatedAt": revision, "nodes": [node["name"] for node in nodes]}
        for sid, (revision, nodes) in selected.items()
    }, startedAt=started_at)

    def test_source(source_id, revision, chunk):
        def record(name, measurement):
            checked = {**measurement, "checkedAt": now()}
            with lock:
                run = results["sources"].get(source_id, {})
                if not run or run["sourceUpdatedAt"] != revision:
                    run = {"sourceUpdatedAt": revision, "items": {}}
                run["items"][name] = checked
                run.update(startedAt=started_at, finishedAt=checked["checkedAt"])
                results["sources"][source_id] = run
                save(file, results)
                emit("result", sourceId=source_id, name=name, measurement=checked)

        measurable = []
        for node in chunk:
            try:
                config = hydrate(node)
            except ValueError:
                config = {}
            if config.get("server") and config.get("port"):
                measurable.append(config)
            else:
                record(node["name"], {"status": "failed", "exitStatus": "failed",
                                      "reason": "节点缺少有效的连接配置"})
        unresolved = {"items": {}}
        measurable = tester._resolve_endpoints(measurable, unresolved)
        for name, failure in unresolved["items"].items():
            record(name, {**failure, "exitStatus": "failed"})
        if measurable:
            measure_chunk(tester, measurable, record)

    jobs = []
    with ThreadPoolExecutor(max_workers=8) as workers:
        # Give each source a group of workers early in a whole-workbench run.
        for start in range(0, max(len(nodes) for _, nodes in selected.values()), 9):
            for source_id, (revision, nodes) in selected.items():
                chunk = nodes[start:start+9]
                if chunk:
                    jobs.append(workers.submit(test_source, source_id, revision, chunk))
        for job in jobs:
            job.result()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", type=Path, default=PRIVATE / "live-store.json")
    parser.add_argument("--events", action="store_true")
    args = parser.parse_args()

    def emit(kind, **payload):
        if args.events:
            print(json.dumps({"type": kind, **payload}, ensure_ascii=False), flush=True)
        elif kind == "start":
            print(f'开始测速，共 {sum(len(v["nodes"]) for v in payload["targets"].values())} 个节点', flush=True)
        elif kind == "error":
            print(payload["message"], file=sys.stderr)

    try:
        if CORE is None or not CORE.is_file():
            raise node_probe.Problem("本机测速内核不可用")
        scope = json.load(sys.stdin) if args.events else {}
        store = json.loads(args.store.read_text())
        lock_file = args.store.parent / "node-measurements.lock"
        with os.fdopen(os.open(lock_file, os.O_CREAT | os.O_WRONLY, 0o600), "w") as guard:
            try:
                fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise node_probe.Problem("已有测速在运行，请稍后再试") from None
            measure(args.store.with_name("node-measurements.json"), targets(store, scope), emit)
        if not args.events:
            print("测速完成", flush=True)
    except node_probe.Problem as error:
        emit("error", message=str(error))
        return 1
    except (OSError, ValueError, RuntimeError):
        emit("error", message="测速中断，请重试")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
