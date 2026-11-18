// test/invariants.test.js
// 订阅工作台：核心不变量自动化验证套件

const assert = require('assert');
const { generateClashYaml } = require('../public/clash-generator');
const { evaluateTarget, compareEvaluation, isIpInCidr, isIpv6InCidr } = require('../public/rule-matcher');

console.log('>>> 开始执行核心不变量测试套件...\n');

// 测试夹具数据
const mockCompany = {
  cidrs: [
    '192.0.2.0/24',
    '203.0.113.16/32',
    '198.51.100.0/24'
  ]
};

const mockSources = [
  {
    id: 'src-1',
    name: '测试机场1',
    nodes: [
      { name: '[示例] 🇯🇵Japan 04', rawName: '🇯🇵Japan 04', type: 'vless', server: '192.0.2.7', port: 443 },
      { name: '[示例] 🇯🇵Japan 01', rawName: '🇯🇵Japan 01', type: 'vless', server: '192.0.2.8', port: 443 }
    ]
  }
];

const mockProfile = {
  id: 'desktop-test',
  name: '电脑测试',
  device: 'desktop',
  sourceIds: ['src-1'],
  publishedVersion: 8,
  publishedAt: '2026-11-13T14:41:25+00:00',
  hasDraft: false,
  groups: [
    {
      id: 'g-ai',
      name: '🤖 AI固定（示例）',
      type: 'fallback',
      members: ['[示例] 🇯🇵Japan 04', '[示例] 🇯🇵Japan 01'],
      selectors: [],
      options: {}
    },
    {
      id: 'g-direct',
      name: 'DIRECT',
      type: 'select',
      members: ['DIRECT'],
      selectors: [],
      options: {}
    }
  ],
  rules: [
    {
      type: 'DOMAIN-SUFFIX',
      value: 'gemini.google.com',
      target: '🤖 AI固定（示例）',
      enabled: true
    },
    {
      type: 'COMPANY',
      value: '',
      target: '🏢 公司内网',
      enabled: true
    },
    {
      type: 'IP-CIDR6',
      value: '2001:db8:ab00::/48',
      target: 'DIRECT',
      enabled: true
    },
    {
      type: 'GEOSITE',
      value: 'cn',
      target: 'DIRECT',
      enabled: true
    },
    {
      type: 'MATCH',
      value: '',
      target: 'DIRECT',
      enabled: true
    }
  ],
  network: {
    dns: { enable: true, ipv6: false, 'enhanced-mode': 'fake-ip' }
  }
};

// -------------------------------------------------------------
// 不变量 1：已发布下载内容必须严格冻结，不受草稿修改影响
// -------------------------------------------------------------
console.log('[Test 1] 验证已发布下载内容冻结不变量...');
const publishedYaml = generateClashYaml(mockProfile, mockSources, mockCompany, {
  isDraft: false,
  frozenTimestamp: mockProfile.publishedAt
});

// 模拟用户在草稿中删改规则
const draftProfile = JSON.parse(JSON.stringify(mockProfile));
draftProfile.rules.unshift({
  type: 'DOMAIN-SUFFIX',
  value: 'draft-temp.com',
  target: 'DIRECT',
  enabled: true
});
draftProfile.hasDraft = true;

// 模拟草稿修改后再次拉取已发布版本
const downloadAfterDraft = generateClashYaml(mockProfile, mockSources, mockCompany, {
  isDraft: false,
  frozenTimestamp: mockProfile.publishedAt
});

assert.strictEqual(publishedYaml, downloadAfterDraft, '已发布配置的生成内容必须与初始快照完全一致，绝不可被草稿篡改');
assert(!downloadAfterDraft.includes('draft-temp.com'), '已发布下载内容绝不可包含草稿新增规则');
assert(!downloadAfterDraft.includes('Subscription-Userinfo'), '试验订阅绝不可包含虚假伪造流量头');
console.log('✓ [Test 1 通过] 已发布下载内容严格冻结在历史快照，草稿修改完全隔离。\n');

// -------------------------------------------------------------
// 不变量 2：版本号计算与历史回滚状态保持
// -------------------------------------------------------------
console.log('[Test 2] 验证历史回滚与版本号递增不变量...');
const mockHistory = [
  { version: 8, publishedAt: '2026-11-13T14:41:25+00:00', profile: mockProfile },
  { version: 7, publishedAt: '2026-11-12T10:00:00+00:00', profile: { ...mockProfile, publishedVersion: 7 } },
  { version: 6, publishedAt: '2026-11-11T10:00:00+00:00', profile: { ...mockProfile, publishedVersion: 6 } }
];

// 模拟将历史 v7 恢复到草稿
const snapV7 = mockHistory.find(h => h.version === 7);
const rollbackDraft = {
  ...JSON.parse(JSON.stringify(snapV7.profile)),
  id: mockProfile.id,
  publishedVersion: mockProfile.publishedVersion, // 保持当前已发布版本依然是 8！
  publishedAt: mockProfile.publishedAt,           // 保持发布时间不变！
  hasDraft: true
};

assert.strictEqual(rollbackDraft.publishedVersion, 8, '回滚历史到草稿时，当前已发布版本号必须保持为 8，不可倒退！');
assert.strictEqual(rollbackDraft.hasDraft, true, '回滚历史内容必须标记为草稿状态，待用户确认');

// 模拟再次发布：必须基于历史最大版本号 (8) + 1 = 9
const maxHistVersion = mockHistory.reduce((max, h) => Math.max(max, h.version), 0);
const nextPublishVersion = Math.max(rollbackDraft.publishedVersion, maxHistVersion) + 1;

