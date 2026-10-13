/* ============================================================
 * 预设正则快照 (Regex Snapshot) v3
 * ============================================================
 * 解决什么问题：
 *   聊天中途换预设后，跟随旧预设的正则失效，导致前文里
 *   依靠旧预设正则隐藏/替换的内容全部失效。
 *
 * 工作原理（快照全部保存在脚本内部，不驻留全局正则）：
 *   1. 在魔法棒(扩展)菜单里点「预设正则快照」打开管理窗口
 *   2. 点「拍快照」：把当前预设中启用的正则保存到脚本变量，
 *      命名为 [快照|预设名] 原名。
 *   3. 动态挂载（叠加核心）：
 *      · 当前预设没有等效正则 → 该快照自动写入全局正则并生效
 *        （挂载条目在正则面板中自动隐藏，完全不可见）
 *      · 当前预设已有等效正则 → 自动从全局正则卸载，防重复执行
 *      · 脚本停用/刷新时会尽力把挂载条目卸载干净
 *   4. 多个预设可各拍各的快照，互不冲突、自动叠加。
 *
 * 管理窗口（魔法棒菜单 → 预设正则快照）：
 *   拍快照      保存/更新当前预设的快照（重复点击安全）
 *   刷新        重新校准挂载状态
 *   清空        删除全部快照
 *   每条快照：电源图标 手动开关 · 机器人图标 恢复自动 · 叉号 删除
 *
 * 注意：
 *   · 手动开关过的快照转为「手动管理」，脚本按你的设置固定
 *     挂载/卸载；点机器人图标恢复自动。
 *   · 旧版脚本遗留在全局正则里的快照，启动时自动收编到脚本内部。
 *   · 正则面板的“正则预设组”批量导出功能可能会带上挂载中的
 *     快照条目（数据层面无法避免），手动操作时留意。
 *   · 需要新版酒馆助手（TavernHelper，含 getTavernRegexes API）。
 * ============================================================ */
 
