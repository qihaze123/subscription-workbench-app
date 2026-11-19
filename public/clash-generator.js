// clash-generator.js
// 订阅工作台：生成标准 Clash / Mihomo YAML 试验订阅配置
const { publicRuleProviderKey } = require('./rule-matcher');

function generateClashYaml(profile, sources, companySubnets, options = {}) {
  const lines = [];

  const version = profile.publishedVersion || 1;
  const isDraft = options.isDraft === true;
  const timestamp = options.frozenTimestamp || profile.publishedAt || new Date().toISOString();

  lines.push('# ========================================================');
  lines.push(`# 订阅工作台 - 试验订阅 (${isDraft ? '草稿预览' : '已发布版本快照'})`);
  lines.push(`# 配置名称: ${profile.name}`);
  lines.push(`# 设备类型: ${profile.device}`);
  lines.push(`# 发布版本: v${version}`);
  lines.push(`# 快照时间: ${timestamp}`);
  lines.push('# 声明: 本订阅为本机试验配置，未附带伪造流量计量');
  lines.push('# ========================================================');
  lines.push('');

  // 1. 基础配置
  lines.push('port: 7890');
  lines.push('socks-port: 7891');
  lines.push('allow-lan: false');
  lines.push('mode: rule');
  lines.push('log-level: info');
  lines.push('ipv6: ' + (profile.network?.dns?.ipv6 ? 'true' : 'false'));
  lines.push('external-controller: 127.0.0.1:9090');
  lines.push('');

  // 2. DNS 配置
  if (profile.network?.dns) {
    const dns = profile.network.dns;
    lines.push('dns:');
    lines.push(`  enable: ${dns.enable !== false}`);
    lines.push(`  ipv6: ${dns.ipv6 === true}`);
    if (dns['enhanced-mode']) lines.push(`  enhanced-mode: ${dns['enhanced-mode']}`);
    lines.push('  fake-ip-range: 198.18.0.1/16');
    lines.push(`  respect-rules: ${dns['respect-rules'] !== false}`);
    lines.push(`  use-hosts: ${dns['use-hosts'] !== false}`);
    lines.push(`  use-system-hosts: ${dns['use-system-hosts'] !== false}`);
    if (Array.isArray(dns.nameserver) && !dns.nameserver.length) {
      lines.push('  nameserver: []');
    } else {
      lines.push('  nameserver:');
      for (const server of dns.nameserver || ['223.5.5.5', '119.29.29.29']) {
        lines.push(`    - ${JSON.stringify(server)}`);
      }
    }
    lines.push('  fallback:');
    lines.push('    - 8.8.8.8');
    lines.push('    - 1.1.1.1');
    lines.push('');
  }

  // 3. TUN 配置
  if (profile.network?.tun && Object.keys(profile.network.tun).length) {
    const tun = profile.network.tun;
    lines.push('tun:');
    lines.push(`  enable: ${tun.enable ?? (tun['auto-route'] !== undefined)}`);
    lines.push('  stack: system');
    lines.push(`  auto-route: ${tun['auto-route'] !== false}`);
    lines.push(`  auto-detect-interface: ${tun['auto-detect-interface'] !== false}`);
    if (tun['route-exclude-address'] && tun['route-exclude-address'].length > 0) {
      lines.push('  route-exclude-address:');
      for (const addr of tun['route-exclude-address']) {
        lines.push(`    - ${JSON.stringify(addr)}`);
      }
    }
    lines.push('');
  }

  // 4. Hosts 配置
  if (profile.hosts && Object.keys(profile.hosts).length > 0) {
    lines.push('hosts:');
    for (const [domain, ip] of Object.entries(profile.hosts)) {
      lines.push(`  '${domain}': '${ip}'`);
    }
    lines.push('');
  }

  // 5. 提取全部有效节点池
  const activeSources = (sources || []).filter(s => (profile.sourceIds || []).includes(s.id));
  const proxyList = [];

  // 固定节点从当前配置取值。
  proxyList.push(...(profile.nodes || []));

  // 机场来源节点
  for (const src of activeSources) {
    if (src.nodes && src.nodes.length > 0) {
      for (const node of src.nodes) {
        if (/剩余流量|套餐到期|到期时间|过期时间|下次重置|流量重置|官网/.test(node.rawName || node.name)) {
          continue;
        }
        proxyList.push({
          name: node.name,
          type: node.type || 'vless',
          server: node.server || 'example.invalid',
          port: node.port || 443
        });
      }
    }
  }

  lines.push('proxies:');
  if (proxyList.length === 0) {
    lines.push('  - { name: "DIRECT-FALLBACK", type: direct }');
  } else {
    for (const p of proxyList) {
      lines.push(`  - name: "${p.name.replace(/"/g, '\\"')}"`);
      lines.push(`    type: ${p.type}`);
      for (const key of ['server', 'port', 'hostname', 'state-dir', 'udp', 'username', 'password', 'dialer-proxy']) {
        if (p[key] != null) lines.push(`    ${key}: ${JSON.stringify(p[key])}`);
      }
    }
  }
  lines.push('');

  // 6. 策略组 (proxy-groups)
  lines.push('proxy-groups:');
  const allProxyNames = proxyList.map(p => p.name);
  const validGroupNames = (profile.groups || []).map(g => g.name);

  for (const group of profile.groups || []) {
    lines.push(`  - name: "${group.name.replace(/"/g, '\\"')}"`);
    lines.push(`    type: ${group.type}`);

    // 计算该组的候选成员
    const members = [];
    const excludedList = group.options?.excluded || [];

    // 显式指定成员
    if (group.members && group.members.length > 0) {
      for (const m of group.members) {
        if (!members.includes(m) && !excludedList.includes(m)) {
          members.push(m);
        }
      }
    }

    // 正则筛选
    if (group.selectors && group.selectors.length > 0) {
      for (const sel of group.selectors) {
        const src = activeSources.find(s => s.id === sel.sourceId);
        if (src && src.nodes) {
          const incRe = sel.include ? new RegExp(sel.include) : null;
          const excRe = sel.exclude ? new RegExp(sel.exclude) : null;
          const included = sel.names ? new Set(sel.names) : null;
          const excludedNames = new Set(sel.excludeNames || []);
          for (const node of src.nodes) {
            if (excludedNames.has(node.name) || (included && !included.has(node.name))) continue;
            if (excRe && excRe.test(node.rawName || node.name)) continue;
            if (incRe && !incRe.test(node.rawName || node.name)) continue;
            if (!members.includes(node.name) && !excludedList.includes(node.name)) {
              members.push(node.name);
            }
          }
        }
      }
    }

    let validMembers = members.filter(m =>
      m === 'DIRECT' || m === 'REJECT' || allProxyNames.includes(m) || validGroupNames.includes(m)
    );
    if (group.type !== 'url-test' && Array.isArray(group.options?.priority) && group.options.priority.length) {
      const prioritized = [...new Set(group.options.priority)].filter(name => validMembers.includes(name));
      validMembers = [...prioritized, ...validMembers.filter(name => !prioritized.includes(name))];
    }

    if (validMembers.length === 0) {
      validMembers.push('DIRECT');
    }

    lines.push('    proxies:');
    for (const m of validMembers) {
      lines.push(`      - "${m.replace(/"/g, '\\"')}"`);
    }

    if (group.type === 'url-test' || group.type === 'fallback') {
      const probeUrl = (group.options?.url ?? group.extra?.url) || 'https://www.gstatic.com/generate_204';
      lines.push(`    url: ${JSON.stringify(probeUrl)}`);
      const expected = group.options?.['expected-status'] ?? group.extra?.['expected-status'];
      if (expected != null || probeUrl !== 'https://www.gstatic.com/generate_204') {
        lines.push(`    expected-status: ${JSON.stringify(String(expected ?? '200-399'))}`);
      }
      lines.push('    interval: 300');
      if (group.type === 'url-test') {
        lines.push('    tolerance: 50');
      }
    }
  }
  lines.push('');

  // 7. 规则 (rules)
  const providers = new Map((profile.rules || []).filter(rule => rule.enabled !== false && publicRuleProviderKey(rule))
    .map(rule => [publicRuleProviderKey(rule), rule.publicSet.entries]));
  if (providers.size) {
    lines.push('rule-providers:');
    for (const [key, payload] of providers) {
      lines.push(`  ${key}:`, '    type: inline', '    behavior: domain', '    format: yaml', '    payload:');
      for (const entry of payload) lines.push(`      - ${JSON.stringify(entry)}`);
    }
    lines.push('');
  }
  lines.push('rules:');
  const directEffectiveRules = options.effectiveRules || profile.effectiveRules;
  if (Array.isArray(directEffectiveRules) && directEffectiveRules.length > 0) {
    // 严格沿用历史快照固化的有效规则真实顺序，杜绝被当前 company 动态重排污染
    for (const ruleStr of directEffectiveRules) {
      lines.push(`  - ${ruleStr}`);
    }
  } else {
    const companyCidrs = (companySubnets && companySubnets.cidrs) ? companySubnets.cidrs : [];

    for (const rule of profile.rules || []) {
      if (rule.enabled === false) continue;

      if (rule.type === 'COMPANY') {
        const target = rule.target || '🏢 公司内网';
        for (const cidr of companyCidrs) {
          lines.push(`  - IP-CIDR,${cidr},${target}`);
        }
        continue;
      }

      if (rule.type === 'MATCH') {
        lines.push(`  - MATCH,${rule.target}`);
      } else {
        const provider = publicRuleProviderKey(rule);
        let rStr = provider ? `  - RULE-SET,${provider},${rule.target}` : `  - ${rule.type},${rule.value},${rule.target}`;
        if (rule.noResolve) {
          rStr += ',no-resolve';
        }
        lines.push(rStr);
      }
    }
  }

  return lines.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { generateClashYaml };
}
