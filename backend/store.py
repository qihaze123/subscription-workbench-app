"""Transactional local store. Network refresh never holds the configuration lock."""
import copy
import json
import os
import re
import sqlite3
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from .compiler import compile_profile as compile_clash, compare_profiles, parse_yaml, selected_nodes, shape_errors
from .seed import COMPANY, now, seed_profiles, seed_sources
from .subscription_parser import parse_source_nodes


def compile_profile(profile, sources, company):
    from live_backend import prepare_profile
    return compile_clash(prepare_profile(profile, sources), sources, company)


class Problem(Exception):
    def __init__(self, message, status=400, **detail):
        super().__init__(message)
        self.status, self.detail = status, detail


META = {"revision", "updatedAt", "publishedVersion", "publishedAt", "hasDraft"}
yaml_value = parse_yaml


def clean_profile(raw):
    return copy.deepcopy({k: v for k, v in raw.items() if k not in META})


def js(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


class Store:
    def __init__(self, path, seed_demo=True):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        os.chmod(path, 0o600)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.jobs = {}
        self.sync_error = ''
        self.db.executescript("""
          PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS profiles (
            id TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL,
            updated TEXT NOT NULL, published INTEGER);
          CREATE TABLE IF NOT EXISTS versions (
            profile_id TEXT NOT NULL, version INTEGER NOT NULL, created TEXT NOT NULL,
            body TEXT NOT NULL, yaml TEXT NOT NULL, stats TEXT NOT NULL,
            sources TEXT NOT NULL, company TEXT NOT NULL,
            PRIMARY KEY(profile_id, version));
        """)
        self.local_mode = self.db.execute("SELECT 1 FROM meta WHERE key='realBaselines'").fetchone() is not None
        if self.db.execute("SELECT 1 FROM meta WHERE key='sources'").fetchone() is None:
            sources = seed_sources() if seed_demo else []
            with self.db:
                self._set("sources", sources)
                self._set("sourcesRevision", 1)
                self._set("company", COMPANY)
                for profile in (seed_profiles() if seed_demo else []):
                    self.db.execute("INSERT INTO profiles VALUES(?,?,?,?,?)",
                                    (profile["id"], js(profile), 1, now(), 1))
                    result, _ = compile_profile(profile, sources, COMPANY)
                    assert result["ok"], result["errors"]
                    self.db.execute("INSERT INTO versions VALUES(?,?,?,?,?,?,?,?)",
                                    (profile["id"], 1, now(), js(profile), result["yaml"],
                                     js(result["stats"]), js(sources), js(COMPANY)))

    def close(self):
        with self.lock:
            self.db.close()

    def _get(self, key):
        return json.loads(self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()[0])

    def _set(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (key, js(value)))

    def _row(self, pid):
        row = self.db.execute("SELECT * FROM profiles WHERE id=?", (pid,)).fetchone()
        if row is None:
            raise Problem("配置不存在", 404)
        return row

    def _version(self, pid, version):
        row = self.db.execute("SELECT * FROM versions WHERE profile_id=? AND version=?", (pid, version)).fetchone()
        if row is None:
            raise Problem("历史版本不存在", 404)
        return row

    def _record(self, row):
        body = json.loads(row["body"])
        published = self._version(row["id"], row["published"]) if row["published"] else None
        dirty = True
        if published:
            sources = self._get("sources")
            current, _ = compile_profile(body, sources, self._get("company"))
            dirty = body != json.loads(published["body"]) or current["yaml"] != published["yaml"]
            def signature(values):
                return {s['id']: {k: s.get(k) for k in ('name', 'prefix', 'url', 'enabled')}
                        for s in values if s['id'] in body.get('sourceIds', [])}
            dirty = dirty or signature(sources) != signature(json.loads(published['sources']))
        return {**body, "revision": row["revision"], "updatedAt": row["updated"],
                "publishedVersion": row["published"], "publishedAt": published["created"] if published else None,
                "hasDraft": dirty}

    def _check_revision(self, row, revision):
        if revision != row["revision"]:
            raise Problem("配置已在其他页面更新，请重新载入后再保存；当前编辑内容未被覆盖。", 409,
                          currentRevision=row["revision"])

    def sources(self):
        result = self._get("sources")
        for s in result:
            s["nodeCount"] = len(s.get("cache", []))
            nodes, names = selected_nodes({"sourceIds": [s["id"]]}, [{**s, "enabled": True}])
            protocols = {n["name"]: n.get("type", "") for n in nodes}
            s["nodeInventory"] = [{"name": name, "rawName": raw, "type": protocols[name]}
                                  for raw, name in names.get(s["id"], [])]
            s["cache"] = [{k: v for k, v in n.items() if k in {"name", "type", "server", "port"}} for n in s.get("cache", [])]
        return result

    def bootstrap(self):
        with self.lock:
            return {"mode": "local" if self.local_mode else "preview", "profiles": [self._record(r) for r in self.db.execute("SELECT * FROM profiles ORDER BY rowid")],
                    "sources": self.sources(), "sourcesRevision": self._get("sourcesRevision"),
                    "company": self._get("company"), "capabilities": {"coreValidation": False, "liveSync": self.local_mode}, "syncError": self.sync_error}

    def create(self, raw):
        if not isinstance(raw, dict):
            raise Problem("配置必须是对象", 422)
        profile = clean_profile(raw)
        profile["id"] = profile.get("id") or "profile-" + uuid.uuid4().hex[:10]
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", profile["id"]):
            raise Problem("配置 ID 仅支持字母、数字、短横线和下划线", 422)
        invalid = shape_errors(profile)
        if invalid:
            raise Problem("配置结构有误", 422, errors=invalid)
        with self.lock, self.db:
            if self.db.execute("SELECT 1 FROM profiles WHERE id=?", (profile["id"],)).fetchone():
                raise Problem("配置 ID 已存在，请换一个 ID 或复制为新配置", 409)
            self.db.execute("INSERT INTO profiles VALUES(?,?,?,?,NULL)", (profile["id"], js(profile), 1, now()))
            return self._record(self._row(profile["id"]))

    def save(self, pid, raw, revision):
        if not isinstance(raw, dict):
            raise Problem("配置必须是对象", 422)
        profile = clean_profile(raw)
        profile["id"] = pid
        invalid = shape_errors(profile)
        if invalid:
            raise Problem("配置结构有误", 422, errors=invalid)
        with self.lock, self.db:
            row = self._row(pid)
            self._check_revision(row, revision)
            self.db.execute("UPDATE profiles SET body=?,revision=revision+1,updated=? WHERE id=?", (js(profile), now(), pid))
            return self._record(self._row(pid))

    def delete(self, pid, revision):
        with self.lock, self.db:
            self._check_revision(self._row(pid), revision)
            if self.db.execute("SELECT count(*) FROM profiles").fetchone()[0] <= 1:
                raise Problem("至少保留一份配置", 422)
            self.db.execute("DELETE FROM versions WHERE profile_id=?", (pid,))
            self.db.execute("DELETE FROM profiles WHERE id=?", (pid,))
            return {"ok": True}

    def validate(self, profile):
        with self.lock:
            result, _ = compile_profile(profile, self._get("sources"), self._get("company"))
            if result['ok'] and self.local_mode:
                from .local_data import hydrate
                try:hydrate(yaml_value(result['yaml']))
                except ValueError as exc:
                    result.update(ok=False,yaml='')
                    result['errors'].append({'path':'credentials','message':str(exc)})
            return result

    def publish(self, pid, revision):
        with self.lock, self.db:
            row = self._row(pid)
            self._check_revision(row, revision)
            profile = json.loads(row["body"])
            sources, company = self._get("sources"), self._get("company")
            result, _ = compile_profile(profile, sources, company)
            if not result["ok"]:
                raise Problem("校验未通过，未发布；上一份订阅仍然有效。", 422,
                              errors=result["errors"], warnings=result["warnings"])
            if self.local_mode:
                from .local_data import hydrate
                try:hydrate(yaml_value(result['yaml']))
                except ValueError as exc:raise Problem(str(exc),422)
            version = (self.db.execute("SELECT max(version) FROM versions WHERE profile_id=?", (pid,)).fetchone()[0] or 0) + 1
            self.db.execute("INSERT INTO versions VALUES(?,?,?,?,?,?,?,?)",
                            (pid, version, now(), row["body"], result["yaml"], js(result["stats"]), js(sources), js(company)))
            self.db.execute("UPDATE profiles SET published=?,revision=revision+1,updated=? WHERE id=?", (version, now(), pid))
            return {"profile": self._record(self._row(pid)), "version": version, "stats": result["stats"]}

    def history(self, pid):
        with self.lock:
            self._row(pid)
            return {"versions": [{"version": r["version"], "createdAt": r["created"], "stats": json.loads(r["stats"])}
                                 for r in self.db.execute("SELECT * FROM versions WHERE profile_id=? ORDER BY version DESC", (pid,))]}

    def restore(self, pid, version, revision):
        with self.lock:
            old = self._version(pid, version)
            return self.save(pid, json.loads(old["body"]), revision)

    def _snapshot(self, pid, version):
        if version is not None:
            row = self._version(pid, version)
            return json.loads(row["body"]), json.loads(row["sources"]), json.loads(row["company"])
        return json.loads(self._row(pid)["body"]), self._get("sources"), self._get("company")

    def compare(self, data):
        with self.lock:
            left, ls, lc = self._snapshot(data.get("leftId"), data.get("leftVersion"))
            right, rs, rc = self._snapshot(data.get("rightId"), data.get("rightVersion"))
            if isinstance(data.get('leftProfile'),dict):left=clean_profile(data['leftProfile'])
            if isinstance(data.get('rightProfile'),dict):right=clean_profile(data['rightProfile'])
            return compare_profiles(left, right, ls, lc, rs, rc)

    def subscription(self, pid):
        with self.lock:
            row = self._row(pid)
            if row["published"] is None:
                raise Problem("还没有已发布版本，请先校验并发布这份配置。", 404)
            text = self._version(pid, row["published"])["yaml"]
            if self.local_mode:
                from .local_data import hydrate
                from .compiler import dump_yaml
                try:text=dump_yaml(hydrate(yaml_value(text)))
                except ValueError as exc:raise Problem(str(exc),503)
            return text

    def published_routing_order(self, pid):
        with self.lock:
            version = self._row(pid)["published"]
            if version is None:
                raise Problem("这份配置还没有已发布版本。", 404)
            snapshot = self._version(pid, version)
            return {"version": version, "rules": yaml_value(snapshot["yaml"]).get("rules", [])}

    def save_sources(self, raw, revision):
        if not isinstance(raw, list) or any(not isinstance(s, dict) for s in raw):
            raise Problem("来源必须是对象数组", 422)
        ids = [s.get("id") for s in raw]
        if any(not isinstance(s, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", s) for s in ids) or len(set(ids)) != len(ids):
            raise Problem("来源 ID 不能为空、重复或包含特殊字符", 422)
        with self.lock, self.db:
            if revision != self._get("sourcesRevision"):
                raise Problem("来源列表已更新，请重新载入后再保存。", 409)
            for row in self.db.execute("SELECT body FROM profiles"):
                p = json.loads(row[0])
                missing = set(p.get("sourceIds", [])) - set(ids)
                if missing:
                    raise Problem(f"配置「{p['name']}」仍引用来源 {', '.join(sorted(missing))}，请先移除引用或停用来源。", 422)
            old = {s["id"]: s for s in self._get("sources")}
            result = []
            for s in raw:
                if not str(s.get("name", "")).strip():
                    raise Problem("请填写来源名称", 422)
                url = str(s.get("url", "")).strip()
                if url and urllib.parse.urlsplit(url).scheme not in {"https", "http"}:
                    raise Problem("订阅地址仅支持 HTTP / HTTPS", 422)
                prev = old.get(s["id"], {})
                saved = {k: s.get(k, "") for k in ("id", "name", "prefix")}
                for key in ('binding','preserveNames'):
                    if key in prev:saved[key]=prev[key]
                saved.update(url=url, enabled=s.get("enabled", True), cache=prev.get("cache", []),
                             status=prev.get("status", "empty"), updatedAt=prev.get("updatedAt"), error=prev.get("error", ""))
                if url != prev.get("url", ""):
                    saved["status"] = "pending"
                    saved["error"] = "地址已修改，尚未刷新；仍保留上次节点缓存"
                result.append(saved)
            self._set("sources", result)
            self._set("sourcesRevision", revision + 1)
            return {"sources": self.sources(), "revision": revision + 1}

    def refresh(self, sid):
        with self.lock:
            src = next((s for s in self._get("sources") if s["id"] == sid), None)
            if src is None:
                raise Problem("来源不存在", 404)
            if not src.get("url"):
                if src.get('binding'):
                    from .local_data import FILES,protect
                    binding=src['binding']; doc=yaml_value(FILES[binding['source']].read_text())
                    src['cache']=[protect(n,binding['source'],('proxies',i)) for i,n in enumerate(doc['proxies']) if n['name'].startswith(binding['prefix'])]
                    if not src['cache']:raise Problem('本地来源中没有匹配节点，保留上次缓存',422)
                    src.update(status='local',updatedAt=now(),error='')
                    values=self._get('sources');values=[src if s['id']==sid else s for s in values]
                    with self.db:self._set('sources',values);self._set('sourcesRevision',self._get('sourcesRevision')+1)
                    jid=uuid.uuid4().hex;self.jobs[jid]={'id':jid,'sourceId':sid,'status':'done'}
                    return {'jobId':jid,'status':'done'}
                raise Problem("请先填写并保存订阅地址。", 422)
            for job in self.jobs.values():
                if job.get("sourceId") == sid and job["status"] == "running":
                    return {"jobId": job["id"], "status": "running"}
            jid = uuid.uuid4().hex
            self.jobs[jid] = {"id": jid, "status": "running", "sourceId": sid}
        threading.Thread(target=self._refresh_worker, args=(jid, copy.deepcopy(src)), daemon=True).start()
        return {"jobId": jid, "status": "running"}

    def _refresh_worker(self, jid, src):
        try:
            req = urllib.request.Request(src["url"], headers={"User-Agent": "clash-meta/subscription-workbench"})
            with urllib.request.urlopen(req, timeout=20) as response:
                payload = response.read(8_000_001)
            if len(payload) > 8_000_000:
                raise ValueError("订阅响应超过大小限制")
            nodes = parse_source_nodes(payload)
            error = None
        except Exception as exc:
            nodes = None
            if isinstance(exc, urllib.error.HTTPError):
                error = f"订阅下载失败：HTTP {exc.code}；保留上次有效节点"
            elif isinstance(exc, ValueError):
                error = str(exc)[:180]
            else:
                error = "订阅下载失败（网络或解析异常）；保留上次有效节点"
        with self.lock, self.db:
            sources = self._get("sources")
            current = next((s for s in sources if s["id"] == src["id"]), None)
            if current is None or current.get("url") != src["url"]:
                self.jobs[jid].update(status="failed", error="来源地址已变化，本次旧结果未应用")
                return
            if error:
                current.update(status="stale" if current.get("cache") else "failed", error=error)
            else:
                current.update(cache=nodes, status="ready", error="", updatedAt=now())
            self._set("sources", sources)
            self._set("sourcesRevision", self._get("sourcesRevision") + 1)
            self.jobs[jid].update(status="failed" if error else "done", **({"error": error} if error else {}))

    def job(self, jid):
        with self.lock:
            if jid not in self.jobs:
                raise Problem("任务不存在", 404)
            return copy.deepcopy(self.jobs[jid])
