// Compare configuration content while keeping rule and policy priority order.
(function (root) {
  function profileContentKey(profile) {
    if (!profile) return null;
    const { id, updatedAt, publishedAt, publishedVersion, hasDraft, hasPendingSourceChanges, hasPendingConfiguration, revision, groupDeletionTargets, ...content } = profile;
    content.groups = (content.groups || []).map(group => {
      const { extra, toleranceHint, probeUrlHint, emptyFallbackHint, ...fields } = group;
      const { excluded, ...options } = group.options || {};
      if (excluded?.length) options.excluded = excluded;
      return extra && Object.keys(extra).length ? { ...fields, options, extra } : { ...fields, options };
    });
    return JSON.stringify(content, (_, value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    });
  }

  function policyRuleTarget(rule) {
    if (rule.type !== 'RAW' || typeof rule.value !== 'string') return rule.target;
    const parts = rule.value.split(',');
    return parts.at(parts.at(-1)?.trim() === 'no-resolve' ? -2 : -1)?.trim();
  }

  function isMatchRule(rule) {
    return rule.type === 'MATCH' || (rule.type === 'RAW' && typeof rule.value === 'string' &&
      rule.value.split(',')[0].trim() === 'MATCH');
  }

  function dnsUsesPolicy(value, name) {
    if (typeof value === 'string') return value.split('#')[1]?.split('&')[0] === name;
    return value && typeof value === 'object' && Object.values(value).some(child => dnsUsesPolicy(child, name));
  }

  function deletePolicyGroup(profile, id, replacement) {
    const { name } = profile.groups.find(group => group.id === id);
    profile.groups = profile.groups.filter(group => group.id !== id);
    for (const group of profile.groups) {
      group.members = (group.members || []).filter(member => member !== name);
      for (const key of ['excluded', 'priority']) {
        if (Array.isArray(group.options?.[key])) group.options[key] = group.options[key].filter(member => member !== name);
      }
    }
    profile.rules = (profile.rules || []).filter(rule => policyRuleTarget(rule) !== name ||
      (replacement && rule.enabled !== false && isMatchRule(rule)));
    if (replacement) {
      retargetGroupReferences(profile, new Map([[name, replacement]]));
      profile.groupDeletionTargets = { ...profile.groupDeletionTargets, [name]: replacement };
    } else if (profile.groupDeletionTargets) {
      profile.groupDeletionTargets = Object.fromEntries(Object.entries(profile.groupDeletionTargets)
        .filter(([, target]) => target !== name));
    }
    return profile;
  }

  function retargetGroupReferences(profile, renames) {
    const target = name => renames.get(name) ?? name;
    for (const group of profile.groups || []) {
      if (Array.isArray(group.members)) group.members = group.members.map(target);
      for (const key of ['excluded', 'priority']) {
        if (Array.isArray(group.options?.[key])) group.options[key] = group.options[key].map(target);
      }
      for (const fields of [group.options, group.extra]) {
        if (fields?.['empty-fallback']) fields['empty-fallback'] = target(fields['empty-fallback']);
      }
      if (group.emptyFallbackHint) group.emptyFallbackHint = target(group.emptyFallbackHint);
    }
    for (const rule of profile.rules || []) {
      if (renames.has(rule.target)) rule.target = target(rule.target);
      if (rule.type === 'RAW' && typeof rule.value === 'string') {
        const parts = rule.value.split(',');
        const index = parts.length - (parts.at(-1)?.trim() === 'no-resolve' ? 2 : 1);
        if (index > 0 && renames.has(parts[index].trim())) {
          parts[index] = target(parts[index].trim());
          rule.value = parts.join(',');
          rule.target = parts[index];
        }
      }
    }
    for (const node of profile.nodes || []) {
      if (renames.has(node['dialer-proxy'])) node['dialer-proxy'] = target(node['dialer-proxy']);
    }
    if (profile.customNodeDialers) {
      profile.customNodeDialers = Object.fromEntries(Object.entries(profile.customNodeDialers)
        .map(([name, dialer]) => [name, target(dialer)]));
    }
    if (profile.groupDeletionTargets) {
      profile.groupDeletionTargets = Object.fromEntries(Object.entries(profile.groupDeletionTargets)
        .map(([name, replacement]) => [name, target(replacement)]));
    }
    function dnsTarget(value) {
      if (Array.isArray(value)) return value.map(dnsTarget);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, dnsTarget(child)]));
      }
      if (typeof value !== 'string') return value;
      const fragment = value.indexOf('#');
      if (fragment < 0) return value;
      const options = value.slice(fragment + 1).split('&');
      if (!renames.has(options[0])) return value;
      options[0] = target(options[0]);
      return value.slice(0, fragment + 1) + options.join('&');
    }
    if (profile.network?.dns) profile.network.dns = dnsTarget(profile.network.dns);
    return profile;
  }

  function reconcileGroupNames(profile, ...baselines) {
    const names = new Map((profile.groups || []).filter(group => group.id).map(group => [group.id, group.name]));
    const activeNames = new Set([...(profile.groups || []).map(group => group.name),
      ...(profile.nodes || []).map(node => node.name)]);
    const renames = new Map();
    for (const baseline of baselines) {
      for (const { id, name } of baseline?.groups || []) {
        if (name && !activeNames.has(name) && names.get(id)) renames.set(name, names.get(id));
      }
    }
    return renames.size ? retargetGroupReferences(structuredClone(profile), renames) : profile;
  }

  const api = { profileContentKey, retargetGroupReferences, reconcileGroupNames, policyRuleTarget,
    isMatchRule, dnsUsesPolicy, deletePolicyGroup };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(globalThis);
