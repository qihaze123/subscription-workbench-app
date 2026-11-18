"""Optional user-triggered abuse report lookup for a measured public exit IP."""
import ipaddress
import json
import os
import urllib.error
import urllib.parse
import urllib.request

from .seed import now
from .store import Problem


PROVIDER = "AbuseIPDB"
WINDOW_DAYS = 90
ENDPOINT = "https://api.abuseipdb.com/api/v2/check"


def available():
    return bool(os.environ.get("WORKBENCH_ABUSEIPDB_KEY", "").strip())


def lookup(value):
    try:
        if not isinstance(value, str) or len(value) > 45:
            raise ValueError("invalid IP")
        address = ipaddress.ip_address(value)
        if not address.is_global:
            raise ValueError("not a public address")
    except ValueError as exc:
        raise Problem("请输入可公开路由的 IPv4 或 IPv6 地址", 422) from exc

    key = os.environ.get("WORKBENCH_ABUSEIPDB_KEY", "").strip()
    if not key:
        raise Problem("尚未配置 IP 信誉数据源", 503)
    query = urllib.parse.urlencode({"ipAddress": str(address), "maxAgeInDays": WINDOW_DAYS})
    request = urllib.request.Request(f"{ENDPOINT}?{query}", headers={
        "Accept": "application/json", "Key": key, "User-Agent": "subscription-workbench",
    })
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            data = json.loads(response.read(64_000))["data"]
        if ipaddress.ip_address(data["ipAddress"]) != address:
            raise ValueError("unexpected IP")
        score, reports = data["abuseConfidenceScore"], data["totalReports"]
        if type(score) is not int or not 0 <= score <= 100 or type(reports) is not int or reports < 0:
            raise ValueError("invalid reputation result")
    except urllib.error.HTTPError as exc:
        description = "IP 信誉服务达到查询限额，稍后再试" if exc.code == 429 else "IP 信誉服务暂不可用"
        raise Problem(description, 502) from exc
    except (OSError, ValueError, TypeError, KeyError) as exc:
        raise Problem("未取得可用的 IP 信誉数据", 502) from exc
    return {"provider": PROVIDER, "days": WINDOW_DAYS, "score": score, "reports": reports,
            "checkedAt": now()}