(async () => {
  // ---------- 环境检查 ----------
  if (typeof getTavernRegexes !== 'function' || typeof updateTavernRegexesWith !== 'function') {
    try { toastr.error('正则快照：酒馆助手版本过低，缺少正则 API，请升级酒馆助手后重试'); } catch {}
    return;
  }
 
  // ---------- 配置 ----------
  const PREFIX = '[快照|';   // 快照命名格式: [快照|预设名] 原名
  const DEBOUNCE_MS = 300;
  const VAR_KEY = 'regexSnapV2'; // 快照数据在脚本变量里的键
 
  // ---------- 通知 ----------
  const notify = (type, msg) => {
    try { (toastr[type] || toastr.info)(msg); } catch { console.log(`[正则快照] ${msg}`); }
  };
 
  // ---------- 工具 ----------
  const genId = () =>
    (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : (typeof SillyTavern !== 'undefined' && SillyTavern.uuidv4)
        ? SillyTavern.uuidv4()
        : `snap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
 
  const clone = (x) => JSON.parse(JSON.stringify(x));
 
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
 
  // 内容指纹：判断“是不是同一条正则”只看内容，不看名字
  const fingerprintOf = (r) => JSON.stringify([
    r.find_regex, r.replace_string, r.trim_strings,
    r.source, r.destination, r.run_on_edit, r.min_depth, r.max_depth,
  ]);
 
  // 从 TavernRegex 提取正则本体字段（去掉 id/名字/开关等管理字段）
  const regexFieldsOf = (r) => ({
    find_regex: r.find_regex,
    replace_string: r.replace_string,
    trim_strings: clone(r.trim_strings ?? []),
    source: clone(r.source ?? {}),
    destination: clone(r.destination ?? {}),
    run_on_edit: r.run_on_edit,
    min_depth: r.min_depth ?? null,
    max_depth: r.max_depth ?? null,
  });
 
  const parseSnapPreset = (name) => {
    const m = String(name ?? '').match(/^\[快照\|(.+?)\] /);
    return m ? m[1] : '';
  };
 
  const parseSnapOrig = (name) => String(name ?? '').replace(/^\[快照\|(.+?)\] /, '');
 
  const debounce = (fn, ms) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };
 
  /* ============================================================
   * 数据层：快照保存在脚本变量里
   * ============================================================ */
 
  // 数据结构: { snapshots: [{ id, preset, origName, mode: 'auto'|'on'|'off', regex: {...} }] }
  const getData = () => {
    const vars = (() => { try { return getVariables({ type: 'script' }) ?? {}; } catch { return {}; } })();
    const d = vars[VAR_KEY];
    return (d && Array.isArray(d.snapshots)) ? d : { snapshots: [] };
  };
 
  const saveData = (data) => {
    try {
      updateVariablesWith((v) => ({ ...(v ?? {}), [VAR_KEY]: data }), { type: 'script' });
    } catch (e) {
      console.warn('[正则快照] 快照数据写入失败', e);
      notify('error', '快照数据写入失败：' + (e?.message ?? e));
    }
  };
 
  // 挂载时构造的 TavernRegex 条目
  const mountOf = (s) => ({
    ...clone(s.regex),
    id: s.id,
    script_name: `${PREFIX}${s.preset}] ${s.origName}`,
    enabled: true,
  });
 
  /* ============================================================
   * 核心：动态挂载 / 卸载（实现“叠加使用”）
   * ============================================================ */
 
  let syncing = false;
 
  async function syncMounts() {
    if (syncing) return;
    syncing = true;
    try {
      const data = getData();
 
      // 当前预设中启用的正则指纹集合
      let presetFps = new Set();
      try {
        presetFps = new Set(
          getTavernRegexes({ type: 'preset', name: 'in_use' })
            .filter((r) => r.enabled)
            .map(fingerprintOf),
        );
      } catch {}
 
      // 应挂载的快照：手动开启，或自动模式下当前预设缺少等效正则
      const mounts = data.snapshots.filter((s) =>
        s.mode === 'on' || (s.mode === 'auto' && !presetFps.has(fingerprintOf(s.regex))),
      );
      const snapIds = new Set(data.snapshots.map((s) => s.id));
 
      const global = getTavernRegexes({ type: 'global' });
      const currentMounted = global.filter((r) => snapIds.has(r.id));
      const desired = mounts.map(mountOf);
 
      // 比较现状与期望，一致则不动（updateTavernRegexesWith 是慢操作）
      const changed =
        currentMounted.length !== desired.length ||
        desired.some((m) => {
          const cur = currentMounted.find((r) => r.id === m.id);
          return !cur || cur.enabled !== true ||
            cur.script_name !== m.script_name || cur.find_regex !== m.find_regex;
        });
 
      if (changed) {
        const base = global.filter((r) => !snapIds.has(r.id));
        await updateTavernRegexesWith(() => [...base, ...desired], { type: 'global' });
      }
    } catch (e) {
      console.error('[正则快照] 挂载同步失败', e);
    } finally {
      syncing = false;
    }
  }
 
  // 当前某条快照是否处于挂载（生效）状态
  const isMountedNow = (id) => {
    try {
      return getTavernRegexes({ type: 'global' }).some((r) => r.id === id);
    } catch { return false; }
  };
 
  /* ============================================================
   * 操作
   * ============================================================ */
 
  async function takeSnapshot() {
    let presetName = '当前预设';
    try { presetName = getLoadedPresetName() || presetName; } catch {}
 
    let presetRegexes = [];
    try { presetRegexes = getTavernRegexes({ type: 'preset', name: 'in_use' }); } catch {}
    const enabled = presetRegexes.filter((r) => r.enabled);
    if (enabled.length === 0) {
      notify('info', `预设「${presetName}」中没有启用的正则，无需快照`);
      return;
    }
 
    const data = getData();
    // 重拍 = 更新：移除本预设旧快照
    data.snapshots = data.snapshots.filter((s) => s.preset !== presetName);
    // 与其他预设的快照按内容去重
    const fps = new Set(data.snapshots.map((s) => fingerprintOf(s.regex)));
 
    let added = 0, skipped = 0;
    for (const r of enabled) {
      const fp = fingerprintOf(r);
      if (fps.has(fp)) { skipped++; continue; }
      fps.add(fp);
      data.snapshots.push({
        id: genId(),
        preset: presetName,
        origName: r.script_name,
        mode: 'auto',
        regex: regexFieldsOf(r),
      });
      added++;
    }
    saveData(data);
    await syncMounts(); // 刚拍的必然在当前预设里，通常不挂载；手动的照常
 
    if (added > 0) {
      notify('success', `已保存预设「${presetName}」的 ${added} 条正则快照${skipped ? `（${skipped} 条内容重复已跳过）` : ''}`);
    } else {
      notify('info', `没有新增快照${skipped ? `（${skipped} 条内容已存在于其他快照中）` : ''}`);
    }
  }
 
  async function clearSnapshots() {
    const data = getData();
    if (data.snapshots.length === 0) { notify('info', '当前没有正则快照'); return; }
    const n = data.snapshots.length;
    saveData({ snapshots: [] });
    await syncMounts(); // 卸载全部
    notify('success', `已删除 ${n} 条正则快照`);
  }
 
  async function toggleOne(id) {
    const data = getData();
    const s = data.snapshots.find((x) => x.id === id);
    if (!s) return;
    s.mode = isMountedNow(id) ? 'off' : 'on';
    saveData(data);
    await syncMounts();
  }
 
  async function deleteOne(id) {
    const data = getData();
    data.snapshots = data.snapshots.filter((x) => x.id !== id);
    saveData(data);
    await syncMounts();
  }
 
  async function restoreAutoOne(id) {
    const data = getData();
    const s = data.snapshots.find((x) => x.id === id);
    if (!s) return;
    s.mode = 'auto';
    saveData(data);
    await syncMounts();
  }
 
  // 旧版脚本把快照存在全局正则里 → 启动时收编到脚本变量
  function migrateOrphans() {
    try {
      const global = getTavernRegexes({ type: 'global' });
      const data = getData();
      const knownIds = new Set(data.snapshots.map((s) => s.id));
      const knownFps = new Set(data.snapshots.map((s) => fingerprintOf(s.regex)));
      let took = 0;
      for (const r of global) {
        if (!r.script_name?.startsWith(PREFIX)) continue;
        if (knownIds.has(r.id)) continue; // 正常挂载条目
        if (knownFps.has(fingerprintOf(r))) continue; // 同内容已收录，丢弃（sync 时会清理）
        data.snapshots.push({
          id: r.id,
          preset: parseSnapPreset(r.script_name) || '未知来源',
          origName: parseSnapOrig(r.script_name),
          mode: 'auto',
          regex: regexFieldsOf(r),
        });
        took++;
      }
      if (took > 0) {
        saveData(data);
        notify('info', `正则快照：已把 ${took} 条旧快照收编到脚本内部`);
      }
    } catch (e) {
      console.warn('[正则快照] 旧快照收编失败', e);
    }
  }
 
  /* ============================================================
   * 管理窗口 UI（SillyTavern.Popup）
   * ============================================================ */
 
  const panelCSS = `
<style>
#rxsnap { max-width: 660px; }
#rxsnap .rxsnap-title {
  display: flex; align-items: center; gap: 8px;
  font-size: 1.15em; font-weight: 700; margin-bottom: 2px;
  padding-right: 40px; /* 给收进来的关闭按钮让位 */
}
#rxsnap .rxsnap-title i { opacity: .85; }
#rxsnap .rxsnap-sub { opacity: .8; font-size: .9em; margin: 4px 0 10px; }
#rxsnap .rxsnap-sub b { word-break: break-all; }
#rxsnap .rxsnap-sub i { margin: 0 1px; }
#rxsnap .rxsnap-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
#rxsnap .rxsnap-actions .menu_button {
  flex: 1 1 0; min-width: 0; margin: 0;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  white-space: nowrap; cursor: pointer;
}
#rxsnap-body .rxsnap-empty { opacity: .7; padding: 18px 4px; text-align: center; }
#rxsnap-body .rxsnap-empty i { display: block; font-size: 1.6em; margin-bottom: 8px; }
#rxsnap-body .rxsnap-grouptitle {
  display: flex; align-items: center; gap: 6px;
  font-weight: 700; margin: 10px 0 4px; opacity: .9;
}
#rxsnap-body .rxsnap-grouptitle small { font-weight: 400; opacity: .6; margin-left: 2px; }
#rxsnap-body .rxsnap-item {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  background: rgba(128,128,128,.13); border: 1px solid rgba(128,128,128,.26);
  border-radius: 8px; padding: 6px 10px; margin: 4px 0;
}
#rxsnap-body .rxsnap-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
#rxsnap-body .rxsnap-badge { font-size: .82em; white-space: nowrap; opacity: .95; }
#rxsnap-body .rxsnap-name { font-weight: 600; word-break: break-all; }
#rxsnap-body .rxsnap-meta { opacity: .6; font-size: .8em; white-space: nowrap; }
#rxsnap-body .rxsnap-meta i { margin: 0 1px; }
#rxsnap-body .rxsnap-ops { display: flex; gap: 4px; flex-shrink: 0; }
#rxsnap-body .rxsnap-ops button {
  background: transparent; border: 1px solid rgba(128,128,128,.4);
  border-radius: 6px; padding: 2px 9px; cursor: pointer; color: inherit; font-size: .9em;
  display: flex; align-items: center; justify-content: center;
}
#rxsnap-body .rxsnap-ops button:hover { background: rgba(128,128,128,.28); }
#rxsnap .rxsnap-tip { opacity: .55; font-size: .8em; margin-top: 12px; line-height: 1.7; }
#rxsnap .rxsnap-tip i { margin: 0 1px; }
/* 把酒馆默认“突出在弹窗边角外”的关闭按钮收进窗口内 */
.popup:has(#rxsnap) .popup-button-close {
  position: absolute !important;
  top: 10px !important;
  right: 10px !important;
  left: auto !important;
  bottom: auto !important;
  background: rgba(128,128,128,.22);
  border-radius: 50%;
  z-index: 10;
}
</style>`;
 
  // 状态图标（FontAwesome）
  const ICON = {
    on: '<i class="fa-solid fa-circle" style="color:#6db56d"></i>',
    off: '<i class="fa-solid fa-circle" style="color:rgba(190,190,190,.5)"></i>',
    hand: '<i class="fa-solid fa-hand" style="color:#d4a259"></i>',
    power: '<i class="fa-solid fa-power-off"></i>',
    robot: '<i class="fa-solid fa-robot"></i>',
    plug: '<i class="fa-solid fa-plug" style="color:#6db56d"></i>',
  };
 
  const destText = (r) => {
    const d = r.destination ?? {};
    if (d.display && d.prompt) return '<i class="fa-solid fa-eye" title="显示"></i><i class="fa-solid fa-brain" title="提示词"></i>';
    if (d.display) return '<i class="fa-solid fa-eye" title="仅显示"></i>';
    if (d.prompt) return '<i class="fa-solid fa-brain" title="仅提示词"></i>';
    return '<i class="fa-solid fa-floppy-disk" title="直接写入聊天文件"></i>';
  };
 
  const depthText = (r) => {
    const mn = r.min_depth, mx = r.max_depth;
    if ((mn == null || mn < 0) && (mx == null || mx < 0)) return '';
    return ` · d:${mn ?? 0}~${mx ?? '∞'}`;
  };
 
  function getPanelData() {
    let presetRegexes = [];
    try { presetRegexes = getTavernRegexes({ type: 'preset', name: 'in_use' }); } catch {}
    const presetFps = new Set(presetRegexes.filter((r) => r.enabled).map(fingerprintOf));
 
    let global = [];
    try { global = getTavernRegexes({ type: 'global' }); } catch {}
    const snapIds = new Set(getData().snapshots.map((s) => s.id));
    const mountedIds = new Set(global.filter((r) => snapIds.has(r.id)).map((r) => r.id));
 
    const data = getData();
    const groups = new Map();
    for (const s of data.snapshots) {
      if (!groups.has(s.preset)) groups.set(s.preset, []);
      groups.get(s.preset).push(s);
    }
    for (const list of groups.values()) list.sort((a, b) => a.origName.localeCompare(b.origName));
    const sortedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
 
    let presetName = '当前预设';
    try { presetName = getLoadedPresetName() || presetName; } catch {}
    return {
      presetName,
      presetEnabledCount: presetRegexes.filter((r) => r.enabled).length,
      snapshots: data.snapshots,
      presetFps, mountedIds, sortedGroups,
    };
  }
 
  function statusOf(s, mountedIds) {
    const mounted = mountedIds.has(s.id);
    if (s.mode !== 'auto') {
      return mounted
        ? { cls: 'manual', text: `${ICON.hand} 手动·启用` }
        : { cls: 'manual', text: `${ICON.hand} 手动·禁用` };
    }
    return mounted
      ? { cls: 'on', text: `${ICON.on} 补位中` }
      : { cls: 'off', text: `${ICON.off} 预设在管` };
  }
 
  function renderSubHTML(d) {
    const mounted = d.snapshots.filter((s) => d.mountedIds.has(s.id)).length;
    const manual = d.snapshots.filter((s) => s.mode !== 'auto').length;
    return `当前预设：<b>${esc(d.presetName)}</b> ｜ 预设内启用正则 ${d.presetEnabledCount} 条 ｜ 快照 ${d.snapshots.length} 条（${ICON.plug}${mounted}${manual ? ` · ${ICON.hand}${manual}` : ''}）`;
  }
 
  function renderBodyHTML(d) {
    if (d.snapshots.length === 0) {
      return `<div class="rxsnap-empty"><i class="fa-regular fa-face-smile"></i>还没有快照。<br>换预设之前点「拍快照」，把当前预设的正则存一份到脚本里。</div>`;
    }
    return d.sortedGroups.map(([gname, items]) => `
      <div class="rxsnap-grouptitle"><i class="fa-solid fa-box"></i>${esc(gname)}<small>${items.length} 条</small></div>
      ${items.map((s) => {
        const st = statusOf(s, d.mountedIds);
        const tip = `查找: ${s.regex.find_regex ?? ''}\n替换: ${s.regex.replace_string ?? ''}`;
        return `
        <div class="rxsnap-item" title="${esc(tip)}">
          <div class="rxsnap-main">
            <span class="rxsnap-badge ${st.cls}">${st.text}</span>
            <span class="rxsnap-name">${esc(s.origName)}</span>
            <span class="rxsnap-meta">${destText(s.regex)}${depthText(s.regex)}</span>
          </div>
          <div class="rxsnap-ops">
            <button data-act="toggle" data-id="${esc(s.id)}" title="手动启用/禁用（转为手动管理）">${ICON.power}</button>
            ${s.mode !== 'auto' ? `<button data-act="auto" data-id="${esc(s.id)}" title="恢复自动管理">${ICON.robot}</button>` : ''}
            <button data-act="del" data-id="${esc(s.id)}" title="删除这条快照"><i class="fa-solid fa-xmark"></i></button>
          </div>
        </div>`;
      }).join('')}`).join('');
  }
 
  function renderPanelHTML() {
    const d = getPanelData();
    return `${panelCSS}
