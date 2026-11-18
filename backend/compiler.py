"""Pure configuration compiler, semantic comparison and import. No network or writes."""
import copy
import difflib
import hashlib
import ipaddress
import json
import re
import urllib.parse
from collections import Counter

import yaml
from yaml.constructor import ConstructorError


class UniqueLoader(yaml.SafeLoader):
    pass


def _unique_mapping(loader, node, deep=False):
    explicit = set()
    for key_node, _ in node.value:
        if key_node.tag == 'tag:yaml.org,2002:merge':
            continue
        key = loader.construct_object(key_node, deep=deep)
        try:
            if key in explicit:
                raise ConstructorError(None, None, f"重复 YAML 字段：{key}", key_node.start_mark)
            explicit.add(key)
        except TypeError as exc:
            raise ConstructorError(None, None, "YAML 字段名必须是标量", key_node.start_mark) from exc
    loader.flatten_mapping(node)
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _unique_mapping)


def parse_yaml(text):
    if len(text.encode()) > 2_000_000:
        raise ValueError("YAML 超过 2MB")
    data = yaml.load(text, Loader=UniqueLoader)
    count = [0]
    def bound(value, ancestors=(), depth=0):
        count[0] += 1
        if count[0] > 100_000 or depth > 64:
            raise ValueError("YAML 展开内容过大或嵌套过深")
        if isinstance(value, (dict, list)):
            if id(value) in ancestors:
                raise ValueError("YAML 不支持循环引用")
            chain = (*ancestors, id(value))
            if isinstance(value, dict):
                if any(not isinstance(k, str) for k in value):
                    raise ValueError("YAML 字段名必须是字符串")
                for child in value.values():
                    bound(child, chain, depth + 1)
            else:
                for child in value:
                    bound(child, chain, depth + 1)
    bound(data)
    # JSON serializability also rejects timestamps, binary and recursive YAML aliases.
    try:
        json.dumps(data, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError, RecursionError) as exc:
        raise ValueError("仅支持 JSON 兼容的 YAML 值；不支持循环引用、日期对象或二进制值") from exc
    return data


def dump_yaml(value):
    return yaml.safe_dump(value, allow_unicode=True, sort_keys=False, width=110)


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:10]


def issue(path, message):
    return {"path": path, "message": message}


def selected_nodes(profile, sources):
    nodes, by_source = [], {}
    desired = set(profile.get("sourceIds", []))
    for src in sources:
        if src["id"] not in desired or not src.get("enabled", True):
            continue
        decorated = []
        original = [n for n in src.get("cache", []) if isinstance(n, dict)]
        counts = Counter(str(n.get("name", "")) for n in original)
        for raw in original:
            node = copy.deepcopy(raw)
            raw_name = str(node.get("name", ""))
            prefix=f'[{src.get("prefix") or src["id"]}]'
            name = raw_name if src.get('preserveNames') and raw_name.startswith(prefix) else f'{prefix} {raw_name}'
            if counts[raw_name] > 1:
                name += " · " + digest(raw)
            node["name"] = name
            if node not in nodes:
                nodes.append(node)
                decorated.append((raw_name, name))
        by_source[src["id"]] = decorated
    return nodes, by_source


