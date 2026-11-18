// test/e2e-http.test.js
// 端到端真实 HTTP 端口集成测试：覆盖两端发布、复制、切组、安全校验与下载不变量

const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { gunzipSync } = require('node:zlib');

// 导入 server.js 相关模块和定义
const TEST_PORT = 3999;
process.env.PORT = String(TEST_PORT);
process.env.HOST = '127.0.0.1';

// 使用独立隔离的测试数据目录，绝不污染或删除用户的项目 data/store.json
const TEST_DATA_DIR = path.join(__dirname, 'temp_test_data');
process.env.WORKBENCH_DATA_DIR = TEST_DATA_DIR;
process.env.WORKBENCH_STORE_PATH = path.join(TEST_DATA_DIR, 'test_store.json');

if (fs.existsSync(TEST_DATA_DIR)) {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}

// 启动真实 server
require('../server.js');

// 辅助 HTTP 请求函数
function request(options, postData = null) {
  return new Promise((resolve, reject) => {
    const defaultHeaders = {
      'Host': `127.0.0.1:${TEST_PORT}`,
      'User-Agent': 'Workbench-E2E-Tester/1.0'
    };

    if (postData) {
      defaultHeaders['Content-Type'] = 'application/json';
    }

    const reqOptions = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: options.path,
      method: options.method || 'GET',
      headers: { ...defaultHeaders, ...(options.headers || {}) }
    };

    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const body = (res.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(body);
        } catch (e) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body, transferred: bytes.length,
          json
        });
      });
    });

    req.on('error', reject);

    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

