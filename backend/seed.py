"""Explicitly synthetic data. No credentials or subscriptions are copied from production."""
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


COMPANY = {
    "cidrs": ["192.0.2.0/24"],
    "origin": "文档专用示例网段",
    "updatedAt": now(),
    "connected": False,
}


def seed_sources():
    result = []
    for key, name, prefix, names in [
        ("demo-a", "示例来源 A", "DEMO-A", ["日本 01", "新加坡 02", "美国 家宽 03"]),
        ("demo-b", "示例来源 B", "DEMO-B", ["日本 轻量 01", "美国 家宽 03"]),
    ]:
        result.append({
            "id": key, "name": name, "prefix": prefix, "url": "", "enabled": True,
            "status": "demo", "updatedAt": now(), "error": "",
            "cache": [{"name": n, "type": "trojan", "server": f"{key}-{i}.example.invalid",
                       "port": 443, "password": "demo-not-a-real-credential", "sni": "example.invalid"}
                      for i, n in enumerate(names, 1)],
        })
    return result


def group(gid, name, kind, sources=(), members=(), include=""):
    return {
        "id": gid, "name": name, "type": kind,
        "selectors": [{"sourceId": s, "include": include, "exclude": ""} for s in sources],
        "members": list(members),
        "options": {"url": "https://www.gstatic.com/generate_204", "interval": 300} if kind != "select" else {},
        "extra": {},
    }


def rule(rid, kind, value, target, no_resolve=False):
    return {"id": rid, "type": kind, "value": value, "target": target,
            "noResolve": no_resolve, "enabled": True}


def seed_profiles():
    profiles = []
    for device, name in (("desktop", "电脑示例"), ("phone", "手机示例")):
        profiles.append({
            "id": device, "name": name, "device": device,
            "description": "虚构示例配置",
            "sourceIds": ["demo-a", "demo-b"],
            "nodes": [
                {"name": "工作台 Tailscale", "type": "tailscale", "hostname": "workbench-demo"},
                {"name": "示例内网代理", "type": "http", "server": "192.0.2.10", "port": 8080},
            ],
            "groups": [
                group("daily", "日常流量", "select", members=["自动优选", "DIRECT"]),
                group("auto", "自动优选", "url-test", ["demo-a", "demo-b"]),
                group("corp", "🏢 公司内网", "select", members=["示例内网代理"]),
            ],
            "rules": [
                rule("mesh", "DOMAIN", "device-01.mesh.example", "工作台 Tailscale"),
                rule("corp", "COMPANY", "", "🏢 公司内网", True),
                rule("last", "MATCH", "", "日常流量"),
            ],
            "network": {"dns": {"enable": False}, "tun": {"enable": False}},
            "extras": {"allow-lan": False, "mode": "rule"},
        })
    return profiles