def shape_errors(profile):
    errors = []
    if not isinstance(profile, dict):
        return [issue("profile", "配置必须是对象")]
    for key in ("sourceIds", "nodes", "groups", "rules"):
        if not isinstance(profile.get(key, []), list):
            errors.append(issue(key, "必须是数组"))
    if errors:
        return errors
    if any(not isinstance(s, str) for s in profile.get("sourceIds", [])):
        errors.append(issue("sourceIds", "来源 ID 必须是字符串"))
    for key in ("nodes", "groups", "rules"):
        if any(not isinstance(v, dict) for v in profile.get(key, [])):
            errors.append(issue(key, "数组元素必须是对象"))
    if errors:
        return errors
    for i, g in enumerate(profile.get("groups", [])):
        if not isinstance(g.get("name", ""), str):
            errors.append(issue(f"groups.{i}.name", "名称必须是字符串"))
        if not isinstance(g.get("members", []), list) or any(not isinstance(v, str) for v in g.get("members", [])):
            errors.append(issue(f"groups.{i}.members", "成员必须是字符串数组"))
        sels = g.get("selectors", [])
        if not isinstance(sels, list) or any(not isinstance(v, dict) for v in sels):
            errors.append(issue(f"groups.{i}.selectors", "选择器必须是对象数组"))
        elif any(any(not isinstance(v.get(k, ""), str) for k in ("sourceId", "include", "exclude")) for v in sels):
            errors.append(issue(f"groups.{i}.selectors", "来源 ID 与正则必须是字符串"))
        else:
            for j, selector in enumerate(sels):
                for field in ("names", "excludeNames"):
                    names = selector.get(field, [])
                    if not isinstance(names, list) or any(not isinstance(name, str) for name in names):
                        errors.append(issue(f"groups.{i}.selectors.{j}.{field}", "节点名称必须是字符串数组"))
        for field in ("options", "extra"):
            if not isinstance(g.get(field, {}), dict):
                errors.append(issue(f"groups.{i}.{field}", "必须是对象"))
    for field in ("network", "extras"):
        if not isinstance(profile.get(field, {}), dict):
            errors.append(issue(field, "必须是 YAML 对象"))
    for field in ('nodeOrder','networkOmitted'):
        if not isinstance(profile.get(field,[]),list) or any(not isinstance(v,str) for v in profile.get(field,[])):
            errors.append(issue(field,'必须是字符串数组'))
    sync=profile.get('companySync',{})
    if not isinstance(sync,dict):
        errors.append(issue('companySync','必须是对象'))
    elif not isinstance(sync.get('cidrOrder',[]),list) or any(not isinstance(v,str) for v in sync.get('cidrOrder',[])):
        errors.append(issue('companySync.cidrOrder','必须是字符串数组'))
    network = profile.get('network', {})
    if isinstance(network, dict):
        for key in ('dns', 'tun'):
            value = network.get(key, {})
            if not isinstance(value, dict):
                errors.append(issue(f'network.{key}', '必须是 YAML 对象'))
            elif 'enable' in value and not isinstance(value['enable'], bool):
                errors.append(issue(f'network.{key}.enable', '开关必须是布尔值'))
        tun = network.get('tun', {})
        if isinstance(tun, dict) and 'route-exclude-address' in tun:
            if not isinstance(tun['route-exclude-address'], list) or any(not isinstance(v, str) for v in tun['route-exclude-address']):
                errors.append(issue('network.tun.route-exclude-address', '排除网段必须是字符串数组'))
    return errors


def selector_regex_matches(selector, nodes):
    include = re.compile(selector.get("include") or ".*")
    exclude = re.compile(selector["exclude"]) if selector.get("exclude") else None
    return [name for raw, name in nodes
            if include.search(raw) and not (exclude and exclude.search(raw))]


def resolve_group_members(group, by_source, source_ids, path):
    fixed = list(group.get("members") or [])
    members = fixed.copy()
    origins, errors, warnings = {}, [], []
    for index, selector in enumerate(group.get("selectors") or []):
        selector_path = f"{path}.selectors.{index}"
        source_id = selector.get("sourceId")
        if source_id not in source_ids:
            errors.append(issue(selector_path, f"来源 {source_id} 不在当前配置使用的来源中"))
            continue
        try:
            available = by_source.get(source_id, [])
            included = set(selector["names"]) if "names" in selector else None
            excluded = set(selector.get("excludeNames", []))
            if included is not None and included.difference(name for _, name in available):
                warnings.append(issue(selector_path, "部分已选节点不在当前来源中，请核对订阅更新"))
            for name in selector_regex_matches(selector, available):
                if (included is None or name in included) and name not in excluded:
                    members.append(name)
                    origins.setdefault(name, source_id)
        except re.error as error:
            errors.append(issue(selector_path, f"筛选正则无效：{error}"))
    return list(dict.fromkeys(members)), origins, errors, warnings


BUILTIN_MEMBERS = {"DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"}


