// server.js
// 中文订阅工作台 - 本地服务 (Node.js 原生零依赖)
// 默认绑定 127.0.0.1，支持 PORT 环境变量配置

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { isIPv6 } = require('node:net');
const { execFile, spawn, spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const { createGzip, gzip } = require('node:zlib');

const { generateClashYaml } = require('./public/clash-generator');
const { profileContentKey, reconcileGroupNames } = require('./public/profile-content');
const { evaluateTarget, compareEvaluation, expandEffectiveRules } = require('./public/rule-matcher');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.WORKBENCH_DATA_DIR || path.join(__dirname, 'data');
const STORE_PATH = process.env.WORKBENCH_STORE_PATH || path.join(DATA_DIR, 'store.json');
const INITIAL_DATA_PATH = path.join(__dirname, 'examples', 'demo.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROBE_CORE = process.env.WORKBENCH_FLCLASH_CORE || '';
let probeJob = null;

// 初始化数据存储
function initStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }

  if (!fs.existsSync(STORE_PATH)) {
    console.log('[Store] 首次启动，从 examples/demo.json 初始化演示数据...');
    if (fs.existsSync(INITIAL_DATA_PATH)) {
      const raw = fs.readFileSync(INITIAL_DATA_PATH, 'utf-8');
      const parsed = JSON.parse(raw);

      // 为已有已发布版本预先固化冻结的 YAML 配置，严格沿用快照自带的真实 effectiveRules 顺序
      if (parsed.history && parsed.profiles) {
        for (const p of parsed.profiles) {
          const hist = parsed.history[p.id] || [];
          for (const item of hist) {
            if (!item.frozenYaml && item.profile) {
              item.frozenYaml = generateClashYaml(item.profile, parsed.sources || [], parsed.company || {}, {
                isDraft: false,
                frozenTimestamp: item.publishedAt,
                effectiveRules: item.effectiveRules
              });
            }
          }
        }
      }

      fs.writeFileSync(STORE_PATH, JSON.stringify(parsed, null, 2), { encoding: 'utf-8', mode: 0o600 });
      console.log('[Store] 初始化完成，持久化文件已就绪。');
    } else {
      console.error('[Store] 错误: 未找到初始数据文件 ' + INITIAL_DATA_PATH);
      fs.writeFileSync(STORE_PATH, JSON.stringify({ profiles: [], sources: [] }, null, 2), { mode: 0o600 });
    }
  }
}

function readStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[Store] 读取失败:', err);
    return null;
  }
}

