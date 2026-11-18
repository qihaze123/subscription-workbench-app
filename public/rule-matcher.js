// rule-matcher.js
// 订阅工作台：网络规则匹配评估器
// 严格区分确定性匹配与条件性/待定规则，遵循真实规则链顺序

// IPv4 转换整数
function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

// 检查 IPv4 是否属于 CIDR
function isIpInCidr(ipStr, cidrStr) {
  if (!cidrStr.includes('/')) cidrStr += '/32';
  const [rangeIp, prefixLenStr] = cidrStr.split('/');
  const prefixLen = parseInt(prefixLenStr, 10);
  const ipInt = ipv4ToInt(ipStr);
  const rangeInt = ipv4ToInt(rangeIp);
  if (ipInt === null || rangeInt === null || isNaN(prefixLen)) return false;
  if (prefixLen === 0) return true;
  if (prefixLen < 0 || prefixLen > 32) return false;
  const mask = ((0xFFFFFFFF << (32 - prefixLen)) >>> 0);
  return (ipInt & mask) === (rangeInt & mask);
}

// 展开 IPv6 完整 16 进制字符串用于前缀比对
function expandIpv6(ip) {
  if (!ip.includes(':')) return null;
  let full = ip;
  if (full.includes('::')) {
    const halves = full.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - (left.length + right.length);
    const middle = Array(missing).fill('0000');
    full = [...left, ...middle, ...right].join(':');
  }
  const parts = full.split(':').map(p => p.padStart(4, '0'));
  if (parts.length !== 8) return null;
  return parts.join(':').toLowerCase();
}

// 检查 IPv6 CIDR
function isIpv6InCidr(ipStr, cidrStr) {
  if (!cidrStr.includes('/')) cidrStr += '/128';
  const [rangeIp, prefixLenStr] = cidrStr.split('/');
  const prefixLen = parseInt(prefixLenStr, 10);
  const expandedIp = expandIpv6(ipStr);
  const expandedRange = expandIpv6(rangeIp);
  if (!expandedIp || !expandedRange || isNaN(prefixLen)) return false;

  // 转换成二进制字符比较前缀
  const hexToBin = hexStr => hexStr.replace(/:/g, '').split('').map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
  const ipBin = hexToBin(expandedIp);
  const rangeBin = hexToBin(expandedRange);
  return ipBin.slice(0, prefixLen) === rangeBin.slice(0, prefixLen);
}

// 展开 Profile 的完整规则流（包含 COMPANY 规则的展开）
function publicRuleProviderKey(rule) {
  return rule.type === 'GEOSITE' && rule.publicSet ? `workbench-domain-${rule.publicSet.version}` : null;
}

function matchPublicDomain(domain, entries) {
  return entries.find(entry => {
    const wildcard = entry.toLowerCase();
    if (wildcard.startsWith('+.')) {
      return domain === wildcard.slice(2) || domain.endsWith(wildcard.slice(1));
    }
    if (wildcard.startsWith('.')) return domain.endsWith(wildcard);
    if (!wildcard.includes('*')) return domain === wildcard;
    const pattern = wildcard.split('.');
    const labels = domain.split('.');
    return pattern.length === labels.length && pattern.every((label, i) => label === '*' || label === labels[i]);
  });
}

function expandEffectiveRules(profile, companySubnets) {
  const effective = [];
  const rules = profile.rules || [];
  const available = companySubnets?.cidrs || [];
  const preferred = (profile.companySync?.cidrOrder || []).filter(cidr => available.includes(cidr));
  const cidrs = [...new Set([...preferred, ...available])];

  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (r.enabled === false) continue;

    if (r.type === 'COMPANY') {
      const target = r.target || '🏢 公司内网';
      for (let cIdx = 0; cIdx < cidrs.length; cIdx++) {
        const type = cidrs[cIdx].includes(':') ? 'IP-CIDR6' : 'IP-CIDR';
        const noResolve = r.noResolve ?? true;
        effective.push({
          sourceIndex: i,
          sourceRule: r,
          type,
          value: cidrs[cIdx],
          target: target,
          noResolve,
          isCompanyExpanded: true,
          displayRule: `${type},${cidrs[cIdx]},${target}${noResolve ? ',no-resolve' : ''}`
        });
      }
      continue;
    }

    const provider = publicRuleProviderKey(r);
    const type = provider ? 'RULE-SET' : r.type;
    const value = provider || r.value || '';
    let line = type;
    if (value) line += `,${value}`;
    line += `,${r.target}`;
    if (r.noResolve) line += ',no-resolve';

    effective.push({
      sourceIndex: i,
      sourceRule: r,
      type,
      value,
      target: r.target,
      noResolve: r.noResolve || false,
      isCompanyExpanded: false,
      displayRule: line
    });
  }

  return effective;
}