// 睡眠辅助
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runE2ETests() {
  console.log('========================================================');
  console.log(`🚀 开始端到端真实 HTTP 端口集成测试 (端口: ${TEST_PORT})...`);
  console.log('========================================================');

  // 等待 server 监听就绪
  await sleep(400);

  let passed = 0;
  let total = 0;

  function testCase(name, fn) {
    total++;
    return fn()
      .then(() => {
        passed++;
        console.log(`  ✅ [PASS] ${name}`);
      })
      .catch((err) => {
        console.error(`  ❌ [FAIL] ${name}`);
        console.error(`     错误详情: ${err.message}`);
        throw err;
      });
  }

  // 1. 安全测试：非法 Host 拦截与 CORS 收敛
  await testCase('安全基线：非法 Host (如 attacker.com) 请求被 403 拦截', async () => {
    const res = await request({
      path: '/api/data',
      headers: { 'Host': 'attacker.com' }
    });
    assert.strictEqual(res.statusCode, 403, '非本机 Host 必须返回 403');
    assert.ok(res.body.includes('403 Forbidden'), '必须明确拒绝外部 Host');
  });

  await testCase('安全基线：CORS 响应头无全开放通配符 *', async () => {
    const res = await request({ path: '/api/data' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined, '不得返回开放的通配 CORS');
  });

  await testCase('首屏仅加载配置，版本与公共规则按需读取，支持压缩和无压缩客户端', async () => {
    const legacy = (await request({ path: '/api/data' })).json;
    const path = '/api/data?view=bootstrap';
    const identity = await request({ path, headers: { 'Accept-Encoding': 'gzip;q=0, *;q=1' } });
    const compressed = await request({ path, headers: { 'Accept-Encoding': 'gzip' } });
    assert.strictEqual(compressed.statusCode, 200);
    assert.strictEqual(compressed.headers['content-encoding'], 'gzip');
    assert.strictEqual(compressed.headers.vary, 'Accept-Encoding');
    assert.strictEqual(identity.headers['content-encoding'], undefined);
    assert.deepStrictEqual(compressed.json, identity.json);
    assert.ok(compressed.transferred < identity.transferred);
    assert.deepStrictEqual(identity.json.profiles, legacy.profiles);
    assert.strictEqual(identity.json.history, undefined);
    assert.strictEqual(identity.json.publicRuleLibrary, undefined);

    const { history } = (await request({ path: '/api/history' })).json;
    assert.strictEqual(identity.json.historyCounts.desktop, history.desktop.length);
    const publishedVersion = identity.json.profiles.find(profile => profile.id === 'desktop').publishedVersion;
    const oldSnapshot = legacy.history.desktop.find(snapshot => snapshot.version === publishedVersion);
    const { snapshot } = (await request({ path: '/api/profile/published?profileId=desktop' })).json;
    assert.deepStrictEqual(snapshot, oldSnapshot);
    assert.strictEqual(snapshot.frozenYaml, undefined);
    const metadata = history.desktop.find(item => item.version === publishedVersion);
    assert.strictEqual(metadata.ruleCount, snapshot.effectiveRules.length);
    assert.strictEqual(metadata.profile, undefined);

    const catalog = await request({ path: '/api/public-rules', headers: { 'Accept-Encoding': 'gzip' } });
    assert.strictEqual(catalog.json.publicRuleLibrary.length, identity.json.publicRuleCount);
    assert.deepStrictEqual(catalog.json.publicRuleLibrary, legacy.publicRuleLibrary);
    const script = await request({ path: '/app.js', headers: { 'Accept-Encoding': 'gzip' } });
    assert.strictEqual(script.headers['content-encoding'], 'gzip');
    assert.ok(script.body.includes('/api/data?view=bootstrap'));
  });

  await testCase('节点测速：快照环境拒绝启动真实测速且没有进度任务', async () => {
    const data = await request({ path: '/api/data' });
    assert.strictEqual(data.json.nodeProbeAvailable, false);
    const started = await request({
      path: '/api/node-probe', method: 'POST', headers: { 'Content-Type': 'application/json' }
    }, {});
    assert.strictEqual(started.statusCode, 503);
    const progress = await request({ path: '/api/node-probe' });
    assert.strictEqual(progress.statusCode, 200);
    assert.strictEqual(progress.json.job, null);
    assert.strictEqual(progress.headers['cache-control'], 'no-store');
  });

  // 2. 数据获取与 URL 脱敏
  let desktopProfile = null;
  await testCase('GET /api/data：成功加载全量数据并脱敏订阅 URL 凭据', async () => {
    const res = await request({ path: '/api/data' });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.json.profiles.length >= 2, '必须包含桌面与手机等配置');
    desktopProfile = res.json.profiles.find(p => p.id === 'desktop');
    assert.ok(desktopProfile, '必须存在 desktop 配置');

    // 检查订阅源 URL 掩蔽
    for (const src of res.json.sources || []) {
      if (src.url) {
        assert.ok(src.url.includes('***'), '包含凭据的 URL 必须掩蔽输出');
      }
    }
  });

  // 3. 复制真实桌面配置并发布 (重点验证第二项修复)
  let duplicatedCopy = null;
  await testCase('POST /api/profile/duplicate：复制真实桌面配置 (包含 Tailscale 内置节点)', async () => {
    const res = await request({
      path: '/api/profile/duplicate',
      method: 'POST'
    }, {
      sourceProfileId: 'desktop',
      newName: '桌面配置副本-实测'
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.json.success);
    duplicatedCopy = res.json.profile;
    assert.ok(duplicatedCopy.id.startsWith('desktop-copy-'));
    assert.strictEqual(duplicatedCopy.publishedVersion, 1);
  });

  await testCase('POST /api/profile/publish：立即发布副本，验证接受 profile.nodes 节点目标且不报错', async () => {
    // 检查副本的 rules 第一条确实指向节点 '工作台 Tailscale'
    const firstRule = duplicatedCopy.rules[0];
    assert.strictEqual(firstRule.target, '工作台 Tailscale', '首条规则应指向 Tailscale 内置节点');

    const res = await request({
      path: '/api/profile/publish',
      method: 'POST'
    }, {
      profileId: duplicatedCopy.id,
      currentProfile: { ...duplicatedCopy, name: `${duplicatedCopy.name} v2` }
    });

    assert.strictEqual(res.statusCode, 200, `发布被拒绝: ${res.body}`);
    assert.ok(res.json.success, '发布必须成功');
    assert.strictEqual(res.json.version, 2, '版本号必须按最大历史版本+1递增为 2');
    duplicatedCopy = res.json.profile;
    assert.strictEqual(duplicatedCopy.hasDraft, false);
  });

  await testCase('草稿：相同内容无需写入，改回发布内容后不再待发布', async () => {
    const save = updates => request({ path: '/api/profile/save-draft', method: 'POST' }, {
      profileId: duplicatedCopy.id, updates
    });
    const initial = fs.readFileSync(process.env.WORKBENCH_STORE_PATH);
    const unchanged = await save({ name: duplicatedCopy.name, groups: duplicatedCopy.groups });
    assert.strictEqual(unchanged.statusCode, 200);
    assert.strictEqual(unchanged.json.profile.hasDraft, false);
    assert.deepStrictEqual(fs.readFileSync(process.env.WORKBENCH_STORE_PATH), initial);
    const changed = await save({ name: '待发布草稿' });
    assert.strictEqual(changed.json.profile.hasDraft, true);
    const restored = await save({ name: duplicatedCopy.name });
    assert.strictEqual(restored.json.profile.hasDraft, false);
    const data = await request({ path: '/api/data' });
    assert.strictEqual(data.json.profiles.find(item => item.id === duplicatedCopy.id).hasDraft, false);
    assert.strictEqual((await request({ path: `/sub/${duplicatedCopy.id}.yaml` })).headers['x-subscription-version'], 'v2');
  });

  // 4. 试验订阅下载测试
  await testCase('GET /sub/{copyId}.yaml：下载内容冻结且严格保留 effectiveRules 顺序', async () => {
    const res = await request({
      path: `/sub/${duplicatedCopy.id}.yaml`
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'text/yaml; charset=utf-8');
    assert.strictEqual(res.headers['x-subscription-version'], 'v2');
    assert.strictEqual(res.headers['subscription-userinfo'], undefined, '绝不伪造流量计量头');

    // 检查 YAML 包含 Tailscale 节点规则
    assert.ok(res.body.includes('- DOMAIN,device-01.mesh.example,工作台 Tailscale'), '必须包含首条有效规则');
    assert.ok(res.body.includes('- IP-CIDR,192.0.2.0/24,🏢 公司内网'), '必须沿用快照有效规则');
  });

  // 5. 空白未发布配置必须返回 404
  let blankProfile = null;
  await testCase('POST /api/profile/create：创建空白配置且下载严格 404', async () => {
    const res = await request({
      path: '/api/profile/create',
      method: 'POST'
    }, {
      name: '测试空白手机配置',
      device: 'phone'
    });

    assert.strictEqual(res.statusCode, 200);
    blankProfile = res.json.profile;
    assert.strictEqual(blankProfile.publishedVersion, 0, '未发布版本号应为 0');

    // 访问其下载链接
    const subRes = await request({
      path: `/sub/${blankProfile.id}.yaml`
    });
    assert.strictEqual(subRes.statusCode, 404, '空白未发布配置必须返回 404');
    assert.ok(subRes.body.includes('尚未发布过任何可用版本'));
  });

  // 6. 历史回滚草稿隔离与再发布
  await testCase('POST /api/profile/rollback：从历史回滚至草稿，已发布快照与下载不受影响', async () => {
    // 载入 v1 到草稿
    const res = await request({
      path: '/api/profile/rollback',
      method: 'POST'
    }, {
      profileId: duplicatedCopy.id,
      targetVersion: 1
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.profile.publishedVersion, 2, '当前已发布版本号必须保持为 2');
    assert.strictEqual(res.json.profile.hasDraft, true, '必须标记为有草稿');

    // 此时下载依然是 v2 的冻结快照！
    const subRes = await request({
      path: `/sub/${duplicatedCopy.id}.yaml`
    });
    assert.strictEqual(subRes.statusCode, 200);
    assert.strictEqual(subRes.headers['x-subscription-version'], 'v2', '下载快照必须仍为 v2');

    // 将该草稿再次发布，新版本号应递增至 3 (历史最大 2 + 1)
    const pubRes = await request({
      path: '/api/profile/publish',
      method: 'POST'
    }, {
      profileId: duplicatedCopy.id,
      currentProfile: res.json.profile
    });
    assert.strictEqual(pubRes.statusCode, 200);
    assert.strictEqual(pubRes.json.version, 3, '新发布版本号应为历史最大 2 + 1 = 3');
  });

  await testCase('自定义节点可加入策略组，发布订阅时带上代理配置', async () => {
    const profileId = blankProfile.id;
    const name = '示例独立代理';
    const password = 'demo-test-only-password';
    const savePath = { path: '/api/profile/save-draft', method: 'POST' };
    const group = { id: 'custom-exit', name: '指定出口', type: 'select', members: [name], selectors: [], options: {} };
    const rules = [{ type: 'DOMAIN-SUFFIX', value: 'test.example', target: group.name, enabled: true },
      { type: 'MATCH', value: '', target: 'DIRECT', enabled: true }];
    const added = await request(savePath, {
      profileId,
      updates: { groups: [group], rules },
      nodeChange: { action: 'add', name, type: 'socks5', server: '192.0.2.20', port: 1080, username: 'example', password }
    });
    assert.strictEqual(added.statusCode, 200);
    assert.strictEqual(added.json.profile.nodes.find(node => node.name === name).hasPassword, true);
    assert.ok(!added.body.includes(password));
    assert.ok(!(await request({ path: '/api/data?view=bootstrap' })).body.includes(password));
    assert.strictEqual((await request({ path: `/sub/${profileId}.yaml` })).statusCode, 404);
    const published = await request({ path: '/api/profile/publish', method: 'POST' }, {
      profileId, currentProfile: added.json.profile
    });
    assert.strictEqual(published.statusCode, 200);
    const downloaded = await request({ path: `/sub/${profileId}.yaml` });
    assert.ok(downloaded.body.includes(`password: "${password}"`));
    assert.ok(downloaded.body.includes(`DOMAIN-SUFFIX,test.example,${group.name}`));
    assert.ok(downloaded.body.includes(`- "${name}"`));
    const removed = await request(savePath, { profileId, updates: {}, nodeChange: { action: 'remove', name } });
    assert.strictEqual(removed.statusCode, 400);
  });

  // 7. 订阅刷新真实性测试 (重点验证第三项修复)
  await testCase('POST /api/source/refresh：脱敏快照源拒绝伪造刷新，如实返回离线快照说明', async () => {
    const snapshot = await request({ path: '/api/data' });
    const source = snapshot.json.sources.find(item => item.subscriptionUrlStored && !item.rawUrlStored);
    assert.ok(source, '真实快照中应有保存过在线订阅、但已移除 URL 的来源');
    const res = await request({
      path: '/api/source/refresh',
      method: 'POST'
    }, {
      sourceId: source.id
    });

    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.json.isSnapshotOnly);
    assert.ok(res.json.error.includes('脱敏快照'));
  });

  await testCase('POST /api/source/refresh：配置实际 URL 发起真实网络连接，连接失败如实返回并保留旧缓存', async () => {
    // 1. 先导入一个配置了本地不可达端口 URL 的订阅源
    const importRes = await request({
      path: '/api/source/update-or-import',
      method: 'POST'
    }, {
      name: '真实网络测试源',
      url: 'http://127.0.0.1:49999/subscription-not-exist.yaml', // 确定无服务端口
      rawContent: `
proxies:
  - name: "缓存节点-01"
    type: vless
    server: 192.0.2.11
    port: 443
    uuid: "12345678-1234-1234-1234-123456789abc"
`
    });

    assert.strictEqual(importRes.statusCode, 200);
    const testSrcId = importRes.json.source.id;
    assert.strictEqual(importRes.json.source.nodes.length, 1);

    // 2. 执行刷新：发起真实 HTTP 请求到 127.0.0.1:49999
    const refreshRes = await request({
      path: '/api/source/refresh',
      method: 'POST'
    }, {
      sourceId: testSrcId
    });

    // 必须如实报错拒绝（ECONNREFUSED），且明确保留了原有 1 个节点的缓存！
    assert.strictEqual(refreshRes.statusCode, 400);
    assert.ok(refreshRes.json.error.startsWith('刷新失败'), `返回的错误不符合预期: ${refreshRes.json.error}`);
    assert.ok(refreshRes.json.error.includes('ECONNREFUSED') || refreshRes.json.error.includes('连接'), '必须是真实的操作系统网络错误');
    assert.strictEqual(refreshRes.json.retainedCount, 1, '必须明确报告保留原有 1 个节点缓存');
  });

  console.log('========================================================');
  console.log(`🎉 端到端真实 HTTP 测试全部通过 (${passed}/${total})！`);
  console.log('========================================================');
  // 测试结束仅清理测试专属的临时数据副本
  try {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
  } catch (e) {}
  process.exit(0);
}

runE2ETests().catch(err => {
  console.error('测试异常终止:', err);
  process.exit(1);
});