def summarize_group_members(profile, sources):
    """Expose the same ordered membership as YAML compilation without returning credentials."""
    errors = shape_errors(profile)
    if errors:
        return None, errors
    source_ids = set(profile.get("sourceIds", []))
    _, by_source = selected_nodes(profile, sources)
    source_names = {source["id"]: source["name"] for source in sources}
    source_by_node = {name: sid for sid, nodes in by_source.items() for _, name in nodes}
    groups = profile.get("groups", [])
    owned_nodes = {node.get("name") for node in profile.get("nodes", []) if isinstance(node.get("name"), str)}
    group_names = {group.get("name") for group in groups}
    summaries = []
    for index, group in enumerate(groups):
        path = f"groups.{index}"
        names, origins, errors, warnings = resolve_group_members(group, by_source, source_ids, path)
        fixed = set(group.get("members") or [])
        members = []
        for name in names:
            source_id = origins.get(name) or source_by_node.get(name)
            if name in group_names:
                kind = "group"
            elif name in BUILTIN_MEMBERS:
                kind = "builtin"
            elif source_id or name in owned_nodes:
                kind = "node"
            else:
                kind = "missing"
                errors.append(issue(f"{path}.members", f"成员不存在：{name}"))
            members.append({"name": name, "kind": kind, "fixed": name in fixed,
                            "source": source_names.get(source_id) or ("自定义节点" if name in owned_nodes else None)})
        providers = (group.get("extra") or {}).get("use", [])
        if not isinstance(providers, list) or any(not isinstance(name, str) for name in providers):
            errors.append(issue(f"{path}.extra.use", "节点提供者引用必须是名称数组"))
            providers = []
        source_notes = []
        for sid in dict.fromkeys(item.get("sourceId", "") for item in group.get("selectors", [])):
            selectors = [item for item in group["selectors"] if item.get("sourceId") == sid]
            message = "订阅未启用或不在配置中" if sid not in by_source else (
                "新增节点自动加入" if any("names" not in item for item in selectors) else "仅使用选定节点")
            if any(item.get("include") or item.get("exclude") for item in selectors):
                message += " · 含名称筛选"
            source_notes.append({"name": source_names.get(sid, sid), "label": message})
        summaries.append({"id": group.get("id"), "name": group.get("name"), "members": members,
                          "providers": providers, "sourceNotes": source_notes, "errors": errors, "warnings": warnings})
    return summaries, []


