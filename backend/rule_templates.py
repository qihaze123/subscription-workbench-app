"""Discover and fetch public Mihomo domain rule sets from MetaCubeX."""

import hashlib
import json
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import yaml

from .compiler import parse_yaml
from .store import Problem


SOURCE = "MetaCubeX / meta-rules-dat"
REPO = "https://github.com/MetaCubeX/meta-rules-dat/tree/meta/geo/geosite"
BASE = "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite"
TREES = "https://api.github.com/repos/MetaCubeX/meta-rules-dat/git/trees"
LABELS = {
    "openai": ("OpenAI", "ChatGPT、OpenAI API 和相关资源"),
    "anthropic": ("Anthropic", "Claude、Anthropic API 和相关资源"),
    "category-ai-!cn": ("海外 AI 服务", "跨多个 AI 服务的社区规则集"),
    "youtube": ("YouTube", "视频网站与相关资源"),
    "github": ("GitHub", "代码托管与相关资源"),
    "netflix": ("Netflix", "视频流媒体与相关资源"),
    "telegram": ("Telegram", "消息服务及相关资源"),
}
MAX_BYTES = 700_000
RULE_FILE = re.compile(r"([a-zA-Z0-9_@!+.=-]+)\.yaml")
DOMAIN = re.compile(r"(?:\+\.)?[a-zA-Z0-9_*.-]{1,253}")
_catalog = json.loads(Path(__file__).with_name("rule_catalog.json").read_text(encoding="utf-8"))
_refresh_lock = threading.Lock()


def describe(template_id):
    name, description = LABELS.get(template_id, (template_id, ""))
    return {"id": template_id, "name": name, "description": description, "source": SOURCE,
            "sourceUrl": f"{BASE}/{urllib.parse.quote(template_id, safe='')}.yaml"}


def catalog():
    index = _catalog
    ids = [rule_id for rule_id in LABELS if rule_id in index]
    ids.extend(sorted(index.keys() - LABELS.keys()))
    return {"templates": [describe(rule_id) for rule_id in ids if index[rule_id] <= MAX_BYTES],
            "featuredIds": list(LABELS), "sourceUrl": REPO}


def _tree(ref):
    request = urllib.request.Request(f"{TREES}/{ref}", headers={
        "User-Agent": "subscription-workbench", "Accept": "application/vnd.github+json",
    })
    with urllib.request.urlopen(request, timeout=5) as response:
        tree = json.loads(response.read(1_500_000))
    if not isinstance(tree, dict) or tree.get("truncated") or not isinstance(tree.get("tree"), list):
        raise ValueError("incomplete rule catalog")
    return tree["tree"]


def _api_index():
    ref = "meta"
    for directory in ("geo", "geosite"):
        ref = next(item["sha"] for item in _tree(ref)
                   if item["type"] == "tree" and item["path"] == directory)
        if not re.fullmatch(r"[a-f0-9]{40}", ref):
            raise ValueError("invalid upstream tree")
    index = {}
    for item in _tree(ref):
        match = RULE_FILE.fullmatch(item["path"])
        if match and item["type"] == "blob":
            index[match[1]] = item["size"]
    return index


def _browser_index(previous):
    """Use GitHub's file-finder index when the anonymous REST quota is exhausted."""
    headers = {"User-Agent": "subscription-workbench"}
    with urllib.request.urlopen(urllib.request.Request(REPO, headers=headers), timeout=5) as response:
        page = response.read(3_000_000)
    commit = re.search(rb'"currentOid":"([a-f0-9]{40})"', page)
    if commit is None:
        raise ValueError("upstream commit missing")
    url = f"https://github.com/MetaCubeX/meta-rules-dat/tree-list/{commit[1].decode()}"
    headers.update(Accept="application/json", **{"X-Requested-With": "XMLHttpRequest"})
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=5) as response:
        paths = json.loads(response.read(8_000_000))["paths"]
    index = {}
    for path in paths:
        if path.startswith("geo/geosite/") and (match := RULE_FILE.fullmatch(path[12:])):
            # File finder lists paths only. A new entry is size-checked at download.
            index[match[1]] = previous.get(match[1], 0)
    return index


def refresh_catalog():
    global _catalog
    with _refresh_lock:
        try:
            try:
                new_index = _api_index()
            except urllib.error.HTTPError as exc:
                if exc.code not in {403, 429}:
                    raise
                new_index = _browser_index(_catalog)
                if len(new_index) < len(_catalog) * 0.9:
                    raise ValueError("incomplete fallback catalog")
            if not LABELS.keys() <= new_index.keys() or len(new_index) < 500:
                raise ValueError("incomplete rule catalog")
        except (OSError, ValueError, StopIteration, TypeError, KeyError) as exc:
            raise Problem("暂时无法刷新 GitHub 目录，可以继续使用已有目录。", 502) from exc
        _catalog = new_index
        return catalog()


def load_template(template_id):
    size = _catalog.get(template_id)
    if size is None and template_id not in LABELS:
        raise Problem("规则集不存在于 MetaCubeX 目录", 404)
    if size is not None and size > MAX_BYTES:
        raise Problem("该规则集超出工作台的快照大小限制", 422)
    info = describe(template_id)
    try:
        request = urllib.request.Request(info["sourceUrl"], headers={"User-Agent": "subscription-workbench"})
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError("rule set too large")
        parsed = parse_yaml(raw.decode())
        entries = parsed.get("payload") if isinstance(parsed, dict) else None
        if not isinstance(entries, list) or not entries or any(
            not isinstance(entry, str) or not DOMAIN.fullmatch(entry) for entry in entries
        ):
            raise ValueError("invalid domain rule set")
    except (OSError, ValueError, yaml.YAMLError) as exc:
        raise Problem("公共规则源暂时不可用。可以重试，已有规则版本可继续使用。", 502) from exc
    entries = sorted(set(entries))
    version = hashlib.sha256("\n".join(entries).encode()).hexdigest()[:12]
    return {**info, "version": version, "entries": entries}
