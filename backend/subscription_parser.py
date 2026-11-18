"""Parse Clash YAML and Shadowsocks URI subscription sources."""
import base64
import binascii
import re
from urllib.parse import parse_qs, unquote, urlsplit

from .compiler import parse_yaml

MAX_TEXT_BYTES = 2_000_000
BASE64 = re.compile(r"[A-Za-z0-9+/_-]+={0,2}")
URI_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://")
FORMAT_ERROR = "订阅需要包含非空 proxies 列表的 Clash YAML，或 Shadowsocks 节点链接"


def _decode_base64(text):
    if not BASE64.fullmatch(text):
        raise ValueError("无效的 Base64")
    unpadded = text.rstrip("=")
    padding = -len(unpadded) % 4
    if padding == 3 or (len(unpadded) != len(text) and len(text) % 4):
        raise ValueError("无效的 Base64")
    try:
        return base64.b64decode(unpadded + "=" * padding, altchars=b"-_", validate=True)
    except binascii.Error:
        raise ValueError("无效的 Base64") from None


def _shadowsocks_node(line):
    authority, _, tag = line[5:].partition("#")
    address, _, query = authority.partition("?")
    if "plugin" in parse_qs(query, keep_blank_values=True):
        raise ValueError("暂不支持带插件的 Shadowsocks 链接，请使用 Clash YAML")
    address = address.rstrip("/")
    try:
        if "@" in address:
            # SIP002 carries either Base64URL or percent-encoded user info.
            credentials, endpoint = address.rsplit("@", 1)
            if ":" in credentials:
                method, password = (
                    unquote(part, errors="strict") for part in credentials.split(":", 1)
                )
            else:
                method, password = _decode_base64(
                    unquote(credentials, errors="strict")
                ).decode("utf-8").split(":", 1)
        else:
            # The older Shadowsocks URI encodes the credentials and endpoint together.
            credentials, endpoint = _decode_base64(
                unquote(address, errors="strict")
            ).decode("utf-8").rsplit("@", 1)
            method, password = credentials.split(":", 1)
        dest = urlsplit(f"//{endpoint}")
        server, port = dest.hostname, dest.port
        name = unquote(tag, errors="strict").strip() or f"{server}:{port}"
        if (not server or not port or dest.netloc != endpoint or dest.username is not None
                or any(char.isspace() for char in server) or dest.path or dest.query
                or dest.fragment or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", method)
                or not password or any(ord(char) < 32 for char in name + password)):
            raise ValueError
    except (ValueError, UnicodeError):
        raise ValueError("Shadowsocks 链接的加密方式、密码或服务器地址无效") from None
    return {"name": name, "type": "ss", "server": server, "port": port,
            "cipher": method, "password": password, "udp": True}


def parse_source_nodes(payload):
    if len(payload) > MAX_TEXT_BYTES:
        raise ValueError("订阅超过 2MB")
    try:
        text = payload.decode("utf-8-sig")
    except UnicodeError:
        raise ValueError("订阅需要使用 UTF-8 编码") from None

    candidate = text.strip()
    if not URI_SCHEME.match(candidate):
        compact = "".join(candidate.split())
        if BASE64.fullmatch(compact):
            try:
                candidate = _decode_base64(compact).decode("utf-8-sig").strip()
            except (ValueError, UnicodeError):
                candidate = ""
    if URI_SCHEME.match(candidate):
        nodes = []
        for number, line in enumerate(candidate.splitlines(), start=1):
            line = line.strip()
            if not line:
                continue
            if not line.lower().startswith("ss://"):
                raise ValueError(f"第 {number} 行不是 Shadowsocks 链接，请使用 Clash YAML")
            try:
                nodes.append(_shadowsocks_node(line))
            except ValueError as exc:
                raise ValueError(f"第 {number} 行：{exc}") from None
        return nodes

    document = parse_yaml(text)
    nodes = document.get("proxies") if isinstance(document, dict) else None
    if not isinstance(nodes, list) or not nodes:
        raise ValueError(FORMAT_ERROR)
    if any(not isinstance(node, dict) or not node.get("name") or not node.get("type")
           for node in nodes):
        raise ValueError("订阅包含缺少名称或协议的节点，未替换上次缓存")
    return nodes