def compile_profile(profile, sources, company):
    invalid = shape_errors(profile)
    if invalid:
        return {"ok": False, "errors": invalid, "warnings": [], "yaml": "",
                "stats": {"nodes": 0, "groups": 0, "rules": 0}}, {}
    errors, warnings = [], []
    source_map = {s["id"]: s for s in sources}
    if not str(profile.get("name", "")).strip():
        errors.append(issue("name", "请填写配置名称"))
    if not isinstance(profile.get("sourceIds", []), list):
        return {"ok": False, "errors": [issue("sourceIds", "来源必须是数组")], "warnings": [],
                "yaml": "", "stats": {"nodes": 0, "groups": 0, "rules": 0}}, {}
    for sid in profile.get("sourceIds", []):
        if sid not in source_map:
            errors.append(issue("sourceIds", f"订阅源不存在：{sid}"))
        elif not source_map[sid].get("enabled", True):
            warnings.append(issue("sourceIds", f"来源已停用：{source_map[sid]['name']}"))
    proxies, by_source = selected_nodes(profile, sources)
    custom = profile.get("nodes") or []
    if not isinstance(custom, list) or any(not isinstance(n, dict) for n in custom):
        errors.append(issue("nodes", "自定义节点必须是对象数组"))
        custom = []
    proxies += copy.deepcopy(custom)
    node_order={name:i for i,name in enumerate(profile.get('nodeOrder',[]))}
    if node_order:
        proxies.sort(key=lambda n:node_order.get(n.get('name'),len(node_order)))
    names = [n.get("name") for n in proxies]
    for i, node in enumerate(proxies):
        if not isinstance(node.get("name"), str) or not node.get("name", "").strip():
            errors.append(issue(f"nodes.{i}.name", "节点名称不能为空"))
        if not node.get("type"):
            errors.append(issue(f"nodes.{i}.type", "节点缺少协议类型"))
        if 'port' in node and (isinstance(node['port'], bool) or not isinstance(node['port'], int) or not 1 <= node['port'] <= 65535):
            errors.append(issue(f'nodes.{i}.port', '端口必须是 1–65535 的整数'))
    valid_names = [n for n in names if isinstance(n, str)]
    for n, count in Counter(valid_names).items():
        if count > 1:
            errors.append(issue("nodes", f"节点名称重复：{n}"))
    defs = profile.get("groups") or []
    if not isinstance(defs, list) or any(not isinstance(g, dict) for g in defs):
        errors.append(issue("groups", "策略组必须是对象数组"))
        defs = []
    group_names = [g.get("name", "") for g in defs]
    known = set(valid_names) | {n for n in group_names if isinstance(n, str)} | BUILTIN_MEMBERS
    for n, count in Counter(n for n in group_names if isinstance(n, str)).items():
        if not n.strip() or count > 1 or n in valid_names or n in {"DIRECT", "REJECT", "PASS"}:
            errors.append(issue("groups", f"策略组名称为空、重复或冲突：{n}"))
    compiled_groups, graph = [], {}
    for i, g in enumerate(defs):
        path = f"groups.{i}"
        members, _, member_errors, member_warnings = resolve_group_members(
            g, by_source, profile.get("sourceIds", []), path)
        errors.extend(member_errors)
        warnings.extend(member_warnings)
        for member in members:
            if member not in known:
                errors.append(issue(f"{path}.members", f"成员不存在：{member}"))
        provider_refs = (g.get("extra") or {}).get("use", [])
        if not isinstance(provider_refs, list):
            errors.append(issue(f'{path}.extra.use', '节点提供者引用必须是数组'))
            provider_refs = []
        for provider in provider_refs:
            if provider not in (profile.get("extras") or {}).get("proxy-providers", {}):
                errors.append(issue(f"{path}.extra.use", f"节点提供者未定义：{provider}"))
        if not members and not provider_refs:
            errors.append(issue(f"{path}.members", "策略组没有成员，请添加节点、订阅选择器或其他策略组"))
        kind = g.get("type", "select")
        if kind not in {"select", "url-test", "fallback", "load-balance", "relay"}:
            errors.append(issue(f"{path}.type", f"不支持的组类型：{kind}"))
        graph[g.get("name", "")] = [m for m in members if m in group_names or m in valid_names]
        value = copy.deepcopy(g.get("extra") or {})
        value.update(copy.deepcopy(g.get("options") or {}))
        value.update(name=g.get("name", ""), type=kind, proxies=members)
        compiled_groups.append(value)
    visiting, visited = [], set()

    def visit(name):
        if name in visiting:
            errors.append(issue("groups", "策略组/节点循环引用：" + " → ".join(visiting[visiting.index(name):] + [name])))
            return
        if name in visited:
            return
        visiting.append(name)
        for dep in graph.get(name, []):
            visit(dep)
        visiting.pop()
        visited.add(name)

    for node in proxies:
        dep = node.get("dialer-proxy")
        if isinstance(node.get("name"), str):
            graph[node["name"]] = [dep] if dep and dep in known else []
        if dep and dep not in known:
            errors.append(issue("nodes", f"{node.get('name')} 的 dialer-proxy 不存在：{dep}"))
        if dep == node.get("name"):
            errors.append(issue("nodes", f"{dep} 不能把自身设为 dialer-proxy"))
    for name in graph:
        visit(name)
    rules, seen_match = [], False
    for i, r in enumerate(profile.get("rules") or []):
        if not r.get("enabled", True):
            continue
        kind, value, target = str(r.get("type", "")), str(r.get("value", "")).strip(), str(r.get("target", ""))
        path = f"rules.{i}"
        if seen_match:
            warnings.append(issue(path, "这条规则位于 MATCH 后面，不会被匹配"))
        if kind == "RAW":
            parts = value.split(",")
            target = parts[-2] if parts and parts[-1] == "no-resolve" and len(parts) > 1 else parts[-1]
        if target not in known:
            errors.append(issue(path, f"规则目标不存在：{target}"))
        if kind == "COMPANY":
            order = (profile.get('companySync') or {}).get('cidrOrder', [])
            cidrs = list(dict.fromkeys([c for c in order if c in company.get('cidrs', [])] + company.get('cidrs', [])))
            for cidr in cidrs:
                try:
                    network = ipaddress.ip_network(cidr, strict=True)
                    ip_kind = "IP-CIDR6" if network.version == 6 else "IP-CIDR"
                    rules.append(f"{ip_kind},{cidr},{target}" + (',no-resolve' if r.get('noResolve', True) else ''))
                except ValueError:
                    errors.append(issue(path, f"公司网段不合法：{cidr}"))
            if not company.get("connected"):
                warnings.append(issue(path, "MoVPN 来源当前不可用，使用上次有效网段；请检查共享公司网络页面"))
        elif kind == "MATCH":
            seen_match = True
            rules.append(f"MATCH,{target}")
        elif kind == "RAW":
            if len(value.split(",")) < 2:
                errors.append(issue(path, "原始规则格式不完整"))
            rules.append(value)
        else:
            if not kind or not value:
                errors.append(issue(path, "规则类型和匹配值不能为空"))
            if ',' in value or '\n' in value or ',' in target or '\n' in target:
                errors.append(issue(path, '匹配值与目标不能包含逗号或换行；复杂表达式请使用 RAW 原始规则'))
            if kind in {"IP-CIDR", "IP-CIDR6", "SRC-IP-CIDR"}:
                try:
                    network = ipaddress.ip_network(value, strict=True)
                    if kind == "IP-CIDR6" and network.version != 6:
                        raise ValueError()
                except ValueError:
                    errors.append(issue(path, f"无效的 CIDR：{value}"))
            if kind == "RULE-SET" and value not in (profile.get("extras") or {}).get("rule-providers", {}):
                errors.append(issue(path, f"规则集未定义：{value}"))
            rules.append(f"{kind},{value},{target}" + (",no-resolve" if r.get("noResolve") else ""))
    if not seen_match:
        warnings.append(issue("rules", "未设置 MATCH 兜底规则，请确认这是你的预期"))
    extras = profile.get("extras") or {}
    if not isinstance(extras, dict):
        errors.append(issue("extras", "高级字段必须是 YAML 对象"))
        extras = {}
    for key in {"proxies", "proxy-groups", "rules", "dns", "tun"} & extras.keys():
        errors.append(issue(f"extras.{key}", "此字段由对应编辑区管理，请在对应区域修改以避免覆盖"))
    network = profile.get("network") or {}
    if not isinstance(network, dict):
        errors.append(issue("network", "网络配置必须是对象"))
        network = {}
    out = copy.deepcopy({k: v for k, v in extras.items() if k not in {"proxies", "proxy-groups", "rules", "dns", "tun"}})
    for key in ("dns", "tun"):
        val = network.get(key, {})
        if not isinstance(val, dict):
            errors.append(issue(f"network.{key}", "必须是 YAML 对象"))
        else:
            if val or key not in profile.get('networkOmitted', []):
                out[key] = copy.deepcopy(val)
    if (profile.get('companySync') or {}).get('adjustTun'):
        excludes = out.get('tun', {}).get('route-exclude-address', [])
        adjusted = []
        for cidr in excludes:
            try:remaining = [ipaddress.ip_network(cidr)]
            except ValueError:
                errors.append(issue('network.tun.route-exclude-address',f'无效网段：{cidr}'))
                continue
            for company_cidr in company.get('cidrs', []):
                try:net = ipaddress.ip_network(company_cidr)
                except ValueError:
                    errors.append(issue('company',f'公司网段不合法：{company_cidr}'))
                    continue
                pieces = []
                for candidate in remaining:
                    if candidate.version != net.version or not candidate.overlaps(net):
                        pieces.append(candidate)
                    elif candidate.subnet_of(net):
                        continue
                    else:
                        pieces.extend(candidate.address_exclude(net))
                remaining = pieces
            adjusted.extend(str(n) for n in sorted(remaining, key=lambda n:int(n.network_address)))
        out.setdefault('tun', {})['route-exclude-address'] = list(dict.fromkeys(adjusted))
    for cidr in out.get("tun", {}).get("route-exclude-address", []) or []:
        try:
            excluded = ipaddress.ip_network(cidr)
            for company_cidr in company.get("cidrs", []):
                c = ipaddress.ip_network(company_cidr)
                if c.version == excluded.version and c.overlaps(excluded):
                    errors.append(issue("network.tun.route-exclude-address", f"TUN 排除 {cidr} 覆盖公司网段 {company_cidr}，公司规则可能无法接管"))
        except ValueError:
            errors.append(issue("network.tun.route-exclude-address", f"无效网段：{cidr}"))
    if any(source_map[s].get("status") == "demo" for s in profile.get("sourceIds", []) if s in source_map):
        warnings.append(issue("sources", "当前包含示例节点，不能用于真实代理联网"))
    out.update(proxies=proxies, **{"proxy-groups": compiled_groups}, rules=rules)
    result = {"ok": not errors, "errors": errors, "warnings": warnings,
              "stats": {"nodes": len(proxies), "groups": len(compiled_groups), "rules": len(rules)},
              "yaml": dump_yaml(out) if not errors else ""}
    return result, out