<div id="rxsnap">
  <div class="rxsnap-title"><i class="fa-solid fa-camera-retro"></i>预设正则快照</div>
  <div class="rxsnap-sub">${renderSubHTML(d)}</div>
  <div class="rxsnap-actions">
    <div class="menu_button" data-act="snap"><i class="fa-solid fa-camera-retro"></i>拍快照</div>
    <div class="menu_button" data-act="refresh"><i class="fa-solid fa-arrows-rotate"></i>刷新</div>
    <div class="menu_button" data-act="clear"><i class="fa-solid fa-trash-can"></i>清空全部</div>
  </div>
  <div id="rxsnap-body">${renderBodyHTML(d)}</div>
  <div class="rxsnap-tip"><i class="fa-regular fa-lightbulb"></i> 快照保存在脚本内部，正则面板里看不到。需要生效时自动挂载到全局（${ICON.plug}补位中），原预设在场时自动卸载，防止重复执行。<br>
  ${ICON.power} 手动开关过的条目转为 ${ICON.hand} 手动管理，可点 ${ICON.robot} 恢复自动。重拍同预设快照 = 更新该预设的快照。</div>
</div>`;
  }
 
  // ---------- 弹窗打开与事件 ----------
  let panelPopup = null;
 
  function rerenderBody() {
    const dlg = panelPopup?.dlg;
    if (!dlg) return;
    const d = getPanelData();
    const body = dlg.querySelector('#rxsnap-body');
    if (body) body.innerHTML = renderBodyHTML(d);
    const sub = dlg.querySelector('#rxsnap .rxsnap-sub');
    if (sub) sub.innerHTML = renderSubHTML(d);
  }
 
  async function onPanelClick(e) {
    const btn = e.target?.closest?.('[data-act]');
    if (!btn || !panelPopup?.dlg?.contains?.(btn)) return;
    const act = btn.getAttribute('data-act');
    const id = btn.getAttribute('data-id');
    try {
      if (act === 'snap') await takeSnapshot();
      else if (act === 'clear') await clearSnapshots();
      else if (act === 'refresh') await syncMounts();
      else if (act === 'toggle') await toggleOne(id);
      else if (act === 'del') await deleteOne(id);
      else if (act === 'auto') await restoreAutoOne(id);
      rerenderBody();
    } catch (err) {
      console.error('[正则快照] 操作失败', err);
      notify('error', '操作失败：' + (err?.message ?? err));
    }
  }
 
  async function openPanel() {
    if (panelPopup) return; // 已打开
    await syncMounts();     // 打开前先校准挂载状态
    let type;
    try { type = SillyTavern.POPUP_TYPE.DISPLAY; } catch { type = 2; }
    const popup = new SillyTavern.Popup(renderPanelHTML(), type, '', {
      wide: true,
      allowVerticalScrolling: true,
      onOpen: (p) => { try { p.dlg.addEventListener('click', onPanelClick); } catch {} },
      onClose: (p) => {
        try { p.dlg.removeEventListener('click', onPanelClick); } catch {}
        panelPopup = null;
      },
    });
    panelPopup = popup;
    try {
      await popup.show();
    } catch (e) {
      console.warn('[正则快照] 弹窗异常', e);
    } finally {
      panelPopup = null;
    }
  }
 
  /* ============================================================
   * 正则面板：隐藏挂载中的快照条目
   * ============================================================ */
 
  const PDOC = (() => {
    try { return window.parent?.document ?? document; } catch { return document; }
  })();
 
  function hideMountedRows() {
    try {
      const list = PDOC.getElementById('saved_regex_scripts');
      if (!list) return;
      for (const row of list.children) {
        const nameEl = row.querySelector?.('.regex_script_name');
        if (!nameEl) continue;
        if ((nameEl.textContent || '').trim().startsWith(PREFIX)) {
          row.style.display = 'none';
          row.dataset.rxsnapHidden = '1';
        } else if (row.dataset.rxsnapHidden === '1') {
          row.style.display = '';
          delete row.dataset.rxsnapHidden;
        }
      }
    } catch {}
  }
 
  let observerTries = 0;
  function setupRegexPanelObserver() {
    try {
      const target = PDOC.getElementById('saved_regex_scripts');
      if (!target) {
        if (++observerTries <= 30) setTimeout(setupRegexPanelObserver, 1000);
        return;
      }
      hideMountedRows();
      new MutationObserver(debounce(hideMountedRows, 50))
        .observe(target, { childList: true, subtree: true, characterData: true });
    } catch (e) {
      console.warn('[正则快照] 正则面板监听失败', e);
    }
  }
 
  /* ============================================================
   * 魔法棒(扩展)菜单入口
   * ============================================================ */
 
  const WAND_BTN_ID = 'rxsnap-wand-button';
 
  // 兼容新旧版本：新版官方扩展挂在 #xxx_wand_container 容器里，
  // 旧版酒馆的菜单本身是 #extensionsMenu
  function findWandMenu() {
    try {
      const legacy = PDOC.getElementById('extensionsMenu');
      if (legacy) return legacy;
      const anchor = PDOC.querySelector('[id$="_wand_container"]');
      if (anchor?.parentElement) return anchor.parentElement;
    } catch {}
    return null;
  }
 
  function removeWandButton() {
    try { PDOC.getElementById(WAND_BTN_ID)?.remove(); } catch {}
  }
 
  function addWandButton() {
    try {
      const menu = findWandMenu();
      if (!menu) {
        fallbackToScriptButtons();
        notify('info', '正则快照：未找到魔法棒菜单，已改用脚本按钮（可在酒馆助手面板使用）');
        return;
      }
      removeWandButton();
      const btn = PDOC.createElement('div');
      btn.id = WAND_BTN_ID;
      btn.className = 'list-group-item flex-container flexGap5';
      btn.title = '预设正则快照：保存 / 管理各预设的正则快照';
      btn.innerHTML = '<div class="fa-solid fa-camera-retro extensionsMenuExtensionButton"></div><span>预设正则快照</span>';
      btn.addEventListener('click', () => openPanel().catch((e) => {
        console.error('[正则快照] 打开窗口失败', e);
        notify('error', '打开窗口失败：' + (e?.message ?? e));
      }));
      menu.appendChild(btn);
      window.addEventListener('pagehide', removeWandButton);
      window.addEventListener('beforeunload', removeWandButton);
    } catch (e) {
      console.warn('[正则快照] 魔法棒按钮添加失败', e);
      fallbackToScriptButtons();
    }
  }
 
  // 兜底：老方案，酒馆助手脚本按钮
  function fallbackToScriptButtons() {
    try {
      replaceScriptButtons([{ name: '正则快照', visible: true }]);
      eventOn(getButtonEvent('正则快照'), () => openPanel().catch((e) => {
        console.error('[正则快照] 打开窗口失败', e);
        notify('error', '打开窗口失败：' + (e?.message ?? e));
      }));
    } catch (e) {
      console.warn('[正则快照] 脚本按钮创建失败', e);
    }
  }
 
  /* ============================================================
   * 事件监听 / 退出清理 / 启动
   * ============================================================ */
 
  const syncDebounced = debounce(syncMounts, DEBOUNCE_MS);
  const EV = typeof tavern_events !== 'undefined' ? tavern_events : {};
  const watchEvents = [
    EV.PRESET_CHANGED ?? 'preset_changed',                     // 预设切换
    EV.OAI_PRESET_CHANGED_AFTER ?? 'oai_preset_changed_after', // 聊天补全预设切换
    EV.CHAT_CHANGED ?? 'chat_id_changed',                      // 切聊天
    EV.MESSAGE_SENT ?? 'message_sent',                         // 兜底
    EV.MESSAGE_RECEIVED ?? 'message_received',                 // 兜底
  ];
  for (const ev of watchEvents) {
    try { eventOn(ev, syncDebounced); } catch {}
  }
 
  // 挂载状态变化时（updateTavernRegexesWith 会触发 CHAT_CHANGED），若管理窗口开着则刷新列表
  try {
    eventOn(EV.CHAT_CHANGED ?? 'chat_id_changed', debounce(rerenderBody, DEBOUNCE_MS));
  } catch {}
 
  // 脚本停用/页面卸载时尽力把挂载条目卸载（下次启动孤儿收编会兜底）
  window.addEventListener('pagehide', () => {
    try {
      const data = getData();
      if (!data.snapshots?.length) return;
      updateTavernRegexesWith((list) => {
        const ids = new Set(data.snapshots.map((s) => s.id));
        return list.filter((r) => !ids.has(r.id));
      }, { type: 'global' })?.catch?.(() => {});
    } catch {}
  });
 
  // ---------- 启动 ----------
  migrateOrphans();          // 收编旧版遗留在全局里的快照
  setupRegexPanelObserver(); // 正则面板隐藏挂载条目
  addWandButton();           // 魔法棒入口
  syncMounts();              // 校准挂载状态
})();