// 评估输入的目标（域名或 IP）命中哪一条规则
function evaluateTarget(inputStr, profile, companySubnets, orderedRules, legacyPublicRules) {
  const trimmed = (inputStr || '').trim();
  if (!trimmed) {
    return {
      success: false,
      status: 'error',
      message: '请输入待查询的域名或 IP 地址'
    };
  }

  const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(trimmed);
  const isIpv6 = trimmed.includes(':') && /^[0-9a-fA-F:]+$/.test(trimmed);
  const isIp = isIpv4 || isIpv6;
  const domain = trimmed.toLowerCase().replace(/\.$/, '');
  const providers = new Map((profile?.rules || []).filter(rule => rule.enabled !== false && publicRuleProviderKey(rule))
    .map(rule => [publicRuleProviderKey(rule), rule]));

  const effectiveRules = orderedRules ? orderedRules.map((line, sourceIndex) => {
    const [type, ...parts] = line.split(',');
    const noResolve = parts.at(-1) === 'no-resolve';
    if (noResolve) parts.pop();
    const target = parts.pop();
    return { sourceIndex, type, value: parts.join(','), target, noResolve, displayRule: line };
  }) : expandEffectiveRules(profile, companySubnets);
  const indeterminateEncountered = []; // 记录排在前面但无法离线决断的待定规则

  for (let index = 0; index < effectiveRules.length; index++) {
    const item = effectiveRules[index];

    // 1. IP-CIDR 匹配 (IPv4)
    if (item.type === 'IP-CIDR') {
      if (isIpv4 && isIpInCidr(trimmed, item.value)) {
        return {
          success: true,
          status: 'matched',
          input: trimmed,
          ruleIndex: index + 1,
          sourceIndex: item.sourceIndex + 1,
          rule: item,
          target: item.target,
          matchType: 'IP-CIDR',
          matchedValue: item.value,
          reason: item.isCompanyExpanded
            ? `IPv4 ${trimmed} 命中公司共享网段 ${item.value}`
            : `IPv4 ${trimmed} 属于网段 ${item.value}`,
          priorIndeterminate: indeterminateEncountered
        };
      }
      // 域名匹配中遇到了没有 no-resolve 的 IP 规则
      if (!isIp && !item.noResolve) {
        // 注明需 DNS 解析
      }
      continue;
    }

    // 2. IP-CIDR6 匹配 (IPv6)
    if (item.type === 'IP-CIDR6') {
      if (isIpv6 && isIpv6InCidr(trimmed, item.value)) {
        return {
          success: true,
          status: 'matched',
          input: trimmed,
          ruleIndex: index + 1,
          sourceIndex: item.sourceIndex + 1,
          rule: item,
          target: item.target,
          matchType: 'IP-CIDR6',
          matchedValue: item.value,
          reason: `IPv6 ${trimmed} 属于网段 ${item.value}`,
          priorIndeterminate: indeterminateEncountered
        };
      }
      continue;
    }

    // 3. 域名精确匹配 DOMAIN
    if (item.type === 'DOMAIN') {
      if (!isIp && trimmed.toLowerCase() === item.value.toLowerCase()) {
        return {
          success: true,
          status: 'matched',
          input: trimmed,
          ruleIndex: index + 1,
          sourceIndex: item.sourceIndex + 1,
          rule: item,
          target: item.target,
          matchType: 'DOMAIN',
          matchedValue: item.value,
          reason: `域名 ${trimmed} 完全精确匹配`,
          priorIndeterminate: indeterminateEncountered
        };
      }
      continue;
    }

    // 4. 域名后缀匹配 DOMAIN-SUFFIX
    if (item.type === 'DOMAIN-SUFFIX') {
      if (!isIp) {
        const dLower = trimmed.toLowerCase();
        const sLower = item.value.toLowerCase();
        if (dLower === sLower || dLower.endsWith('.' + sLower)) {
          return {
            success: true,
            status: 'matched',
            input: trimmed,
            ruleIndex: index + 1,
            sourceIndex: item.sourceIndex + 1,
            rule: item,
            target: item.target,
            matchType: 'DOMAIN-SUFFIX',
            matchedValue: item.value,
            reason: `域名 ${trimmed} 匹配后缀 ${item.value}`,
            priorIndeterminate: indeterminateEncountered
          };
        }
      }
      continue;
    }

    // 5. 域名关键字匹配 DOMAIN-KEYWORD
    if (item.type === 'DOMAIN-KEYWORD') {
      if (!isIp && trimmed.toLowerCase().includes(item.value.toLowerCase())) {
        return {
          success: true,
          status: 'matched',
          input: trimmed,
          ruleIndex: index + 1,
          sourceIndex: item.sourceIndex + 1,
          rule: item,
          target: item.target,
          matchType: 'DOMAIN-KEYWORD',
          matchedValue: item.value,
          reason: `域名 ${trimmed} 包含关键字 ${item.value}`,
          priorIndeterminate: indeterminateEncountered
        };
      }
      continue;
    }

    // 6. 无法确定的条件规则 (必须如实标注，绝不凭猜想或后缀草率判定)
    if (item.type === 'GEOIP') {
      indeterminateEncountered.push({
        ruleIndex: index + 1,
        rule: item,
        reason: `GEOIP:${item.value} 需本地 MaxMind/GeoIP 离线数据库查询目标 IP 归属国`
      });
      continue;
    }

    if (item.type === 'GEOSITE' || item.type === 'RULE-SET') {
      const isGeosite = item.type === 'GEOSITE';
      if (isGeosite && isIp) continue;
      const managedRule = providers.get(item.value);
      const entries = isGeosite ? legacyPublicRules?.get(item.value.toLowerCase()) : managedRule?.publicSet.entries;
      if (entries) {
        const match = !isIp && matchPublicDomain(domain, entries);
        if (!match) continue;
        return {
          success: true, status: 'matched', input: trimmed, ruleIndex: index + 1,
          sourceIndex: item.sourceIndex + 1, rule: item, target: item.target,
          matchType: item.type, matchedValue: match, publicRuleId: managedRule?.value || item.value,
          reason: `域名 ${trimmed} 匹配公共规则 ${match}`, priorIndeterminate: indeterminateEncountered
        };
      }
      indeterminateEncountered.push({
        ruleIndex: index + 1,
        rule: item,
        reason: `需核对 ${item.value} 规则集`
      });
      continue;
    }

    // 7. MATCH 最终兜底规则
    if (item.type === 'MATCH') {
      if (indeterminateEncountered.length > 0) {
        // 如果前面有待定规则，必须如实警示
        return {
          success: true,
          status: 'fallback_with_uncertainty',
          input: trimmed,
          ruleIndex: index + 1,
          sourceIndex: item.sourceIndex + 1,
          rule: item,
          target: item.target,
          matchType: 'MATCH',
          matchedValue: '(兜底)',
          reason: `当前按顺序到达 MATCH 兜底 [${item.target}]，但规则链前序存在 ${indeterminateEncountered.length} 条待定规则（如 GEOSITE / GEOIP），需外部数据方可最终确认`,
          priorIndeterminate: indeterminateEncountered
        };
      }

      return {
        success: true,
        status: 'matched',
        input: trimmed,
        ruleIndex: index + 1,
        sourceIndex: item.sourceIndex + 1,
        rule: item,
        target: item.target,
        matchType: 'MATCH',
        matchedValue: '(兜底)',
        reason: `未被任何前置规则拦截，确定命中末尾兜底规则 [${item.displayRule}]`,
        priorIndeterminate: []
      };
    }
  }

  return {
    success: false,
    status: 'unmatched',
    input: trimmed,
    message: '未能命中任何规则，规则链中缺少 MATCH 兜底',
    priorIndeterminate: indeterminateEncountered
  };
}

// 实时对比草稿与已发布版本
function compareEvaluation(inputStr, draftProfile, publishedProfile, companySubnets, publishedRules, legacyPublicRules) {
  const draftResult = evaluateTarget(inputStr, draftProfile, companySubnets, undefined, legacyPublicRules);
  const publishedResult = evaluateTarget(inputStr, publishedProfile, companySubnets, publishedRules, legacyPublicRules);

  const hasDiff = draftResult.target !== publishedResult.target ||
                  draftResult.ruleIndex !== publishedResult.ruleIndex ||
                  draftResult.status !== publishedResult.status ||
                  draftResult.rule?.displayRule !== publishedResult.rule?.displayRule;

  return {
    input: inputStr,
    draft: draftResult,
    published: publishedResult,
    hasDiff: hasDiff
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    evaluateTarget,
    compareEvaluation,
    expandEffectiveRules,
    isIpInCidr,
    isIpv6InCidr,
    publicRuleProviderKey
  };
}