SENSITIVE = re.compile(r"password|passwd|secret|token|auth[-_]?key|api[-_]?key|access[-_]?key|authorization|private[-_]?key|client[-_]?key|pre[-_]?shared[-_]?key|(^|\.)key($|\.)|uuid|credential|cookie|username", re.I)


def redact(value, path=""):
    if SENSITIVE.search(path):
        return "[敏感字段已隐藏]"
    if isinstance(value, dict):
        return {k: redact(v, f"{path}.{k}" if path else k) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v, path) for v in value]
    if isinstance(value, str):
        if '-----BEGIN' in value and 'PRIVATE KEY-----' in value:
            return '[私钥已隐藏]'
        if path.endswith('.url') and (path.startswith('sources.') or 'providers.' in path):
            return "[订阅地址已隐藏]" if value else value
        if value.startswith(('https://', 'http://')):
            u = urllib.parse.urlsplit(value)
            query = urllib.parse.parse_qsl(u.query, keep_blank_values=True)
            if u.username or any(SENSITIVE.search(k) for k, _ in query):
                return "[含凭据的地址已隐藏]"
        return value
    return value


def compare_profiles(left, right, sources, company, right_sources=None, right_company=None):
    changes = []
    sentinel = object()

    def add(section, path, kind, a, b):
        av, bv = (None if a is sentinel else redact(a, path)), (None if b is sentinel else redact(b, path))
        if a is not sentinel and b is not sentinel and a != b and av == bv:
            av, bv = "[原敏感值]", "[敏感字段已变更]"
        changes.append({"section": section, "path": path, "kind": kind, "before": av, "after": bv})

    def walk(section, path, a, b):
        if a == b:
            return
        if a is sentinel or b is sentinel:
            add(section, path, "added" if a is sentinel else "removed", a, b)
        elif isinstance(a, dict) and isinstance(b, dict):
            for k in sorted(a.keys() | b.keys()):
                walk(section, f"{path}.{k}" if path else str(k), a.get(k, sentinel), b.get(k, sentinel))
        elif isinstance(a, list) and isinstance(b, list):
            if Counter(map(digest, a)) == Counter(map(digest, b)):
                add(section, path, "moved", a, b)
            elif section == '规则' or (
                section == '策略组' and path.startswith('proxy-groups.') and path.endswith('.proxies')
            ):
                matcher = difflib.SequenceMatcher(a=[digest(x) for x in a],b=[digest(x) for x in b],autojunk=False)
                for op,i,j,k,l in matcher.get_opcodes():
                    if op=='equal':continue
                    for offset in range(max(j-i,l-k)):
                        walk(section,f'{path}[左{i+offset+1} / 右{k+offset+1}]',a[i+offset] if i+offset<j else sentinel,b[k+offset] if k+offset<l else sentinel)
            else:
                for i in range(max(len(a), len(b))):
                    walk(section, f"{path}[{i+1}]", a[i] if i < len(a) else sentinel, b[i] if i < len(b) else sentinel)
        else:
            add(section, path, "changed", a, b)

    right_sources = sources if right_sources is None else right_sources
    right_company = company if right_company is None else right_company
    walk("来源", "sourceIds", left.get("sourceIds", []), right.get("sourceIds", []))
    def source_defs(p, values):
        return {s['id']: {k: s.get(k) for k in ('name', 'prefix', 'url', 'enabled')}
                for s in values if s['id'] in p.get('sourceIds', [])}
    walk("来源", "sources", source_defs(left, sources), source_defs(right, right_sources))
    la, lc = compile_profile(left, sources, company)
    ra, rc = compile_profile(right, right_sources, right_company)
    for section, key in [("节点", "proxies"), ("策略组", "proxy-groups")]:
        # Definition selectors matter even if two different selectors currently select identical nodes.
        a = {n.get("name", f"#{i}"): n for i, n in enumerate(lc.get(key, []))}
        b = {n.get("name", f"#{i}"): n for i, n in enumerate(rc.get(key, []))}
        walk(section, key, a, b)
    walk("策略组", "selectors", {g.get("name"): g.get("selectors", []) for g in left.get("groups", [])},
         {g.get("name"): g.get("selectors", []) for g in right.get("groups", [])})
    # Include disabled and unexpanded definitions, too; compiled equality alone can conceal a draft difference.
    walk("规则", "规则定义", [{k: v for k, v in r.items() if k != "id"} for r in left.get("rules", [])],
         [{k: v for k, v in r.items() if k != "id"} for r in right.get("rules", [])])
    if any(r.get('type') == 'COMPANY' for r in left.get('rules', []) + right.get('rules', [])):
        walk("规则", "共享公司网段", company.get('cidrs', []), right_company.get('cidrs', []))
    for section, key in [("DNS", "dns"), ("TUN", "tun")]:
        walk(section, key, left.get("network", {}).get(key, {}), right.get("network", {}).get(key, {}))
    walk('Hosts','hosts',left.get('extras',{}).get('hosts',{}),right.get('extras',{}).get('hosts',{}))
    walk("高级字段", "", {k:v for k,v in left.get("extras", {}).items() if k!='hosts'}, {k:v for k,v in right.get("extras", {}).items() if k!='hosts'})
    walk('应用设置','appSettings',(left.get('baseline') or {}).get('appSettings',{}),(right.get('baseline') or {}).get('appSettings',{}))
    counts = Counter(c["kind"] for c in changes)
    return {"left": {"id": left["id"], "name": left["name"]},
            "right": {"id": right["id"], "name": right["name"]}, "changes": changes,
            "summary": {**{k: counts[k] for k in ("added", "removed", "changed", "moved")}, "total": len(changes)},
            'leftStats':la['stats'],'rightStats':ra['stats'],
            "warnings": [*la["errors"], *ra["errors"]]}