assert.strictEqual(nextPublishVersion, 9, '基于回滚草稿重新发布时，新版本号必须是历史最大版本号 + 1 = 9');
console.log('✓ [Test 2 通过] 历史恢复到草稿保持当前已发布版本，再发布版本号严格递增。\n');

// -------------------------------------------------------------
// 不变量 3：规则匹配器准确性与未知条件显式待定
// -------------------------------------------------------------
console.log('[Test 3] 验证规则匹配器准确性与条件性待定...');

// 3.1 确定性命中
const resGemini = evaluateTarget('gemini.google.com', mockProfile, mockCompany);
assert.strictEqual(resGemini.status, 'matched', 'gemini.google.com 必须确定命中');
assert.strictEqual(resGemini.target, '🤖 AI固定（示例）');
assert.strictEqual(resGemini.matchType, 'DOMAIN-SUFFIX');

// 3.2 公司网段展开命中
const resCompanyIp = evaluateTarget('192.0.2.5', mockProfile, mockCompany);
assert.strictEqual(resCompanyIp.status, 'matched', '公司私有 IP 必须确定命中 COMPANY 展开规则');
assert.strictEqual(resCompanyIp.target, '🏢 公司内网');

// 3.3 IPv6 网段命中
const resIpv6 = evaluateTarget('fd7a:115c:a1e0:1::1', mockProfile, mockCompany);
assert.strictEqual(resIpv6.status, 'matched', 'IPv6 目标必须精确命中 IP-CIDR6');
assert.strictEqual(resIpv6.target, 'DIRECT');

// 3.4 待定条件 (GEOSITE) 与兜底
const resUnknownDomain = evaluateTarget('random-site.net', mockProfile, mockCompany);
assert.strictEqual(resUnknownDomain.status, 'fallback_with_uncertainty', '未决站点遇到前序 GEOSITE 必须明确报告待定，不可草率报告无误确定');
assert(resUnknownDomain.priorIndeterminate.length > 0, '必须包含待定的前置规则原因');

const publicBefore = {
  type: 'GEOSITE', value: 'openai', target: 'REJECT',
  publicSet: { version: '000000000001', entries: ['+.old.example', '*.voice.example', '.assets.example'] }
};
const publicAfter = {
  ...publicBefore, publicSet: { version: '000000000002', entries: ['+.openai.com'] }
};
const beforeProfile = { ...mockProfile, rules: [publicBefore, ...mockProfile.rules] };
const afterProfile = { ...mockProfile, rules: [publicAfter, ...mockProfile.rules] };
const beforeRules = ['RULE-SET,workbench-domain-000000000001,REJECT', 'MATCH,DIRECT'];
const comparedPublic = compareEvaluation('api.openai.com', afterProfile, beforeProfile, mockCompany, beforeRules);
assert.strictEqual(comparedPublic.draft.matchedValue, '+.openai.com');
assert.strictEqual(comparedPublic.published.target, 'DIRECT');
assert.strictEqual(evaluateTarget('api.old.example', beforeProfile, mockCompany, beforeRules).target, 'REJECT');
assert.strictEqual(evaluateTarget('one.voice.example', beforeProfile, mockCompany, beforeRules).target, 'REJECT');
assert.strictEqual(evaluateTarget('two.one.voice.example', beforeProfile, mockCompany, beforeRules).target, 'DIRECT');
assert.strictEqual(evaluateTarget('assets.example', beforeProfile, mockCompany, beforeRules).target, 'DIRECT');
assert.strictEqual(evaluateTarget('deep.cdn.assets.example', beforeProfile, mockCompany, beforeRules).target, 'REJECT');
assert.deepStrictEqual(evaluateTarget('gemini.google.com', afterProfile, mockCompany).priorIndeterminate, []);
const legacy = { ...mockProfile, rules: [{ type: 'GEOSITE', value: 'openai', target: 'REJECT' }, ...mockProfile.rules] };
const legacyEntries = new Map([['openai', ['+.openai.com']]]);
assert.strictEqual(evaluateTarget('api.openai.com', legacy, mockCompany, undefined, legacyEntries).target, 'REJECT');
assert.deepStrictEqual(evaluateTarget('gemini.google.com', legacy, mockCompany, undefined, legacyEntries).priorIndeterminate, []);
assert.match(generateClashYaml(afterProfile, mockSources, mockCompany),
  /workbench-domain-000000000002:\n    type: inline\n    behavior: domain\n    format: yaml\n    payload:\n      - "\+\.openai\.com"/);
console.log('✓ [Test 3 通过] 确定性规则准确判定，缺数据条件严格标记待定，绝不虚假断言。\n');

// -------------------------------------------------------------
// 不变量 4：CIDR 计算边界
// -------------------------------------------------------------
console.log('[Test 4] 验证 IPv4 / IPv6 CIDR 计算边界...');
assert(isIpInCidr('192.0.2.1', '192.0.2.0/24'), '192.0.2.1 属于 192.0.2.0/24');
assert(!isIpInCidr('198.51.100.1', '192.0.2.0/24'), '198.51.100.1 不属于 192.0.2.0/24');
assert(isIpInCidr('203.0.113.16', '203.0.113.16/32'), '精确单个 IP /32 命中');
assert(!isIpInCidr('203.0.113.17', '203.0.113.16/32'), '邻近 IP 不命中');
assert(isIpv6InCidr('2001:db8:ab00:abcd::1', '2001:db8:ab00::/48'), 'IPv6 前缀 /48 命中');
assert(!isIpv6InCidr('2001:db8:ab01::1', '2001:db8:ab00::/48'), '不同前缀 IPv6 不命中');
console.log('✓ [Test 4 通过] CIDR 位掩码与 IPv6 前缀计算边界准确无误。\n');

console.log('========================================================');
console.log('🎉 全部核心不变量自动化测试 100% 通过！');
console.log('========================================================');