function writeStore(data) {
  const pending = `${STORE_PATH}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(pending, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(pending, STORE_PATH);
    return true;
  } catch (err) {
    console.error('[Store] 写入失败:', err);
    return false;
  }
}

function privateBackend(action, input) {
  const result = spawnSync('python3', [path.join(__dirname, 'live_backend.py'), action], {
    input: JSON.stringify(input), encoding: 'utf-8', timeout: 12000, maxBuffer: 12 * 1024 * 1024
  });
  let output;
  try { output = JSON.parse(result.stdout || ''); } catch { /* Do not relay subprocess diagnostics. */ }
  if (result.status !== 0 || !output) throw new Error(output?.error || '本机配置处理失败');
  return output;
}

function runPrivateBackend(action, input, timeout, failureMessage) {
  return new Promise((resolve, reject) => {
    const child = execFile('python3', [path.join(__dirname, 'live_backend.py'), action], {
      encoding: 'utf-8', timeout, maxBuffer: 12 * 1024 * 1024
    }, (error, stdout) => {
      let result;
      try { result = JSON.parse(stdout); } catch { /* Raw output is private. */ }
      if (error || !result) reject(new Error(result?.error || failureMessage));
      else resolve(result);
    });
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify(input));
  });
}

async function loadRealSource(source) {
  const { id, prefix, preserveNames, url } = source;
  try {
    return await runPrivateBackend('fetch', { source: { id, prefix, preserveNames, url } }, 26000, '连接订阅上游超时或失败');
  } catch (error) {
    if (error.message !== 'TLS 连接中断') throw error;
    try {
      const body = await fetchSubscriptionUrl(source.url, 8000, 2_000_000);
      return privateBackend('parse', { source, body });
    } catch {
      throw error;
    }
  }
}

function compileDownload(store, profile, effectiveRules) {
  if (store.liveData) {
    return privateBackend('compile', { profile, sources: store.sources, company: store.company });
  }
  return {
    yaml: generateClashYaml(profile, store.sources || [], store.company || {}, {
      isDraft: false, frozenTimestamp: profile.publishedAt, effectiveRules
    }),
    rules: effectiveRules,
    nodeCount: (profile.groups || []).reduce((total, group) => total + group.members.length, 0)
  };
}

function publicSource(source) {
  const { url: upstream, cache, ...publicFields } = source;
  return { ...publicFields, rawUrlStored: Boolean(upstream) };
}

function readNodeMeasurements() {
  try {
    const file = path.join(path.dirname(STORE_PATH), 'node-measurements.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).sources || {};
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[Node measurements] 无法读取检测结果');
    return {};
  }
}

function canMeasure(store) {
  return Boolean(store?.liveData && fs.existsSync(PROBE_CORE));
}

function startNodeMeasurement(scope) {
  const job = {
    id: randomUUID(), status: 'running', scope,
    total: 0, completed: 0, targets: {}, results: Object.create(null)
  };
  probeJob = job;
  const worker = spawn('python3', [
    path.join(__dirname, 'measure-live-nodes.py'), '--store', STORE_PATH, '--events'
  ], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  });
  const lines = createInterface({ input: worker.stdout });
  lines.on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'start') {
      job.targets = event.targets;
      job.startedAt = event.startedAt;
      job.total = Object.values(job.targets).reduce((total, target) => total + target.nodes.length, 0);
    } else if (event.type === 'result' && job.targets[event.sourceId]?.nodes.includes(event.name)) {
      const results = (job.results[event.sourceId] ??= Object.create(null));
      if (!Object.hasOwn(results, event.name)) job.completed++;
      results[event.name] = event.measurement;
    } else if (event.type === 'error') {
      job.error = event.message;
    }
  });
  worker.stdin.on('error', () => {});
  worker.stdin.end(JSON.stringify(scope));
  worker.on('error', () => { job.error = '本机测速进程启动失败，请重试'; });
  worker.on('close', code => {
    job.status = code === 0 && job.total > 0 && job.completed === job.total ? 'done' : 'failed';
    if (job.status === 'failed') job.error ||= '测速中断，可重新测速';
  });
  return job;
}

function publicProfile(profile) {
  const { extras, customNodeNames = [], ...display } = profile;
  const managed = new Set(customNodeNames);
  return {
    ...display,
    nodes: (profile.nodes || []).map(({ name, type, server, port, username = '', password, 'dialer-proxy': dialerProxy = '' }) =>
      managed.has(name) ? { name, type, custom: true, server, port, username, dialerProxy, hasPassword: Boolean(password) } : { name, type }),
    groups: (profile.groups || []).map(({ extra, ...group }) => group)
  };
}

function applyNodeChange(profile, change) {
  if (!change || !['add', 'edit', 'remove'].includes(change.action)) throw new Error('自定义节点操作无效');
  const { action, name, type, server, port, username = '', password = '' } = change;
  if (typeof name !== 'string' || !/^[^,#&\r\n]{1,128}$/.test(name) || name !== name.trim()) {
    throw new Error('请输入有效的节点名称');
  }
  const nodes = profile.nodes || [];
  const groups = profile.groups || [];
  const managed = new Set(profile.customNodeNames || []);
  const previous = nodes.find(node => node.name === name);
  if (action === 'add') {
    const reserved = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL'];
    if (previous || reserved.includes(name) || groups.some(group => group.name === name)) {
      throw new Error('节点或策略组名称已存在');
    }
  } else if (!previous || !managed.has(name)) {
    throw new Error('找不到该自定义节点');
  }
  if (action === 'remove') {
    if (groups.some(group => group.members?.includes(name)) || profile.rules?.some(rule => rule.target === name)
        || nodes.some(node => node['dialer-proxy'] === name)) {
      throw new Error('请先解除策略组、规则或其他节点对该节点的引用');
    }
    profile.nodes = nodes.filter(node => node.name !== name);
    managed.delete(name);
  } else {
    if (!['http', 'socks5'].includes(type) || typeof server !== 'string' || !/^[a-zA-Z0-9_.:-]{1,253}$/.test(server)) {
      throw new Error('请选择 HTTP 或 SOCKS5，并填写主机名或 IP');
    }
    if (server.includes(':') && !isIPv6(server)) throw new Error('IPv6 地址格式无效');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口须在 1 到 65535 之间');
    if (typeof username !== 'string' || typeof password !== 'string') throw new Error('节点认证信息格式无效');
    const updated = { ...(previous || {}), name, type, server, port };
    const dialer = change.dialerProxy ?? '';
    if (typeof dialer !== 'string' || (dialer && (dialer === name || ![...nodes, ...groups].some(item => item.name === dialer)))) {
      throw new Error('前置代理不存在或指向自身');
    }
    if (dialer) updated['dialer-proxy'] = dialer;
    else delete updated['dialer-proxy'];
    if (username) updated.username = username;
    else delete updated.username;
    if (password) updated.password = password;
    else if (change.clearPassword === true) delete updated.password;
    profile.nodes = previous ? nodes.map(node => node === previous ? updated : node) : [...nodes, updated];
    managed.add(name);
  }
  profile.customNodeNames = [...managed].sort();
}

function publishedSnapshot(store, profile) {
  return store.history?.[profile.id]?.find(item => item.version === profile.publishedVersion);
}

function visibleSnapshot(version) {
  const { frozenYaml, ...metadata } = version;
  return { ...metadata, profile: publicProfile(version.profile) };
}

function hasPublishableDraft(store, profile) {
  const published = publishedSnapshot(store, profile)?.profile;
  return published ? profileContentKey(profile) !== profileContentKey(published)
    : !profile.publishedVersion || Boolean(profile.hasDraft);
}

function comparisonSnapshot(store, id, version) {
  const profile = store.profiles.find(item => item.id === id);
  if (!profile || typeof version !== 'string') return null;
  if (version === 'draft') return hasPublishableDraft(store, profile) ? { version, profile } : null;
  if (!/^[1-9][0-9]*$/.test(version)) return null;
  const snapshot = store.history?.[id]?.find(item => item.version === Number(version));
  return snapshot ? {
    version,
    profile: snapshot.profile,
    effectiveRules: snapshot.effectiveRules,
    yaml: snapshot.downloadUnavailable ? undefined : snapshot.frozenYaml
  } : null;
}

function mergeDraft(current, incoming, catalog, published) {
  if (!incoming) return current;
  const allowed = ['name', 'groups', 'rules', 'network', 'hosts', 'sourceIds'];
  const draft = Object.fromEntries(allowed.filter(key => Object.hasOwn(incoming, key)).map(key => [key, incoming[key]]));
  if (Array.isArray(draft.groups)) {
    draft.groups = draft.groups.map(group => ({
      ...group,
      extra: current.groups?.find(original => original.id === group.id)?.extra || {}
    }));
  }
  if (Array.isArray(draft.rules)) {
    const known = new Set((catalog || []).map(item => item.id));
    for (const rule of draft.rules) {
      if (!Object.hasOwn(rule, 'publicSet')) continue;
      const { version, entries } = rule.publicSet || {};
      const validEntries = Array.isArray(entries) && entries.length > 0 &&
        entries.every((entry, index) => typeof entry === 'string' && entry === entry.trim() &&
          /^(?:\+\.)?[a-zA-Z0-9_*.-]{1,253}$/.test(entry) && (index === 0 || entries[index - 1] < entry));
      if (rule.type !== 'GEOSITE' || typeof rule.value !== 'string' || !known.has(rule.value.toLowerCase()) || !validEntries) {
        throw new Error('公共规则集内容无效，请重新选择规则集');
      }
      const payload = entries.join('\n');
      if (payload.length > 700_000 || createHash('sha256').update(payload).digest('hex').slice(0, 12) !== version) {
        throw new Error('公共规则集版本与内容不符，请重新选择规则集');
      }
      rule.publicSet = { version, entries };
    }
  }
  return reconcileGroupNames({ ...current, ...draft }, published, current);
}

if (process.env.WORKBENCH_REQUIRE_LIVE === '1') {
  if (!fs.existsSync(STORE_PATH) || !readStore()?.liveData) {
    throw new Error('缺少本机真实订阅数据库，未启动。');
  }
} else {
  initStore();
}

// 静态文件 MIME 表
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// 校验是否为合法本机 Host (防 DNS Rebinding)
function isLocalHost(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.split(':')[0].toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

// 真实 HTTP(S) 请求拉取订阅内容 (带 8s 超时与 5MB 限制)
function fetchSubscriptionUrl(targetUrl, timeoutMs = 8000, maxSizeBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return reject(new Error('非法 URL 格式: ' + e.message));
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return reject(new Error(`不支持的协议: ${parsed.protocol}`));
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(targetUrl, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'clash-meta/subscription-workbench',
        'Accept': '*/*'
      }
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''}`));
      }

      let receivedBytes = 0;
      const chunks = [];

      res.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > maxSizeBytes) {
          req.destroy();
          return reject(new Error(`响应数据超过 5MB 大小限制 (已接收 ${receivedBytes} 字节)`));
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        const fullBody = Buffer.concat(chunks).toString('utf-8');
        resolve(fullBody);
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`连接上游超时 (超过 ${timeoutMs}ms)`));
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

