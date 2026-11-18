// app.js
// 中文订阅工作台核心前端交互逻辑 (Impeccable Operate 模式精修版)

(function() {
  'use strict';

  // 全局状态
  const state = {
    data: null,
    savedProfiles: new Map(),
    history: null,
    historyRequest: null,
    catalog: null,
    catalogRequest: null,
    publishedSnapshots: new Map(),
    publishedRequests: new Map(),
    profileWrites: new Set(),
    currentProfileId: 'desktop',
    currentView: 'groups',
    selectedGroupId: null,
    groupViewMode: 'card',
    groupSort: 'config',
    groupDisplay: 'all',
    groupSourceOpen: new Map(),
    groupTab: 'nodes',
    expandedSources: new Set(),
    sourceSort: 'latency',
    probeJobs: [],
    groupProbeRuns: new Map(),
    groupProbeResults: new Map(),
    probeTasks: new Map(),
    probeStarting: new Map(),
    ruleSearchQuery: '',
    publicRuleSearchQuery: '',
    publicRuleDetails: new Map(),
    publicRuleRequests: new Map(),
    selectedPublicRuleIds: new Set(),
    ruleTestInput: 'gemini.google.com'
  };
  try {
    if (localStorage.getItem('workbench.sourceSort') === 'original') state.sourceSort = 'original';
  } catch { /* Keep the default when browser storage is unavailable. */ }

  // DOM 元素引用
  const el = {
    profileSelect: document.getElementById('profileSelect'),
    versionBadge: document.getElementById('versionBadge'),
    draftBadge: document.getElementById('draftBadge'),
    discardDraftBtn: document.getElementById('discardDraftBtn'),
    saveDraftBtn: document.getElementById('saveDraftBtn'),
    validateBtn: document.getElementById('validateBtn'),
    reviewChangesBtn: document.getElementById('reviewChangesBtn'),
    publishBtn: document.getElementById('publishBtn'),
    subExportBtn: document.getElementById('subExportBtn'),
    mainStage: document.getElementById('mainStage'),
    toastContainer: document.getElementById('toastContainer'),
    modalContainer: document.getElementById('modalContainer'),
    mobileViewSelect: document.getElementById('mobileViewSelect'),
    navItems: document.querySelectorAll('.nav-item'),
    navCounts: {
      groups: document.getElementById('navGroupsCount'),
      rules: document.getElementById('navRulesCount'),
      publicRules: document.getElementById('navPublicRulesCount'),
      sources: document.getElementById('navSourcesCount'),
      history: document.getElementById('navHistoryCount'),
    }
  };

  // 1. 数据加载与初始化
  async function loadData() {
    try {
      const res = await fetch('/api/data?view=bootstrap');
      if (!res.ok) {
        throw new Error(`无法获取工作台数据 (HTTP ${res.status})`);
      }
      state.data = await res.json();
      // Older servers return the full response for the compact URL.
      state.catalog = state.data.publicRuleLibrary || null;
      invalidateHistory();
      if (state.data.history) {
        state.history = state.data.history;
        for (const [id, versions] of Object.entries(state.history)) {
          for (const snapshot of versions) state.publishedSnapshots.set(`${id}:${snapshot.version}`, snapshot);
        }
      }
      state.data.historyCounts ||= Object.fromEntries(Object.entries(state.history || {}).map(([id, versions]) => [id, versions.length]));
      state.savedProfiles = new Map(state.data.profiles.map(profile => [profile.id, structuredClone(profile)]));
    } catch {
      el.mainStage.innerHTML = '<div class="empty-message" role="alert">暂时无法加载工作台数据。 <button id="retryData" class="btn btn-default btn-sm">重试</button></div>';
      el.mainStage.querySelector('#retryData').onclick = loadData;
      return;
    }

    initProfileSelect();
    updateTopbarBadges();
    renderCurrentView();
  }

  function getCurrentProfile() {
    if (!state.data || !state.data.profiles) return null;
    return state.data.profiles.find(p => p.id === state.currentProfileId) || state.data.profiles[0];
  }

  async function readViewData(path, fallback) {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) throw new Error(fallback);
    return response.json();
  }

  function ensureCatalog() {
    if (state.catalog) return Promise.resolve(state.catalog);
    state.catalogRequest ||= readViewData('/api/public-rules', '暂时无法读取公共规则库。')
      .then(data => (state.catalog = data.publicRuleLibrary))
      .finally(() => { state.catalogRequest = null; });
    return state.catalogRequest;
  }

  function invalidateHistory() {
    state.history = null;
    state.historyRequest = null;
  }

  function ensureHistory() {
    if (state.history) return Promise.resolve(state.history);
    if (!state.historyRequest) {
      const request = readViewData('/api/history', '暂时无法读取版本历史。').then(data => {
        if (state.historyRequest !== request) return ensureHistory();
        state.history = data.history;
        state.data.historyCounts = Object.fromEntries(Object.entries(data.history).map(([id, versions]) => [id, versions.length]));
        updateTopbarBadges();
        return state.history;
      }).finally(() => { if (state.historyRequest === request) state.historyRequest = null; });
      state.historyRequest = request;
    }
    return state.historyRequest;
  }

  function getPublishedSnapshot(profile) {
    return state.publishedSnapshots.get(`${profile.id}:${profile.publishedVersion}`);
  }

  function ensurePublishedSnapshot(profile) {
    const key = `${profile.id}:${profile.publishedVersion}`;
    const version = profile.publishedVersion;
    if (!version || getPublishedSnapshot(profile)) return Promise.resolve(getPublishedSnapshot(profile));
    if (!state.publishedRequests.has(key)) {
      const request = readViewData(`/api/profile/published?profileId=${encodeURIComponent(profile.id)}`, '暂时无法读取当前发布版本。')
        .then(({ snapshot }) => {
          if (snapshot.version !== version) throw new Error('当前发布版本已变化，请刷新页面。');
          state.publishedSnapshots.set(key, snapshot);
          return snapshot;
        }).finally(() => state.publishedRequests.delete(key));
      state.publishedRequests.set(key, request);
    }
    return state.publishedRequests.get(key);
  }

  function renderDeferred(container, message, load, render) {
    const status = document.createElement('div');
    status.className = 'empty-message';
    status.setAttribute('role', 'status');
    status.textContent = message;
    container.replaceChildren(status);
    load().then(() => {
      if (status.isConnected) render();
    }).catch(error => {
      if (!status.isConnected) return;
      status.textContent = error.message || '加载失败。';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-default btn-sm';
      retry.textContent = '重试';
      retry.onclick = () => renderDeferred(container, message, load, render);
      status.append(' ', retry);
    });
  }

  function initProfileSelect() {
    if (!state.data || !state.data.profiles) return;
    el.profileSelect.innerHTML = '';
    state.data.profiles.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === state.currentProfileId) opt.selected = true;
      el.profileSelect.appendChild(opt);
    });
  }

  function getEditState(profile) {
    const saved = state.savedProfiles.get(profile.id) || profile;
    const currentKey = profileContentKey(profile);
    const savedKey = profileContentKey(saved);
    const published = getPublishedSnapshot(profile)?.profile || state.data.publishedBaselines?.[profile.id];
    const publishedKey = profileContentKey(published);
    const dirty = currentKey !== savedKey;
    const issued = Boolean(profile.publishedVersion);
    const pending = !issued || (typeof saved.hasPendingConfiguration === 'boolean'
      ? dirty || saved.hasPendingConfiguration
      : saved.hasPendingSourceChanges || (publishedKey
      ? currentKey !== publishedKey || (saved.hasDraft && savedKey === publishedKey)
      : dirty || saved.hasDraft));
    return { saved, dirty, issued, pending, discardSaved: issued && saved.hasDraft && pending };
  }

  function rememberProfile(profile) {
    state.savedProfiles.set(profile.id, structuredClone(profile));
  }

  function acceptSavedProfile(current, saved) {
    rememberProfile(saved);
    for (const key of ['hasDraft', 'hasPendingSourceChanges', 'hasPendingConfiguration', 'updatedAt', 'publishedVersion', 'publishedAt', 'revision']) {
      if (Object.hasOwn(saved, key)) current[key] = saved[key];
    }
  }

  function replaceProfile(profile) {
    rememberProfile(profile);
    const index = state.data.profiles.findIndex(item => item.id === profile.id);
    state.data.profiles[index] = profile;
  }

  function updateTopbarBadges() {
    const prof = getCurrentProfile();
    if (!prof) return;

    const focus = document.activeElement;
    const { saved, dirty, issued, pending, discardSaved } = getEditState(prof);
    const busy = state.profileWrites.has(prof.id);
    el.versionBadge.hidden = false;
    el.versionBadge.textContent = issued ? `v${prof.publishedVersion}` : '未发布';
    el.draftBadge.hidden = !dirty && !pending;
    el.draftBadge.textContent = dirty ? '有未保存的修改' : pending
      ? saved.hasPendingSourceChanges && !saved.hasDraft ? '配置待发布' : '草稿已保存' : '';
    el.draftBadge.className = `badge ${dirty ? 'badge-draft' : 'badge-clean'}`;

    el.saveDraftBtn.hidden = !dirty;
    el.reviewChangesBtn.hidden = !state.data.draftReviewAvailable || !pending || !issued;
    el.publishBtn.hidden = !pending;
    const publishLabel = issued ? '发布新版' : '首次发布';
    el.publishBtn.querySelector('span').textContent = publishLabel;
    el.publishBtn.setAttribute('aria-label', publishLabel);
    el.validateBtn.hidden = !pending;
    el.subExportBtn.hidden = !issued;
    el.discardDraftBtn.hidden = !dirty && !discardSaved;
    const discardLabel = discardSaved ? '放弃草稿' : '撤销修改';
    el.discardDraftBtn.querySelector('span').textContent = discardLabel;
    el.discardDraftBtn.title = discardSaved ? '回到当前发布版本' : '回到上次保存的内容';
    const actions = [el.saveDraftBtn, el.reviewChangesBtn, el.publishBtn, el.discardDraftBtn, el.validateBtn, el.subExportBtn];
    for (const button of actions) button.disabled = busy && button !== el.subExportBtn;
    const visibleActions = actions.filter(button => !button.hidden).length;
    const actionBar = el.saveDraftBtn.closest('.topbar-right');
    actionBar.hidden = visibleActions === 0;
    actionBar.closest('.topbar').classList.toggle('has-one-action', visibleActions === 1);
    if (actions.includes(focus) && focus.hidden) {
      (actions.find(button => !button.hidden && !button.disabled) || el.profileSelect).focus({ preventScroll: true });
    }

    if (el.navCounts.groups) el.navCounts.groups.textContent = (prof.groups || []).length;
    if (el.navCounts.rules) el.navCounts.rules.textContent = (prof.rules || []).length;
    if (el.navCounts.publicRules) el.navCounts.publicRules.textContent = state.data.publicRuleCount ?? state.catalog?.length ?? 0;
    if (el.navCounts.sources) el.navCounts.sources.textContent = (state.data.sources || []).length;
    if (el.navCounts.history) el.navCounts.history.textContent = state.data.historyCounts[prof.id] || 0;
  }

  function showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.textContent = msg;

    el.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(6px)';
      setTimeout(() => toast.remove(), 250);
    }, 3200);
  }

  // ========================================================
  // 核心功能：保存草稿、放弃、发布、回滚、校验 (绝不掩盖错误)
  // ========================================================

  function draftUpdates(profile) {
    const { groups, rules, network, hosts, sourceIds, name, customNodeDialers } = profile;
    return { groups, rules, network, hosts, sourceIds, name, customNodeDialers };
  }

  async function saveDraft() {
    const prof = getCurrentProfile();
    if (!prof || !getEditState(prof).dirty || state.profileWrites.has(prof.id)) return;
    const requestedKey = profileContentKey(prof);
    state.profileWrites.add(prof.id);
    updateTopbarBadges();

    try {
      const res = await fetch('/api/profile/save-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: prof.id,
          revision: prof.revision,
          updates: draftUpdates(prof)
        })
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `保存失败 (HTTP ${res.status})`);
      }

      if (profileContentKey(prof) === requestedKey) prof.customNodeDialers = json.profile.customNodeDialers;
      prof.nodes = json.profile.nodes;
      acceptSavedProfile(prof, json.profile);
      const { dirty, pending } = getEditState(prof);
      if (dirty) showToast('已保存，另有未保存的修改', 'info');
      else if (!pending) showToast('已恢复至发布版本', 'success');
      else if (getCurrentProfile()?.id !== prof.id) showToast(`${prof.name} 草稿已保存`, 'success');
    } catch (err) {
      // 绝对不伪造成功！明确告诉用户保存失败并保留其输入
      showToast(`保存草稿失败: ${err.message}`, 'error');
    } finally {
      state.profileWrites.delete(prof.id);
      updateTopbarBadges();
    }
  }

  async function discardDraft() {
    const prof = getCurrentProfile();
    if (!prof || state.profileWrites.has(prof.id)) return;
    const { saved, dirty, discardSaved } = getEditState(prof);
    if (!dirty && !discardSaved) return;
    if (!discardSaved) {
      if (!confirm('撤销这次未保存的修改？')) return;
      replaceProfile(structuredClone(saved));
      updateTopbarBadges();
      renderCurrentView();
      return;
    }
    if (!confirm('放弃草稿并回到当前发布版本？')) return;
    const requestedKey = profileContentKey(prof);
    state.profileWrites.add(prof.id);
    updateTopbarBadges();

    try {
      const res = await fetch('/api/profile/discard-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: prof.id, revision: prof.revision })
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `放弃草稿失败 (HTTP ${res.status})`);
      }

      if (profileContentKey(prof) === requestedKey) replaceProfile(json.profile);
      else acceptSavedProfile(prof, json.profile);
      if (getCurrentProfile()?.id === prof.id) renderCurrentView();
      showToast('已放弃草稿', 'info');
    } catch (err) {
      showToast(`放弃草稿失败: ${err.message}`, 'error');
    } finally {
      state.profileWrites.delete(prof.id);
      updateTopbarBadges();
    }
  }

  // 一并提交当前编辑进行服务端校验与原子发布
  async function publishProfile() {
    const prof = getCurrentProfile();
    if (!prof || !getEditState(prof).pending || state.profileWrites.has(prof.id)) return;

    // 前端初筛校验
    const validation = validateProfile(prof);
    if (!validation.valid) {
      showToast(`发布阻止: ${validation.errors[0]}`, 'error');
      return;
    }

    state.profileWrites.add(prof.id);
    updateTopbarBadges();
    try {
      const res = await fetch('/api/profile/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: prof.id,
          revision: prof.revision,
          currentProfile: prof // 保证将当前编辑原子提交
        })
      });

      const json = await res.json();
      if (!res.ok) {
        const detailMsg = json.details ? ` (${json.details.join('; ')})` : '';
        throw new Error((json.error || '发布失败') + detailMsg);
      }

      acceptSavedProfile(prof, json.profile);

      state.publishedSnapshots.set(`${prof.id}:${json.version}`, {
        version: json.version,
        publishedAt: json.publishedAt,
        profile: json.profile,
        effectiveRules: json.effectiveRules,
        nodeCount: json.nodeCount
      });
      invalidateHistory();
      state.data.historyCounts[prof.id] = (state.data.historyCounts[prof.id] || 0) + 1;

      if (getCurrentProfile()?.id === prof.id) renderCurrentView();
      showToast(`已发布 v${json.version}`, 'success');
    } catch (err) {
      // 失败保留输入并明确报错
      showToast(`发布失败: ${err.message}`, 'error');
    } finally {
      state.profileWrites.delete(prof.id);
      updateTopbarBadges();
    }
  }

  // 本地完整性校验 (支持策略组、内置节点与内置目标)
  function validateProfile(prof) {
    const errors = [];
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
        errors.push(`规则 [${r.type}, ${r.value || ''}] 目标不存在: "${r.target}"`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  // ========================================================
  // 视图渲染分发
  // ========================================================

  function renderCurrentView() {
    el.mainStage.innerHTML = '';
    switch (state.currentView) {
      case 'groups':
        renderGroupsView();
        break;
      case 'rules':
        renderRulesView();
        break;
      case 'public-rules':
        renderPublicRulesView();
        break;
      case 'sources':
        renderSourcesView();
        break;
      case 'history':
        renderHistoryView();
        break;
      case 'network':
        renderNetworkView();
        break;
      case 'profiles':
        renderProfilesManageView();
        break;
      default:
        renderGroupsView();
    }
  }

  // ========================================================
  // 视图 1：策略组管理 (AI固定出口、排除置底、调整排序)
  // ========================================================

  function renderGroupsView() {
    el.mainStage.innerHTML = '';
    refreshGroupProbeView = null;
    const prof = getCurrentProfile();
    if (!prof) return;

    const groups = prof.groups || [];
    if (!state.selectedGroupId && groups.length > 0) {
      state.selectedGroupId = groups[0].id;
    }

    const currentGroup = groups.find(g => g.id === state.selectedGroupId) || groups[0];
    const container = document.createElement('div');
    container.className = 'group-management-layout';

    // 左侧：策略组列表
    const listCol = document.createElement('div');
    listCol.className = 'group-list-col';
    listCol.innerHTML = `
      <div class="panel-header">
        <span class="panel-title desktop-group-title">策略组 (${groups.length})</span>
        <select id="mobileGroupSelect" class="input-text mobile-group-select" aria-label="选择策略组" ${groups.length ? '' : 'disabled'}>
          ${groups.length ? groups.map(g => `<option value="${escapeHtml(g.id)}" ${g.id === currentGroup?.id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join('') : '<option>暂无策略组</option>'}
        </select>
        <button id="addGroupBtn" class="btn btn-default btn-sm" title="新建策略组">+ 新建</button>
      </div>
      <div class="group-items-scroll" id="groupListScroll"></div>
    `;

    const scrollBox = listCol.querySelector('#groupListScroll');
    groups.forEach(g => {
      const row = document.createElement('div');
      row.className = `group-row ${g.id === currentGroup?.id ? 'active' : ''}`;
      row.tabIndex = 0;
      row.innerHTML = `
        <div class="group-row-left">
          <span class="group-row-name">${escapeHtml(g.name)}</span>
        </div>
        <span class="group-type-badge type-${g.type}">${g.type}</span>
      `;
      const selectThisGroup = () => {
        state.selectedGroupId = g.id;
        renderGroupsView();
      };
      row.onclick = selectThisGroup;
      row.onkeydown = (e) => {
        if (e.key === 'Enter') {
          selectThisGroup();
        }
      };
      scrollBox.appendChild(row);
    });

    listCol.querySelector('#mobileGroupSelect').onchange = event => {
      state.selectedGroupId = event.target.value;
      renderGroupsView();
      el.mainStage.querySelector('#mobileGroupSelect').focus({ preventScroll: true });
    };

    listCol.querySelector('#addGroupBtn').onclick = () => openGroupSetup(prof);

    // 右侧：当前组详情与候选节点管理
    const detailCol = document.createElement('div');
    detailCol.className = 'group-detail-col';

    if (currentGroup) {
      const { candidates, natural, excludedNodes, sourcesByNode } = computeGroupCandidates(currentGroup, prof);
      const showRules = state.groupTab === 'rules';
      const ruleCount = (prof.rules || []).filter(rule => rule.target === currentGroup.name).length;
      const hasSubscription = [...candidates, ...excludedNodes].some(node => sourcesByNode.has(node.name));
      const priorityKey = `${prof.id}:${currentGroup.id}`;
      const editablePriority = candidates.length > 1 && currentGroup.type !== 'url-test';
      const canProbe = state.data.groupProbeAvailable && candidates.length;
      const targetInput = () => currentGroup.options?.url ?? currentGroup.probeUrlHint ?? '';
      const defaultUrl = state.data.defaultProbeUrl || 'https://www.gstatic.com/generate_204';
      const activeUrl = () => targetInput() || defaultUrl;
      const probeKey = () => JSON.stringify([prof.id, currentGroup.id, activeUrl(), prof.revision,
        candidates.map(node => [node.name, sourcesByNode.get(node.name)?.updatedAt])]);
      const measurementForGroup = node => {
        const current = state.groupProbeResults.get(probeKey())?.get(node.name);
        if (!current) return activeUrl() === defaultUrl ? node.measurement : null;
        return { ...node.measurement, ...current };
      };

      detailCol.innerHTML = `
        <div class="group-detail-header">
          <div class="group-fields">
            <input type="text" id="groupNameInput" class="input-text" value="${escapeHtml(currentGroup.name)}" aria-label="策略组名称" />
            <select id="groupTypeSelect" class="input-text" aria-label="策略组类型">
              <option value="select" ${currentGroup.type === 'select' ? 'selected' : ''}>手动选择 (select)</option>
              <option value="fallback" ${currentGroup.type === 'fallback' ? 'selected' : ''}>故障回退 (fallback)</option>
              <option value="url-test" ${currentGroup.type === 'url-test' ? 'selected' : ''}>自动测速 (url-test)</option>
            </select>
            ${currentGroup.type === 'url-test' ? `<label class="group-tolerance">
              <span>节点切换容差</span>
              <input id="groupTolerance" class="input-text" type="number" min="0" max="65535" step="1" required
                value="${escapeHtml(String(currentGroup.options?.tolerance ?? currentGroup.toleranceHint ?? 50))}">
              <span>ms</span>
            </label>` : ''}
          </div>
          <div class="group-toolbar">
            ${!showRules && candidates.length + excludedNodes.length > 1 ? `<div class="group-view-switch" role="group" aria-label="节点显示方式">
              <button id="viewModeList" aria-pressed="${state.groupViewMode === 'list'}" class="btn btn-sm ${state.groupViewMode === 'list' ? 'btn-primary' : 'btn-subtle'}">列表</button>
              <button id="viewModeCard" aria-pressed="${state.groupViewMode === 'card'}" class="btn btn-sm ${state.groupViewMode === 'card' ? 'btn-primary' : 'btn-subtle'}">卡片</button>
            </div>` : ''}
            <button id="deleteGroupBtn" class="btn btn-danger btn-sm">删除此组</button>
          </div>
        </div>

        <div class="group-tabs" role="group" aria-label="策略组内容">
          <button type="button" class="group-tab" data-group-tab="nodes" aria-pressed="${!showRules}">节点 <span>${candidates.length}</span></button>
          <button type="button" class="group-tab" data-group-tab="rules" aria-pressed="${showRules}">规则 <span>${ruleCount}</span></button>
        </div>
        ${showRules ? '<div class="group-detail-content" id="groupRulesPanel"></div>' : `
        <div class="group-detail-content">
          <div class="candidates-section">
            <div class="candidates-toolbar">
              <h2 class="panel-title">候选节点</h2>
              <div class="group-candidate-actions">
                ${hasSubscription ? `<select id="groupNodeDisplay" class="input-text source-sort" aria-label="节点分组方式">
                  <option value="all">全部</option>
                  <option value="source">按来源</option>
                </select>` : ''}
                ${candidates.length > 1 ? `<select id="groupNodeSort" class="input-text source-sort" aria-label="组内节点排序">
                  <option value="config">配置顺序</option>
                  <option value="latency">延迟优先</option>
                </select>` : ''}
                <div class="group-probe-actions" role="group" aria-label="组内测速">
                  ${canProbe ? `<button type="button" id="probeGroupBtn" class="btn btn-default btn-sm probe-all" aria-label="测速当前组">${speedIcon}<span>测速</span></button>` : ''}
                  <button type="button" id="groupProbeSettings" class="btn btn-default btn-sm" aria-haspopup="dialog" aria-label="测速设置" title="测速设置">
                    ${canProbe ? '<span class="probe-settings-chevron" aria-hidden="true"></span>' : '测速设置'}
                  </button>
                </div>
                ${editablePriority ? '<button type="button" id="editGroupPriority" class="btn btn-subtle btn-sm">编辑优先级</button><span id="groupPrioritySelection" role="status" hidden></span><button type="button" id="moveSelectedPriority" class="btn btn-default btn-sm" hidden>移动所选</button><button type="button" id="cancelGroupPriority" class="btn btn-default btn-sm" hidden>取消</button><button type="button" id="applyGroupPriority" class="btn btn-primary btn-sm" hidden>应用到草稿</button>' : ''}
                ${candidates.length ? nodeBulkActions('exclude') : ''}
                <button type="button" id="addManualMemberBtn" class="btn btn-default btn-sm">配置候选</button>
              </div>
            </div>

            ${editablePriority ? '<p id="groupPriorityHint" class="group-priority-hint" hidden><span class="priority-mouse-hint">Shift 连选 · ⌘/Ctrl 增减 · 拖动已选卡片调整顺序</span><span class="priority-touch-hint">轻点多选 · 长按已选卡片拖动</span></p>' : ''}
            ${candidates.length ? nodeSelectionHint('exclude') : ''}
            <div id="candidatesContainer" class="${state.groupViewMode === 'card' ? 'candidate-card-grid' : 'candidate-list'}"></div>
            ${candidates.length ? '' : `<p class="empty-message">${excludedNodes.length ? '暂无候选节点，可恢复下方已排除的节点。' : '暂无候选节点。'}</p>`}
          </div>

          ${excludedNodes.length > 0 ? `
            <div class="candidates-section" style="margin-top: 14px; border-top: 1px dashed var(--border-subtle); padding-top: 14px;">
              <div class="candidates-toolbar">
                <span class="panel-title">已排除 (${excludedNodes.length})</span>
                <div class="group-candidate-actions">${nodeBulkActions('restore')}</div>
              </div>
              ${nodeSelectionHint('restore')}
              <div id="excludedContainer" class="${state.groupViewMode === 'card' ? 'candidate-card-grid' : 'candidate-list'}"></div>
            </div>
          ` : ''}
        </div>`}
      `;

      detailCol.querySelectorAll('[data-group-tab]').forEach(button => {
        button.onclick = () => {
          if (state.groupTab === button.dataset.groupTab) return;
          state.groupTab = button.dataset.groupTab;
          renderGroupsView();
          el.mainStage.querySelector(`[data-group-tab="${state.groupTab}"]`)?.focus({ preventScroll: true });
        };
      });
      if (showRules) {
        renderGroupRules(detailCol.querySelector('#groupRulesPanel'), currentGroup, prof);
      } else {
        const candBox = detailCol.querySelector('#candidatesContainer');
        const candidateCards = new Map();
        const cards = [];
        const viewClass = candBox.className;
        const orderedNames = candidates.map(node => node.name);
        const candidatesByName = new Map(candidates.map(node => [node.name, node]));
        const priorityButton = detailCol.querySelector('#editGroupPriority');
        const applyButton = detailCol.querySelector('#applyGroupPriority');
        const cancelButton = detailCol.querySelector('#cancelGroupPriority');
        const excludedBox = detailCol.querySelector('#excludedContainer');
        let bulkMode = null;
        const bulkSelection = new Set();
        let stagedOrder = null;
        let positionEditor = null;
        const selected = new Set();
        const applyPriority = ordered => {
          currentGroup.options ||= {};
          if (ordered.every((item, index) => item === natural[index].name)) delete currentGroup.options.priority;
          else currentGroup.options.priority = ordered;
          updateTopbarBadges();
          renderGroupsView();
        };
        const move = (name, position) => {
          const ordered = [...orderedNames];
          ordered.splice(ordered.indexOf(name), 1);
          ordered.splice(position, 0, name);
          applyPriority(ordered);
          findGroupNode(name)?.querySelector('.node-more')?.focus({ preventScroll: true });
        };
        candidates.forEach((node, index) => {
          const card = createNodeElement(node, currentGroup, index, candidates.length, false, sourcesByNode.get(node.name), move, prof,
            canProbe ? () => testGroup(node.name) : null);
          cards.push(card);
          candidateCards.set(node.name, card);
        });

        if (excludedBox) {
          excludedNodes.forEach(node => {
            const card = createNodeElement(node, currentGroup, -1, candidates.length, true, sourcesByNode.get(node.name), move, prof);
            cards.push(card);
            candidateCards.set(node.name, card);
          });
        }

        let arranged;
        const resetBulkSelection = [candBox, excludedBox].filter(Boolean).map(box => {
          const reset = bindNodeSelection(box, '[data-bulk-node]', '.node-item', (names, checked) => {
            setNodeSelection(bulkSelection, names, checked);
            renderBulkMode();
          });
          box.addEventListener('toggle', event => {
            if (event.target.matches('.group-source-section')) reset();
          }, true);
          return reset;
        });
        function resetBulkAnchor() {
          resetBulkSelection.forEach(reset => reset());
        }
        function arrangeCandidates() {
          const ordered = stagedOrder ? stagedOrder.map(name => candidatesByName.get(name))
            : state.groupSort === 'latency' ? orderByLatency(candidates.map(node => ({ ...node, measurement: measurementForGroup(node) }))) : candidates;
          const grouped = !stagedOrder && hasSubscription && state.groupDisplay === 'source';
          const signature = JSON.stringify([Boolean(stagedOrder), grouped, ...ordered.map(node => node.name)]);
          if (signature === arranged) return;
          arranged = signature;
          resetBulkAnchor();
          const focus = document.activeElement;
          const restoreFocus = candBox.contains(focus);
          function arrangeRegion(box, entries, suffix) {
            const result = document.createDocumentFragment();
            if (!grouped) {
              for (const node of entries) result.append(candidateCards.get(node.name).item);
              box.className = `${viewClass}${stagedOrder && box === candBox ? ' candidate-priority-edit' : ''}`;
              box.replaceChildren(result);
              return;
            }
            const buckets = new Map();
            for (const node of entries) {
              const key = sourceKey(node);
              if (buckets.has(key)) continue;
              const section = document.createElement('details');
              section.className = 'group-source-section';
              const openKey = `${priorityKey}:${suffix}:${key}`;
              const includedCount = candidates.filter(entry => sourceKey(entry) === key).length;
              const excludedCount = excludedNodes.filter(entry => sourceKey(entry) === key).length;
              section.open = state.groupSourceOpen.get(openKey) ?? (box === candBox ? includedCount : excludedCount) <= 12;
              section.ontoggle = () => { state.groupSourceOpen.set(openKey, section.open); };
              const title = document.createElement('summary');
              const sourceName = sourcesByNode.get(node.name)?.name || '策略组与内置目标';
              title.textContent = sourceName;
              const total = document.createElement('span');
              total.className = 'group-source-count';
              total.textContent = `${includedCount} 个候选 · ${excludedCount} 个已排除`;
              title.appendChild(total);
              const listing = document.createElement('div');
              listing.className = viewClass;
              section.append(title, listing);
              buckets.set(key, listing);
              if (box === candBox && namesBySource.has(key)) {
                const bucket = document.createElement('div');
                bucket.className = 'group-source-bucket';
                const selection = document.createElement('label');
                selection.className = 'source-bulk-pick';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.dataset.bulkSource = key;
                checkbox.setAttribute('aria-label', `全选 ${sourceName} 的候选节点`);
                selection.append(checkbox, '全选');
                bucket.append(selection, section);
                result.append(bucket);
              } else {
                result.append(section);
              }
            }
            for (const node of entries) buckets.get(sourceKey(node)).append(candidateCards.get(node.name).item);
            box.className = 'group-source-sections';
            box.replaceChildren(result);
          }
          (stagedOrder || orderedNames).forEach((name, index) =>
            candidateCards.get(name).setPosition(index, Boolean(stagedOrder)));
          arrangeRegion(candBox, ordered, 'candidates');
          if (excludedBox) arrangeRegion(excludedBox, excludedNodes, 'excluded');
          updateSourceSelection();
          if (restoreFocus) focus.focus({ preventScroll: true });
        }
        arrangeCandidates();
        const sort = detailCol.querySelector('#groupNodeSort');
        if (sort) {
          sort.value = state.groupSort;
          sort.onchange = () => {
            state.groupSort = sort.value;
            arrangeCandidates();
          };
        }
        const display = detailCol.querySelector('#groupNodeDisplay');
        if (display) {
          display.value = state.groupDisplay;
          display.onchange = () => {
            state.groupDisplay = display.value;
            arrangeCandidates();
          };
        }
        function updateSourceSelection() {
          for (const checkbox of candBox.querySelectorAll('[data-bulk-source]')) {
            const names = namesBySource.get(checkbox.dataset.bulkSource);
            const count = names.filter(name => bulkSelection.has(name)).length;
            checkbox.checked = count === names.length;
            checkbox.indeterminate = count > 0 && count < names.length;
            checkbox.closest('label').hidden = bulkMode === 'restore';
          }
        }
        function renderBulkMode() {
          for (const hint of detailCol.querySelectorAll('[data-bulk-hint]')) {
            hint.hidden = hint.dataset.bulkHint !== bulkMode;
          }
          detailCol.querySelectorAll('[data-node-bulk]').forEach(actions => {
            const active = actions.dataset.nodeBulk === bulkMode;
            actions.querySelector('[data-bulk-start]').hidden = Boolean(bulkMode || stagedOrder);
            actions.querySelector('[data-bulk-cancel]').hidden = !active;
            actions.querySelector('[data-bulk-count]').hidden = !active || !bulkSelection.size;
            actions.querySelector('[data-bulk-count]').textContent = `已选 ${bulkSelection.size} 个`;
            actions.querySelector('[data-bulk-apply]').hidden = !active || !bulkSelection.size;
            actions.querySelector('[data-bulk-start]').setAttribute('aria-expanded', String(active));
          });
          for (const { item, excluded } of cards) {
            const input = item.querySelector('[data-bulk-node]');
            input.closest('label').hidden = bulkMode !== (excluded ? 'restore' : 'exclude');
            input.checked = bulkSelection.has(item.dataset.nodeName);
            item.classList.toggle('is-bulk-selected', input.checked);
          }
          updateSourceSelection();
          if (priorityButton) priorityButton.hidden = Boolean(bulkMode || stagedOrder);
          detailCol.querySelector('#addManualMemberBtn').hidden = Boolean(bulkMode || stagedOrder);
        }
        detailCol.querySelectorAll('[data-node-bulk]').forEach(actions => {
          const mode = actions.dataset.nodeBulk;
          actions.querySelector('[data-bulk-start]').onclick = () => {
            bulkMode = mode;
            resetBulkAnchor();
            renderBulkMode();
            (mode === 'exclude' ? candBox : excludedBox).querySelector('input[data-bulk-node]')?.focus();
          };
          actions.querySelector('[data-bulk-cancel]').onclick = () => {
            bulkMode = null;
            bulkSelection.clear();
            resetBulkAnchor();
            renderBulkMode();
            actions.querySelector('[data-bulk-start]').focus();
          };
          actions.querySelector('[data-bulk-apply]').onclick = () => {
            if (!bulkSelection.size) return;
            if (mode === 'exclude' && bulkSelection.size === candidates.length) {
              showToast('请至少保留一个候选节点。', 'error');
              return;
            }
            const count = bulkSelection.size;
            updateGroupExclusions(currentGroup, bulkSelection, mode === 'exclude');
            el.mainStage.querySelector(`[data-node-bulk="${mode}"] [data-bulk-start]`)?.focus();
            showToast(`${mode === 'exclude' ? '已排除' : '已恢复'} ${count} 个节点`, 'success');
          };
        });
        detailCol.addEventListener('change', event => {
          const checkbox = event.target;
          const source = checkbox.dataset.bulkSource;
          if (!source) return;
          bulkMode = 'exclude';
          resetBulkAnchor();
          setNodeSelection(bulkSelection, namesBySource.get(source), checkbox.checked);
          renderBulkMode();
        });
        if (priorityButton) {
          const selectedCount = detailCol.querySelector('#groupPrioritySelection');
          const moveSelected = detailCol.querySelector('#moveSelectedPriority');
          const hint = detailCol.querySelector('#groupPriorityHint');
          let anchor = null;
          let lastPointerType;
          let selectedByContextMenu = false;
          function updateSelection() {
            const allSelected = selected.size === stagedOrder?.length;
            selectedCount.hidden = !selected.size;
            selectedCount.textContent = selected.size ? `已选 ${selected.size} 个` : '';
            moveSelected.hidden = selected.size < 2 || allSelected;
            for (const button of candBox.querySelectorAll('[data-node-move]')) button.disabled = allSelected;
            for (const { item } of candidateCards.values()) {
              const active = selected.has(item.dataset.nodeName);
              item.classList.toggle('is-priority-selected', active);
              item.querySelector('.node-priority-select')?.setAttribute('aria-pressed', String(active));
            }
          }

          function closePositionEditor() {
            if (!positionEditor) return;
            const button = positionEditor.parentElement.querySelector('[data-node-move]');
            button.setAttribute('aria-expanded', 'false');
            positionEditor.remove();
            positionEditor = null;
          }
          function movingNodes(name) {
            return selected.has(name) ? [...selected] : [name];
          }
          function moveStagedNodes(names, to, focusName) {
            if (!stagedOrder || !Number.isInteger(to) || to < 0 || to > stagedOrder.length - names.length) return;
            closePositionEditor();
            const moving = new Set(names);
            stagedOrder = stagedOrder.filter(name => !moving.has(name));
            stagedOrder.splice(to, 0, ...names);
            applyButton.hidden = stagedOrder.every((name, index) => name === orderedNames[index]);
            arrangeCandidates();
            renderBulkMode();
            if (focusName) candidateCards.get(focusName).item.querySelector('[data-node-move]').focus();
          }
          const cancelDrag = enableOrderDragging(detailCol, candBox, (from, to, block) =>
            moveStagedNodes(block.map(card => card.dataset.nodeName), to), {
            grid: true,
            scroller: () => matchMedia('(max-width: 768px)').matches ? el.mainStage : candBox.closest('.group-detail-content'),
            layer: document.body,
            canHold: card => selected.has(card.dataset.nodeName),
            getBlock: card => movingNodes(card.dataset.nodeName).map(name => candidateCards.get(name).item)
          });
          function setPriorityEditing(edit) {
            cancelDrag();
            closePositionEditor();
            stagedOrder = edit ? [...orderedNames] : null;
            anchor = null;
            selected.clear();
            updateSelection();
            hint.hidden = !edit;
            priorityButton.hidden = edit;
            cancelButton.hidden = !edit;
            applyButton.hidden = true;
            for (const control of [sort, display, detailCol.querySelector('#addManualMemberBtn'),
              detailCol.querySelector('.group-probe-actions'), detailCol.querySelector('.group-view-switch')]) {
              if (control) control.hidden = edit;
            }
            arrangeCandidates();
            renderBulkMode();
            (edit ? cancelButton : priorityButton).focus({ preventScroll: true });
          }
          priorityButton.onclick = () => setPriorityEditing(true);
          cancelButton.onclick = () => setPriorityEditing(false);
          applyButton.onclick = () => {
            if (!stagedOrder) return;
            state.groupSort = 'config';
            state.groupDisplay = 'all';
            applyPriority(stagedOrder);
            el.mainStage.querySelector('#editGroupPriority')?.focus({ preventScroll: true });
          };
          function openPositionEditor(button) {
            const card = button.closest('.node-item');
            const wasOpen = card.contains(positionEditor);
            closePositionEditor();
            if (wasOpen) return;
            const names = movingNodes(card.dataset.nodeName);
            const max = stagedOrder.length - names.length + 1;
            const initial = Math.min(stagedOrder.indexOf(names[0]) + 1, max);
            if (max === 1) return;
            const form = document.createElement('form');
            form.className = 'node-priority-position';
            form.innerHTML = `
              ${names.length > 1 ? `<span class="node-priority-batch-label">${names.length} 个节点的起始位次</span>` : ''}
              <label>第 <input type="number" inputmode="numeric" class="input-text" required min="1" max="${max}" step="1" value="${initial}" aria-label="${names.length > 1 ? '批量起始位次' : '目标位置'}"> 位</label>
              <button type="submit" class="btn btn-default btn-sm">移动</button>
            `;
            positionEditor = form;
            button.setAttribute('aria-expanded', 'true');
            card.append(form);
            form.onsubmit = event => {
              event.preventDefault();
              moveStagedNodes(names, form.querySelector('input').valueAsNumber - 1, card.dataset.nodeName);
            };
            form.querySelector('input').focus();
          }
          moveSelected.onclick = () => {
            const first = selected.values().next().value;
            if (first) openPositionEditor(candidateCards.get(first).item.querySelector('[data-node-move]'));
          };
          function selectCard(event) {
            closePositionEditor();
            const card = event.target.closest('.node-item');
            const name = card?.dataset.nodeName;
            const touch = event.pointerType === 'touch' || (event.detail > 0 && lastPointerType === 'touch');
            if (!name) {
              anchor = null;
              selected.clear();
            } else if (event.shiftKey && anchor && !touch) {
              const start = stagedOrder.indexOf(anchor);
              const end = stagedOrder.indexOf(name);
              selected.clear();
              for (const entry of nodeRange(stagedOrder, start, end)) selected.add(entry);
            } else {
              anchor = name;
              if (touch || event.metaKey || event.ctrlKey || event.detail === 0) {
                if (selected.has(name)) selected.delete(name);
                else selected.add(name);
              } else {
                selected.clear();
                selected.add(name);
              }
            }
            updateSelection();
          }
          candBox.addEventListener('pointerdown', event => {
            lastPointerType = event.pointerType;
            selectedByContextMenu = false;
          });
          candBox.addEventListener('contextmenu', event => {
            // macOS reports Control + primary click as a context menu.
            if (!stagedOrder || !event.ctrlKey || event.button !== 0 || isOrderControl(event.target) ||
              !event.target.closest('[data-order-index]')) return;
            event.preventDefault();
            selectCard(event);
            selectedByContextMenu = true;
          });
          candBox.onclick = event => {
            if (!stagedOrder) return;
            const button = event.target.closest('[data-node-move]');
            if (button) openPositionEditor(button);
            else if ((!selectedByContextMenu || event.detail === 0) && !isOrderControl(event.target)) selectCard(event);
          };
        }
        const groupProbe = detailCol.querySelector('#probeGroupBtn');
        const settingsButton = detailCol.querySelector('#groupProbeSettings');
        settingsButton.onclick = () => openGroupProbeSettings(settingsButton, targetInput(), defaultUrl, next => {
          currentGroup.options ||= {};
          const saved = state.savedProfiles.get(prof.id)?.groups?.find(group => group.id === currentGroup.id);
          const savedOptions = saved?.options || {};
          if (next === (savedOptions.url ?? saved?.probeUrlHint ?? '') && !Object.hasOwn(savedOptions, 'url')) {
            delete currentGroup.options.url;
          } else {
            currentGroup.options.url = next;
          }
          updateTopbarBadges();
          refreshVisibleProbe();
        });
        async function testGroup(nodeName) {
          const key = probeKey();
          if (state.groupProbeRuns.size) return;
          const names = nodeName ? [nodeName] : candidates.map(node => node.name);
          state.groupProbeRuns.set(key, new Set(names));
          refreshVisibleProbe();
          try {
            const response = await fetch('/api/group-probe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ profileId: prof.id, revision: prof.revision, groupId: currentGroup.id,
                nodeNames: names, updates: draftUpdates(prof) }),
              signal: AbortSignal.timeout(18000)
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '测速失败');
            const previous = state.groupProbeResults.get(key) || new Map();
            state.groupProbeResults.set(key, new Map([...previous, ...Object.entries(result.results)]));
            const results = Object.values(result.results);
            showToast(`测速完成 · ${results.filter(item => item.status === 'ok').length}/${results.length} 可用`, 'success');
          } catch (error) {
            showToast(error.message || '测速失败', 'error');
          } finally {
            state.groupProbeRuns.delete(key);
            refreshVisibleProbe();
          }
        }
        if (groupProbe) groupProbe.onclick = () => testGroup();
        refreshGroupProbeView = () => {
          const pending = state.groupProbeRuns.get(probeKey());
          for (const card of cards) {
            const testing = pending?.has(card.node.name);
            card.update(testing ? 'running' : null, Boolean(state.groupProbeRuns.size), measurementForGroup(card.node));
          }
          if (groupProbe) updateProbeButton(groupProbe, Boolean(state.groupProbeRuns.size), pending ? '测速中' : '测速');
          if (!pending) arrangeCandidates();
        };
      }

      const nameInput = detailCol.querySelector('#groupNameInput');
      nameInput.oninput = () => {
        const previousName = currentGroup.name;
        const nextName = nameInput.value.trim();
        if (nextName === previousName) {
          nameInput.setCustomValidity('');
          return;
        }
        const reserved = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL'];
        const taken = groups.some(group => group !== currentGroup && group.name === nextName) ||
          [...(prof.nodes || []), ...(state.data.customNodes || [])].some(node => node.name === nextName) ||
          (state.data.sources || []).some(source => source.enabled !== false &&
            prof.sourceIds?.includes(source.id) && source.nodes?.some(node => node.name === nextName));
        const error = !nextName ? '请输入策略组名称。' : /[,#&\r\n]/.test(nextName)
          ? '策略组名称不能包含逗号、#、& 或换行。'
          : taken || reserved.includes(nextName) ? '此名称已被使用，请换一个名称。' : '';
        nameInput.setCustomValidity(error);
        if (error) return;
        currentGroup.name = nextName;
        retargetGroupReferences(prof, new Map([[previousName, nextName]]));
        listCol.querySelector('.group-row.active .group-row-name').textContent = nextName;
        listCol.querySelector('#mobileGroupSelect').selectedOptions[0].textContent = nextName;
        updateTopbarBadges();
      };
      nameInput.onchange = () => {
        if (!nameInput.validity.valid) showToast(nameInput.validationMessage, 'error');
        nameInput.value = currentGroup.name;
        nameInput.setCustomValidity('');
      };

      const typeSelect = detailCol.querySelector('#groupTypeSelect');
      typeSelect.onchange = () => {
        currentGroup.type = typeSelect.value;
        updateTopbarBadges();
        renderGroupsView();
      };
      const tolerance = detailCol.querySelector('#groupTolerance');
      if (tolerance) {
        const startingValue = tolerance.value;
        tolerance.oninput = () => {
          if (!tolerance.validity.valid) return;
          currentGroup.options ||= {};
          const saved = state.savedProfiles.get(prof.id)?.groups.find(group => group.id === currentGroup.id);
          if (tolerance.value === startingValue && !Object.hasOwn(saved?.options || {}, 'tolerance')
              && tolerance.valueAsNumber === (saved?.toleranceHint ?? 50)) delete currentGroup.options.tolerance;
          else currentGroup.options.tolerance = tolerance.valueAsNumber;
          updateTopbarBadges();
        };
        tolerance.onchange = () => {
          if (!tolerance.validity.valid) {
            tolerance.value = currentGroup.options?.tolerance ?? currentGroup.toleranceHint ?? 50;
            showToast('节点切换容差需填写 0 到 65535 的整数，单位 ms。', 'error');
          }
        };
      }

      for (const [id, mode] of [['#viewModeList', 'list'], ['#viewModeCard', 'card']]) {
        const button = detailCol.querySelector(id);
        if (button) button.onclick = () => {
          state.groupViewMode = mode;
          renderGroupsView();
        };
      }

      detailCol.querySelector('#deleteGroupBtn').onclick = () => {
        if (!confirm(`确定删除策略组 "${currentGroup.name}" 吗？`)) return;
        prof.groups = prof.groups.filter(g => g.id !== currentGroup.id);
        state.selectedGroupId = prof.groups[0]?.id || null;
        updateTopbarBadges();
        renderGroupsView();
      };

      const editMembers = detailCol.querySelector('#addManualMemberBtn');
      if (editMembers) editMembers.onclick = () => openGroupSetup(prof, currentGroup);
    } else {
      detailCol.innerHTML = '<p class="empty-message">新建策略组后可添加候选节点。</p>';
    }

    container.appendChild(listCol);
    container.appendChild(detailCol);
    el.mainStage.appendChild(container);
    refreshGroupProbeView?.();
    if (state.data.nodeProbeAvailable) scheduleProbePoll(0);
  }

  function openGroupProbeSettings(trigger, current, defaultUrl, apply) {
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog-box node-picker group-probe-dialog';
    dialog.setAttribute('aria-labelledby', 'groupProbeSettingsTitle');
    dialog.innerHTML = `
      <form>
        <div class="dialog-header">
          <h2 class="panel-title" id="groupProbeSettingsTitle">测速设置</h2>
        </div>
        <div class="dialog-body">
          <label class="group-probe-address">
            测速地址
            <input id="groupProbeUrl" class="input-text" type="url" inputmode="url" maxlength="2048" autofocus
              value="${escapeHtml(current)}" placeholder="${escapeHtml(defaultUrl)}" aria-describedby="groupProbeAddressHint">
          </label>
          <p id="groupProbeAddressHint" class="group-probe-hint">留空使用默认地址。</p>
        </div>
        <div class="dialog-footer">
          <button type="button" class="btn btn-subtle group-probe-reset">恢复默认</button>
          <button type="button" class="btn btn-default close-modal">取消</button>
          <button type="submit" class="btn btn-primary">应用到草稿</button>
        </div>
      </form>`;
    const form = dialog.querySelector('form');
    const input = dialog.querySelector('#groupProbeUrl');
    const reset = dialog.querySelector('.group-probe-reset');
    reset.disabled = !input.value;
    input.oninput = () => {
      input.setCustomValidity('');
      reset.disabled = !input.value;
    };
    reset.onclick = () => {
      input.value = '';
      input.oninput();
      input.focus();
    };
    dialog.querySelector('.close-modal').onclick = () => dialog.close();
    form.onsubmit = event => {
      event.preventDefault();
      const next = input.value.trim();
      if (next) {
        let valid = false;
        try {
          const url = new URL(next);
          valid = /^https?:\/\//i.test(next) && !url.username && !url.password && !url.hash &&
            url.port !== '0' && !/\s/.test(next);
        } catch { /* Invalid URL. The form stays open. */ }
        if (!valid) {
          input.setCustomValidity('请输入完整的 HTTP 或 HTTPS 网址，且不包含认证信息或片段');
          input.reportValidity();
          return;
        }
      }
      if (next !== current) {
        apply(next);
        showToast(next ? '测速地址已应用到草稿' : '已恢复默认测速地址', 'success');
      }
      dialog.close();
    };
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (trigger.isConnected) trigger.focus({ preventScroll: true });
    });
    el.modalContainer.appendChild(dialog);
    dialog.showModal();
  }

  function nodeBulkActions(mode) {
    const action = mode === 'exclude' ? '排除' : '恢复';
    return `<span class="node-bulk-actions" data-node-bulk="${mode}">
      <button type="button" class="btn btn-subtle btn-sm" data-bulk-start aria-expanded="false">批量${action}</button>
      <span class="node-bulk-count" data-bulk-count role="status" hidden></span>
      <button type="button" class="btn btn-default btn-sm" data-bulk-cancel hidden>取消</button>
      <button type="button" class="btn ${mode === 'exclude' ? 'btn-danger' : 'btn-primary'} btn-sm" data-bulk-apply hidden>${action}所选</button>
    </span>`;
  }

  function nodeSelectionHint(mode) {
    return `<p class="node-selection-hint" data-bulk-hint="${mode}" hidden>
      <span class="priority-mouse-hint">按住 Shift 点击，连续选择</span><span class="priority-touch-hint">轻点节点多选</span>
    </p>`;
  }

  function setNodeSelection(selection, names, checked) {
    for (const name of names) {
      if (checked) selection.add(name);
      else selection.delete(name);
    }
  }

  function nodeRange(order, start, end) {
    const nodes = order.slice(Math.min(start, end), Math.max(start, end) + 1);
    return start > end ? nodes.reverse() : nodes;
  }

  function bindNodeSelection(list, inputSelector, rowSelector, onSelect) {
    let anchor;
    const clickInput = (input, shiftKey) => {
      input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey }));
    };
    list.addEventListener('click', event => {
      const target = event.target;
      if (target.matches(inputSelector)) {
        if (!target.getClientRects().length) return;
        const visible = [...list.querySelectorAll(inputSelector)]
          .filter(input => input.getClientRects().length).map(input => input.value);
        const end = event.shiftKey && anchor ? anchor.order.indexOf(target.value) : -1;
        if (end < 0) {
          anchor = { order: visible, index: visible.indexOf(target.value), checked: target.checked };
          onSelect([target.value], target.checked, target.value);
          return;
        }
        const visibleNames = new Set(visible);
        onSelect(nodeRange(anchor.order, anchor.index, end).filter(name => visibleNames.has(name)),
          anchor.checked, target.value);
        return;
      }
      if (target.closest('button, a, input, select, textarea, summary, [popover]')) return;
      const label = target.closest('label');
      if (label && !event.shiftKey) return;
      const input = (label || target.closest(rowSelector))?.querySelector(inputSelector);
      if (!input?.getClientRects().length) return;
      if (label) event.preventDefault();
      input.focus({ preventScroll: true });
      clickInput(input, event.shiftKey);
    });
    list.addEventListener('keydown', event => {
      if (event.key !== ' ' || !event.shiftKey || !event.target.matches(inputSelector)) return;
      event.preventDefault();
      if (!event.repeat) clickInput(event.target, true);
    });
    return () => { anchor = null; };
  }

  function updateGroupExclusions(group, names, exclude) {
    const previous = new Set(group.options?.excluded || []);
    for (const name of names) {
      if (exclude) previous.add(name);
      else previous.delete(name);
    }
    group.options ||= {};
    if (previous.size) group.options.excluded = [...previous];
    else delete group.options.excluded;
    updateTopbarBadges();
    renderGroupsView();
  }

  function sourceSelectorMatches(selector) {
    const include = selector.include ? new RegExp(selector.include) : null;
    const exclude = selector.exclude ? new RegExp(selector.exclude) : null;
    const names = selector.names ? new Set(selector.names) : null;
    const excluded = new Set(selector.excludeNames || []);
    return node => (!names || names.has(node.name)) && !excluded.has(node.name) &&
      (!include || include.test(node.rawName || node.name)) && (!exclude || !exclude.test(node.rawName || node.name));
  }

  function computeGroupCandidates(group, profile) {
    const activeSources = (state.data.sources || []).filter(s => s.enabled !== false && profile.sourceIds?.includes(s.id));
    const rawNodesMap = new Map();
    const knownNotices = new Set();
    const sourcesByNode = new Map();

    for (const src of activeSources) {
      for (const n of src.nodes || []) {
        if (subscriptionNotice.test(n.rawName || n.name)) {
          knownNotices.add(n.name);
          continue;
        }
        rawNodesMap.set(n.name, n);
        sourcesByNode.set(n.name, src);
      }
    }
    for (const n of [...catalogNodesFor(profile), ...(profile.nodes || [])]) {
      rawNodesMap.set(n.name, n);
    }
    for (const other of profile.groups || []) {
      if (!rawNodesMap.has(other.name)) rawNodesMap.set(other.name, { name: other.name, type: '策略组' });
    }

    const excludedList = group.options?.excluded || [];
    const candidateNames = [];

    (group.members || []).forEach(m => {
      if (!knownNotices.has(m) && !candidateNames.includes(m)) candidateNames.push(m);
    });

    (group.selectors || []).forEach(sel => {
      const src = activeSources.find(s => s.id === sel.sourceId);
      if (src && src.nodes) {
        const matches = sourceSelectorMatches(sel);
        for (const n of src.nodes) {
          if (knownNotices.has(n.name) || !matches(n)) continue;
          if (!candidateNames.includes(n.name)) candidateNames.push(n.name);
        }
      }
    });

    const candidates = [];
    const excludedNodes = [];

    candidateNames.forEach(name => {
      const nodeObj = rawNodesMap.get(name) || { name };
      if (excludedList.includes(name)) {
        excludedNodes.push(nodeObj);
      } else {
        candidates.push(nodeObj);
      }
    });

    const natural = candidates.slice();
    const configuredPriority = group.type !== 'url-test' && Array.isArray(group.options?.priority) ? group.options.priority : [];
    const positions = new Map(configuredPriority.map((name, index) => [name, index]));
    candidates.sort((a, b) => (positions.get(a.name) ?? configuredPriority.length) - (positions.get(b.name) ?? configuredPriority.length));
    return { candidates, natural, excludedNodes, sourcesByNode, configuredNames: candidateNames };
  }

  function nodeMeasurementBadge(node) {
    switch (node.measurement?.status) {
      case 'ok': return `<span class="status-pill status-pill-ok tabular-nums">${escapeHtml(String(node.measurement.delayMs))} ms</span>`;
      case 'failed': return `<span class="status-pill status-pill-failed"${node.measurement.reason ? ` title="${escapeHtml(node.measurement.reason)}"` : ''}>失败</span>`;
      case 'timeout': return '<span class="status-pill status-pill-timeout">超时</span>';
      case 'skipped': return '<span class="status-pill status-pill-none">已跳过</span>';
      default: return '<span class="status-pill status-pill-none">尚未测量</span>';
    }
  }

  function nodeExitResult(node) {
    const measurement = node.measurement;
    if (!measurement?.exitStatus) return '';
    const value = measurement.exitStatus === 'ok' ? measurement.exitIp
      : measurement.exitStatus === 'timeout' ? '查询超时' : '未取得';
    return `<span class="node-exit-ip tabular-nums">出口 IP <span>${escapeHtml(value)}</span></span>`;
  }

  const moreIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>';

  function openNodePopover(popover, trigger) {
    popover.showPopover({ source: trigger });
    const anchor = trigger.getBoundingClientRect();
    const { width, height } = popover.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8));
    const top = anchor.bottom + height + 6 <= innerHeight - 8
      ? anchor.bottom + 6 : Math.max(8, anchor.top - height - 6);
    Object.assign(popover.style, { top: `${top}px`, left: `${left}px` });
    popover.querySelector('button')?.focus({ preventScroll: true });
  }

  function createNodeElement(node, group, index, count, excluded, source, move, profile, runCheck) {
    const item = document.createElement('div');
    const preferred = index === 0 && group.type !== 'url-test';
    const canMove = !excluded && count > 1 && group.type !== 'url-test';
    const linkedGroup = profile.groups.find(item => item.name === node.name);
    const testable = Boolean(runCheck);
    const name = escapeHtml(node.rawName ? node.rawName.replace(/^\[[^\]]+\]\s*/, '') : node.name);
    const fullName = escapeHtml(node.name);
    const metadata = [source && (source.prefix || source.name), node.type].filter(Boolean).join(' · ');
    item.className = `node-item${preferred ? ' is-default' : ''}${excluded ? ' is-excluded' : ''}`;
    item.dataset.nodeName = node.name;
    item.innerHTML = `
      <div class="group-node-title">
        <span class="node-name" title="${fullName}">${name}</span>
        ${canMove ? `<button type="button" class="node-priority-select" aria-label="选择 ${fullName}" aria-pressed="false" title="${fullName}" hidden>${name}</button>` : ''}
        <button type="button" class="btn btn-subtle node-more" title="节点详情与操作" aria-label="${fullName}的详情与操作" aria-expanded="false">
          ${moreIcon}
        </button>
      </div>
      <label class="node-bulk-pick" hidden><input type="checkbox" value="${fullName}" data-bulk-node aria-label="选择 ${fullName}"><span>选择</span></label>
      <div class="group-node-meta">
        <div class="group-node-tags">
          ${metadata ? `<span class="group-node-origin" title="${escapeHtml(metadata)}">${escapeHtml(metadata)}</span>` : ''}
          <span class="group-node-rank" hidden></span>
        </div>
        ${testable ? `<button type="button" class="btn group-node-probe" aria-label="测速 ${fullName}" title="点击重新测速"></button>` : '<span class="group-node-measurement"></span>'}
      </div>
      ${canMove ? `<div class="node-priority-controls" hidden><span class="node-priority-number tabular-nums"></span><button type="button" class="btn btn-subtle btn-sm" data-node-move aria-expanded="false">移到…</button></div>` : ''}
      <div class="group-node-popover" popover="auto">
        <strong>${fullName}</strong>
        <div class="group-node-probe-details"></div>
        ${linkedGroup ? '<button type="button" class="btn btn-default btn-sm group-node-open">查看策略组</button>' : ''}
        ${canMove && index > 0 ? `<button type="button" class="btn btn-default btn-sm group-node-first">${group.type === 'fallback' ? '设为首选' : '设为默认项'}</button>` : ''}
        ${canMove && group.type === 'fallback' ? `<select class="input-text group-node-backup" aria-label="设为第几备选">
          <option value="">设置备选顺序</option>
        </select>` : ''}
        <button type="button" class="btn btn-subtle btn-sm group-node-exclude">${excluded ? '恢复节点' : '排除节点'}</button>
      </div>
    `;
    const probe = item.querySelector('.group-node-probe');
    const badge = probe || item.querySelector('.group-node-measurement');
    const more = item.querySelector('.node-more');
    const popover = item.querySelector('.group-node-popover');
    const details = popover.querySelector('.group-node-probe-details');
    const setBackup = popover.querySelector('.group-node-backup');
    const rank = item.querySelector('.group-node-rank');
    const priorityControls = item.querySelector('.node-priority-controls');
    const prioritySelect = item.querySelector('.node-priority-select');
    const title = item.querySelector('.group-node-title .node-name');
    function setPosition(position, editing) {
      const first = position === 0 && group.type !== 'url-test';
      rank.textContent = position < 0 ? '' : group.type === 'fallback'
        ? (first ? '首选' : `备选 ${position}`) : first ? '默认项' : '';
      rank.hidden = !rank.textContent;
      rank.classList.toggle('group-node-preferred', first);
      item.classList.toggle('is-default', first);
      if (!priorityControls) return;
      priorityControls.hidden = !editing;
      prioritySelect.hidden = !editing;
      title.hidden = editing;
      more.hidden = editing;
      if (editing) {
        if (popover.matches(':popover-open')) popover.hidePopover();
        item.dataset.orderIndex = position;
        priorityControls.querySelector('.node-priority-number').textContent = `第 ${position + 1} 位`;
        priorityControls.querySelector('button').setAttribute('aria-label', `移动 ${node.name} 的优先级`);
      } else {
        delete item.dataset.orderIndex;
      }
    }
    setPosition(index, false);
    if (probe) probe.onclick = runCheck;
    more.onclick = () => {
      if (popover.matches(':popover-open')) {
        popover.hidePopover();
        return;
      }
      if (setBackup?.options.length === 1) {
        for (let position = 1; position < count; position++) {
          const option = new Option(`设为备选 ${position}`, String(position));
          option.disabled = position === index;
          setBackup.add(option);
        }
      }
      openNodePopover(popover, more);
    };
    popover.addEventListener('toggle', event => more.setAttribute('aria-expanded', String(event.newState === 'open')));
    const openGroup = popover.querySelector('.group-node-open');
    if (openGroup) openGroup.onclick = () => {
      state.selectedGroupId = linkedGroup.id;
      renderGroupsView();
    };
    const setFirst = popover.querySelector('.group-node-first');
    if (setFirst) setFirst.onclick = () => move(node.name, 0);
    if (setBackup) setBackup.onchange = () => {
      if (setBackup.value) move(node.name, Number(setBackup.value));
    };
    popover.querySelector('.group-node-exclude').onclick = () => {
      updateGroupExclusions(group, [node.name], !excluded);
      findGroupNode(node.name)?.querySelector('.node-more')?.focus({ preventScroll: true });
      showToast(`${excluded ? '已恢复' : '已排除'} ${node.name}`, 'info');
    };
    return { item, node, setPosition, source, excluded, update(pending, busy, measurement) {
      const measuredNode = { ...node, measurement };
      const result = pending ? probeStatusMarkup(pending)
        : nodeMeasurementBadge(measuredNode).replace('尚未测量', '未测');
      if (badge.innerHTML !== result) badge.innerHTML = result;
      if (probe) updateProbeButton(probe, busy);
      const timestamp = measurement?.checkedAt;
      const measured = nodeExitResult(measuredNode) + (timestamp ? `<time datetime="${escapeHtml(timestamp)}">测速于 ${escapeHtml(new Date(timestamp).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'}))}</time>` : '');
      if (details.innerHTML !== measured) details.innerHTML = measured;
      details.hidden = !measured;
    } };
  }

  function findGroupNode(name) {
    return [...el.mainStage.querySelectorAll('.node-item')].find(item => item.dataset.nodeName === name);
  }

  function renderGroupRules(panel, group, profile) {
    if (!state.catalog) return renderDeferred(panel, '正在加载公共规则库…', ensureCatalog,
      () => renderGroupRules(panel, group, profile));
    const catalog = publicRuleCatalog();
    const rules = (profile.rules || []).map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => rule.target === group.name)
      .map(({ rule, index }) => {
        const item = rule.type === 'GEOSITE' ? catalog.get(rule.value?.toLowerCase()) : null;
        const name = item?.name || rule.value || (rule.type === 'COMPANY' ? '公司共享网段' : '全部流量');
        return { rule, index, item, name };
      });
    const groupRuleCount = panel.closest('.group-detail-col').querySelector('[data-group-tab="rules"] span');
    groupRuleCount.textContent = rules.length;
    const selectedSets = rules.filter(({ rule, item }) => item && rule.publicSet && rule.enabled !== false);
    panel.innerHTML = `
      <div class="group-rules-toolbar">
        <h2 class="panel-title">流向此组的规则</h2>
        <button type="button" id="addGroupRule" class="btn btn-primary btn-sm">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>
          添加规则
        </button>
      </div>
      ${rules.length ? `<div class="group-rule-list">${rules.map(({ rule, index, item, name }) => {
        const canTest = rule.enabled !== false && ['DOMAIN', 'DOMAIN-SUFFIX', 'IP-CIDR', 'IP-CIDR6'].includes(rule.type);
        return `
        <div class="group-rule-row">
          <span class="group-rule-index tabular-nums" title="在配置中的位置">第 ${index + 1} 条</span>
          <div class="group-rule-expression">
            <span class="badge badge-version">${item ? '公共规则集' : escapeHtml(rule.type)}</span>
            ${item ? `<span class="group-rule-set">
              <button type="button" class="btn btn-subtle btn-sm group-rule-name" data-group-rule-detail="${index}" aria-haspopup="dialog">${escapeHtml(name)}</button>
              <span class="group-rule-update-slot" data-rule-update="${index}"></span>
            </span>` : `<span>${escapeHtml(name)}</span>`}
            ${rule.enabled === false ? '<span class="badge badge-version">已停用</span>' : ''}
          </div>
          <div class="group-rule-actions">
            ${canTest ? `<button type="button" class="btn btn-subtle btn-sm" data-group-rule-test="${index}">测试匹配</button>` : ''}
            <button type="button" class="btn btn-subtle btn-sm group-rule-remove" data-group-rule-remove="${index}" aria-haspopup="dialog"
              aria-label="${item ? '移除' : '删除'} ${escapeHtml(name)}">${item ? '移除' : '删除'}</button>
          </div>
        </div>`;
      }).join('')}</div>` : '<p class="empty-message">这里还没有规则。添加一条规则，让对应的域名或网段走这个组。</p>'}
    `;
    panel.querySelector('#addGroupRule').onclick = () => openGroupRulePicker(profile, group);
    panel.querySelectorAll('[data-group-rule-detail]').forEach(button => {
      button.onclick = () => {
        const rule = profile.rules[Number(button.dataset.groupRuleDetail)];
        if (!rule) return;
        const item = catalog.get(rule.value.toLowerCase());
        showPublicRuleDetail(item, () => button.focus(), rule.publicSet, rule.publicSet ? null : snapshot => {
          if (!profile.rules.includes(rule) || rule.publicSet) return;
          rule.publicSet = snapshot;
          updateTopbarBadges();
          renderGroupRules(panel, group, profile);
          panel.querySelector(`[data-group-rule-detail="${button.dataset.groupRuleDetail}"]`)?.focus();
        });
      };
    });
    forPublicRules(selectedSets, async ({ rule, index, item }) => {
      const slot = panel.querySelector(`[data-rule-update="${index}"]`);
      const before = rule.publicSet;
      const latest = await fetchPublicRule(item.id);
      if (before.version === latest.version || !slot?.isConnected || profile.rules[index] !== rule ||
        rule.publicSet !== before || rule.target !== group.name) return;
      const notice = document.createElement('button');
      notice.type = 'button';
      notice.className = 'btn btn-sm rule-update-button';
      notice.innerHTML = '<span>有更新</span>';
      notice.setAttribute('aria-label', `${item.name} 有更新`);
      notice.setAttribute('aria-haspopup', 'dialog');
      notice.onclick = () => showPublicRuleUpdate(item, before, latest, () => notice.focus(), () => {
        if (!profile.rules.includes(rule) || rule.publicSet !== before) return;
        rule.publicSet = ruleSnapshot(latest);
        updateTopbarBadges();
        renderGroupRules(panel, group, profile);
        panel.querySelector(`[data-group-rule-detail="${index}"]`)?.focus();
      });
      slot.replaceChildren(notice);
    });
    panel.querySelectorAll('[data-group-rule-test]').forEach(button => {
      button.onclick = () => {
        const rule = profile.rules[Number(button.dataset.groupRuleTest)];
        state.ruleTestInput = rule.value.split('/')[0];
        navigateTo('rules');
      };
    });
    panel.querySelectorAll('[data-group-rule-remove]').forEach((button, rowIndex) => {
      button.onclick = () => {
        const { rule, item, name } = rules[rowIndex];
        const nearbyRule = (rules[rowIndex + 1] || rules[rowIndex - 1])?.rule;
        confirmGroupRuleRemoval(name, Boolean(item), button, () => {
          const index = profile.rules.indexOf(rule);
          if (index < 0) return;
          const scrollTop = panel.scrollTop;
          profile.rules.splice(index, 1);
          updateTopbarBadges();
          renderGroupRules(panel, group, profile);
          panel.scrollTop = scrollTop;
          const next = panel.querySelector(`[data-group-rule-remove="${profile.rules.indexOf(nearbyRule)}"]`);
          (next || panel.querySelector('#addGroupRule')).focus();
        });
      };
    });
  }

  function confirmGroupRuleRemoval(label, publicRule, trigger, onRemove) {
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog-box node-picker group-setup-dialog group-rule-remove-dialog';
    dialog.setAttribute('aria-labelledby', 'removeGroupRuleTitle');
    dialog.setAttribute('aria-describedby', 'removeGroupRuleBody');
    const action = publicRule ? '移除' : '删除';
    dialog.innerHTML = `
      <div class="group-setup-form">
        <div class="dialog-header"><h2 class="panel-title" id="removeGroupRuleTitle">${action}${publicRule ? '公共规则集' : '规则'}？</h2></div>
        <div class="dialog-body" id="removeGroupRuleBody"><strong>${escapeHtml(label)}</strong><span>发布后生效。</span></div>
        <div class="dialog-footer">
          <button type="button" class="btn btn-default" data-remove-cancel autofocus>取消</button>
          <button type="button" class="btn btn-danger" data-remove-confirm>${action}</button>
        </div>
      </div>
    `;
    dialog.querySelector('[data-remove-cancel]').onclick = () => dialog.close();
    dialog.querySelector('[data-remove-confirm]').onclick = () => {
      dialog.close();
      onRemove();
    };
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (trigger.isConnected) trigger.focus({ preventScroll: true });
    });
    el.modalContainer.appendChild(dialog);
    dialog.showModal();
  }

  function openGroupSetup(profile, existing) {
    const original = existing || { id: `g-${crypto.randomUUID()}`, name: '', type: 'select', members: [], selectors: [], options: {} };
    const fixed = new Set(original.members || []);
    const originalSelectors = original.selectors || [];
    const originalExcluded = new Set(original.options?.excluded || []);
    const pickedOrder = new Set();
    const selectedSources = (state.data.sources || []).filter(source => source.enabled !== false).map(source => {
      const nodes = (source.nodes || []).filter(node => !subscriptionNotice.test(node.rawName || node.name));
      const selectors = originalSelectors.filter(selector => selector.sourceId === source.id);
      const names = new Set(nodes.map(node => node.name));
      const matches = selectors.map(sourceSelectorMatches);
      const configured = new Set(nodes.filter(node => fixed.has(node.name) || matches.some(match => match(node))).map(node => node.name));
      return { source, nodes, names, selectors, configured, baseline: configured, picked: new Set(configured),
        mode: null, originalExcluded, restored: new Set() };
    });
    const groups = new Map(profile.groups.map(group => [group.name, group]));
    const reserved = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL'];
    const attached = new Set(fixed);
    const linked = profile.groups.filter(group => !groupLeadsTo(group.name, original.name, groups));
    const localNodes = (profile.nodes || []).filter(node => !node.custom).map(node => node.name);
    const customNodes = new Map([...catalogNodesFor(profile), ...(profile.nodes || []).filter(node => node.custom)]
      .map(node => [node.name, node]));
    const customNames = [...customNodes.keys()].filter(name => !groups.has(name) && !localNodes.includes(name));
    const sharedNames = new Set(customNames);
    const dialers = new Map(Object.entries(profile.customNodeDialers || {}));
    const builtins = [...localNodes, 'DIRECT', 'REJECT', 'PASS'];
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog-box node-picker group-setup-dialog';
    dialog.setAttribute('aria-labelledby', 'groupSetupTitle');
    dialog.innerHTML = `
      <form class="group-setup-form">
      <div class="dialog-header">
        <h2 class="panel-title" id="groupSetupTitle">${existing ? `配置候选 · ${escapeHtml(existing.name)}` : '新建策略组'}</h2>
      </div>
      ${existing ? '' : `<div class="group-setup-fields">
        <label>策略组名称<input id="newGroupName" type="text" class="input-text" autocomplete="off" placeholder="例如 日常备用" autofocus></label>
        <label>选择方式<select id="newGroupType" class="input-text">
          <option value="select">手动选择</option><option value="fallback">按优先级回退</option><option value="url-test">自动测速</option>
        </select></label>
      </div>`}
      <div class="group-tabs group-setup-tabs" role="group" aria-label="候选类型">
        <button type="button" class="group-tab" data-setup-tab="sources" aria-pressed="true">订阅来源</button>
        <button type="button" class="group-tab" data-setup-tab="groups" aria-pressed="false">自定义节点与策略组</button>
      </div>
      <div class="group-setup-scroll">
        <div id="groupSetupSources"></div>
        <div id="groupSetupGroups" hidden></div>
      </div>
      <div class="dialog-footer group-setup-footer">
        <p class="group-setup-error" role="alert" hidden></p>
        <output class="group-setup-summary" aria-live="polite"></output>
        <button type="button" class="btn btn-default close-modal">取消</button>
        <button type="submit" class="btn btn-primary" id="confirmGroupSetup">${existing ? '应用候选' : '创建策略组'}</button>
      </div>
      </form>
    `;
    const sourcePanel = dialog.querySelector('#groupSetupSources');
    const groupPanel = dialog.querySelector('#groupSetupGroups');
    const sourceStatus = entry => {
      if (entry.mode === 'all' || (entry.mode === null && entry.selectors.some(s => !s.names && !s.include && !s.exclude))) return '整家加入';
      if (entry.mode === null && entry.selectors.some(s => !s.names)) return '按条件加入';
      return entry.picked.size ? `手选 ${entry.picked.size} 个` : '';
    };
    const error = dialog.querySelector('.group-setup-error');
    function showSummary() {
      const count = selectedSources.filter(entry => sourceStatus(entry)).length;
      const references = [...attached].filter(name => !selectedSources.some(entry => entry.names.has(name))).length;
      const total = selectedSources.reduce((sum, entry) => sum + entry.picked.size, 0);
      dialog.querySelector('.group-setup-summary').textContent = [count && `${count} 家 · ${total} 个节点`, references && `另选 ${references} 项`].filter(Boolean).join(' · ');
      error.hidden = true;
    }
    let collapseSource;
    for (const entry of [...selectedSources].sort((a, b) => Number(Boolean(sourceStatus(b))) - Number(Boolean(sourceStatus(a))))) {
      sourcePanel.appendChild(createSetupSource(entry, sourceStatus, pickedOrder, showSummary, collapse => {
        collapseSource?.();
        collapseSource = collapse;
      }));
    }
    if (!selectedSources.length) sourcePanel.innerHTML = '<p class="empty-message">暂无订阅来源。</p>';
    for (const [title, names] of [['自定义节点', customNames], ['可引用的策略组', linked.map(group => group.name)], ['固定节点与内置目标', builtins]]) {
      const section = document.createElement('section');
      section.className = 'group-setup-references';
      section.innerHTML = `<h3>${title}</h3>${names.map(name => {
        const currentDialer = dialers.get(name) || '';
        const choices = [...new Set([...localNodes, ...linked.map(group => group.name),
          ...customNames, currentDialer])].filter(value => value && value !== name);
        return `
        <div class="group-setup-reference">
        <label class="group-setup-choice">
          <input type="checkbox" value="${escapeHtml(name)}" ${attached.has(name) ? 'checked' : ''}>
          <span>${escapeHtml(name)}</span>
          ${fixed.has(name) && originalExcluded.has(name) ? '<span class="group-setup-choice-hint">已排除</span>' : ''}
        </label>
        ${sharedNames.has(name) && customNodes.get(name).type !== 'tailscale' ? `<label class="group-setup-dialer" ${attached.has(name) ? '' : 'hidden'}>
          前置代理（${escapeHtml(profile.name)}）
          <select class="input-text" data-node-dialer="${escapeHtml(name)}" aria-label="${escapeHtml(name)}的前置代理">
            <option value="">直接连接</option>
            ${choices.map(value => `<option value="${escapeHtml(value)}" ${value === currentDialer ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}
          </select>
        </label>` : ''}
        </div>`;
      }).join('') || '<p class="empty-message">暂无可选项。</p>'}`;
      groupPanel.appendChild(section);
    }
    groupPanel.onchange = event => {
      const { checked, value } = event.target;
      if (event.target.matches('[data-node-dialer]')) {
        const name = event.target.dataset.nodeDialer;
        if (value) dialers.set(name, value);
        else dialers.delete(name);
        return;
      }
      if (checked) attached.add(value);
      else attached.delete(value);
      if (!fixed.has(value)) setNodeSelection(pickedOrder, [value], checked);
      const status = event.target.closest('label')?.querySelector('.group-setup-choice-hint');
      if (status) status.hidden = !checked;
      const dialerField = event.target.closest('.group-setup-reference')?.querySelector('.group-setup-dialer');
      if (dialerField) dialerField.hidden = !checked;
      showSummary();
    };
    dialog.querySelectorAll('[data-setup-tab]').forEach(button => {
      button.onclick = () => {
        const active = button.dataset.setupTab === 'sources';
        dialog.querySelector('[data-setup-tab="sources"]').setAttribute('aria-pressed', String(active));
        dialog.querySelector('[data-setup-tab="groups"]').setAttribute('aria-pressed', String(!active));
        sourcePanel.hidden = !active;
        groupPanel.hidden = active;
      };
    });
    dialog.querySelector('form').onsubmit = event => {
      event.preventDefault();
      const draft = structuredClone(original);
      if (!existing) {
        draft.name = dialog.querySelector('#newGroupName').value.trim();
        draft.type = dialog.querySelector('#newGroupType').value;
        if (!draft.name || [...groups.keys(), ...builtins, ...customNames, ...reserved].includes(draft.name) ||
            selectedSources.some(entry => entry.names.has(draft.name))) {
          error.textContent = draft.name ? '此名称已被使用，请换一个名称。' : '请输入策略组名称。';
          error.hidden = false;
          dialog.querySelector('#newGroupName').focus();
          return;
        }
      }
      draft.members = [...attached];
      draft.selectors = [...originalSelectors];
      const sourceIds = new Set(profile.sourceIds || []);
      const excluded = new Set(originalExcluded);
      const removedMembers = new Set([...fixed].filter(name => !attached.has(name)));
      for (const name of attached) if (!fixed.has(name)) excluded.delete(name);
      for (const entry of selectedSources) {
        const sourceId = entry.source.id;
        const added = [...entry.picked].filter(name => !entry.baseline.has(name));
        const removed = new Set([...entry.baseline].filter(name => !entry.picked.has(name)));
        if (entry.mode === null && !added.length && !removed.size && !entry.restored.size) continue;
        if (entry.mode !== null) {
          draft.members = draft.members.filter(name => !entry.names.has(name));
          draft.selectors = draft.selectors.filter(selector => selector.sourceId !== sourceId);
          if (entry.mode === 'all') draft.selectors.push({ sourceId });
          if (entry.mode === 'none') {
            for (const name of entry.names) if (!entry.picked.has(name)) removedMembers.add(name);
          }
        }
        if (removed.size) {
          draft.members = draft.members.filter(name => !removed.has(name));
          draft.selectors = draft.selectors.flatMap(selector => {
            if (selector.sourceId !== sourceId) return [selector];
            if (selector.names) {
              const names = selector.names.filter(name => !removed.has(name));
              return names.length ? [{ ...selector, names }] : [];
            }
            const matches = sourceSelectorMatches(selector);
            const removedHere = entry.nodes.filter(node => removed.has(node.name) && matches(node)).map(node => node.name);
            return removedHere.length ? [{ ...selector, excludeNames: [...(selector.excludeNames || []), ...removedHere] }] : [selector];
          });
          for (const name of removed) removedMembers.add(name);
        }
        for (const name of entry.restored) excluded.delete(name);
        for (const name of entry.picked) if (!entry.configured.has(name)) excluded.delete(name);
        const explicit = added.filter(name => entry.mode === 'none' || (entry.mode === null && !entry.configured.has(name)));
        const manual = draft.selectors.findLast(selector => selector.sourceId === sourceId && selector.names &&
          !selector.include && !selector.exclude && !selector.excludeNames?.length);
        if (explicit.length && manual) {
          draft.selectors = draft.selectors.map(selector => selector === manual
            ? { ...selector, names: [...new Set([...selector.names, ...explicit])] } : selector);
        } else if (explicit.length) {
          draft.selectors.push({ sourceId, names: explicit });
        }
        if (entry.mode === 'all' || entry.picked.size) sourceIds.add(sourceId);
      }
      for (const name of removedMembers) excluded.delete(name);
      if (removedMembers.size && Array.isArray(draft.options?.priority)) {
        draft.options.priority = draft.options.priority.filter(name => !removedMembers.has(name));
      }
      if (excluded.size) draft.options = { ...draft.options, excluded: [...excluded] };
      else if (draft.options) delete draft.options.excluded;
      if (!draft.members.length && !draft.selectors.length) {
        error.textContent = '先选一条订阅来源、一个节点或一个策略组。';
        error.hidden = false;
        return;
      }
      const nextSourceIds = [...sourceIds];
      if (draft.type !== 'url-test' && pickedOrder.size) {
        const previous = computeGroupCandidates(original, profile).configuredNames;
        const current = computeGroupCandidates(draft, { ...profile, sourceIds: nextSourceIds }).configuredNames;
        const preferred = draft.options?.priority || [];
        const available = new Set(current);
        const additions = [...pickedOrder].filter(name => available.has(name));
        if (additions.length) {
          const order = [...new Set([
            ...preferred.filter(name => !pickedOrder.has(name)),
            ...previous.filter(name => available.has(name) && !pickedOrder.has(name)),
            ...additions,
            ...current
          ])];
          draft.options ||= {};
          if (order.length !== current.length || order.some((name, index) => name !== current[index])) draft.options.priority = order;
          else delete draft.options.priority;
          state.groupSort = 'config';
          state.groupDisplay = 'all';
        }
      }
      if (existing) Object.assign(existing, draft);
      else profile.groups.push(draft);
      profile.sourceIds = nextSourceIds;
      profile.customNodeDialers = Object.fromEntries(dialers);
      state.selectedGroupId = draft.id;
      state.groupTab = 'nodes';
      dialog.close();
      updateTopbarBadges();
      renderGroupsView();
      el.mainStage.querySelector('#addManualMemberBtn')?.focus({ preventScroll: true });
    };
    dialog.addEventListener('close', () => dialog.remove());
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        dialog.close();
      }
    });
    dialog.querySelectorAll('.close-modal').forEach(button => button.onclick = () => dialog.close());
    el.modalContainer.appendChild(dialog);
    showSummary();
    dialog.showModal();
  }

  function groupLeadsTo(name, target, groups, visited = new Set()) {
    if (name === target) return true;
    if (visited.has(name)) return false;
    visited.add(name);
    return (groups.get(name)?.members || []).some(member => groupLeadsTo(member, target, groups, visited));
  }

  function createSetupSource(entry, sourceStatus, pickedOrder, onChange, onExpand) {
    const { source, nodes } = entry;
    const item = document.createElement('section');
    item.className = 'group-setup-source';
    item.dataset.sourceId = source.id;
    item.innerHTML = `
      <div class="group-setup-source-top">
        <div class="group-setup-source-name"><strong>${escapeHtml(source.name)}</strong><span class="group-setup-source-status"></span></div>
        ${nodes.length ? `
        <button type="button" class="btn btn-default btn-sm setup-add-whole" aria-pressed="false"></button>
        <button type="button" class="btn btn-subtle btn-sm setup-expand-source" aria-label="选择 ${escapeHtml(source.name)} 的节点" aria-expanded="false">选节点</button>` : ''}
      </div>
      <div class="group-setup-source-body" hidden>
        <div class="group-setup-source-search">
          <input type="search" class="input-text" aria-label="搜索 ${escapeHtml(source.name)} 的节点" placeholder="搜索节点名称或出口 IP">
          <select class="input-text setup-node-status" aria-label="节点测速状态">
            <option value="">全部状态</option><option value="ok">可用</option><option value="timeout">超时</option>
            <option value="failed">失败</option><option value="unmeasured">未测</option><option value="skipped">已跳过</option>
          </select>
        </div>
        <div class="group-setup-source-tools">
          <label><input type="checkbox" class="setup-select-filtered"><span>全选当前结果</span></label>
          <label><input type="checkbox" class="setup-members-only"> 只看本组</label>
          <button type="button" class="btn btn-subtle btn-sm setup-clear-source">清空所选</button>
        </div>
        <p class="node-selection-hint priority-mouse-hint">按住 Shift 点击，连续选择</p>
        <div class="group-setup-choices"></div>
      </div>
    `;
    const whole = item.querySelector('.setup-add-whole');
    const expand = item.querySelector('.setup-expand-source');
    const status = item.querySelector('.group-setup-source-status');
    const body = item.querySelector('.group-setup-source-body');
    const search = body.querySelector('input[type="search"]');
    const stateFilter = body.querySelector('.setup-node-status');
    const visibleSelect = body.querySelector('.setup-select-filtered');
    const membersOnly = body.querySelector('.setup-members-only');
    const clear = body.querySelector('.setup-clear-source');
    const list = body.querySelector('.group-setup-choices');
    const ordered = orderByLatency(nodes);
    const isExcluded = name => entry.picked.has(name) && entry.configured.has(name) &&
      entry.originalExcluded.has(name) && !entry.restored.has(name);
    let filtered = [];
    function updateStatus() {
      const mode = sourceStatus(entry);
      const excludedCount = [...entry.picked].filter(isExcluded).length;
      const selection = mode ? (mode.startsWith('手选') ? mode : `${mode} · 已选 ${entry.picked.size} 个`)
        : `${nodes.length} 个节点 · 未选`;
      status.textContent = excludedCount ? `${selection} · 已排除 ${excludedCount} 个` : selection;
      status.classList.toggle('has-selected-nodes', Boolean(mode));
      if (whole) {
        whole.textContent = mode === '整家加入' ? '取消整家' : '整家加入';
        whole.setAttribute('aria-pressed', String(mode === '整家加入'));
      }
      clear.hidden = !entry.picked.size && !mode;
    }
    function updateFilteredSelection() {
      const checked = filtered.filter(node => entry.picked.has(node.name)).length;
      visibleSelect.checked = Boolean(filtered.length) && checked === filtered.length;
      visibleSelect.indeterminate = checked > 0 && checked < filtered.length;
      visibleSelect.disabled = !filtered.length;
      visibleSelect.nextElementSibling.textContent = `全选当前结果（${filtered.length}）`;
    }
    function renderChoices(resetScroll = false) {
      const query = search.value.trim().toLowerCase();
      filtered = ordered.filter(node =>
        (!membersOnly.checked || entry.picked.has(node.name)) &&
        (!stateFilter.value || (node.measurement?.status || 'unmeasured') === stateFilter.value) &&
        (!query || node.name.toLowerCase().includes(query) || node.rawName?.toLowerCase().includes(query) || node.measurement?.exitIp?.includes(query)));
      const scroll = list.scrollTop;
      list.innerHTML = filtered.map((node, index) => {
        const name = escapeHtml(node.rawName || node.name);
        const measurement = nodeMeasurementBadge(node);
        const excluded = isExcluded(node.name);
        return `
          <div class="group-setup-choice setup-node-choice${excluded ? ' setup-excluded-choice' : ''}">
            <label class="setup-node-label">
              <input type="checkbox" data-choice="${index}" value="${escapeHtml(node.name)}" ${entry.picked.has(node.name) ? 'checked' : ''}>
              <span>${name} ${excluded ? '<small class="group-setup-choice-hint">已排除</small>' : ''}</span>
            </label>
            ${measurement}
            ${excluded ? `<button type="button" class="btn btn-subtle btn-sm" data-restore-choice="${index}" aria-label="恢复 ${name}">恢复</button>` : ''}
          </div>`;
      }).join('') || '<p class="empty-message">没有匹配的节点。</p>';
      list.scrollTop = resetScroll ? 0 : scroll;
      updateFilteredSelection();
    }
    function changed(redraw) {
      updateStatus();
      if (redraw && !body.hidden) renderChoices();
      else updateFilteredSelection();
      onChange();
    }
    function updatePicks(names, checked) {
      setNodeSelection(entry.picked, names, checked);
      setNodeSelection(pickedOrder, [...names].filter(name => !entry.configured.has(name)), checked);
    }
    function setMode(mode) {
      resetRange();
      entry.mode = mode;
      entry.baseline = new Set(mode === 'all' ? entry.names : []);
      setNodeSelection(pickedOrder, entry.picked, false);
      entry.picked = new Set();
      updatePicks(entry.baseline, true);
      changed(true);
    }
    updateStatus();
    if (whole) whole.onclick = () => setMode(sourceStatus(entry) === '整家加入' ? 'none' : 'all');
    function setExpanded(open) {
      resetRange();
      body.hidden = !open;
      expand.textContent = open ? '收起' : '选节点';
      expand.setAttribute('aria-expanded', String(open));
      expand.setAttribute('aria-label', `${open ? '收起' : '选择'} ${source.name} 的节点`);
    }
    if (expand) expand.onclick = () => {
      if (body.hidden) {
        onExpand(() => setExpanded(false));
        setExpanded(true);
        renderChoices();
      } else {
        setExpanded(false);
      }
    };
    clear.onclick = () => {
      setMode('none');
      membersOnly.focus();
    };
    function focusChoice(node) {
      const index = filtered.indexOf(node);
      (list.querySelector(`[data-choice="${index}"]`) || membersOnly).focus({ preventScroll: true });
    }
    list.onclick = event => {
      const action = event.target.closest('[data-restore-choice]');
      if (!action) return;
      const node = filtered[Number(action.dataset.restoreChoice)];
      entry.restored.add(node.name);
      changed(true);
      focusChoice(node);
    };
    const resetRange = bindNodeSelection(list, '[data-choice]', '.setup-node-choice', (names, checked, last) => {
      const node = filtered.find(node => node.name === last);
      updatePicks(names, checked);
      changed(true);
      focusChoice(node);
    });
    visibleSelect.onchange = () => {
      resetRange();
      updatePicks(filtered.map(node => node.name), visibleSelect.checked);
      changed(true);
      if (visibleSelect.disabled) membersOnly.focus({ preventScroll: true });
    };
    search.oninput = stateFilter.onchange = membersOnly.onchange = () => {
      resetRange();
      renderChoices(true);
    };
    search.onkeydown = event => {
      if (event.key === 'Enter' && !event.isComposing) event.preventDefault();
    };
    return item;
  }

  // ========================================================
  // 视图 2：分流规则与实时匹配测试器 (精确与待定分流)
  // ========================================================

  function renderRulesView() {
    el.mainStage.innerHTML = '';
    const prof = getCurrentProfile();
    if (!prof) return;

    const published = getPublishedSnapshot(prof);
    if (!state.catalog || (prof.publishedVersion && !published)) {
      return renderDeferred(el.mainStage, '正在加载分流规则…',
        () => Promise.all([ensureCatalog(), ensurePublishedSnapshot(prof)]), renderRulesView);
    }
    const publishedProf = published?.profile || prof;
    const publishedRules = published?.effectiveRules;
    const companyDomain = prof.rules.find(rule => rule.enabled && rule.type === 'DOMAIN-SUFFIX' && rule.target.includes('公司'))?.value;
    const companySubnet = state.data.company.cidrs[0];
    const examples = [companyDomain, companySubnet?.split('/')[0], 'gemini.google.com', 'youtube.com', 'baidu.com'].filter(Boolean);
    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '16px';

    const testerBox = document.createElement('div');
    testerBox.className = 'tester-box';
    testerBox.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
        <span style="font-weight: 700; color: #fff; font-size: 14px; display: flex; align-items: center; gap: 6px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          分流规则匹配实时测试器
        </span>
      </div>

      <div class="tester-input-row">
        <input type="text" id="ruleTestInput" class="input-text" value="${escapeHtml(state.ruleTestInput)}" placeholder="输入待测域名或 IP" aria-label="分流测试输入" />
        <button id="runRuleTestBtn" class="btn btn-primary">立即评估</button>
      </div>

      <div class="quick-test-chips">
        ${examples.map(value => `<button type="button" class="chip" data-test="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join('')}
      </div>

      <div id="testResultDisplay" class="test-result-display"></div>
    `;

    testerBox.querySelectorAll('.chip').forEach(chip => {
      chip.onclick = () => {
        state.ruleTestInput = chip.getAttribute('data-test');
        testerBox.querySelector('#ruleTestInput').value = state.ruleTestInput;
        runEvaluation();
      };
    });

    testerBox.querySelector('#runRuleTestBtn').onclick = () => {
      state.ruleTestInput = testerBox.querySelector('#ruleTestInput').value.trim();
      runEvaluation();
    };

    testerBox.querySelector('#ruleTestInput').onkeydown = (e) => {
      if (e.key === 'Enter') {
        state.ruleTestInput = testerBox.querySelector('#ruleTestInput').value.trim();
        runEvaluation();
      }
    };

    let evaluationRun = 0;
    async function runEvaluation() {
      const input = state.ruleTestInput;
      if (!input) return;

      const run = ++evaluationRun;
      const resDisplay = testerBox.querySelector('#testResultDisplay');
      const { issued, pending } = getEditState(prof);
      const publishedLabel = `已发布 · v${prof.publishedVersion}`;
      const legacy = new Map();
      const evaluate = () => issued && pending
        ? compareEvaluation(input, prof, publishedProf, state.data.company, publishedRules, legacy)
        : { current: issued
          ? evaluateTarget(input, publishedProf, state.data.company, publishedRules, legacy)
          : evaluateTarget(input, prof, state.data.company, undefined, legacy) };
      let results = evaluate();
      const catalog = publicRuleCatalog();
      const geositeIds = new Set(Object.values(results).flatMap(result => result?.priorIndeterminate || [])
        .filter(({ rule }) => rule.type === 'GEOSITE' && catalog.has(rule.value.toLowerCase()))
        .map(({ rule }) => rule.value.toLowerCase()));
      if (geositeIds.size) {
        resDisplay.classList.add('is-single');
        resDisplay.innerHTML = '<p class="empty-message" role="status">正在核对规则…</p>';
        await forPublicRules([...geositeIds], async id => legacy.set(id, (await fetchPublicRule(id)).entries));
        if (run !== evaluationRun || !resDisplay.isConnected) return;
        results = evaluate();
      }

      function formatResultCard(title, res, isDiff) {
        const blockers = res.priorIndeterminate || [];
        const isUncertain = blockers.length > 0;
        const uncertainty = blockers.some(({ rule }) => ['GEOSITE', 'RULE-SET'].includes(rule.type))
          ? '还需核对排在前面的规则集。'
          : '还需核对目标 IP 的地区。';
        const publicRule = catalog.get(res.publicRuleId?.toLowerCase());
        const rule = publicRule ? `公共规则集 · ${publicRule.name}` : res.rule?.displayRule;
        const hasPosition = Number.isInteger(res.ruleIndex);
        return `
          <div class="test-result-card ${isDiff ? 'is-diff' : ''} ${isUncertain ? 'is-uncertain' : ''}">
            <div class="test-card-header">
              <span>${title}</span>
              ${isDiff ? '<span class="badge badge-draft">有差异</span>' : ''}
            </div>
            <div class="test-target-val">${res.success ? `${isUncertain ? '可能走 ' : ''}${escapeHtml(res.target)}` : isUncertain ? '暂无法确认出口' : '未命中'}</div>
            <div class="test-rule-line">${escapeHtml(rule || (isUncertain ? '' : res.message || ''))}</div>
            <div class="test-reason">${escapeHtml(isUncertain ? uncertainty : res.reason || '')}${hasPosition && !isUncertain ? `（第 ${res.ruleIndex} 条有效规则）` : ''}</div>
          </div>
        `;
      }

      if (results.current) {
        resDisplay.classList.add('is-single');
        resDisplay.innerHTML = formatResultCard(issued ? publishedLabel : '当前配置', results.current, false);
        return;
      }
      const comp = results;
      const matchSummary = result => [
        result.target, result.status, result.publicRuleId || result.rule?.displayRule,
        result.matchedValue, result.priorIndeterminate?.[0]?.rule.type
      ];
      const publishedMatch = matchSummary(comp.published);
      const compare = matchSummary(comp.draft).some((value, index) => value !== publishedMatch[index]);
      resDisplay.classList.toggle('is-single', !compare);
      if (compare) {
        resDisplay.innerHTML = formatResultCard('草稿', comp.draft, true) +
          formatResultCard(publishedLabel, comp.published, false);
      } else {
        resDisplay.innerHTML = formatResultCard(`草稿与 v${prof.publishedVersion} 的匹配结果一致`, comp.draft, false);
      }
    }

    container.appendChild(testerBox);

    // 规则表格
    const rulePanel = document.createElement('div');
    rulePanel.className = 'panel';
    const rules = prof.rules || [];
    const sortable = rules.some((rule, index) => index > 0 && rule.type !== 'MATCH');
    rulePanel.innerHTML = `
      <div class="panel-header">
        <span class="panel-title">当前配置规则链 (${rules.length} 条定义)</span>
        <div class="rule-panel-actions">
          ${sortable ? '<button type="button" id="adjustRuleOrder" class="btn btn-default btn-sm" aria-haspopup="dialog">调整顺序</button>' : ''}
          <button type="button" id="addRuleBtn" class="btn btn-default btn-sm">+ 添加规则</button>
        </div>
      </div>
      <div class="panel-body" style="padding: 0;">
        <div class="rule-table-container">
          <table class="rule-table rules-flow-table" role="table">
            <thead>
              <tr>
                <th style="width: 50px;">序号</th>
                <th style="width: 140px;">类型</th>
                <th>匹配表达式 / 网段</th>
                <th style="width: 180px;">目标策略组</th>
                <th style="width: 110px;">no-resolve</th>
                <th style="width: 80px;">操作</th>
              </tr>
            </thead>
            <tbody id="ruleTableBody"></tbody>
          </table>
        </div>
      </div>
    `;

    const tbody = rulePanel.querySelector('#ruleTableBody');
    (prof.rules || []).forEach((r, idx) => {
      const tr = document.createElement('tr');
      const isCompany = r.type === 'COMPANY';

      tr.innerHTML = `
        <td class="tabular-nums" style="color: var(--text-dim);">${idx + 1}</td>
        <td><span class="badge ${isCompany ? 'rule-company-tag' : 'badge-version'}">${r.type}</span></td>
        <td>
          ${isCompany
            ? `<span style="color: #d8b4fe; font-weight: 600;">公司共享网段 · ${state.data.company.cidrs.length} 个</span>`
            : `<span style="font-family: var(--font-mono); color: #fff;">${escapeHtml(r.value || '(全部流量)')}</span>`
          }
        </td>
        <td><strong style="color: var(--primary);">${escapeHtml(r.target)}</strong></td>
        <td>${r.noResolve ? '<span class="status-pill status-pill-none">no-resolve</span>' : '<span class="rule-empty-flag">—</span>'}</td>
        <td><button class="btn btn-subtle btn-sm btn-del-rule" aria-label="删除第 ${idx + 1} 条规则" style="color: #fca5a5;">删除</button></td>
      `;

      tr.querySelector('.btn-del-rule').onclick = () => {
        if (!confirm(`确定删除第 ${idx + 1} 条规则吗？`)) return;
        prof.rules.splice(idx, 1);
        updateTopbarBadges();
        renderRulesView();
      };

      tbody.appendChild(tr);
    });

    rulePanel.querySelector('#addRuleBtn').onclick = () => {
      promptAddRule(prof);
    };
    const orderButton = rulePanel.querySelector('#adjustRuleOrder');
    if (orderButton) orderButton.onclick = () => openRuleOrder(prof, orderButton, () => {
      updateTopbarBadges();
      renderRulesView();
      el.mainStage.querySelector('#runRuleTestBtn')?.focus();
    });

    container.appendChild(rulePanel);
    el.mainStage.appendChild(container);
    runEvaluation();
  }

  function openRuleOrder(profile, trigger, onApply) {
    const original = profile.rules;
    const catalog = publicRuleCatalog();
    openOrderEditor({
      trigger, title: '调整分流顺序', unit: '条', label: '规则',
      entries: original.map(rule => ({
        value: rule,
        name: rule.type === 'COMPANY' ? '公司共享网段' : rule.type === 'MATCH' ? '兜底规则'
          : (rule.type === 'GEOSITE' ? catalog.get(rule.value?.toLowerCase())?.name : '') || rule.value,
        detail: `${rule.type} · ${rule.target}`,
        searchText: rule.value,
        locked: rule.type === 'MATCH'
      })),
      onApply(ordered) {
        if (profile.rules !== original) return;
        profile.rules = ordered;
        onApply();
      }
    });
  }

  function openOrderEditor({ trigger, title, unit, label, entries, onApply }) {
    const movable = entries.filter(entry => !entry.locked);
    const locked = entries.filter(entry => entry.locked);
    const orderedEntries = () => [...movable, ...locked];
    const hasChanges = () => orderedEntries().some((entry, index) => entry !== entries[index]);
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog-box node-picker group-setup-dialog rule-order-dialog';
    dialog.setAttribute('aria-labelledby', 'ruleOrderTitle');
    dialog.innerHTML = `
      <div class="group-setup-form">
        <div class="dialog-header"><h2 class="panel-title" id="ruleOrderTitle">${escapeHtml(title)}</h2></div>
        <div class="rule-picker-filter">
          <input type="search" class="input-text" aria-label="${label === '规则' ? '搜索规则或策略组' : '搜索节点或来源'}" placeholder="${label === '规则' ? '搜索规则或策略组' : '搜索节点或来源'}">
          <span class="rule-picker-count" hidden></span>
        </div>
        <ol class="rule-order-list" aria-label="${label}顺序"></ol>
        <p class="rule-order-empty empty-message" hidden>没有匹配的${label}。</p>
        <div class="dialog-footer group-setup-footer">
          <span class="group-setup-summary" role="status"></span>
          <button type="button" class="btn btn-default" data-order-cancel autofocus>取消</button>
          <button type="button" class="btn btn-primary" data-order-apply hidden>应用到草稿</button>
        </div>
      </div>
    `;
    const search = dialog.querySelector('input');
    const count = dialog.querySelector('.rule-picker-count');
    const list = dialog.querySelector('ol');
    const noResults = dialog.querySelector('.rule-order-empty');
    const status = dialog.querySelector('[role="status"]');
    const apply = dialog.querySelector('[data-order-apply]');
    let editing = null;

    function renderOrder() {
      cancelDrag();
      const ordered = orderedEntries();
      const query = search.value.trim().toLowerCase();
      const visible = ordered.map((entry, index) => ({ entry, index })).filter(({ entry }) =>
        !query || [entry.name, entry.detail, entry.searchText].some(value => value?.toLowerCase().includes(query)));
      count.hidden = !query;
      count.textContent = `${visible.length} / ${ordered.length} ${unit}`;
      apply.hidden = !hasChanges();
      list.innerHTML = visible.map(({ entry, index }) => `
        <li class="rule-order-row" data-order-index="${index}" ${entry.locked ? 'data-order-locked' : ''}>
          <span class="rule-order-grip" aria-hidden="true">${entry.locked ? '' : '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><circle cx="5" cy="4" r="1"/><circle cx="10" cy="4" r="1"/><circle cx="5" cy="8" r="1"/><circle cx="10" cy="8" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="10" cy="12" r="1"/></svg>'}</span>
          <span class="rule-order-index tabular-nums">第 ${index + 1} ${unit}</span>
          <div class="rule-order-summary">
            <strong title="${escapeHtml(entry.searchText || entry.name)}">${escapeHtml(entry.name)}</strong>
            ${entry.detail ? `<span>${escapeHtml(entry.detail)}</span>` : ''}
          </div>
          ${entry.locked ? '<span class="rule-order-fixed">固定末尾</span>'
            : `<button type="button" class="btn btn-subtle btn-sm" data-order-move aria-label="移动第 ${index + 1} ${unit}${label}" aria-expanded="${editing === entry}">移到…</button>`}
          ${editing === entry ? `<form class="rule-order-position">
            <label for="ruleOrderPosition">移到第</label>
            <input id="ruleOrderPosition" class="input-text" type="number" inputmode="numeric" min="1" max="${movable.length}" step="1" value="${index + 1}" required>
            <span>${unit}</span>
            <button type="submit" class="btn btn-default btn-sm">移动</button>
            <button type="button" class="btn btn-subtle btn-sm" data-order-position-cancel>取消</button>
          </form>` : ''}
        </li>`).join('');
      list.hidden = !visible.length;
      noResults.hidden = Boolean(visible.length);
    }

    function moveEntry(entry, position) {
      const from = movable.indexOf(entry);
      if (from < 0 || !Number.isInteger(position) || position < 0 || position >= movable.length) return;
      editing = null;
      if (from !== position) {
        movable.splice(from, 1);
        movable.splice(position, 0, entry);
        status.textContent = `已移到第 ${position + 1} ${unit}`;
      }
      renderOrder();
      list.querySelector(`[data-order-index="${position}"] [data-order-move]`)?.focus();
    }

    search.oninput = () => {
      editing = null;
      status.textContent = '';
      renderOrder();
      list.scrollTop = 0;
    };
    list.onclick = event => {
      const row = event.target.closest('[data-order-index]');
      if (!row) return;
      if (event.target.closest('[data-order-move]')) {
        const entry = movable[Number(row.dataset.orderIndex)];
        editing = editing === entry ? null : entry;
        renderOrder();
        const input = list.querySelector('#ruleOrderPosition');
        if (input) {
          input.focus();
          input.select();
        } else {
          list.querySelector(`[data-order-index="${row.dataset.orderIndex}"] [data-order-move]`)?.focus();
        }
      } else if (event.target.closest('[data-order-position-cancel]')) {
        editing = null;
        renderOrder();
        list.querySelector(`[data-order-index="${row.dataset.orderIndex}"] [data-order-move]`)?.focus();
      }
    };
    list.onsubmit = event => {
      event.preventDefault();
      moveEntry(editing, event.target.querySelector('input').valueAsNumber - 1);
    };

    const cancelDrag = enableOrderDragging(dialog, list, (from, to) => moveEntry(movable[from], to));
    dialog.querySelector('[data-order-cancel]').onclick = () => dialog.close();
    apply.onclick = () => {
      if (!hasChanges()) return;
      dialog.close();
      onApply(orderedEntries().map(entry => entry.value));
    };
    dialog.addEventListener('close', () => {
      cancelDrag();
      dialog.remove();
      if (trigger.isConnected) trigger.focus();
    });
    el.modalContainer.appendChild(dialog);
    renderOrder();
    dialog.showModal();
  }

  function isOrderControl(target) {
    const control = target.closest('button, input, form, label, a, select, summary, [contenteditable]');
    return control && !control.matches('.node-priority-select');
  }

  function enableOrderDragging(scope, list, onMove, { grid = false, scroller = list, layer = scope, getBlock, canHold } = {}) {
    let drag = null;
    let frame = 0;
    let holdTimer = 0;
    let suppressClick = false;
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

    function finish(commit = false) {
      clearTimeout(holdTimer);
      if (!drag) return;
      const { row, next, index, pointer, ghost, original, block, positioned } = drag;
      drag = null;
      cancelAnimationFrame(frame);
      if (pointer !== undefined && list.hasPointerCapture(pointer)) list.releasePointerCapture(pointer);
      if (!ghost) return;
      for (const item of list.children) {
        for (const animation of item.getAnimations()) animation.cancel();
      }
      ghost.remove();
      for (const item of block) item.removeAttribute('data-order-placeholder');
      scope.classList.remove('is-order-dragging');
      if (grid) {
        if (!commit || !positioned) list.replaceChildren(...original);
        else onMove(index, [...list.children].indexOf(block[0]), block);
        return;
      }
      const sibling = row.nextElementSibling;
      if (!commit || sibling === next) {
        list.insertBefore(row, next);
        return;
      }
      const nextIndex = Number(sibling?.dataset.orderIndex);
      const destination = nextIndex < index ? nextIndex : Number(row.previousElementSibling?.dataset.orderIndex);
      onMove(index, destination);
    }

    function renderDrag() {
      if (!list.isConnected) {
        finish();
        return;
      }
      const { x, y, offsetX, offsetY, ghost, block, picked, scrollTarget } = drag;
      const scrollBox = scrollTarget.getBoundingClientRect();
      const edge = Math.min(42, scrollBox.height / 4);
      if (x >= scrollBox.left && x <= scrollBox.right && y >= scrollBox.top - edge && y <= scrollBox.bottom + edge) {
        const scroll = y < scrollBox.top + edge ? -8 : y > scrollBox.bottom - edge ? 8 : 0;
        if (scroll) scrollTarget.scrollTop += scroll;
      }
      const box = list.getBoundingClientRect();
      ghost.style.transform = `translate3d(${x - offsetX}px, ${y - offsetY}px, 0)`;
      const rows = [...list.children].filter(candidate => !picked.has(candidate));
      const following = block.at(-1).nextElementSibling;
      let before;
      if (grid) {
        const hit = distanceMoved() < 5 ? null : rows.find(candidate => {
          const left = box.left + candidate.offsetLeft;
          const top = box.top + candidate.offsetTop;
          return x >= left && x < left + candidate.offsetWidth && y >= top && y < top + candidate.offsetHeight;
        });
        before = hit ? (hit.compareDocumentPosition(block[0]) & Node.DOCUMENT_POSITION_FOLLOWING ? hit : hit.nextElementSibling)
          : following;
      } else {
        before = rows.find(candidate => candidate.hasAttribute('data-order-locked') ||
          box.top + candidate.offsetTop - list.scrollTop + candidate.offsetHeight / 2 > y) || null;
      }
      if (following !== before) {
        drag.positioned = true;
        const starts = reduceMotion.matches ? [] : rows.map(candidate => [candidate, candidate.getBoundingClientRect()]);
        for (const item of block) list.insertBefore(item, before);
        for (const [candidate, start] of starts) {
          for (const animation of candidate.getAnimations()) animation.cancel();
          const end = candidate.getBoundingClientRect();
          const dx = start.left - end.left;
          const dy = start.top - end.top;
          if (Math.abs(dx) + Math.abs(dy) > 1) candidate.animate([
            { transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0)' }
          ], { duration: 145, easing: 'ease-out' });
        }
      }
      frame = requestAnimationFrame(renderDrag);
    }

    function begin(target, x, y, { pointer, touch } = {}) {
      if (drag || isOrderControl(target) || list.querySelector('.node-priority-position')) return false;
      const row = target.closest('[data-order-index]:not([data-order-locked])');
      if (!row || (touch !== undefined && !canHold(row))) return false;
      const original = [...list.children];
      const block = getBlock ? getBlock(row) : [row];
      if (grid && block.length === original.length) return false;
      const bounds = row.getBoundingClientRect();
      drag = {
        row, bounds, next: row.nextElementSibling, index: Number(row.dataset.orderIndex),
        original, block, picked: new Set(block), pointer, touch,
        offsetX: x - bounds.left, offsetY: y - bounds.top, startX: x, startY: y, x, y,
        scrollTarget: typeof scroller === 'function' ? scroller() : scroller,
        positioned: false,
      };
      return true;
    }

    function distanceMoved() {
      return Math.hypot(drag.x - drag.startX, drag.y - drag.startY);
    }

    function activate() {
      if (!drag || drag.ghost || !drag.row.isConnected) return;
      suppressClick = true;
      if (drag.pointer !== undefined) list.setPointerCapture(drag.pointer);
      const ghost = drag.row.cloneNode(true);
      for (const element of ghost.querySelectorAll('[id]')) element.removeAttribute('id');
      ghost.removeAttribute('data-order-index');
      ghost.classList.add('rule-order-ghost');
      ghost.inert = true;
      ghost.setAttribute('aria-hidden', 'true');
      ghost.style.width = `${drag.bounds.width}px`;
      if (drag.block.length > 1) {
        const count = document.createElement('span');
        count.className = 'node-priority-drag-count';
        count.textContent = `${drag.block.length} 个节点`;
        ghost.append(count);
      }
      drag.ghost = ghost;
      const afterFirst = drag.original.slice(drag.original.indexOf(drag.block[0])).find(item => !drag.picked.has(item)) || null;
      for (const item of drag.block) {
        item.setAttribute('data-order-placeholder', '');
        if (drag.block.length > 1) list.insertBefore(item, afterFirst);
      }
      scope.classList.add('is-order-dragging');
      layer.append(ghost);
      renderDrag();
    }

    function drop(x, y) {
      if (!drag.ghost) {
        finish();
        return;
      }
      drag.x = x;
      drag.y = y;
      const box = list.getBoundingClientRect();
      const scrollBox = drag.scrollTarget.getBoundingClientRect();
      finish(y >= Math.max(box.top, scrollBox.top) && y <= Math.min(box.bottom, scrollBox.bottom) &&
        x >= Math.max(box.left, scrollBox.left) && x <= Math.min(box.right, scrollBox.right));
    }

    list.addEventListener('click', event => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    list.onpointerdown = event => {
      suppressClick = false;
      if (event.button !== 0 || event.pointerType !== 'mouse' || event.metaKey || event.ctrlKey || event.shiftKey ||
        (!grid && matchMedia('(max-width: 768px)').matches)) return;
      if (!begin(event.target, event.clientX, event.clientY, { pointer: event.pointerId })) return;
      if (!grid) {
        event.preventDefault();
        list.setPointerCapture(event.pointerId);
      }
    };
    list.onpointermove = event => {
      if (drag?.pointer !== event.pointerId) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (!drag.ghost && distanceMoved() >= 5) activate();
    };
    list.onpointerup = event => {
      if (drag?.pointer === event.pointerId) drop(event.clientX, event.clientY);
    };
    list.onpointercancel = event => {
      if (event.pointerId === drag?.pointer || (event.pointerType === 'touch' && drag?.touch !== undefined)) finish();
    };
    list.onlostpointercapture = event => {
      if (event.pointerId === drag?.pointer) finish();
    };
    list.onpointerleave = () => {
      if (drag && drag.pointer !== undefined && !drag.ghost && !list.hasPointerCapture(drag.pointer)) finish();
    };
    if (canHold) {
      list.addEventListener('touchstart', event => {
        if (event.touches.length !== 1) {
          finish();
          return;
        }
        suppressClick = false;
        const point = event.changedTouches[0];
        if (begin(event.target, point.clientX, point.clientY, { touch: point.identifier }))
          holdTimer = setTimeout(activate, 380);
      }, { passive: true });
      list.addEventListener('touchmove', event => {
        const point = [...event.changedTouches].find(touch => touch.identifier === drag?.touch);
        if (!point) return;
        drag.x = point.clientX;
        drag.y = point.clientY;
        if (drag.ghost && event.cancelable) event.preventDefault();
        else if (distanceMoved() > 8) finish();
      }, { passive: false });
      list.addEventListener('touchend', event => {
        const point = [...event.changedTouches].find(touch => touch.identifier === drag?.touch);
        if (!point) return;
        if (drag.ghost && event.cancelable) event.preventDefault();
        drop(point.clientX, point.clientY);
      }, { passive: false });
      list.addEventListener('touchcancel', event => {
        if ([...event.changedTouches].some(touch => touch.identifier === drag?.touch)) finish();
      });
      list.addEventListener('contextmenu', event => {
        if (drag && drag.touch !== undefined) event.preventDefault();
      });
    }
    scope.addEventListener('keydown', event => {
      if (event.key === 'Escape' && drag) {
        event.preventDefault();
        finish();
      }
    });
    return finish;
  }

  function manualRuleFields() {
    return `
      <label for="newRuleType">规则类型</label>
      <select id="newRuleType" class="input-text">
        <option value="DOMAIN-SUFFIX">域名后缀</option>
        <option value="DOMAIN">精确域名</option>
        <option value="DOMAIN-KEYWORD">域名关键字</option>
        <option value="IP-CIDR">IPv4 网段</option>
        <option value="IP-CIDR6">IPv6 网段</option>
        <option value="GEOIP">IP 地区</option>
      </select>
      <label for="newRuleValue">匹配表达式</label>
      <input type="text" id="newRuleValue" class="input-text" placeholder="例如 api.anthropic.com 或 192.168.1.0/24" autocomplete="off" />
    `;
  }

  function readManualRule(container, target) {
    const value = container.querySelector('#newRuleValue').value.trim();
    if (!value) return null;
    return {
      type: container.querySelector('#newRuleType').value,
      value, target,
      noResolve: container.querySelector('#newRuleNoResolve').checked,
      enabled: true
    };
  }

  function promptAddRule(profile) {
    const groupNames = (profile.groups || []).map(g => g.name);
    const nodeNames = (profile.nodes || []).map(n => n.name);
    const modal = document.createElement('div');
    modal.className = 'dialog-overlay';
    modal.innerHTML = `
      <div class="dialog-box">
        <div class="dialog-header">
          <span style="font-weight: 700; color: #fff;">添加前置分流规则</span>
          <button class="btn btn-subtle btn-sm close-modal">✕</button>
        </div>
        <div class="dialog-body">
          <div class="manual-rule-fields">${manualRuleFields()}</div>
          <div>
            <label for="newRuleTarget" style="display:block; margin-bottom: 4px; font-weight: 600;">目标策略组或节点</label>
            <select id="newRuleTarget" class="input-text" style="width: 100%;">
              <optgroup label="内置动作">
                <option value="DIRECT">🎯 DIRECT (直连)</option>
                <option value="REJECT">🛑 REJECT (拦截)</option>
              </optgroup>
              <optgroup label="策略组">
                ${groupNames.map(gn => `<option value="${escapeHtml(gn)}">${escapeHtml(gn)}</option>`).join('')}
              </optgroup>
              ${nodeNames.length > 0 ? `
              <optgroup label="内置节点">
                ${nodeNames.map(nn => `<option value="${escapeHtml(nn)}">${escapeHtml(nn)}</option>`).join('')}
              </optgroup>
              ` : ''}
            </select>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <input type="checkbox" id="newRuleNoResolve" />
            <label for="newRuleNoResolve" style="cursor: pointer;">no-resolve (不触发本地 DNS 解析)</label>
          </div>
        </div>
        <div class="dialog-footer">
          <button class="btn btn-default close-modal">取消</button>
          <button id="confirmAddRuleBtn" class="btn btn-primary">确定添加</button>
        </div>
      </div>
    `;

    modal.querySelectorAll('.close-modal').forEach(b => b.onclick = () => modal.remove());
    modal.querySelector('#confirmAddRuleBtn').onclick = () => {
      const rule = readManualRule(modal, modal.querySelector('#newRuleTarget').value);
      if (!rule) {
        alert('请输入匹配表达式');
        return;
      }

      profile.rules.unshift(rule);
      updateTopbarBadges();
      modal.remove();
      renderRulesView();
      showToast(`已添加规则 ${rule.value}`, 'success');
    };

    el.modalContainer.appendChild(modal);
  }

  function publicRulesMatching(items, query) {
    const term = query.trim().toLowerCase();
    return items.filter(item => [item.id, item.name, item.description].some(value => value?.toLowerCase().includes(term)));
  }

  function openGroupRulePicker(profile, group) {
    const catalog = state.catalog || [];
    const byId = publicRuleCatalog();
    const active = new Map();
    const inactiveHere = new Map();
    for (const rule of profile.rules) {
      if (rule.type !== 'GEOSITE' || !rule.value) continue;
      const id = rule.value.toLowerCase();
      if (rule.enabled !== false && !active.has(id)) active.set(id, rule);
      if (rule.enabled === false && rule.target === group.name && !inactiveHere.has(id)) inactiveHere.set(id, rule);
    }

    const dialog = document.createElement('dialog');
    dialog.className = 'dialog-box node-picker group-setup-dialog group-rule-picker';
    dialog.setAttribute('aria-labelledby', 'groupRulePickerTitle');
    dialog.innerHTML = `
      <form class="group-setup-form">
        <div class="dialog-header"><h2 class="panel-title" id="groupRulePickerTitle">添加规则 · ${escapeHtml(group.name)}</h2></div>
        <div class="group-tabs" role="group" aria-label="添加方式">
          <button type="button" class="group-tab" data-rule-tab="catalog" aria-pressed="true">公共规则集</button>
          <button type="button" class="group-tab" data-rule-tab="manual" aria-pressed="false">自定义规则</button>
        </div>
        <section class="rule-picker-catalog">
          <div class="rule-picker-filter">
            <input type="search" class="input-text" aria-label="搜索公共规则集" placeholder="搜索名称或规则集 ID" autofocus>
            <span class="rule-picker-count tabular-nums"></span>
          </div>
          <div class="rule-picker-scroll">
            <div class="rule-picker-results"></div>
            <button type="button" class="btn btn-subtle btn-sm rule-picker-more" hidden>显示更多</button>
          </div>
        </section>
        <section class="rule-picker-manual" hidden>
          <div class="manual-rule-fields">${manualRuleFields()}</div>
          <label class="manual-no-resolve"><input type="checkbox" id="newRuleNoResolve"> no-resolve（跳过 DNS 解析）</label>
        </section>
        <div class="dialog-footer group-setup-footer">
          <p class="group-setup-error" id="groupRuleError" role="alert" hidden></p>
          <output class="group-setup-summary" aria-live="polite"></output>
          <button type="button" class="btn btn-default rule-picker-cancel">取消</button>
          <button type="submit" class="btn btn-primary" id="confirmGroupRule">绑定到本组</button>
        </div>
      </form>
    `;
    const search = dialog.querySelector('input[type=search]');
    const count = dialog.querySelector('.rule-picker-count');
    const results = dialog.querySelector('.rule-picker-results');
    const more = dialog.querySelector('.rule-picker-more');
    const summary = dialog.querySelector('output');
    const submit = dialog.querySelector('#confirmGroupRule');
    const manual = dialog.querySelector('.rule-picker-manual');
    const error = dialog.querySelector('#groupRuleError');
    const selected = new Set();
    let mode = 'catalog';
    let loading = false;
    const pageSize = 24;
    let limit = pageSize;

    function updateFooter() {
      const ids = [...selected];
      const rebound = ids.filter(id => active.has(id)).length;
      submit.disabled = loading || (mode === 'catalog' && !selected.size);
      dialog.querySelector('.rule-picker-catalog').inert = loading;
      dialog.querySelectorAll('[data-rule-tab]').forEach(tab => { tab.disabled = loading; });
      submit.textContent = loading ? '正在读取规则…' : mode === 'manual' ? '添加规则' : selected.size ? `绑定 ${selected.size} 项` : '绑定到本组';
      const names = ids.slice(0, 2).map(id => byId.get(id).name).join('、') + (ids.length > 2 ? '等' : '');
      summary.textContent = mode === 'catalog' && ids.length ? [names, rebound && `${rebound} 项将改绑`].filter(Boolean).join(' · ') : '';
    }

    function renderList() {
      const matching = publicRulesMatching(catalog, search.value);
      count.textContent = `${matching.length} 项`;
      more.hidden = matching.length <= limit;
      results.innerHTML = matching.slice(0, limit).map(item => {
        const rule = active.get(item.id);
        const attached = rule?.target === group.name;
        const status = attached ? '已引用' : rule ? `流向 ${rule.target}` : inactiveHere.has(item.id) ? '已停用' : '';
        const detail = rule?.publicSet || state.publicRuleDetails.get(item.id)?.detail;
        return `<div class="rule-picker-row">
          <div class="rule-picker-item">
            <button type="button" class="rule-picker-name" data-catalog-detail="${escapeHtml(item.id)}" aria-haspopup="dialog">${escapeHtml(item.name)}</button>
            ${detail ? `<span class="rule-picker-entry-count">${detail.entries.length} 条</span>` : ''}
            ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ''}
          </div>
          ${status ? `<span class="rule-picker-status${attached ? ' is-attached' : ''}" title="${escapeHtml(status)}">${escapeHtml(status)}</span>` : ''}
          ${attached ? '' : `<label class="rule-picker-toggle"><input type="checkbox" class="rule-picker-check" data-catalog-rule="${escapeHtml(item.id)}" aria-label="${rule ? '改绑' : '选择'} ${escapeHtml(item.name)}" ${selected.has(item.id) ? 'checked' : ''}></label>`}
        </div>`;
      }).join('') || '<p class="empty-message">没有匹配的公共规则集。</p>';
    }

    search.oninput = () => {
      limit = pageSize;
      renderList();
      results.parentElement.scrollTop = 0;
    };
    search.onkeydown = event => {
      if (event.key === 'Enter' && !event.isComposing) event.preventDefault();
    };
    more.onclick = () => {
      limit += pageSize;
      renderList();
      if (more.hidden) results.lastElementChild?.querySelector('button')?.focus({ preventScroll: true });
    };
    results.onchange = event => {
      const id = event.target.dataset.catalogRule;
      if (!id) return;
      if (event.target.checked) selected.add(id);
      else selected.delete(id);
      updateFooter();
    };
    results.onclick = event => {
      const button = event.target.closest('[data-catalog-detail]');
      if (!button) return;
      const id = button.dataset.catalogDetail;
        showPublicRuleDetail(byId.get(id), () => {
        if (!dialog.open) return;
        renderList();
        [...results.querySelectorAll('[data-catalog-detail]')].find(node => node.dataset.catalogDetail === id)?.focus({ preventScroll: true });
      }, active.get(id)?.publicSet || inactiveHere.get(id)?.publicSet);
    };
    dialog.querySelectorAll('[data-rule-tab]').forEach(button => {
      button.onclick = () => {
        mode = button.dataset.ruleTab;
        dialog.classList.toggle('is-manual', mode === 'manual');
        manual.hidden = mode !== 'manual';
        dialog.querySelector('.rule-picker-catalog').hidden = mode === 'manual';
        dialog.querySelectorAll('[data-rule-tab]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
        error.hidden = true;
        updateFooter();
      };
    });
    dialog.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      if (loading) return;
      error.hidden = true;
      const additions = [];
      if (mode === 'manual') {
        const rule = readManualRule(dialog, group.name);
        if (!rule) {
          error.textContent = '请输入匹配表达式。';
          error.hidden = false;
          dialog.querySelector('#newRuleValue').focus();
          return;
        }
        additions.push(rule);
      } else {
        if (!selected.size) return;
        const ids = [...selected];
        loading = true;
        updateFooter();
        const missing = ids.filter(id => !active.has(id) && !inactiveHere.has(id));
        const snapshots = await readRuleSnapshots(missing);
        loading = false;
        if (!dialog.open) return;
        updateFooter();
        if (!snapshots) {
          error.textContent = '有规则集暂时无法读取，请重试。';
          error.hidden = false;
          return;
        }
        for (const id of ids) {
          const rule = active.get(id) || inactiveHere.get(id);
          if (rule) {
            rule.target = group.name;
            rule.enabled = true;
          } else {
            additions.push({ type: 'GEOSITE', value: id, target: group.name, enabled: true, publicSet: snapshots.get(id) });
          }
        }
      }
      profile.rules.unshift(...additions);
      dialog.close();
      updateTopbarBadges();
      renderGroupsView();
      el.mainStage.querySelector('#addGroupRule')?.focus({ preventScroll: true });
    };
    dialog.addEventListener('close', () => dialog.remove());
    dialog.querySelector('.rule-picker-cancel').onclick = () => dialog.close();
    el.modalContainer.appendChild(dialog);
    renderList();
    updateFooter();
    dialog.showModal();
  }

  // ========================================================
  // 视图 3：公共规则库 (支持多选、批量引用与详情)
  // ========================================================

  function renderPublicRulesView() {
    el.mainStage.innerHTML = '';
    if (!state.catalog) return renderDeferred(el.mainStage, '正在加载公共规则库…', ensureCatalog, renderPublicRulesView);
    const prof = getCurrentProfile();
    const rules = state.catalog;
    const container = document.createElement('div');
    container.className = 'panel';

    container.innerHTML = `
      <div class="panel-header">
        <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
          <span class="panel-title">公共规则库 (${rules.length} 个规则集)</span>
          <input type="text" id="publicRuleSearch" class="input-text" placeholder="搜索规则集 (如 openai, anthropic, ai, youtube)..." style="width: 260px;" value="${escapeHtml(state.publicRuleSearchQuery)}" aria-label="搜索公共规则集" />
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <button id="batchImportBtn" class="btn btn-primary btn-sm" hidden></button>
        </div>
      </div>
      <div class="panel-body" style="padding: 0;">
        <div class="rule-table-container">
          <table class="rule-table rule-library-table" role="table">
            <thead>
              <tr>
                <th style="width: 40px;"><input type="checkbox" id="selectAllRules" title="全选当前展示" aria-label="全选" /></th>
                <th style="width: 140px;">规则集 ID</th>
                <th style="width: 180px;">名称</th>
                <th>描述 / 说明</th>
                <th style="width: 170px;">来源</th>
                <th style="width: 140px;">操作</th>
              </tr>
            </thead>
            <tbody id="publicRuleTableBody"></tbody>
          </table>
        </div>
      </div>
    `;

    const searchInput = container.querySelector('#publicRuleSearch');
    const selectAllBox = container.querySelector('#selectAllRules');
    const batchImportBtn = container.querySelector('#batchImportBtn');

    function updateBatchBar() {
      const cnt = state.selectedPublicRuleIds.size;
      batchImportBtn.hidden = !cnt;
      batchImportBtn.textContent = `引用所选 (${cnt})`;
    }

    searchInput.oninput = () => {
      state.publicRuleSearchQuery = searchInput.value.toLowerCase();
      renderFilteredPublicRules();
    };

    function renderFilteredPublicRules() {
      const tbody = container.querySelector('#publicRuleTableBody');
      tbody.innerHTML = '';
      const q = state.publicRuleSearchQuery;
      const filtered = q ? publicRulesMatching(rules, q) : rules.slice(0, 80);
      selectAllBox.hidden = !filtered.length;
      const selectedCount = filtered.filter(item => state.selectedPublicRuleIds.has(item.id)).length;
      selectAllBox.checked = selectedCount > 0 && selectedCount === filtered.length;
      selectAllBox.indeterminate = selectedCount > 0 && selectedCount < filtered.length;
      if (!filtered.length) tbody.innerHTML = '<tr><td colspan="6" class="empty-message">没有找到匹配的规则集。</td></tr>';

      filtered.forEach(item => {
        const tr = document.createElement('tr');
        const isChecked = state.selectedPublicRuleIds.has(item.id);

        tr.innerHTML = `
          <td><input type="checkbox" class="rule-chk" data-id="${item.id}" ${isChecked ? 'checked' : ''} aria-label="选择 ${escapeHtml(item.name)}" /></td>
          <td><strong style="color: var(--primary); font-family: var(--font-mono);">${escapeHtml(item.id)}</strong></td>
          <td>${escapeHtml(item.name)}</td>
          <td style="color: var(--text-muted);">${escapeHtml(item.description || '社区维护规则集')}</td>
          <td style="font-size: 12px; color: var(--text-dim);">${escapeHtml(item.source)}</td>
          <td>
            <div style="display: flex; gap: 4px;">
              <button class="btn btn-default btn-sm btn-view-detail">详情</button>
              <button class="btn btn-primary btn-sm btn-single-import">引用</button>
            </div>
          </td>
        `;

        tr.querySelector('.rule-chk').onchange = (e) => {
          if (e.target.checked) state.selectedPublicRuleIds.add(item.id);
          else state.selectedPublicRuleIds.delete(item.id);
          const checked = tbody.querySelectorAll('.rule-chk:checked').length;
          selectAllBox.checked = checked === filtered.length;
          selectAllBox.indeterminate = checked > 0 && checked < filtered.length;
          updateBatchBar();
        };

        tr.querySelector('.btn-view-detail').onclick = () => {
          showPublicRuleDetail(item);
        };

        tr.querySelector('.btn-single-import').onclick = () => {
          promptImportPublicRules([item], prof);
        };

        tbody.appendChild(tr);
      });
    }

    selectAllBox.onchange = (e) => {
      const tbody = container.querySelector('#publicRuleTableBody');
      tbody.querySelectorAll('.rule-chk').forEach(c => {
        c.checked = e.target.checked;
        const id = c.getAttribute('data-id');
        if (e.target.checked) state.selectedPublicRuleIds.add(id);
        else state.selectedPublicRuleIds.delete(id);
      });
      selectAllBox.indeterminate = false;
      updateBatchBar();
    };

    batchImportBtn.onclick = () => {
      const selectedItems = rules.filter(r => state.selectedPublicRuleIds.has(r.id));
      if (selectedItems.length === 0) return;
      promptImportPublicRules(selectedItems, prof);
    };

    renderFilteredPublicRules();
    updateBatchBar();
    el.mainStage.appendChild(container);
  }

  function publicRuleCatalog() {
    return new Map((state.catalog || []).map(item => [item.id, item]));
  }

  function ruleSnapshot({ version, entries }) {
    return { version, entries };
  }

  async function forPublicRules(items, action) {
    const results = [];
    for (let start = 0; start < items.length; start += 4) {
      results.push(...await Promise.allSettled(items.slice(start, start + 4).map(action)));
    }
    return results;
  }

  async function readRuleSnapshots(ids) {
    const loaded = await forPublicRules(ids, async id => [id, ruleSnapshot(await fetchPublicRule(id))]);
    return loaded.some(result => result.status === 'rejected') ? null : new Map(loaded.map(result => result.value));
  }

  function fetchPublicRule(id) {
    const cached = state.publicRuleDetails.get(id);
    if (cached && Date.now() - cached.checkedAt < 60_000) return Promise.resolve(cached.detail);
    if (state.publicRuleRequests.has(id)) return state.publicRuleRequests.get(id);
    const request = (async () => {
      const response = await fetch(`/api/public-rule-detail?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
      const detail = await response.json();
      if (!response.ok || !Array.isArray(detail.entries) || !detail.version) throw new Error(detail.error || '暂时无法查看上游规则');
      state.publicRuleDetails.delete(id);
      if (state.publicRuleDetails.size >= 24) state.publicRuleDetails.delete(state.publicRuleDetails.keys().next().value);
      state.publicRuleDetails.set(id, { detail, checkedAt: Date.now() });
      return detail;
    })().finally(() => state.publicRuleRequests.delete(id));
    state.publicRuleRequests.set(id, request);
    return request;
  }

  function showPublicRuleDetail(item, onClose, snapshot, onAdopt) {
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog-box node-picker group-setup-dialog public-rule-detail';
    dialog.setAttribute('aria-labelledby', 'publicRuleDetailTitle');
    const upstream = `https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/${encodeURIComponent(item.id)}.yaml`;
    dialog.innerHTML = `
      <div class="group-setup-form">
        <div class="dialog-header">
          <h2 class="panel-title" id="publicRuleDetailTitle">${escapeHtml(item.name)}</h2>
          <button type="button" class="btn btn-subtle btn-sm public-rule-detail-close">关闭</button>
        </div>
        <div class="public-rule-detail-meta">
          <span>${snapshot ? '配置采用的版本' : '上游规则'}</span>
          <span>${escapeHtml(item.source)}</span>
          <a href="${escapeHtml(upstream)}" target="_blank" rel="noopener noreferrer">上游文件</a>
        </div>
        <div class="rule-picker-filter" hidden>
          <input type="search" class="input-text" aria-label="搜索规则集条目" placeholder="搜索规则条目">
          <span class="rule-picker-count tabular-nums"></span>
        </div>
        <div class="public-rule-entries"></div>
        ${onAdopt ? `<div class="dialog-footer group-setup-footer public-rule-adopt" hidden>
          <span class="group-setup-summary">采用上游当前内容，发布后生效。</span>
          <button type="button" class="btn btn-primary">采用此版本</button>
        </div>` : ''}
      </div>
    `;
    const output = dialog.querySelector('.public-rule-entries');
    const search = dialog.querySelector('input');
    const count = dialog.querySelector('.rule-picker-count');
    const filter = dialog.querySelector('.rule-picker-filter');
    let detail;
    function renderEntries() {
      const query = search.value.trim().toLowerCase();
      const matches = detail.entries.filter(entry => entry.toLowerCase().includes(query));
      count.textContent = query ? `${matches.length} / ${detail.entries.length} 条` : `${detail.entries.length} 条`;
      const max = 100;
      output.innerHTML = matches.length ? `<ul>${matches.slice(0, max).map(entry => `<li>${escapeHtml(entry)}</li>`).join('')}</ul>
        ${matches.length > max ? '<p class="rule-picker-count">显示前 100 条，可搜索其余条目。</p>' : ''}` : '<p class="empty-message">没有匹配的条目。</p>';
      output.scrollTop = 0;
    }
    async function load() {
      filter.hidden = true;
      output.innerHTML = '<p class="empty-message" role="status">正在读取上游规则…</p>';
      try {
        detail = snapshot || await fetchPublicRule(item.id);
        if (!dialog.open) return;
        const adopt = dialog.querySelector('.public-rule-adopt');
        if (adopt) {
          adopt.hidden = false;
          adopt.querySelector('button').onclick = () => {
            dialog.close();
            onAdopt(ruleSnapshot(detail));
          };
        }
        filter.hidden = false;
        renderEntries();
      } catch (error) {
        if (!dialog.open) return;
        output.innerHTML = `<p class="empty-message" role="alert">${escapeHtml(error.message)} <button type="button" class="btn btn-default btn-sm">重试</button></p>`;
        output.querySelector('button').onclick = load;
      }
    }
    search.oninput = renderEntries;
    dialog.querySelector('.public-rule-detail-close').onclick = () => dialog.close();
    dialog.addEventListener('close', () => {
      dialog.remove();
      onClose?.();
    });
    el.modalContainer.appendChild(dialog);
    dialog.showModal();
    load();
  }

  function showPublicRuleUpdate(item, before, latest, onClose, onApply) {
    const previous = new Set(before.entries);
    const next = new Set(latest.entries);
    const added = latest.entries.filter(entry => !previous.has(entry));
    const removed = before.entries.filter(entry => !next.has(entry));
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog-box node-picker group-setup-dialog public-rule-update';
    dialog.setAttribute('aria-labelledby', 'publicRuleUpdateTitle');
    dialog.innerHTML = `
      <div class="group-setup-form">
        <div class="dialog-header"><h2 class="panel-title" id="publicRuleUpdateTitle">${escapeHtml(item.name)} · 规则更新</h2></div>
        <div class="rule-picker-filter" ${added.length + removed.length > 16 ? '' : 'hidden'}>
          <input type="search" class="input-text" aria-label="搜索变动的规则" placeholder="搜索变动的规则">
        </div>
        <div class="public-rule-entries rule-update-diff"></div>
        <div class="dialog-footer group-setup-footer">
          <span class="group-setup-summary">发布后生效</span>
          <button type="button" class="btn btn-default rule-update-cancel" autofocus>取消</button>
          <button type="button" class="btn btn-primary rule-update-apply">更新到草稿</button>
        </div>
      </div>
    `;
    const filter = dialog.querySelector('input');
    const output = dialog.querySelector('.rule-update-diff');
    function renderChanges() {
      const query = filter.value.trim().toLowerCase();
      output.innerHTML = [[added, '新增'], [removed, '移除']].map(([entries, label]) => {
        const matches = entries.filter(entry => entry.toLowerCase().includes(query));
        return `<section><h3>${label} ${entries.length} 条</h3>
          ${matches.length ? `<ul>${matches.slice(0, 100).map(entry => `<li>${escapeHtml(entry)}</li>`).join('')}</ul>`
            : `<p class="rule-picker-count">${query ? '无匹配条目' : '无变动'}</p>`}
          ${matches.length > 100 ? '<p class="rule-picker-count">显示前 100 条，可搜索其余条目。</p>' : ''}</section>`;
      }).join('');
      output.scrollTop = 0;
    }
    filter.oninput = renderChanges;
    dialog.querySelector('.rule-update-cancel').onclick = () => dialog.close();
    dialog.querySelector('.rule-update-apply').onclick = () => {
      dialog.close();
      onApply();
    };
    dialog.addEventListener('close', () => {
      dialog.remove();
      onClose();
    });
    el.modalContainer.appendChild(dialog);
    renderChanges();
    dialog.showModal();
  }

  function promptImportPublicRules(items, profile) {
    const groupNames = (profile.groups || []).map(g => g.name);
    const nodeNames = (profile.nodes || []).map(n => n.name);
    const modal = document.createElement('div');
    modal.className = 'dialog-overlay';
    modal.innerHTML = `
      <div class="dialog-box">
        <div class="dialog-header">
          <span style="font-weight: 700; color: #fff;">引用 ${items.length} 个公共规则集</span>
          <button class="btn btn-subtle btn-sm close-modal">✕</button>
        </div>
        <div class="dialog-body">
          <div style="font-size: 13px; color: var(--text-muted);">
            将以下规则集引入到配置中:
            <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;">
              ${items.map(it => `<span class="badge badge-version">${escapeHtml(it.name)}</span>`).join('')}
            </div>
          </div>
          <div>
            <label for="batchRuleTarget" style="display:block; margin-bottom: 4px; font-weight: 600;">统一流向目标策略组或节点</label>
            <select id="batchRuleTarget" class="input-text" style="width: 100%;">
              <optgroup label="内置动作">
                <option value="DIRECT">🎯 DIRECT (直连)</option>
                <option value="REJECT">🛑 REJECT (拦截)</option>
              </optgroup>
              <optgroup label="策略组">
                ${groupNames.map(gn => `<option value="${escapeHtml(gn)}">${escapeHtml(gn)}</option>`).join('')}
              </optgroup>
              ${nodeNames.length > 0 ? `
              <optgroup label="内置节点">
                ${nodeNames.map(nn => `<option value="${escapeHtml(nn)}">${escapeHtml(nn)}</option>`).join('')}
              </optgroup>
              ` : ''}
            </select>
          </div>
        </div>
        <div class="dialog-footer">
          <button class="btn btn-default close-modal">取消</button>
          <button id="confirmBatchImportBtn" class="btn btn-primary">确认引入</button>
        </div>
      </div>
    `;

    modal.querySelectorAll('.close-modal').forEach(b => b.onclick = () => modal.remove());
    const confirmImport = modal.querySelector('#confirmBatchImportBtn');
    confirmImport.onclick = async () => {
      const target = modal.querySelector('#batchRuleTarget').value;
      confirmImport.disabled = true;
      confirmImport.textContent = '正在读取规则…';
      const existing = new Map();
      for (const rule of profile.rules) {
        const id = rule.type === 'GEOSITE' && rule.value?.toLowerCase();
        if (id && rule.enabled !== false && !existing.has(id)) existing.set(id, rule);
      }
      const snapshots = await readRuleSnapshots(items.filter(item => !existing.has(item.id)).map(item => item.id));
      if (!modal.isConnected) return;
      if (!snapshots) {
        confirmImport.disabled = false;
        confirmImport.textContent = '重试引入';
        showToast('有规则集暂时无法读取，请重试。', 'error');
        return;
      }
      const additions = [];
      for (const it of items) {
        const rule = existing.get(it.id);
        if (rule) rule.target = target;
        else additions.push({
          type: 'GEOSITE',
          value: it.id,
          target: target,
          enabled: true,
          publicSet: snapshots.get(it.id)
        });
      }
      profile.rules.unshift(...additions);
      state.selectedPublicRuleIds.clear();
      updateTopbarBadges();
      modal.remove();
      renderCurrentView();
      showToast(`已成功组合引入 ${items.length} 个规则集 -> ${target}`, 'success');
    };

    el.modalContainer.appendChild(modal);
  }

  // ========================================================
  // 视图 4：订阅源管理 (真实性维护、绝不伪造刷新)
  // ========================================================

  const speedIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 18a9 9 0 1 1 16 0H4Z"/><path d="m12 14 4-4"/><circle cx="12" cy="14" r="1"/></svg>';
  const subscriptionNotice = /剩余流量|套餐到期|到期时间|过期时间|下次重置|流量重置|官网/;
  let refreshProbeView;
  let refreshGroupProbeView;
  let sourceGridObserver;
  let probePollTimer;
  let probePolling = false;
  let probePollError = false;
  let probeEpoch = 0;

  function refreshVisibleProbe() {
    if (state.currentView === 'sources') refreshProbeView?.();
    if (state.currentView === 'groups') refreshGroupProbeView?.();
  }

  function currentProbeJobs() {
    return [...state.probeJobs.filter(job => job.status === 'running'),
      ...[...state.probeStarting.values()].map(scope => ({ scope }))];
  }

  function probeNodeKey(sourceId, updatedAt, name) {
    return JSON.stringify([sourceId, updatedAt, name]);
  }

  function probeNodeStatus(source, name, active) {
    if (!source || source.enabled === false) return null;
    const task = state.probeTasks.get(probeNodeKey(source.id, source.updatedAt, name));
    if (task) return task;
    const starting = active.some(job => {
      if (job.targets) return false;
      const { scope } = job;
      if (scope.selection) return scope.selection.some(target =>
        target.sourceId === source.id && target.sourceUpdatedAt === source.updatedAt && target.nodes.includes(name));
      return !scope.sourceId || (scope.sourceId === source.id && scope.sourceUpdatedAt === source.updatedAt &&
        (!scope.nodeName || scope.nodeName === name));
    });
    return starting ? 'queued' : null;
  }

  function probeNodeBusy(source, name, status, active) {
    return status === 'running' || Boolean(source && active.some(({ scope, results }) =>
      scope.sourceId === source.id && scope.sourceUpdatedAt === source.updatedAt && scope.nodeName === name &&
      !Object.hasOwn(results?.[source.id] || {}, name)));
  }

  function probeStatusMarkup(status) {
    return `<span class="status-pill ${status === 'running' ? 'status-pill-running' : 'status-pill-none'}">${status === 'running' ? '测速中' : '排队中'}</span>`;
  }

  function orderByLatency(nodes) {
    function score({ measurement }) {
      return measurement?.status === 'ok' && Number.isFinite(measurement.delayMs)
        ? measurement.delayMs : Number.MAX_SAFE_INTEGER;
    }
    return [...nodes].sort((left, right) => score(left) - score(right));
  }

  function applyProbeSnapshot(payload) {
    const previous = new Map(state.probeJobs.map(job => [job.id, job.status]));
    state.probeJobs = payload.jobs || (payload.job ? [payload.job] : []);
    const tasks = payload.tasks || state.probeJobs.flatMap(job => job.status === 'running'
      ? Object.entries(job.targets).flatMap(([sourceId, target]) => target.nodes
        .filter(name => !Object.hasOwn(job.results[sourceId] || {}, name))
        .map(name => ({ sourceId, sourceUpdatedAt: target.sourceUpdatedAt, name, status: 'running' }))) : []);
    state.probeTasks = new Map(tasks.map(task =>
      [probeNodeKey(task.sourceId, task.sourceUpdatedAt, task.name), task.status]));
    for (const job of state.probeJobs) {
      for (const source of state.data.sources || []) {
        const results = job.results[source.id];
        if (!results || job.targets[source.id]?.sourceUpdatedAt !== source.updatedAt) continue;
        for (const node of source.nodes || []) {
          const measurement = Object.hasOwn(results, node.name) && results[node.name];
          if (!measurement || (node.measurement?.checkedAt || '') > measurement.checkedAt) continue;
          node.measurement = measurement;
          if (!source.lastMeasurement?.finishedAt || source.lastMeasurement.finishedAt < measurement.checkedAt) {
            source.lastMeasurement = { finishedAt: measurement.checkedAt };
          }
        }
      }
      if (previous.get(job.id) !== 'running' || job.status === 'running') continue;
      if (job.status === 'done') {
        const measured = job.results[job.scope.sourceId]?.[job.scope.nodeName];
        const status = measured?.status === 'ok' ? `${measured.delayMs} ms`
          : measured?.status === 'timeout' ? '超时' : '失败';
        const message = measured ? `${job.scope.nodeName} · ${status}` : `测速完成 · ${job.completed} 个节点`;
        showToast(message, 'success');
      }
      else showToast(job.error || '测速中断，请重试', 'error');
    }
    refreshVisibleProbe();
  }

  function scheduleProbePoll(delay = 900) {
    clearTimeout(probePollTimer);
    probePollTimer = setTimeout(pollProbeJob, delay);
  }

  async function pollProbeJob() {
    if (probePolling) return;
    if (state.probeStarting.size) {
      scheduleProbePoll(150);
      return;
    }
    probePolling = true;
    const epoch = probeEpoch;
    try {
      const res = await fetch('/api/node-probe', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error();
      const payload = await res.json();
      if (!state.probeStarting.size && probeEpoch === epoch) {
        probePollError = false;
        applyProbeSnapshot(payload);
      }
    } catch {
      probePollError = currentProbeJobs().length > 0;
      refreshVisibleProbe();
    } finally {
      probePolling = false;
      if (probeEpoch !== epoch || currentProbeJobs().length) scheduleProbePoll(probePollError ? 2000 : 900);
    }
  }

  function startProbe(source, node) {
    if (node && probeNodeBusy(source, node.name, probeNodeStatus(source, node.name, []), currentProbeJobs())) return;
    return runProbe({ sourceId: source?.id, sourceUpdatedAt: source?.updatedAt, nodeName: node?.name });
  }

  async function runProbe(scope) {
    const key = JSON.stringify(scope);
    if (currentProbeJobs().some(job => JSON.stringify(job.scope) === key)) return;
    probeEpoch++;
    state.probeStarting.set(key, scope);
    refreshVisibleProbe();
    try {
      const res = await fetch('/api/node-probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scope)
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      // Responses can arrive out of order. Read the shared queue after submissions settle.
    } catch (error) {
      showToast(error.message || '无法开始测速，请重试', 'error');
    } finally {
      probeEpoch++;
      state.probeStarting.delete(key);
      refreshVisibleProbe();
      scheduleProbePoll(0);
    }
  }

  function updateProbeProgress(element, show, completed, total) {
    element.hidden = !show;
    if (!show) return;
    const description = probePollError ? '正在重新获取测速进度' : total ? `已测 ${completed} / ${total}` : '正在准备测速';
    const label = element.querySelector('.probe-progress-text');
    if (label.textContent !== description) label.textContent = description;
    const progress = element.querySelector('progress');
    if (total) {
      progress.max = total;
      progress.value = completed;
    } else {
      progress.removeAttribute('value');
    }
  }

  function updateProbeButton(button, busy, label) {
    button.setAttribute('aria-disabled', String(busy));
    if (label && button.querySelector('span').textContent !== label) button.querySelector('span').textContent = label;
  }

  function sourceTagMarkup(source, nodes, measuring) {
    const count = status => nodes.filter(node => (node.measurement?.status || 'none') === status).length;
    const statuses = [['ok', '可用', 'ok'], ['failed', '失败', 'failed'], ['timeout', '超时', 'timeout'],
      ['none', '未测量', 'none'], ['skipped', '已跳过', 'none']];
    const measuredAt = source.lastMeasurement?.finishedAt || source.lastMeasurement?.startedAt;
    return `
      <span class="badge badge-version tabular-nums">${nodes.length} 个节点</span>
      ${measuring ? '' : statuses.map(([status, label, color]) => {
        const total = count(status);
        return total ? `<span class="status-pill status-pill-${color} tabular-nums">${label} ${total}</span>` : '';
      }).join('')}
      ${measuredAt && !measuring ? `<time class="source-measured" datetime="${escapeHtml(measuredAt)}">最近测速 ${escapeHtml(new Date(measuredAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</time>` : ''}
      ${source.url || source.rawUrlStored ? '' : '<span class="badge badge-version">未配置订阅地址</span>'}
    `;
  }

  function renderSourcesView() {
    sourceGridObserver?.disconnect();
    sourceGridObserver = new ResizeObserver(entries => {
      for (const { target } of entries) target.updatePreview?.();
    });
    el.mainStage.innerHTML = '';
    const sources = state.data.sources || [];
    const canProbe = state.data.nodeProbeAvailable;
    const showSort = sources.some(source => (source.nodes || [])
      .filter(node => !subscriptionNotice.test(node.rawName || node.name)).length > 1);
    const progressMarkup = '<div class="probe-progress" hidden><span class="probe-progress-text tabular-nums"></span><progress aria-label="测速进度"></progress></div>';
    const sourceUpdates = [];
    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '16px';

    const headerBar = document.createElement('div');
    headerBar.className = 'section-heading';
    headerBar.innerHTML = `
      <h1>订阅来源</h1>
      <div class="source-actions">
        ${showSort ? `<select id="sourceNodeSort" class="input-text source-sort" aria-label="节点排序">
          <option value="latency">延迟优先</option>
          <option value="original">原顺序</option>
        </select>` : ''}
        ${canProbe && sources.some(source => source.enabled !== false && source.nodes?.some(node => !subscriptionNotice.test(node.rawName || node.name))) ? `<button type="button" class="btn btn-default btn-sm probe-all" aria-label="测速全部订阅" title="测速全部订阅">${speedIcon}<span>测速</span></button>` : ''}
        <button id="importNewSourceBtn" class="btn btn-primary btn-sm">添加来源</button>
      </div>
      ${progressMarkup}
    `;
    container.append(headerBar, renderCustomNodesPanel());

    headerBar.querySelector('#importNewSourceBtn').onclick = () => {
      promptSourceImportModal(null);
    };
    const allButton = headerBar.querySelector('.probe-all');
    const allProgress = headerBar.querySelector('.probe-progress');
    const sortMode = headerBar.querySelector('#sourceNodeSort');
    if (sortMode) {
      sortMode.value = state.sourceSort;
      sortMode.onchange = () => {
        state.sourceSort = sortMode.value;
        try { localStorage.setItem('workbench.sourceSort', state.sourceSort); } catch {}
        refreshProbeView();
      };
    }
    if (allButton) allButton.onclick = () => startProbe();

    sources.forEach((src, index) => {
      const panel = document.createElement('div');
      panel.className = 'panel';
      const notices = (src.nodes || []).filter(n => subscriptionNotice.test(n.rawName || n.name));
      const nodes = (src.nodes || []).filter(n => !subscriptionNotice.test(n.rawName || n.name));
      const hasUrl = Boolean(src.url || src.rawUrlStored);
      const canProbeSource = canProbe && src.enabled !== false && nodes.length > 0;
      const gridId = `source-nodes-${index}`;
      const infoId = `source-info-${index}`;

      panel.innerHTML = `
        <div class="panel-header">
          <div class="source-heading">
            <div class="source-title">
              <h2 class="panel-title">${escapeHtml(src.name)}</h2>
              ${notices.length ? `<button type="button" class="btn btn-subtle source-info-trigger" popovertarget="${infoId}"
                aria-label="${escapeHtml(src.name)}的订阅信息">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01" stroke-linecap="round"/></svg>
              </button>
              <div id="${infoId}" class="source-info" popover="auto">
                <strong>订阅信息</strong>
                <ul>${notices.map(node => `<li>${escapeHtml((node.rawName || node.name).replace(/^\[[^\]]+\]\s*/, ''))}</li>`).join('')}</ul>
              </div>` : ''}
            </div>
            <div class="source-tags"></div>
          </div>
          <div class="source-actions">
            ${canProbeSource ? `<button type="button" class="btn btn-default btn-sm probe-source" aria-label="测速 ${escapeHtml(src.name)} 全部节点" title="测速此来源的全部节点">${speedIcon}<span>测速</span></button>` : ''}
            <button class="btn btn-default btn-sm btn-edit-src">${hasUrl ? '编辑来源' : '配置来源'}</button>
            ${hasUrl ? '<button class="btn btn-default btn-sm btn-refresh-src">刷新订阅</button>' : ''}
            <details class="source-manage">
              <summary class="btn btn-subtle btn-sm">管理<span class="sr-only"> ${escapeHtml(src.name)}</span></summary>
              <div class="source-manage-actions">
                <button type="button" class="btn btn-default btn-sm btn-toggle-src">${src.enabled === false ? '启用' : '停用'}</button>
                <button type="button" class="btn btn-danger btn-sm btn-delete-src">删除</button>
              </div>
            </details>
          </div>
          ${progressMarkup}
        </div>

        <div class="panel-body source-body">
          <p class="source-feedback" role="status" ${src.lastRefreshError ? '' : 'hidden'}>${escapeHtml(src.lastRefreshError || '')}</p>
          <div class="source-node-grid" id="${gridId}"></div>
          ${nodes.length ? '' : '<p class="empty-message">暂无节点</p>'}
          ${nodes.length > 2 ? `<button class="btn btn-subtle source-toggle" type="button" aria-controls="${gridId}" hidden>
            <span class="source-toggle-label"></span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>` : ''}
        </div>
      `;

      const grid = panel.querySelector('.source-node-grid');
      const toggle = panel.querySelector('.source-toggle');
      const tags = panel.querySelector('.source-tags');
      const sourceButton = panel.querySelector('.probe-source');
      const sourceProgress = panel.querySelector('.probe-progress');
      const info = panel.querySelector('.source-info');
      if (info) {
        const trigger = panel.querySelector('.source-info-trigger');
        info.addEventListener('beforetoggle', event => {
          if (event.newState !== 'open') return;
          const anchor = trigger.getBoundingClientRect();
          const width = Math.min(320, window.innerWidth - 24);
          info.style.width = `${width}px`;
          info.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))}px`;
          const available = window.innerHeight - anchor.bottom - 12;
          const opensAbove = available < 160 && anchor.top > available;
          info.style.top = opensAbove ? 'auto' : `${anchor.bottom + 6}px`;
          info.style.bottom = opensAbove ? `${window.innerHeight - anchor.top + 6}px` : 'auto';
          info.style.maxHeight = `${Math.max(70, opensAbove ? anchor.top - 18 : available - 6)}px`;
        });
      }
      if (sourceButton) sourceButton.onclick = () => startProbe(src);
      let lastTags = '';
      let ordered = nodes;
      let visible = [];
      let lastMode;
      let lastSortedAt;
      let wasProbing = false;
      let previewCount = 2;

      function updateMeasurements(active) {
        const sourceJob = active.find(job => job.scope.sourceId === src.id && !job.scope.nodeName);
        const job = sourceJob || active.find(job => !job.scope.nodeName && job.targets?.[src.id]?.sourceUpdatedAt === src.updatedAt);
        const target = job?.targets?.[src.id];
        const results = job?.results?.[src.id];
        const tested = Object.keys(results || {}).length;
        const total = target?.nodes.length || 0;
        const batch = Boolean(job) && (!total || tested < total);
        const inScope = canProbeSource && nodes.some(node => probeNodeStatus(src, node.name, active));
        const measurementTime = src.lastMeasurement?.finishedAt;
        if (lastMode !== state.sourceSort || (!inScope && (wasProbing || lastSortedAt !== measurementTime))) {
          ordered = state.sourceSort === 'latency' ? orderByLatency(nodes) : nodes;
          lastMode = state.sourceSort;
          lastSortedAt = measurementTime;
          showNodes();
        }
        wasProbing = inScope;
        const markup = sourceTagMarkup(src, nodes, batch);
        if (markup !== lastTags) {
          tags.innerHTML = markup;
          lastTags = markup;
        }
        if (sourceButton) {
          const testing = sourceJob && nodes.some(node => probeNodeStatus(src, node.name, active) === 'running');
          updateProbeButton(sourceButton, Boolean(sourceJob), sourceJob ? (testing ? '测速中' : '排队中') : '测速');
        }
        updateProbeProgress(sourceProgress, batch, tested, total);
        for (const [index, row] of Array.from(grid.children).entries()) {
          const node = visible[index];
          const pending = probeNodeStatus(src, node.name, active);
          const badge = row.querySelector('.source-node-status');
          const exit = row.querySelector('.source-node-exit');
          const button = row.querySelector('.probe-node');
          const badgeHtml = pending ? probeStatusMarkup(pending) : nodeMeasurementBadge(node);
          const exitHtml = nodeExitResult(node);
          if (badge.innerHTML !== badgeHtml) badge.innerHTML = badgeHtml;
          if (exit.innerHTML !== exitHtml) exit.innerHTML = exitHtml;
          exit.classList.toggle('is-pending', pending === 'running');
          if (button) updateProbeButton(button, probeNodeBusy(src, node.name, pending, active));
        }
      }
      sourceUpdates.push(updateMeasurements);

      function showNodes() {
        const expanded = state.expandedSources.has(src.id);
        const next = ordered.slice(0, expanded ? ordered.length : previewCount);
        if (toggle) {
          toggle.hidden = nodes.length <= previewCount;
          toggle.querySelector('.source-toggle-label').textContent = expanded ? '收起节点' : `展开全部 ${nodes.length} 个节点`;
          toggle.setAttribute('aria-expanded', String(expanded));
        }
        if (next.length === visible.length && next.every((node, index) => node === visible[index])) return;
        const active = document.activeElement;
        const focused = grid.contains(active) ? visible[Number(active.dataset.index)] : null;
        visible = next;
        grid.innerHTML = visible.map((node, index) => `
          <div class="source-node">
            <div class="source-node-label">
              <span class="node-name">${escapeHtml(node.name)}</span>
              <div class="source-node-exit"></div>
            </div>
            <div class="source-node-actions">
              <div class="source-node-status"></div>
              ${canProbeSource ? `<button type="button" class="btn btn-subtle probe-node" data-index="${index}" aria-label="测速 ${escapeHtml(node.name)}" title="测速此节点">${speedIcon}</button>` : ''}
            </div>
          </div>`).join('');
        if (focused) {
          const button = grid.querySelector(`.probe-node[data-index="${visible.indexOf(focused)}"]`) || toggle;
          button?.focus({ preventScroll: true });
        }
      }
      grid.updatePreview = () => {
        const tracks = getComputedStyle(grid).gridTemplateColumns.match(/\d+(?:\.\d+)?px/g);
        const next = (tracks?.length || 1) * 2;
        if (previewCount === next) return;
        previewCount = next;
        showNodes();
        refreshProbeView();
      };
      sourceGridObserver.observe(grid);
      grid.onclick = event => {
        const button = event.target.closest('.probe-node');
        if (button) startProbe(src, visible[Number(button.dataset.index)]);
      };
      if (toggle) toggle.onclick = () => {
        if (!state.expandedSources.delete(src.id)) state.expandedSources.add(src.id);
        showNodes();
        refreshProbeView();
      };

      const refresh = panel.querySelector('.btn-refresh-src');
      if (refresh) refresh.onclick = async () => {
        const feedback = panel.querySelector('.source-feedback');
        refresh.disabled = true;
        refresh.textContent = '刷新中…';
        feedback.hidden = true;
        try {
          const res = await fetch('/api/source/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceId: src.id })
          });
          const json = await res.json();
          if (!res.ok) {
            throw new Error(json.error || '刷新失败');
          }
          const updated = json.source;
          if (updated) {
            const { url, ...info } = updated;
            Object.assign(src, info);
          }
          if (state.currentView === 'sources') renderSourcesView();
          showToast(`${src.name} 已刷新`, 'success');
        } catch (err) {
          src.lastRefreshError = err.message;
          feedback.textContent = err.message;
          feedback.hidden = false;
        } finally {
          refresh.disabled = false;
          refresh.textContent = '刷新订阅';
        }
      };

      panel.querySelector('.btn-edit-src').onclick = () => {
        promptSourceImportModal(src);
      };
      async function manageSource(button, action) {
        if (action === 'delete' && !confirm(`删除「${src.name}」及其节点缓存？`)) return;
        panel.querySelectorAll('.source-manage button').forEach(control => { control.disabled = true; });
        try {
          const res = await fetch('/api/source/manage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceId: src.id, action })
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(payload.error || '操作失败');
          if (payload.source) Object.assign(src, payload.source);
          else state.data.sources = state.data.sources.filter(item => item.id !== src.id);
          updateTopbarBadges();
          if (state.currentView === 'sources') {
            renderSourcesView();
            (el.mainStage.querySelector(`[data-source-card="${CSS.escape(src.id)}"] summary`) ||
              el.mainStage.querySelector('#importNewSourceBtn'))?.focus({ preventScroll: true });
          }
          showToast(payload.message, 'success');
        } catch (error) {
          showToast(error.message, 'error');
          panel.querySelectorAll('.source-manage button').forEach(control => { control.disabled = false; });
          button.focus({ preventScroll: true });
        }
      }
      panel.dataset.sourceCard = src.id;
      for (const [selector, action] of [['.btn-toggle-src', src.enabled === false ? 'enable' : 'disable'], ['.btn-delete-src', 'delete']]) {
        const button = panel.querySelector(selector);
        button.onclick = () => manageSource(button, action);
      }

      container.appendChild(panel);
    });

    el.mainStage.appendChild(container);
    refreshProbeView = () => {
      const active = currentProbeJobs();
      const all = active.find(job => !job.scope.sourceId && !job.scope.selection);
      if (allButton) updateProbeButton(allButton, Boolean(all), all ? '测速中' : '测速');
      updateProbeProgress(allProgress, Boolean(all), all?.completed || 0, all?.total || 0);
      for (const update of sourceUpdates) update(active);
    };
    refreshProbeView();
    for (const grid of container.querySelectorAll('.source-node-grid')) grid.updatePreview();
    if (canProbe) scheduleProbePoll(0);
  }

  // 录入订阅 URL 或粘贴节点内容弹窗
  function promptSourceImportModal(source) {
    const isNew = !source;
    const modal = document.createElement('div');
    modal.className = 'dialog-overlay';
    modal.innerHTML = `
      <div class="dialog-box" style="max-width: 600px;">
        <div class="dialog-header">
          <span style="font-weight: 700; color: #fff;">${isNew ? '新建/导入订阅源' : `维护订阅源: ${escapeHtml(source.name)}`}</span>
          <button class="btn btn-subtle btn-sm close-modal">✕</button>
        </div>
        <div class="dialog-body">
          <div>
            <label for="srcNameInput" style="display:block; margin-bottom: 4px; font-weight: 600;">来源名称</label>
            <input type="text" id="srcNameInput" class="input-text" value="${escapeHtml(source?.name || '')}" placeholder="例如: 我的自建节点 / 机场A" style="width: 100%;" />
          </div>
          <div>
            <label for="srcUrlInput" style="display:block; margin-bottom: 4px; font-weight: 600;">订阅地址</label>
            <input type="url" id="srcUrlInput" class="input-text" placeholder="${source?.rawUrlStored ? '已设置，留空保留当前地址' : '粘贴机场提供的订阅地址'}" style="width: 100%;" />
          </div>
          <div>
            <label for="srcRawInput" style="display:block; margin-bottom: 4px; font-weight: 600;">直接粘贴 Clash YAML 或 Base64 订阅内容导入节点</label>
            <textarea id="srcRawInput" class="input-text" rows="6" style="width: 100%; font-size: 12px;" placeholder="粘贴 Clash YAML 配置 (含 proxies:) 或 Base64 编码的节点列表..."></textarea>
          </div>
        </div>
        <div class="dialog-footer">
          <button class="btn btn-default close-modal">取消</button>
          <button id="saveSourceBtn" class="btn btn-primary">保存并导入</button>
        </div>
      </div>
    `;

    modal.querySelectorAll('.close-modal').forEach(b => b.onclick = () => modal.remove());
    modal.querySelector('#saveSourceBtn').onclick = async () => {
      const name = modal.querySelector('#srcNameInput').value.trim();
      const urlVal = modal.querySelector('#srcUrlInput').value.trim();
      const rawVal = modal.querySelector('#srcRawInput').value.trim();

      if (!name) {
        alert('请输入来源名称');
        return;
      }

      try {
        const res = await fetch('/api/source/update-or-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceId: source?.id,
            name: name,
            url: urlVal,
            rawContent: rawVal
          })
        });

        const json = await res.json();
        if (!res.ok) {
          throw new Error(json.error || '导入失败');
        }

        modal.remove();
        showToast(json.message, 'success');
        await loadData();
        renderSourcesView();
      } catch (err) {
        showToast(`操作失败: ${err.message}`, 'error');
      }
    };

    el.modalContainer.appendChild(modal);
  }

  // ========================================================
  // 视图 5：版本历史与回滚 (保持当前已发布不变，再发布递增)
  // ========================================================

  async function openProfileComparison(trigger, { profile = null, version = null, review = false } = {}) {
    if (!review && !state.history) {
      trigger.disabled = true;
      trigger.setAttribute('aria-busy', 'true');
      try {
        await ensureHistory();
      } catch (error) {
        showToast(error.message, 'error');
        return;
      } finally {
        trigger.disabled = false;
        trigger.removeAttribute('aria-busy');
      }
      if (!trigger.isConnected) return;
    }
    const profiles = state.data.profiles;
    const current = profile || getCurrentProfile();
    const other = profile || profiles.find(item => item.id !== current.id) || current;
    const page = document.createElement('main');
    page.className = 'profile-compare-page';
    page.setAttribute('aria-labelledby', 'profile-compare-title');
    const narrow = matchMedia('(max-width: 720px)');
    let layout = 'split';
    try {
      if (localStorage.getItem('workbench.compareLayout') === 'inline') layout = 'inline';
    } catch { /* The layout still works without browser storage. */ }
    let data = null;
    let selectedSection = '';
    let showUpstream = false;
    let request;
    let restoring = false;

    function side(label) {
      return `<fieldset class="compare-side"><legend>${label}</legend>
        ${review ? '<strong class="compare-fixed-version"></strong>' : ''}
        ${profile ? '' : `<label>配置<select class="input-text compare-profile">
          ${profiles.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('')}
        </select></label>`}
      <label${review ? ' hidden' : ''}><span class="compare-version-label">版本</span><select class="input-text compare-version"></select></label>
      </fieldset>`;
    }
    const origin = review ? '工作台' : profile ? '版本历史' : '设备配置';
    page.innerHTML = `
      <header class="compare-toolbar">
        <div class="compare-width">
          <div class="compare-top">
            <button type="button" class="btn btn-subtle compare-close" aria-label="返回${origin}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m12 19-7-7 7-7M5 12h14"/></svg>
              ${origin}
            </button>
            <h1 id="profile-compare-title" tabindex="-1">${review ? '查看变更' : profile ? '版本对比' : '配置对比'}</h1>
            <div class="compare-layout" role="group" aria-label="差异布局">
              <button type="button" class="btn btn-subtle" data-layout="split">双栏</button>
              <button type="button" class="btn btn-subtle" data-layout="inline">单列</button>
            </div>
          </div>
          ${profile ? `<p class="compare-profile-name">${escapeHtml(profile.name)}</p>` : ''}
          <div class="compare-controls">${side(review ? '当前发布' : '基准')}${side(review ? '待发布' : '对比')}</div>
          <div class="compare-tabs">
            <nav class="compare-categories" aria-label="配置差异类别" hidden></nav>
            <div class="compare-extra-actions">
              <button type="button" class="btn btn-subtle compare-upstream" aria-pressed="false" hidden>查看机场节点变化</button>
              ${review ? '<button type="button" class="btn btn-default btn-sm compare-restore-all" data-restore="all" hidden>全部恢复</button>' : ''}
            </div>
          </div>
        </div>
      </header>
      <div class="compare-scroll" tabindex="0" role="region" aria-label="差异结果">
        <div class="compare-output" aria-busy="true">
          <p class="compare-status" role="status"></p>
          <div class="compare-results"></div>
        </div>
      </div>`;
    const sides = Array.from(page.querySelectorAll('.compare-side'), fieldset => ({
      fieldset,
      profile: fieldset.querySelector('.compare-profile'),
      version: fieldset.querySelector('.compare-version'),
      fixed: fieldset.querySelector('.compare-fixed-version'),
      limit: fieldset.appendChild(document.createElement('p'))
    }));
    sides.forEach((side, index) => {
      side.limit.className = 'compare-side-limit';
      side.limit.hidden = true;
      side.limit.id = `compare-side-limit-${index}`;
      side.fieldset.setAttribute('aria-describedby', side.limit.id);
    });
    const profileId = side => side.profile?.value ?? profile.id;
    const scroll = page.querySelector('.compare-scroll');
    const output = page.querySelector('.compare-output');
    const status = page.querySelector('.compare-status');
    const results = page.querySelector('.compare-results');
    const categories = page.querySelector('.compare-categories');
    const upstreamButton = page.querySelector('.compare-upstream');
    const restoreAll = page.querySelector('.compare-restore-all');
    const layouts = [...page.querySelectorAll('[data-layout]')];
    const editedProfile = () => state.data.profiles.find(item => item.id === current.id);
    const reviewInput = () => {
      const editing = editedProfile();
      return { profileId: editing.id, revision: editing.revision,
        publishedVersion: editing.publishedVersion, currentProfile: editing };
    };

    function updateLayout() {
      page.dataset.mode = narrow.matches ? 'inline' : layout;
      for (const button of layouts) {
        button.setAttribute('aria-pressed', String(button.dataset.layout === layout));
      }
    }

    function close() {
      if (restoring) return;
      request?.abort();
      narrow.removeEventListener('change', updateLayout);
      page.remove();
      (trigger.isConnected && !trigger.hidden ? trigger : el.profileSelect).focus({ preventScroll: true });
    }

    function fillVersions(side, selected) {
      const id = profileId(side);
      const active = profiles.find(item => item.id === id);
      const history = (state.history?.[id] || []).slice().sort((a, b) => b.version - a.version);
      if (active.publishedVersion && !history.some(item => item.version === active.publishedVersion)) {
        history.unshift({ version: active.publishedVersion });
      }
      const choices = history.map(({ version }) => [String(version),
        `v${version}${version === active.publishedVersion ? ' · 当前发布' : ''}`]);
      if (review) {
        choices.push(['draft', '待发布配置']);
      } else if (state.savedProfiles.get(id)?.hasDraft || !active.publishedVersion) {
        choices.push(['draft', '已保存草稿']);
      } else if (state.savedProfiles.get(id)?.hasPendingSourceChanges) {
        choices.push(['draft', '待发布配置']);
      }
      side.version.replaceChildren(...choices.map(([value, title]) => new Option(title, value)));
      if (choices.some(([value]) => value === String(selected))) side.version.value = String(selected);
      if (side.fixed) side.fixed.textContent = side.version.selectedOptions[0]?.textContent?.replace(' · 当前发布', '') || '';
    }

    function restoreButton(item) {
      return review && item.restore ? `<button type="button" class="btn btn-subtle btn-sm compare-restore-one"
        data-restore="${escapeHtml(item.restore)}" aria-label="${escapeHtml(item.restoreLabel + ' · ' + item.name)}">${escapeHtml(item.restoreLabel)}</button>` : '';
    }

    function difference(item) {
      if (item.details) {
        const leading = item.details.find(change => change.name === '首个候选');
        const remaining = leading ? item.details.filter(change => change !== leading) : item.details;
        return `<li class="compare-group-change">
          <h3>${escapeHtml(item.name)} ${restoreButton(item)}</h3>
          ${leading ? `<ul class="compare-items">${difference(leading)}</ul>` : ''}
          ${remaining.length > 2 ? `<details class="compare-group-details"${leading ? '' : ' open'}>
            <summary>${escapeHtml(item.detailsLabel || '候选与设置变动')} <span>${remaining.length}</span></summary>
            <ul class="compare-items">${remaining.map(difference).join('')}</ul>
          </details>` : remaining.length ? `<ul class="compare-items">${remaining.map(difference).join('')}</ul>` : ''}
        </li>`;
      }
      const names = { added: '新增', removed: '移除', changed: '变更', moved: '调序' };
      function cell(key, label, mark) {
        const position = item[`${key}Position`];
        const value = item[key];
        const vacant = value === null && (item.kind === 'added' || item.kind === 'removed');
        return `<div class="compare-cell compare-${key}${vacant ? ' compare-vacant' : ''}">
          <span class="compare-sign" aria-hidden="true">${vacant ? '' : mark}</span>
          <span class="compare-cell-label">${label}</span>
          <span class="compare-cell-value">${value === null ? (vacant ? '—' : '未显示') : escapeHtml(value)}</span>
          ${position ? `<span class="compare-position">第 ${position} 条</span>` : ''}
        </div>`;
      }
      const moved = item.kind === 'moved';
      return `<li class="compare-item" data-change="${item.kind}">
        <div class="compare-item-title"><span>${escapeHtml(item.name)}</span><span class="compare-item-actions">
          <span class="compare-kind">${names[item.kind]}${item.alsoMoved ? '并调序' : ''}</span>${restoreButton(item)}</span></div>
        <div class="compare-values">${cell('before', '基准', moved ? '' : '−')}${cell('after', '对比', moved ? '' : '+')}</div>
      </li>`;
    }

    function renderSection() {
      const section = showUpstream
        ? { title: '机场节点变化', items: data.upstream }
        : data?.sections.find(item => item.title === selectedSection);
      for (const button of categories.querySelectorAll('button')) {
        button.setAttribute('aria-pressed', String(!showUpstream && button.value === selectedSection));
      }
      upstreamButton.setAttribute('aria-pressed', String(showUpstream));
      upstreamButton.textContent = showUpstream ? '返回配置差异' : '查看机场节点变化';
      status.textContent = section ? '' : review ? '配置已与当前发布版一致' : '可对比的配置项没有变化';
      if (restoreAll) restoreAll.hidden = !data?.canRestoreAll || showUpstream;
      results.innerHTML = section ? `<section class="compare-section" aria-labelledby="compare-category-title">
        <div class="compare-section-heading">
          <h2 id="compare-category-title">${escapeHtml(section.title)}</h2>
          ${showUpstream ? `<span>订阅下发快照中有 ${section.items.length} 个节点变化</span>` : ''}
          ${section.title === '策略组' && data.complete.includes(false) ? '<span>按保存的策略设置对比</span>' : ''}
        </div>
        <div class="compare-column-labels" aria-hidden="true">
          ${sides.map((side, index) => `<span>${index === 0 ? '基准' : '对比'} · ${escapeHtml(side.version.selectedOptions[0].textContent)}</span>`).join('')}
        </div>
        <ul class="compare-items compare-diff">${section.items.map(difference).join('')}</ul>
      </section>` : '';
      scroll.scrollTop = 0;
    }

    async function compare() {
      request?.abort();
      const active = new AbortController();
      request = active;
      const [a, b] = sides;
      const query = new URLSearchParams({
        left: profileId(a), leftVersion: a.version.value,
        right: profileId(b), rightVersion: b.version.value
      });
      results.replaceChildren();
      categories.replaceChildren();
      categories.hidden = true;
      upstreamButton.hidden = true;
      if (restoreAll) restoreAll.hidden = true;
      showUpstream = false;
      for (const side of sides) side.limit.hidden = true;
      if (!review && profileId(a) === profileId(b) && a.version.value === b.version.value) {
        output.setAttribute('aria-busy', 'false');
        status.textContent = '两侧选择了同一个版本。';
        return;
      }
      status.textContent = '正在对比…';
      output.setAttribute('aria-busy', 'true');
      try {
        const response = review
          ? await fetch('/api/profile/review', { method: 'POST', signal: active.signal,
              headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reviewInput()) })
          : await fetch(`/api/profile/compare?${query}`, { signal: active.signal, cache: 'no-store' });
        const comparison = await response.json();
        if (active.signal.aborted) return;
        if (!response.ok) throw new Error(comparison.error);
        data = comparison;
        sides.forEach((side, index) => {
          side.limit.hidden = data.complete[index];
          side.limit.textContent = side.version.value === 'draft' ? '当前编辑暂时无法生成完整配置' : '这个版本未保留实际节点名单';
        });
        if (!data.sections.some(section => section.title === selectedSection)) {
          selectedSection = data.sections[0]?.title || '';
        }
        categories.innerHTML = data.sections.map(section =>
          `<button type="button" class="btn btn-subtle" value="${escapeHtml(section.title)}">${escapeHtml(section.title)} <span>${section.items.length}</span></button>`).join('');
        categories.hidden = !selectedSection;
        upstreamButton.hidden = !data.upstream?.length;
        renderSection();
      } catch (error) {
        if (active.signal.aborted) return;
        status.textContent = error.message || '暂时无法读取对比结果。';
        const retry = document.createElement('button');
        retry.className = 'btn btn-default btn-sm';
        retry.textContent = '重试';
        retry.onclick = compare;
        results.appendChild(retry);
      } finally {
        if (!active.signal.aborted) output.setAttribute('aria-busy', 'false');
      }
    }

    if (!profile) {
      sides[0].profile.value = current.id;
      sides[1].profile.value = other.id;
    }
    const versions = (state.history?.[current.id] || []).map(item => item.version).sort((a, b) => b - a);
    fillVersions(sides[0], review ? current.publishedVersion
      : profile ? version ?? versions.find(value => value !== current.publishedVersion) : current.publishedVersion);
    fillVersions(sides[1], review ? 'draft' : other.publishedVersion);
    for (const side of sides) {
      side.profile?.addEventListener('change', () => { fillVersions(side); compare(); });
      side.version.addEventListener('change', compare);
    }
    categories.onclick = event => {
      const button = event.target.closest('button');
      if (!button) return;
      showUpstream = false;
      selectedSection = button.value;
      renderSection();
    };
    upstreamButton.onclick = () => {
      showUpstream = !showUpstream;
      renderSection();
    };
    if (review) {
      page.addEventListener('click', async event => {
        const button = event.target.closest('[data-restore]');
        if (!button || restoring) return;
        const restore = button.dataset.restore;
        if (restore === 'all' && !confirm('将全部配置恢复到当前发布版，并保存到草稿？')) return;
        if (restore !== 'all' && getEditState(editedProfile()).dirty &&
            !confirm('恢复这一项，并把其他未保存的修改一起保存到草稿？')) return;
        restoring = true;
        page.querySelectorAll('button').forEach(control => { control.disabled = true; });
        try {
          const reply = await fetch('/api/profile/restore-change', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...reviewInput(), restore })
          });
          const payload = await reply.json();
          if (!reply.ok) throw new Error(payload.error || '恢复失败');
          replaceProfile(payload.profile);
          updateTopbarBadges();
          renderCurrentView();
          await compare();
          showToast('已恢复并保存到草稿', 'success');
          const focus = page.querySelector('.compare-categories [aria-pressed="true"]');
          (focus || page.querySelector('#profile-compare-title')).focus({ preventScroll: true });
        } catch (error) {
          showToast(error.message, 'error');
          button.focus({ preventScroll: true });
        } finally {
          restoring = false;
          page.querySelectorAll('button').forEach(control => { control.disabled = false; });
        }
      });
    }
    for (const button of layouts) {
      button.onclick = () => {
        layout = button.dataset.layout;
        updateLayout();
        try { localStorage.setItem('workbench.compareLayout', layout); } catch { /* Keep choice in this view. */ }
      };
    }
    page.querySelector('.compare-close').onclick = close;
    page.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented && event.target.tagName !== 'SELECT') close();
    });
    narrow.addEventListener('change', updateLayout);
    updateLayout();
    document.body.appendChild(page);
    page.querySelector('h1').focus();
    compare();
  }

  function renderHistoryView() {
    el.mainStage.innerHTML = '';
    const prof = getCurrentProfile();
    if (!state.history) return renderDeferred(el.mainStage, '正在加载版本历史…', ensureHistory, renderHistoryView);
    const historyList = state.history[prof.id] || [];
    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '16px';

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="panel-header">
        <span class="panel-title">版本快照与历史回滚 (${historyList.length} 个发布记录)</span>
        ${historyList.length > 1 ? '<button class="btn btn-default btn-sm compare-history">对比版本</button>' : ''}
      </div>
      <div class="panel-body" style="padding: 0;">
        <div class="rule-table-container">
          <table class="rule-table version-table" role="table">
            <thead>
              <tr>
                <th style="width: 80px;">版本</th>
                <th style="width: 180px;">发布时间</th>
                <th style="width: 120px;">规则行数</th>
                <th style="width: 140px;">状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${historyList.length ? historyList.map(h => `
                <tr>
                  <td><strong style="color: var(--primary); font-size: 14px;">v${h.version}</strong></td>
                  <td class="tabular-nums" style="color: var(--text-muted);">${new Date(h.publishedAt).toLocaleString()}</td>
                  <td class="tabular-nums">${h.ruleCount ?? h.effectiveRules?.length ?? '—'} 条</td>
                  <td>
                    ${h.version === prof.publishedVersion
                      ? '<span class="badge badge-clean">当前发布</span>'
                      : '<span class="badge badge-version">历史版本</span>'
                    }
                  </td>
                  <td><div class="version-row-actions">
                    ${historyList.length > 1 ? `<button class="btn btn-subtle btn-sm compare-history" data-version="${h.version}" aria-label="对比 v${h.version}">对比</button>` : ''}
                    ${h.version !== prof.publishedVersion ? `<button class="btn btn-default btn-sm btn-rollback" data-ver="${h.version}" aria-label="将 v${h.version} 恢复为草稿">恢复草稿</button>` : ''}
                  </div></td>
                </tr>
              `).join('') : '<tr><td colspan="5" class="empty-message">这个配置还没有发布记录。</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;

    panel.querySelectorAll('.compare-history').forEach(btn => {
      btn.onclick = () => {
        const version = Number(btn.dataset.version);
        openProfileComparison(btn, { profile: prof, version: version && version !== prof.publishedVersion ? version : null });
      };
    });
    panel.querySelectorAll('.btn-rollback').forEach(btn => {
      btn.onclick = async () => {
        if (state.profileWrites.has(prof.id)) return;
        const ver = parseInt(btn.getAttribute('data-ver'), 10);
        if (!confirm(`确定载入历史版本 v${ver} 到当前草稿吗？\n注意：当前对外发布的 v${prof.publishedVersion} 下载依然保持生效，直到你确认并重新发布。`)) return;

        const requestedKey = profileContentKey(prof);
        state.profileWrites.add(prof.id);
        updateTopbarBadges();
        btn.disabled = true;
        try {
          const res = await fetch('/api/profile/rollback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profileId: prof.id, targetVersion: ver, revision: prof.revision })
          });

          const json = await res.json();
          if (!res.ok) {
            throw new Error(json.error || '回滚失败');
          }

          if (profileContentKey(prof) === requestedKey) replaceProfile(json.profile);
          else acceptSavedProfile(prof, json.profile);
          if (getCurrentProfile()?.id === prof.id && state.currentView === 'history') renderHistoryView();
          showToast(json.profile.hasDraft ? '草稿已恢复' : '该版本与当前发布内容一致', 'success');
        } catch (err) {
          showToast(`回滚失败: ${err.message}`, 'error');
        } finally {
          btn.disabled = false;
          state.profileWrites.delete(prof.id);
          updateTopbarBadges();
        }
      };
    });

    container.appendChild(panel);
    el.mainStage.appendChild(container);
  }

  // ========================================================
  // 视图 7：DNS 与 TUN
  // ========================================================

  function renderNetworkView() {
    el.mainStage.innerHTML = '';
    const prof = getCurrentProfile();
    const net = prof.network || {};
    const dns = net.dns || {};
    const tun = net.tun || {};
    const hosts = prof.hosts || {};

    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '16px';

    container.innerHTML = `
      <div class="panel">
        <div class="panel-header"><span class="panel-title">DNS 解析配置</span></div>
        <div class="panel-body" style="display: flex; flex-direction: column; gap: 12px;">
          <div style="display: flex; gap: 24px;">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="dnsEnable" ${dns.enable !== false ? 'checked' : ''} />
              <span>启用 DNS 增强解析</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="dnsIpv6" ${dns.ipv6 ? 'checked' : ''} />
              <span>启用 IPv6 解析</span>
            </label>
          </div>
          <div>
            <label style="display:block; margin-bottom: 4px; font-weight: 600;">解析模式 (Enhanced Mode)</label>
            <input type="text" class="input-text" value="${escapeHtml(dns['enhanced-mode'] || 'fake-ip')}" readonly style="width: 220px;" />
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header"><span class="panel-title">TUN 虚拟网卡路由</span></div>
        <div class="panel-body" style="display: flex; flex-direction: column; gap: 10px;">
          <div>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="tunAutoRoute" ${tun['auto-route'] !== false ? 'checked' : ''} />
              <span>自动接管系统路由 (Auto Route)</span>
            </label>
          </div>
          <div>
            <label style="display:block; margin-bottom: 4px; font-weight: 600;">直连绕过网段 (Route Exclude Address)</label>
            <div class="code-preview" style="max-height: 120px;">
              ${(tun['route-exclude-address'] || []).map(escapeHtml).join('\n')}
            </div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header"><span class="panel-title">静态 Hosts 映射 (${Object.keys(hosts).length} 条)</span></div>
        <div class="panel-body" style="padding: 0;">
          <div class="rule-table-container">
            <table class="rule-table hosts-table">
              <thead><tr><th>域名</th><th>映射 IP</th></tr></thead>
              <tbody>
                ${Object.entries(hosts).map(([d, ip]) => `
                  <tr>
                    <td style="font-family: var(--font-mono); color: var(--primary);">${escapeHtml(d)}</td>
                    <td style="font-family: var(--font-mono); color: #fff;">${escapeHtml(Array.isArray(ip) ? ip.join(', ') : ip)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    for (const [id, section, field, defaultValue] of [
      ['dnsEnable', 'dns', 'enable', true], ['dnsIpv6', 'dns', 'ipv6', false], ['tunAutoRoute', 'tun', 'auto-route', true]
    ]) {
      container.querySelector('#' + id).onchange = event => {
        const checked = event.target.checked;
        const original = state.savedProfiles.get(prof.id)?.network?.[section];
        const fields = { ...prof.network?.[section] };
        if (!Object.hasOwn(original || {}, field) && checked === defaultValue) delete fields[field];
        else fields[field] = checked;
        prof.network = { ...prof.network };
        if (Object.keys(fields).length || original) prof.network[section] = fields;
        else delete prof.network[section];
        updateTopbarBadges();
      };
    }
    el.mainStage.appendChild(container);
  }

  // ========================================================
  // 视图 8：设备配置管理
  // ========================================================

  async function saveCustomNode(change) {
    const response = await fetch('/api/custom-nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...change, revision: state.data.customNodesRevision })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '无法保存自定义节点');
    state.data.customNodes = result.customNodes;
    state.data.customNodesRevision = result.customNodesRevision;
    for (const { profile, previousRevision } of result.changedProfiles) {
      const current = state.data.profiles.find(item => item.id === profile.id);
      if (current.revision !== previousRevision) continue;
      if (!getEditState(current).dirty) replaceProfile(profile);
      else {
        current.nodes = profile.nodes;
        acceptSavedProfile(current, profile);
      }
    }
    updateTopbarBadges();
    const panel = document.getElementById('customNodesPanel');
    if (panel) panel.replaceWith(renderCustomNodesPanel());
    return result.changedProfiles.length;
  }

  const customNodeTypes = { http: 'HTTP', socks5: 'SOCKS5', tailscale: 'Tailscale' };

  function catalogNodesFor(profile) {
    return (state.data.customNodes || []).filter(node => !node.profileId || node.profileId === profile.id);
  }

  function openCustomNodeForm(node) {
    const dialog = document.createElement('dialog');
    const owner = node?.profileId || getCurrentProfile()?.id;
    const isTailscale = node?.type === 'tailscale';
    dialog.className = 'dialog-box node-picker custom-node-dialog';
    dialog.setAttribute('aria-labelledby', 'customNodeTitle');
    dialog.innerHTML = `
      <form class="group-setup-form">
        <div class="dialog-header"><h2 class="panel-title" id="customNodeTitle">${node ? '编辑自定义节点' : '添加自定义节点'}</h2></div>
        <div class="dialog-body custom-node-fields">
          <label>节点名称<input class="input-text" name="nodeName" required maxlength="128" ${node ? 'readonly' : 'autofocus'}
            value="${escapeHtml(node?.name || '')}"></label>
          <label>节点类型<select class="input-text" name="protocol" ${isTailscale ? 'disabled' : ''}>
            ${Object.entries(customNodeTypes).map(([value, label]) =>
              `<option value="${value}" ${node?.type === value ? 'selected' : ''}
                ${node && !isTailscale && value === 'tailscale' ? 'disabled' : ''}>${label}</option>`).join('')}
          </select></label>
          <label data-node-fields="tailscale">所属设备配置<select class="input-text" name="profileId" required>
            ${state.data.profiles.map(item => `<option value="${escapeHtml(item.id)}" ${owner === item.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}
          </select></label>
          <label data-node-fields="tailscale">Tailscale 设备名<input class="input-text" name="hostname" required maxlength="63"
            autocapitalize="none" spellcheck="false" pattern="[a-zA-Z0-9](?:[a-zA-Z0-9\\-]{0,61}[a-zA-Z0-9])?"
            value="${escapeHtml(node?.hostname || '')}" placeholder="例如 workbench-phone"></label>
          <p class="custom-node-login-hint" data-node-fields="tailscale">首次有流量走这个节点时，从客户端日志打开登录链接，在浏览器授权。</p>
          <label data-node-fields="proxy">主机名或 IP<input class="input-text" name="server" required maxlength="253"
            value="${escapeHtml(node?.server || '')}" placeholder="proxy.example.invalid"></label>
          <label data-node-fields="proxy">端口<input class="input-text" type="number" name="port" min="1" max="65535" required value="${escapeHtml(String(node?.port ?? ''))}"></label>
          <label data-node-fields="proxy">用户名（可选）<input class="input-text" name="username" autocomplete="off"
            value="${escapeHtml(node?.username || '')}"></label>
          <label data-node-fields="proxy">密码（可选）<input class="input-text" name="password" type="password" autocomplete="new-password"
            ${node?.hasPassword ? 'placeholder="留空保留原密码"' : ''}></label>
          ${node?.hasPassword ? '<label class="custom-node-clear"><input type="checkbox" name="clearPassword"> 清除原密码</label>' : ''}
          <p class="group-setup-error" role="alert" hidden></p>
        </div>
        <div class="dialog-footer">
          <button type="button" class="btn btn-default close-modal">取消</button>
          <button type="submit" class="btn btn-primary">保存节点</button>
        </div>
      </form>`;
    const form = dialog.querySelector('form');
    const submit = form.querySelector('[type=submit]');
    const error = form.querySelector('[role=alert]');
    const protocol = form.elements.namedItem('protocol');
    function syncFields() {
      const kind = protocol.value === 'tailscale' ? 'tailscale' : 'proxy';
      for (const field of form.querySelectorAll('[data-node-fields]')) {
        field.hidden = field.dataset.nodeFields !== kind;
        const control = field.querySelector('input, select');
        if (control) control.disabled = field.hidden || (isTailscale && control.name === 'profileId');
      }
      error.hidden = true;
    }
    protocol.onchange = syncFields;
    syncFields();
    form.onsubmit = async event => {
      event.preventDefault();
      const data = new FormData(form);
      submit.disabled = true;
      error.hidden = true;
      try {
        const connection = protocol.value === 'tailscale' ? {
          profileId: isTailscale ? node.profileId : data.get('profileId'),
          hostname: data.get('hostname').trim()
        } : {
          server: data.get('server').trim().replace(/^\[([^\]]+)\]$/, '$1'),
          port: Number(data.get('port')),
          username: data.get('username'),
          password: data.get('password'),
          clearPassword: data.has('clearPassword')
        };
        const changed = await saveCustomNode({
          action: node ? 'edit' : 'add',
          name: data.get('nodeName').trim(),
          type: protocol.value,
          ...connection
        });
        dialog.close();
        showToast(changed ? `已更新 ${changed} 份草稿，发布后生效` : '自定义节点已保存', 'success');
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    };
    dialog.querySelector('.close-modal').onclick = () => dialog.close();
    dialog.addEventListener('close', () => {
      dialog.remove();
      const card = node && document.querySelector(`.custom-node-card[data-node-name="${CSS.escape(node.name)}"]`);
      (card?.querySelector('.node-more') || document.getElementById('addCustomNodeBtn'))?.focus();
    });
    el.modalContainer.appendChild(dialog);
    dialog.showModal();
  }

  function renderCustomNodesPanel() {
    const customNodes = state.data.customNodes || [];
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
        <section id="customNodesPanel" class="panel">
          <div class="panel-header">
            <span class="panel-title">自定义节点</span>
            <button id="addCustomNodeBtn" class="btn btn-primary btn-sm">+ 添加节点</button>
          </div>
          <div class="panel-body">
            ${customNodes.length ? '<div class="custom-node-grid"></div>' :
              '<p class="group-setup-choice-hint">添加节点后，可在设备的策略组里选用。</p>'}
          </div>
        </section>`;
    const container = wrapper.firstElementChild;
    container.querySelector('#addCustomNodeBtn').onclick = () => openCustomNodeForm();
    const grid = container.querySelector('.custom-node-grid');
    for (const node of customNodes) {
      const card = document.createElement('div');
      card.className = 'node-item custom-node-card';
      card.dataset.nodeName = node.name;
      card.dataset.nodeType = node.type;
      const name = escapeHtml(node.name);
      const isTailscale = node.type === 'tailscale';
      const owner = isTailscale && state.data.profiles.find(item => item.id === node.profileId);
      const host = node.server?.includes(':') ? `[${node.server}]` : node.server;
      const endpoint = escapeHtml(isTailscale ? node.hostname : `${host}:${node.port}`);
      card.innerHTML = `
        <div class="group-node-title">
          <strong class="node-name" title="${name}">${name}</strong>
          <button class="btn btn-subtle node-more" type="button" aria-expanded="false" aria-label="${name}的操作" title="节点操作">${moreIcon}</button>
        </div>
        <div class="custom-node-meta">
          <span class="custom-node-type">${escapeHtml(customNodeTypes[node.type] || node.type)}</span>
          <span class="custom-node-endpoint" title="${endpoint}">${endpoint}</span>
        </div>
        ${owner ? `<span class="custom-node-owner" title="${escapeHtml(owner.name)}">${escapeHtml(owner.name)}</span>` : ''}
        <div class="group-node-popover custom-node-actions" popover="auto" role="group" aria-label="${name}的操作">
          <button type="button" class="btn btn-subtle custom-node-edit">编辑</button>
          <button type="button" class="btn btn-subtle custom-node-remove">移除</button>
        </div>`;
      const more = card.querySelector('.node-more');
      const popover = card.querySelector('.custom-node-actions');
      const remove = card.querySelector('.custom-node-remove');
      more.onclick = () => popover.matches(':popover-open') ? popover.hidePopover() : openNodePopover(popover, more);
      popover.addEventListener('toggle', event => more.setAttribute('aria-expanded', String(event.newState === 'open')));
      card.querySelector('.custom-node-edit').onclick = () => {
        popover.hidePopover();
        openCustomNodeForm(node);
      };
      remove.onclick = async () => {
        popover.hidePopover();
        more.focus();
        if (!confirm(`移除「${node.name}」？`)) return;
        more.disabled = true;
        try {
          await saveCustomNode({ action: 'remove', name: node.name });
          document.getElementById('addCustomNodeBtn')?.focus();
          showToast('自定义节点已移除', 'success');
        } catch (error) {
          showToast(error.message, 'error');
        } finally {
          more.disabled = false;
          if (more.isConnected) more.focus();
        }
      };
      grid.appendChild(card);
    }
    return container;
  }

  function renderProfilesManageView() {
    el.mainStage.innerHTML = '';
    const profiles = state.data.profiles || [];
    const current = getCurrentProfile();
    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '16px';

    container.innerHTML = `
      <div class="panel">
        <div class="panel-header">
          <span class="panel-title">设备配置管理 (${profiles.length})</span>
          <div class="profile-management-actions">
            ${profiles.length > 1 ? '<button id="compareProfilesBtn" class="btn btn-default btn-sm">对比配置</button>' : ''}
            <button id="createNewProfileBtn" class="btn btn-default btn-sm">+ 新建空白配置</button>
            <button id="duplicateCurrentProfileBtn" class="btn btn-primary btn-sm">复制当前配置</button>
          </div>
        </div>
        <div class="panel-body">
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px;">
            ${profiles.map(p => `
              <div class="panel" style="padding: 14px; display: flex; flex-direction: column; gap: 8px; ${p.id === state.currentProfileId ? 'border-color: var(--primary);' : ''}">
                <div style="display: flex; align-items: center; justify-content: space-between;">
                  <strong style="color: #fff; font-size: 14px;">${escapeHtml(p.name)}</strong>
                  <span class="badge badge-version">v${p.publishedVersion || 0}</span>
                </div>
                <div style="font-size: 12px; color: var(--text-dim);">设备: ${p.device} | 策略组: ${p.groups?.length || 0} | 规则: ${p.rules?.length || 0}</div>
                ${p.id !== state.currentProfileId ? `<div style="display: flex; gap: 6px; margin-top: 6px;">
                  <button class="btn btn-sm btn-default btn-switch-p" data-id="${p.id}">
                    切换至此配置
                  </button>
                </div>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    const compareProfiles = container.querySelector('#compareProfilesBtn');
    if (compareProfiles) compareProfiles.onclick = () => openProfileComparison(compareProfiles);
    container.querySelectorAll('.btn-switch-p').forEach(btn => {
      btn.onclick = () => {
        state.currentProfileId = btn.getAttribute('data-id');
        initProfileSelect();
        updateTopbarBadges();
        renderCurrentView();
        showToast('已切换设备配置', 'info');
      };
    });

    container.querySelector('#createNewProfileBtn').onclick = async () => {
      const name = prompt('输入新配置名称:');
      if (!name || !name.trim()) return;

      try {
        const res = await fetch('/api/profile/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, device: 'desktop' })
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || '创建失败');

        rememberProfile(json.profile);
        state.data.profiles.push(json.profile);
        state.currentProfileId = json.profile.id;
        initProfileSelect();
        updateTopbarBadges();
        renderCurrentView();
        showToast(`已创建空白配置: ${name} (初始未发布状态)`, 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    };

    container.querySelector('#duplicateCurrentProfileBtn').onclick = async () => {
      const cur = getCurrentProfile();
      const newName = prompt('输入新副本名称:', `${cur.name} (测试副本)`);
      if (!newName || !newName.trim()) return;

      try {
        const res = await fetch('/api/profile/duplicate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceProfileId: cur.id, newName: newName })
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || '复制失败');

        rememberProfile(json.profile);
        state.data.profiles.push(json.profile);
        invalidateHistory();
        state.data.historyCounts[json.profile.id] = Number(Boolean(json.profile.publishedVersion));
        state.currentProfileId = json.profile.id;
        initProfileSelect();
        updateTopbarBadges();
        renderCurrentView();
        showToast(`已复制配置: ${newName}`, 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    };

    el.mainStage.appendChild(container);
  }

  // ========================================================
  // 试验订阅导出 (无伪造流量头，未发布返回404)
  // ========================================================

  async function openSubscriptionExportDialog() {
    const prof = getCurrentProfile();
    if (!prof) return;

    // 检查是否从未发布
    if (!prof.publishedVersion || prof.publishedVersion === 0) {
      alert(`配置 "${prof.name}" 尚未发布过任何可用版本，请先点击「发布新版」生成正式快照。`);
      return;
    }

    let distribution = state.data.distribution;
    if (distribution?.enabled && !distribution.links?.[prof.id]) {
      try {
        const response = await fetch('/api/distribution', { cache: 'no-store' });
        if (!response.ok) throw new Error();
        distribution = await response.json();
      } catch {
        showToast('暂时无法读取订阅地址，请重试', 'error');
        return;
      }
      if (getCurrentProfile()?.id !== prof.id) return;
    }
    const subUrl = distribution?.enabled ? distribution.links?.[prof.id] : `${window.location.origin}/sub/${prof.id}.yaml`;
    if (!subUrl) {
      showToast('此配置的订阅地址暂不可用', 'error');
      return;
    }

    const modal = document.createElement('div');
    modal.className = 'dialog-overlay';
    modal.innerHTML = `
      <div class="dialog-box" style="max-width: 720px;">
        <div class="dialog-header">
          <span style="font-weight: 700; color: #fff;">订阅地址 · v${prof.publishedVersion}</span>
          <button class="btn btn-subtle btn-sm close-modal">✕</button>
        </div>
        <div class="dialog-body">
          <div>
            <label for="subUrlInput" style="display:block; margin-bottom: 4px; font-weight: 600;">${distribution?.enabled ? 'Tailscale 订阅地址' : '本机订阅地址'}</label>
            <div style="display: flex; gap: 8px;">
              <input type="text" class="input-text" value="${escapeHtml(subUrl)}" readonly id="subUrlInput" style="flex:1; min-width:0;" />
              <button id="copySubUrlBtn" class="btn btn-default">复制链接</button>
            </div>
            <div style="font-size: 12px; color: var(--text-dim); margin-top: 4px;">
              下载当前已发布的 v${prof.publishedVersion}。
            </div>
          </div>
          ${distribution?.funnelAvailable ? `
          <section class="subscription-share">
            <label class="subscription-share-toggle">
              <input type="checkbox" role="switch" data-share-toggle disabled aria-describedby="subscriptionShareHint">
              <strong>允许外发</strong>
            </label>
            <p id="subscriptionShareHint" role="status">正在读取外发状态…</p>
            <div class="subscription-share-link" data-share-link hidden>
              <input type="text" class="input-text" readonly aria-label="公网订阅地址">
              <button type="button" class="btn btn-default" data-copy-share>复制公网链接</button>
            </div>
          </section>` : ''}
        </div>
        <div class="dialog-footer">
          <button class="btn btn-default close-modal">关闭</button>
          <a id="downloadYamlFileBtn" class="btn btn-success btn-sm" href="${escapeHtml(subUrl)}" download>下载 YAML</a>
        </div>
      </div>
    `;

    modal.querySelectorAll('.close-modal').forEach(b => b.onclick = () => modal.remove());

    async function copySubscriptionUrl(input) {
      try {
        await navigator.clipboard.writeText(input.value);
        showToast('订阅地址已复制', 'success');
      } catch {
        input.select();
        showToast('请手动复制已选中的地址', 'info');
      }
    }
    modal.querySelector('#copySubUrlBtn').onclick = () => copySubscriptionUrl(modal.querySelector('#subUrlInput'));

    el.modalContainer.appendChild(modal);
    if (!distribution?.funnelAvailable) return;

    const toggle = modal.querySelector('[data-share-toggle]');
    const hint = modal.querySelector('#subscriptionShareHint');
    const link = modal.querySelector('[data-share-link]');
    const publicInput = link.querySelector('input');
    link.querySelector('button').onclick = () => copySubscriptionUrl(publicInput);
    let current;

    function showShare(share) {
      current = share;
      toggle.disabled = !share.allowed;
      toggle.checked = share.enabled;
      publicInput.value = share.url || '';
      link.hidden = !share.enabled;
      hint.textContent = share.allowed
        ? '拿到公网链接的人可以下载当前已发布的配置。关闭后，旧链接立即失效。'
        : '这份现用设备订阅仅通过 Tailnet 发放。';
    }

    async function fetchShare(options) {
      const path = '/api/distribution/share';
      const url = options ? path : `${path}?profileId=${encodeURIComponent(prof.id)}`;
      const response = await fetch(url, { cache: 'no-store', ...options });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '暂时无法读取外发状态');
      return body;
    }

    toggle.onchange = async () => {
      const enabled = toggle.checked;
      toggle.disabled = true;
      try {
        showShare(await fetchShare({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId: prof.id, enabled })
        }));
      } catch (error) {
        showShare(current);
        showToast(error.message, 'error');
      }
    };
    try {
      showShare(await fetchShare());
    } catch (error) {
      hint.textContent = `${error.message}，请重新打开订阅地址弹窗。`;
    }
  }

  function escapeHtml(str) {
    if (typeof str !== 'string') return String(str || '');
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ========================================================
  // 事件绑定与键盘导航
  // ========================================================

  function navigateTo(view) {
    if (view !== 'sources') sourceGridObserver?.disconnect();
    el.navItems.forEach(item => {
      const selected = item.dataset.view === view;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-current', selected ? 'page' : 'false');
    });
    state.currentView = view;
    el.mobileViewSelect.value = view;
    renderCurrentView();
    el.mainStage.scrollTop = 0;
  }

  el.navItems.forEach(item => {
    el.mobileViewSelect.add(new Option(item.getAttribute('aria-label'), item.dataset.view));
    item.onclick = () => navigateTo(item.dataset.view);
    item.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        item.click();
      }
    };
  });
  el.mobileViewSelect.value = state.currentView;
  el.mobileViewSelect.onchange = event => navigateTo(event.target.value);

  el.profileSelect.onchange = () => {
    state.currentProfileId = el.profileSelect.value;
    state.selectedGroupId = null;
    updateTopbarBadges();
    renderCurrentView();
  };

  el.saveDraftBtn.onclick = saveDraft;
  el.discardDraftBtn.onclick = discardDraft;
  el.publishBtn.onclick = publishProfile;
  el.subExportBtn.onclick = openSubscriptionExportDialog;

  el.validateBtn.onclick = () => {
    const prof = getCurrentProfile();
    const res = validateProfile(prof);
    if (res.valid) {
      showToast('配置校验通过：结构合法完整', 'success');
    } else {
      showToast(`校验失败: ${res.errors[0]}`, 'error');
    }
  };
  el.reviewChangesBtn.onclick = () => {
    const profile = getCurrentProfile();
    if (profile?.publishedVersion) openProfileComparison(el.reviewChangesBtn, { profile, review: true });
  };

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (!document.querySelector('.profile-compare-page')) saveDraft();
    }
  });

  loadData();

})();