def import_config(text, name="导入配置"):
    raw = parse_yaml(text)
    if not isinstance(raw, dict):
        raise ValueError("完整配置必须是 YAML 对象")
    raw = copy.deepcopy(raw)
    groups = []
    for i, g in enumerate(raw.pop("proxy-groups", []) or []):
        value = copy.deepcopy(g)
        groups.append({"id": f"import-g-{i}", "name": value.pop("name", ""),
                       "type": value.pop("type", "select"), "members": value.pop("proxies", []),
                       "selectors": [], "options": {}, "extra": value})
    rules = []
    simple = {"MATCH", "DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "IP-CIDR", "IP-CIDR6", "SRC-IP-CIDR",
              "GEOIP", "GEOSITE", "RULE-SET", "DST-PORT", "SRC-PORT", "PROCESS-NAME", "NETWORK"}
    for i, line in enumerate(raw.pop("rules", []) or []):
        if not isinstance(line, str):
            raise ValueError(f"第 {i+1} 条规则不是字符串")
        parts = line.split(",")
        no_resolve = parts[-1] == "no-resolve"
        target = parts[-2] if no_resolve and len(parts) > 1 else parts[-1]
        kind = parts[0]
        simple_rule = kind in simple and len(parts) == (2 if kind == "MATCH" else 3) + int(no_resolve)
        value = ("" if kind == "MATCH" else parts[1]) if simple_rule else line
        rules.append({"id": f"import-r-{i}", "type": kind if simple_rule else "RAW", "value": value,
                      "target": target, "noResolve": no_resolve, "enabled": True})
    nodes = raw.pop("proxies", []) or []
    omitted = [k for k in ('dns','tun') if k not in raw]
    network = {k: raw.pop(k, {}) for k in ("dns", "tun")}
    profile = {"id": "", "name": name, "device": "custom", "description": "从完整 YAML 导入",
               "sourceIds": [], "nodes": nodes, "groups": groups, "rules": rules,
               "network": network, "networkOmitted": omitted, "nodeOrder":[n.get('name') for n in nodes if isinstance(n,dict)], "extras": raw}
    return {"profile": profile, "warnings": ["导入保留节点、规则及未知字段；节点为静态快照，不会自动恢复订阅源选择器。",
                                                 "YAML 注释、锚点写法和原排版不保留，配置值保留。"]}