// 解析请求体 JSON
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) {
        req.connection.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// 安全发送 JSON：移除开放 CORS 通配符
function acceptsGzip(header = '') {
  const encodings = new Map(header.toLowerCase().split(',').map(item => {
    const [encoding, ...parameters] = item.trim().split(';');
    const quality = parameters.find(parameter => /^\s*q\s*=/.test(parameter));
    return [encoding.trim(), quality === undefined ? 1 : Number(quality.split('=')[1])];
  }));
  return (encodings.get('gzip') ?? encodings.get('*') ?? 0) > 0;
}

function sendJson(res, statusCode, data, compress = false) {
  const body = JSON.stringify(data);
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (compress) {
    headers['Cache-Control'] = 'no-store';
    headers.Vary = 'Accept-Encoding';
  }
  if (compress && body.length >= 1024 && acceptsGzip(res.req.headers['accept-encoding'])) {
    gzip(body, (error, compressed) => {
      if (!error) headers['Content-Encoding'] = 'gzip';
      res.writeHead(statusCode, headers);
      res.end(error ? body : compressed);
    });
    return;
  }
  res.writeHead(statusCode, headers);
  res.end(body);
}

// 校验 Profile (合法目标支持：策略组、内置节点、标准内置目标)
function serverValidateProfile(prof) {
  const errors = [];
  if (!prof.name || !prof.name.trim()) {
    errors.push('配置名称不能为空');
  }

  const groupNames = (prof.groups || []).map(g => g.name);
  const nodeNames = (prof.nodes || []).map(n => n.name);
  const validTargets = new Set([...groupNames, ...nodeNames, 'DIRECT', 'REJECT', 'PASS', 'GLOBAL']);

  const nameSet = new Set();
  for (const name of groupNames) {
    if (nameSet.has(name)) {
      errors.push(`策略组名称重复: "${name}"`);
    }
    nameSet.add(name);
  }

  for (const r of prof.rules || []) {
    if (!r.target || !validTargets.has(r.target)) {
      errors.push(`规则 [${r.type}, ${r.value || ''}] 指向不存在的目标: "${r.target}"`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// 解析输入的 Clash YAML 文本或 Base64 订阅
function parseClashOrBase64Nodes(rawText) {
  const nodes = [];
  const trimmed = rawText.trim();
  if (!trimmed) return nodes;

  // 1. 尝试判断是否是 Base64 编码的节点列表
  if (!trimmed.includes('\n') && /^[A-Za-z0-9+/=]+$/.test(trimmed)) {
    try {
      const decoded = Buffer.from(trimmed, 'base64').toString('utf-8');
      const lines = decoded.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (line.startsWith('vmess://') || line.startsWith('vless://') || line.startsWith('ss://') || line.startsWith('trojan://')) {
          const type = line.split('://')[0];
          // 提取备注名
          let name = `导入节点-${type}-${nodes.length + 1}`;
          if (line.includes('#')) {
            name = decodeURIComponent(line.split('#')[1].trim());
          }
          nodes.push({
            name: name,
            rawName: name,
            type: type
          });
        }
      }
      if (nodes.length > 0) return nodes;
    } catch (e) {
      // 不是有效的 Base64，继续后续解析
    }
  }

  // 2. 尝试从 YAML 中解析 proxies
  const lines = trimmed.split(/\r?\n/);
  let inProxies = false;
  let currentProxy = null;

  for (const line of lines) {
    const lTrim = line.trim();
    if (line.startsWith('proxies:')) {
      inProxies = true;
      continue;
    }
    if (inProxies && !line.startsWith(' ') && !line.startsWith('\t') && lTrim.endsWith(':')) {
      // 进入下一节
      break;
    }
    if (inProxies) {
      if (lTrim.startsWith('- name:')) {
        if (currentProxy) nodes.push(currentProxy);
        const nameMatch = lTrim.match(/- name:\s*["']?([^"']+)["']?/);
        currentProxy = {
          name: nameMatch ? nameMatch[1].trim() : `节点-${nodes.length + 1}`,
          rawName: nameMatch ? nameMatch[1].trim() : `节点-${nodes.length + 1}`,
          type: 'vless'
        };
      } else if (currentProxy && lTrim.startsWith('type:')) {
        const typeMatch = lTrim.match(/type:\s*(\w+)/);
        if (typeMatch) currentProxy.type = typeMatch[1];
      }
    }
  }
  if (currentProxy) nodes.push(currentProxy);

  return nodes;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // 1. 本机 Host 安全校验 (防止外部恶意 Host 攻击与 DNS Rebinding)
  if (!isLocalHost(req.headers['host'])) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden: 非法 Host 访问，仅允许 127.0.0.1 / localhost');
  }

  // 2. Origin 来源校验
  const origin = req.headers['origin'];
  if (origin) {
    try {
      const parsedOrigin = new URL(origin);
      if (!isLocalHost(parsedOrigin.hostname)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('403 Forbidden: 非法跨域 Origin 访问');
      }
    } catch (e) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('403 Forbidden: 非法 Origin 格式');
    }
  }

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // 1. 获取工作台全部数据 (普通数据响应脱敏掩蔽 URL 凭据)
  if (method === 'GET' && pathname === '/api/data') {
    const store = readStore();
    if (!store) {
      return sendJson(res, 500, { error: '无法读取数据仓库' });
    }
    const measurements = store.liveData ? readNodeMeasurements() : {};
    const sources = store.sources.map(source => {
      const run = measurements[source.id];
      const display = publicSource(source);
      if (!run || run.sourceUpdatedAt !== source.updatedAt) return display;
      return {
        ...display,
        lastMeasurement: { startedAt: run.startedAt, finishedAt: run.finishedAt },
        nodes: (display.nodes || []).map(node => run.items[node.name]
          ? { ...node, measurement: run.items[node.name] }
          : node)
      };
    });
    const profiles = store.profiles.map(profile => publicProfile({
      ...reconcileGroupNames(profile, publishedSnapshot(store, profile)?.profile),
      hasDraft: hasPublishableDraft(store, profile)
    }));
    const common = {
      sources, profiles, company: store.company, liveData: store.liveData,
      nodeProbeAvailable: canMeasure(store),
    };
    if (parsedUrl.query.view === 'bootstrap') {
      const publishedBaselines = Object.fromEntries(profiles.flatMap(profile => {
        const snapshot = profile.hasDraft && publishedSnapshot(store, profile);
        return snapshot ? [[profile.id, publicProfile(snapshot.profile)]] : [];
      }));
      return sendJson(res, 200, {
        ...common, publishedBaselines,
        publicRuleCount: (store.publicRuleLibrary || []).length,
        historyCounts: Object.fromEntries(Object.entries(store.history || {}).map(([id, items]) => [id, items.length])),
      }, true);
    }
    const history = Object.fromEntries(Object.entries(store.history || {}).map(([id, versions]) => [id, versions.map(visibleSnapshot)]));
    return sendJson(res, 200, { ...store, ...common, history }, true);
  }

  if (method === 'GET' && pathname === '/api/history') {
    const store = readStore();
    if (!store) return sendJson(res, 500, { error: '无法读取版本历史' });
    const history = Object.fromEntries(Object.entries(store.history || {}).map(([id, versions]) => [id,
      versions.map(({ version, publishedAt, effectiveRules }) => ({ version, publishedAt, ruleCount: effectiveRules?.length }))
    ]));
    return sendJson(res, 200, { history }, true);
  }

  if (method === 'GET' && pathname === '/api/profile/published') {
    const store = readStore();
    if (!store) return sendJson(res, 500, { error: '无法读取发布版本' });
    const profile = store.profiles.find(item => item.id === parsedUrl.query.profileId);
    const snapshot = profile && publishedSnapshot(store, profile);
    if (!snapshot) return sendJson(res, 404, { error: '找不到当前发布版本' });
    return sendJson(res, 200, { snapshot: visibleSnapshot(snapshot) }, true);
  }

  if (method === 'GET' && pathname === '/api/public-rules') {
    const store = readStore();
    if (!store) return sendJson(res, 500, { error: '无法读取公共规则库' });
    return sendJson(res, 200, { publicRuleLibrary: store.publicRuleLibrary || [] }, true);
  }

  if (pathname === '/api/profile/compare' && method === 'GET') {
    const store = readStore();
    if (!store) return sendJson(res, 500, { error: '无法读取配置仓库' });
    const { left, leftVersion, right, rightVersion } = parsedUrl.query;
    const a = comparisonSnapshot(store, left, leftVersion);
    const b = comparisonSnapshot(store, right, rightVersion);
    if (!a || !b) return sendJson(res, 404, { error: '所选版本已不存在，请重新选择。' });
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await runPrivateBackend('compare', {
        left: a, right: b, sources: store.sources, company: store.company
      }, 9000, '读取配置超时');
      return sendJson(res, 200, result);
    } catch {
      return sendJson(res, 500, { error: '暂时无法对比所选配置，请重试。' });
    }
  }

  if (pathname === '/api/public-rule-detail' && method === 'GET') {
    const store = readStore();
    if (!store) return sendJson(res, 500, { error: '无法读取规则库' });
    const id = parsedUrl.query.id;
    if (typeof id !== 'string' || !(store.publicRuleLibrary || []).some(item => item.id === id)) {
      return sendJson(res, 404, { error: '规则库中没有这条规则集' });
    }
    try {
      const detail = await runPrivateBackend('public-rule-detail', { id }, 13000, '读取上游规则超时，请重试');
      return sendJson(res, 200, detail);
    } catch (error) {
      return sendJson(res, 502, { error: error.message });
    }
  }

  if (pathname === '/api/node-probe' && method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return sendJson(res, 200, { job: probeJob });
  }

  if (pathname === '/api/node-probe' && method === 'POST') {
    try {
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        return sendJson(res, 415, { error: '测速请求需要 JSON' });
      }
      const { sourceId, nodeName, sourceUpdatedAt, selection } = await parseBody(req);
      const store = readStore();
      if (!canMeasure(store)) return sendJson(res, 503, { error: '本机测速内核不可用' });
      if (probeJob?.status === 'running') {
        return sendJson(res, 409, { error: '已有测速正在运行', job: probeJob });
      }
      if ((sourceId !== undefined && typeof sourceId !== 'string') ||
          (nodeName !== undefined && (typeof nodeName !== 'string' || !sourceId))) {
        return sendJson(res, 400, { error: '请选择有效的测速范围' });
      }
      const eligible = store.sources.filter(source => source.enabled !== false && source.cache?.length);
      if (selection !== undefined) {
        if (sourceId !== undefined || !Array.isArray(selection) || !selection.length || selection.length > eligible.length) {
          return sendJson(res, 400, { error: '请选择有效的测速范围' });
        }
        const seen = new Set();
        for (const target of selection) {
          const source = eligible.find(item => item.id === target?.sourceId);
          if (!source || source.updatedAt !== target.sourceUpdatedAt) {
            return sendJson(res, 409, { error: '节点列表已更新，请重新打开本页后测速' });
          }
          const names = new Set((source.nodes || []).map(node => node.name));
          if (seen.has(source.id) || !Array.isArray(target.nodes) || !target.nodes.length ||
              target.nodes.length > names.size || new Set(target.nodes).size !== target.nodes.length ||
              target.nodes.some(name => !names.has(name))) {
            return sendJson(res, 400, { error: '请选择有效的测速节点' });
          }
          seen.add(source.id);
        }
        return sendJson(res, 202, { job: startNodeMeasurement({
          selection: selection.map(({ sourceId, sourceUpdatedAt, nodes }) => ({ sourceId, sourceUpdatedAt, nodes }))
        }) });
      }
      const source = eligible.find(item => item.id === sourceId);
      if (sourceId && !source) return sendJson(res, 404, { error: '订阅来源不可用' });
      if (source && source.updatedAt !== sourceUpdatedAt) {
        return sendJson(res, 409, { error: '节点列表已更新，请重新打开本页后测速' });
      }
      if (nodeName && !source.nodes?.some(node => node.name === nodeName)) {
        return sendJson(res, 404, { error: '找不到要测速的节点' });
      }
      if (!eligible.length) return sendJson(res, 400, { error: '没有可测速的订阅来源' });
      return sendJson(res, 202, { job: startNodeMeasurement({ sourceId, nodeName, sourceUpdatedAt }) });
    } catch {
      return sendJson(res, 400, { error: '无法读取测速请求' });
    }
  }

  // 2. 规则命中测试评估
  if (method === 'POST' && pathname === '/api/rule-test') {
    try {
      const { input, profileId, currentProfile } = await parseBody(req);
      const store = readStore();
      const profile = currentProfile || store.profiles.find(p => p.id === profileId);
      if (!profile) {
        return sendJson(res, 404, { error: '未找到指定设备配置' });
      }

      // 获取当前已发布版本的快照
      let publishedProfile = profile;
      let publishedRules;
      if (store.history && store.history[profile.id]) {
        const pubSnap = store.history[profile.id].find(h => h.version === profile.publishedVersion);
        if (pubSnap && pubSnap.profile) {
          publishedProfile = pubSnap.profile;
          publishedRules = pubSnap.effectiveRules;
        }
      }

      const result = compareEvaluation(input, profile, publishedProfile, store.company, publishedRules);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 3. 保存草稿 (只改变草稿，绝不影响已发布的快照与下载)
  if (method === 'POST' && pathname === '/api/profile/save-draft') {
    try {
      const { profileId, updates, nodeChange } = await parseBody(req);
      const store = readStore();
      const profileIdx = store.profiles.findIndex(p => p.id === profileId);
      if (profileIdx === -1) {
        return sendJson(res, 404, { error: '未找到指定设备配置' });
      }

      const current = store.profiles[profileIdx];
      const merged = mergeDraft(current, updates, store.publicRuleLibrary, publishedSnapshot(store, current)?.profile);
      if (nodeChange !== undefined) applyNodeChange(merged, nodeChange);
      const hasDraft = hasPublishableDraft(store, merged);
      if (profileContentKey(merged) === profileContentKey(current)) {
        return sendJson(res, 200, { success: true, profile: publicProfile({ ...current, hasDraft }) });
      }
      const updatedProfile = {
        ...merged,
        id: current.id,
        publishedVersion: current.publishedVersion, // 保持已发布版本号不变
        publishedAt: current.publishedAt,
        hasDraft,
        updatedAt: new Date().toISOString()
      };

      store.profiles[profileIdx] = updatedProfile;
      if (!writeStore(store)) return sendJson(res, 500, { error: '草稿保存失败，请重试' });
      return sendJson(res, 200, { success: true, profile: publicProfile(updatedProfile) });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 4. 放弃草稿 (还原回当前已发布版本快照)
  if (method === 'POST' && pathname === '/api/profile/discard-draft') {
    try {
      const { profileId } = await parseBody(req);
      const store = readStore();
      const profileIdx = store.profiles.findIndex(p => p.id === profileId);
      if (profileIdx === -1) {
        return sendJson(res, 404, { error: '未找到指定设备配置' });
      }

      const current = store.profiles[profileIdx];
      const pubSnap = publishedSnapshot(store, current);

      if (!pubSnap || !pubSnap.profile) {
        return sendJson(res, 400, { error: '未找到已发布的历史快照' });
      }

      const restored = {
        ...JSON.parse(JSON.stringify(pubSnap.profile)),
        hasDraft: false,
        updatedAt: current.updatedAt
      };

      store.profiles[profileIdx] = restored;
      if (!writeStore(store)) return sendJson(res, 500, { error: '放弃草稿失败，请重试' });
      return sendJson(res, 200, { success: true, profile: publicProfile(restored) });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 5. 正式发布：将当前编辑内容进行服务端校验、持久化，并按历史最大版本号+1生成新版本与冻结快照
  if (method === 'POST' && pathname === '/api/profile/publish') {
    try {
      const { profileId, currentProfile } = await parseBody(req);
      const store = readStore();
      const profileIdx = store.profiles.findIndex(p => p.id === profileId);
      if (profileIdx === -1) {
        return sendJson(res, 404, { error: '未找到指定设备配置' });
      }

      const current = store.profiles[profileIdx];
      const targetState = mergeDraft(current, currentProfile, store.publicRuleLibrary, publishedSnapshot(store, current)?.profile);

      // 服务端严格校验
      const validation = serverValidateProfile(targetState);
      if (!validation.valid) {
        return sendJson(res, 400, {
          error: '发布校验失败',
          details: validation.errors
        });
      }

      // 计算新版本号：必须找出该 profile 在 history 中的最大历史版本号
      if (!store.history) store.history = {};
      if (!store.history[profileId]) store.history[profileId] = [];

      const maxHistVersion = store.history[profileId].reduce((max, h) => Math.max(max, h.version || 0), 0);
      const newVersion = Math.max(current.publishedVersion || 0, maxHistVersion) + 1;
      const nowIso = new Date().toISOString();

      const publishedProfile = {
        ...targetState,
        id: current.id,
        publishedVersion: newVersion,
        publishedAt: nowIso,
        hasDraft: false,
        updatedAt: nowIso
      };

      const effectiveRules = expandEffectiveRules(publishedProfile, store.company).map(r => r.displayRule);
      const compiled = compileDownload(store, publishedProfile, effectiveRules);

      // 固化到 history 快照（按版本倒序排在首位）
      store.history[profileId].unshift({
        version: newVersion,
        publishedAt: nowIso,
        profile: JSON.parse(JSON.stringify(publishedProfile)),
        effectiveRules: compiled.rules,
        frozenYaml: compiled.yaml,
        nodeCount: compiled.nodeCount
      });

      store.profiles[profileIdx] = publishedProfile;
      const writeOk = writeStore(store);
      if (!writeOk) {
        return sendJson(res, 500, { error: '持久化文件写入失败，发布中止' });
      }

      return sendJson(res, 200, {
        success: true,
        profile: publicProfile(publishedProfile),
        version: newVersion,
        publishedAt: nowIso,
        effectiveRules: compiled.rules,
        nodeCount: compiled.nodeCount
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 6. 从历史版本恢复到草稿：保持当前已发布版本和下载内容不变！
  if (method === 'POST' && pathname === '/api/profile/rollback') {
    try {
      const { profileId, targetVersion } = await parseBody(req);
      const store = readStore();
      const profileIdx = store.profiles.findIndex(p => p.id === profileId);
      if (profileIdx === -1) {
        return sendJson(res, 404, { error: '未找到指定设备配置' });
      }

      const current = store.profiles[profileIdx];
      const historyList = store.history?.[profileId] || [];
      const snap = historyList.find(h => h.version === targetVersion);
      if (!snap || !snap.profile) {
        return sendJson(res, 404, { error: `未找到版本 v${targetVersion} 的历史快照` });
      }

      // 关键不变量：恢复历史内容作为草稿，但保持当前已发布版本号与已发布快照绝对不变！
      const draftRestored = {
        ...JSON.parse(JSON.stringify(snap.profile)),
        id: current.id,
        publishedVersion: current.publishedVersion, // 保持已发布版本不变！
        publishedAt: current.publishedAt,           // 保持已发布时间不变！
        updatedAt: new Date().toISOString()
      };
      draftRestored.hasDraft = hasPublishableDraft(store, draftRestored);

      store.profiles[profileIdx] = draftRestored;
      if (!writeStore(store)) return sendJson(res, 500, { error: '恢复草稿失败，请重试' });

      return sendJson(res, 200, {
        success: true,
        profile: publicProfile(draftRestored),
        message: `已载入版本 v${targetVersion} 的内容作为草稿，当前已发布版本 v${current.publishedVersion} 保持不变`
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 7. 复制设备配置
  if (method === 'POST' && pathname === '/api/profile/duplicate') {
    try {
      const { sourceProfileId, newName } = await parseBody(req);
      const store = readStore();
      const source = store.profiles.find(p => p.id === sourceProfileId);
      if (!source) {
        return sendJson(res, 404, { error: '源配置不存在' });
      }

      const newId = `${source.id}-copy-${Date.now().toString(36)}`;
      const duplicated = {
        ...JSON.parse(JSON.stringify(source)),
        id: newId,
        name: newName || `${source.name} (副本)`,
        publishedVersion: 1,
        publishedAt: new Date().toISOString(),
        hasDraft: false,
        updatedAt: new Date().toISOString()
      };

      const effectiveRules = expandEffectiveRules(duplicated, store.company).map(r => r.displayRule);
      const compiled = compileDownload(store, duplicated, effectiveRules);

      store.profiles.push(duplicated);
      if (!store.history) store.history = {};
      store.history[newId] = [
        {
          version: 1,
          publishedAt: duplicated.publishedAt,
          profile: JSON.parse(JSON.stringify(duplicated)),
          effectiveRules: compiled.rules,
          frozenYaml: compiled.yaml,
          nodeCount: compiled.nodeCount
        }
      ];

      const writeOk = writeStore(store);
      if (!writeOk) {
        return sendJson(res, 500, { error: '持久化文件写入失败，复制中止' });
      }
      return sendJson(res, 200, { success: true, profile: publicProfile(duplicated) });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 8. 创建全新空白配置 (初始未发布状态)
  if (method === 'POST' && pathname === '/api/profile/create') {
    try {
      const { name, device } = await parseBody(req);
      if (!name || !name.trim()) {
        return sendJson(res, 400, { error: '配置名称不能为空' });
      }

      const store = readStore();
      const newId = `profile-${Date.now().toString(36)}`;
      const newProfile = {
        id: newId,
        name: name.trim(),
        device: device === 'phone' ? 'phone' : 'desktop',
        sourceIds: [],
        publishedVersion: 0, // 0 表示空白从未发布
        publishedAt: null,
        hasDraft: true,
        updatedAt: new Date().toISOString(),
        groups: [
          {
            id: 'g-default',
            name: 'DIRECT',
            type: 'select',
            members: ['DIRECT'],
            selectors: [],
            options: {}
          }
        ],
        rules: [
          {
            type: 'MATCH',
            value: '',
            target: 'DIRECT',
            enabled: true
          }
        ],
        nodes: [],
        hosts: {},
        network: {
          dns: { enable: true, ipv6: false, 'enhanced-mode': 'fake-ip' }
        }
      };

      store.profiles.push(newProfile);
      writeStore(store);
      return sendJson(res, 200, { success: true, profile: newProfile });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (method === 'POST' && pathname === '/api/source/manage') {
    try {
      const { sourceId, action } = await parseBody(req);
      if (!['enable', 'disable', 'delete'].includes(action)) return sendJson(res, 400, { error: '未知来源操作' });
      const store = readStore();
      if (!store) return sendJson(res, 500, { error: '无法读取数据仓库' });
      const source = store.sources.find(item => item.id === sourceId);
      if (!source) return sendJson(res, 404, { error: '订阅来源不存在' });
      if (action === 'delete') {
        const usedBy = store.profiles.filter(profile => profile.sourceIds?.includes(sourceId) ||
          profile.groups?.some(group => group.selectors?.some(selector => selector.sourceId === sourceId)));
        if (usedBy.length) return sendJson(res, 409, { error: `「${usedBy.map(profile => profile.name).join('、')}」仍在使用此来源，可先停用。` });
        store.sources = store.sources.filter(item => item.id !== sourceId);
      } else {
        source.enabled = action === 'enable';
      }
      if (!writeStore(store)) return sendJson(res, 500, { error: '来源操作保存失败' });
      return sendJson(res, 200, action === 'delete' ? { message: '来源已删除' } : {
        source: publicSource(source), message: source.enabled ? '来源已启用' : '来源已停用'
      });
    } catch {
      return sendJson(res, 400, { error: '无法读取来源操作' });
    }
  }

  // 9. 订阅源刷新：绝不伪造！真实发起网络请求，超时与大小限制，失败保留旧缓存
  if (method === 'POST' && pathname === '/api/source/refresh') {
    try {
      const { sourceId } = await parseBody(req);
      const store = readStore();
      const src = store.sources.find(s => s.id === sourceId);
      if (!src) {
        return sendJson(res, 404, { error: '订阅源不存在' });
      }

      // 真实性校验：如果没有真实配置 URL
      if (!src.url && src.subscriptionUrlStored) {
        return sendJson(res, 400, {
          error: `订阅源 [${src.name}] 为脱敏快照，未配置在线更新 URL，无法发起网络刷新。请录入真实订阅地址或粘贴内容更新。`,
          isSnapshotOnly: true
        });
      }

      if (!src.url || !src.url.trim()) {
        return sendJson(res, 400, {
          error: `订阅源 [${src.name}] 未设置订阅地址`
        });
      }

      // 真实发起网络请求 (超时 8s，限制 5MB)
      try {
        const parsed = store.liveData ? await loadRealSource(src)
          : { nodes: parseClashOrBase64Nodes(await fetchSubscriptionUrl(src.url, 8000, 5 * 1024 * 1024)) };
        const parsedNodes = parsed.nodes;
        if (parsedNodes.length === 0) {
          return sendJson(res, 400, {
            error: `请求成功但未能解析出有效节点，已保留原有的 ${src.nodes?.length || 0} 个节点缓存`,
            retainedCount: src.nodes?.length || 0
          });
        }
        const latest = readStore();
        const activeSource = latest.sources.find(item => item.id === sourceId && item.url === src.url);
        if (!activeSource) return sendJson(res, 409, { error: '来源地址已更换，请重新刷新。' });
        if (store.liveData && JSON.stringify(parsed.cache) === JSON.stringify(activeSource.cache)) {
          parsed.nodes = activeSource.nodes;
        } else {
          activeSource.lastMeasurement = null;
        }
        Object.assign(activeSource, parsed, { nodeCount: parsedNodes.length, updatedAt: new Date().toISOString(), status: 'ready', lastRefreshError: '' });
        if (!writeStore(latest)) return sendJson(res, 500, { error: '刷新结果保存失败，保留上次节点。' });
        return sendJson(res, 200, {
          success: true,
          message: `订阅源 [${src.name}] 刷新成功，更新 ${parsedNodes.length} 个节点`,
          source: publicSource(activeSource)
        });
      } catch (reqErr) {
        const message = `刷新失败（${reqErr.message}），已保留原有 ${src.nodes?.length || 0} 个节点。`;
        const latest = readStore();
        const activeSource = latest?.sources.find(item => item.id === sourceId && item.url === src.url);
        if (activeSource) {
          activeSource.lastRefreshError = message;
          writeStore(latest);
        }
        return sendJson(res, 400, {
          error: message,
          retainedCount: src.nodes?.length || 0
        });
      }
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 10. 订阅源手工维护 / 导入（录入真实 URL 或粘贴 Clash YAML / Base64 内容）
  if (method === 'POST' && pathname === '/api/source/update-or-import') {
    try {
      const { sourceId, name, url: subUrl, rawContent } = await parseBody(req);
      const store = readStore();
      let src = sourceId ? store.sources.find(s => s.id === sourceId) : null;
      if (sourceId && !src) return sendJson(res, 404, { error: '订阅来源不存在' });

      if (!src) {
        // 新建订阅源
        const newSrcId = `src-${Date.now().toString(36)}`;
        src = {
          id: newSrcId,
          name: name || '新订阅源',
          prefix: name ? name.slice(0, 4) : '自定义',
          enabled: true,
          status: 'ready',
          nodeCount: 0,
          updatedAt: new Date().toISOString(),
          subscriptionUrlStored: false,
          lastMeasurement: null,
          nodes: []
        };
        store.sources.push(src);
      }

      if (name) src.name = name;
      if (typeof subUrl === 'string' && subUrl.trim()) {
        const upstream = new URL(subUrl.trim());
        if (!['https:', 'http:'].includes(upstream.protocol)) throw new Error('订阅地址必须使用 HTTP 或 HTTPS');
        src.url = upstream.href;
        src.lastRefreshError = '';
      }

      // 如果提供了文本内容（YAML / Base64）
      if (rawContent && rawContent.trim()) {
        const parsed = store.liveData ? privateBackend('parse', { source: src, body: rawContent })
          : { nodes: parseClashOrBase64Nodes(rawContent) };
        const parsedNodes = parsed.nodes;
        if (parsedNodes.length === 0) {
          return sendJson(res, 400, {
            error: '未能从输入内容中解析出有效节点，请确认是合法的 Clash YAML 格式（包含 proxies）或 Base64 节点列表'
          });
        }
        Object.assign(src, parsed);
        src.nodeCount = parsedNodes.length;
        src.updatedAt = new Date().toISOString();
        src.status = 'ready';
        src.lastMeasurement = null; // 新节点未测量
      }

      if (!writeStore(store)) return sendJson(res, 500, { error: '来源保存失败' });
      return sendJson(res, 200, {
        success: true,
        source: publicSource(src),
        message: `订阅源 [${src.name}] 维护完成，有效节点数：${src.nodes.length}`
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 11. 试验订阅下载 (严格冻结在发布历史记录，未发布配置返回 404，无假流量头)
  const subMatch = pathname.match(/^\/(?:sub|api\/subscription)\/([a-zA-Z0-9_-]+)(?:\.ya?ml)?$/);
  if (method === 'GET' && subMatch) {
    const profileId = subMatch[1];
    const store = readStore();
    const profile = store.profiles.find(p => p.id === profileId);

    if (!profile) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`404 Not Found: 未找到配置 "${profileId}"`);
    }

    // 空白未发布的配置，必须返回 404！
    if (!profile.publishedVersion || profile.publishedVersion === 0) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`404 Not Found: 配置 "${profile.name}" 尚未发布过任何可用版本`);
    }

    // 查找对应已发布版本的历史快照
    const historyList = store.history?.[profileId] || [];
    const pubSnap = historyList.find(h => h.version === profile.publishedVersion);

    if (!pubSnap) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`404 Not Found: 找不到版本 v${profile.publishedVersion} 的已发布快照`);
    }

    // 核心不变量：必须直接下发历史记录中冻结的 frozenYaml！
    // 杜绝刷新来源或修改网段后悄悄生成不同内容！
    if (store.liveData && !pubSnap.frozenYaml) {
      res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('此历史版本缺少节点凭据，无法下载。');
    }
    const finalYaml = pubSnap.frozenYaml || generateClashYaml(pubSnap.profile, store.sources || [], store.company || {}, {
      isDraft: false,
      frozenTimestamp: pubSnap.publishedAt
    });

    res.writeHead(200, {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${profileId}-v${profile.publishedVersion}.yaml"`,
      'Cache-Control': 'no-store',
      'X-Subscription-Version': `v${profile.publishedVersion}`,
      'X-Subscription-Type': store.liveData ? 'local-workbench' : 'experimental-workbench'
      // 绝对不添加假伪造流量头 Subscription-Userinfo
    });
    return res.end(finalYaml);
  }

  // 12. 静态资源服务
  let reqPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, reqPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`404 Not Found: ${pathname}`);
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const compress = stats.size >= 1024 && ['.html', '.js', '.css'].includes(ext);
    const headers = { 'Content-Type': contentType };
    if (compress) headers.Vary = 'Accept-Encoding';
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    if (compress && acceptsGzip(req.headers['accept-encoding'])) {
      headers['Content-Encoding'] = 'gzip';
      const encoder = createGzip();
      encoder.on('error', () => res.destroy());
      res.writeHead(200, headers);
      stream.pipe(encoder).pipe(res);
    } else {
      res.writeHead(200, headers);
      stream.pipe(res);
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log('========================================================');
  console.log(`🚀 订阅工作台已成功启动！`);
  console.log(`💻 绑定地址:           http://${HOST}:${PORT}`);
  console.log(`💻 Web 界面访问:       http://localhost:${PORT}`);
  console.log(`📥 电脑订阅下载:       http://localhost:${PORT}/sub/desktop.yaml`);
  console.log(`📱 手机订阅下载:       http://localhost:${PORT}/sub/phone.yaml`);
  console.log('========================================================');
});
