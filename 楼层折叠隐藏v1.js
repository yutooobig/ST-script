/**
 * ═══════════════════════════════════════════════════════════════════
 *  楼层折叠脚本 · Floor Fold
 *  运行环境：酒馆助手（Tavern Helper）脚本库 —— 立即执行脚本
 * ═══════════════════════════════════════════════════════════════════
 *  功能：
 *   1. 在每个消息楼层的悬浮工具栏添加一个「折叠」按钮（📦）
 *   2. 一键折叠该楼层，实现三重隔离：
 *      ① is_hidden = true —— 等价于原生「排除于提示词 / /hide」，
 *         该楼层完全不参与上下文构建，不会发给 LLM；
 *      ② 楼层正文与全部 swipe 消息页都被替换为极简标记 [此楼层已折叠]
 *         —— 任何插件 / 脚本 / 世界书扫描直接读聊天记录，读到的也只是这句标记；
 *      ③ 原文完整保存在该楼层的自定义数据（楼层变量 __floorFold__）中，
 *         随聊天文件持久化，随时可还原。
 *   3. 折叠后界面显示为一条极简标记条（含字数统计），
 *      点击可查看原文（弹窗）、可一键展开还原。
 *   4. 「仅插件可读」：把正文与 swipe 在数据层恢复为原文，
 *      但保持 is_hidden = true 与折叠标记条 ——
 *      插件 / 脚本 / 世界书扫描可读到原文，LLM 与界面依旧不可读。
 *
 *  交互：
 *   · 工具栏按钮：未折叠 → 左键折叠；已折叠 → 左键查看原文，右键展开还原
 *   · 标记条：    整条点击 → 查看原文；点「展开还原」→ 恢复该楼层
 *                点「仅插件可读」→ 恢复数据层原文（界面仍折叠，提示词仍隔离）
 *   · 原文弹窗：  支持复制原文、一键展开还原，Esc / 点遮罩关闭
 * ═══════════════════════════════════════════════════════════════════
 */
(async function () {
    'use strict';

    // ─────────── 配置 ───────────
    const DATA_KEY    = '__floorFold__';   // 楼层变量中保存折叠信息的键名
    const MARKER_TEXT = '[此楼层已折叠]';   // 折叠后写入正文 / swipe 页的极简标记

    // ─────────── 重入清理（脚本重新保存执行时，先销毁旧实例） ───────────
    if (window.__FLOOR_FOLD__) {
        try { window.__FLOOR_FOLD__.destroy(); } catch (e) { /* 忽略 */ }
    }

    // ─────────── 样式注入 ───────────
    $('#ff-style').remove();
    $(`
    <style id="ff-style">
    /* 极简标记条 */
    .ff-marker {
        display: flex; flex-wrap: wrap; align-items: center; gap: .6em;
        padding: .55em 1em; margin: .1em 0;
        border: 1px dashed rgba(150, 150, 150, .45); border-radius: 10px;
        background: rgba(128, 128, 128, .08);
        opacity: .8; cursor: pointer; user-select: none;
        font-size: .92em; line-height: 1.5;
        transition: opacity .15s ease, background .15s ease;
    }
    .ff-marker:hover { opacity: 1; background: rgba(128, 128, 128, .16); }
    .ff-marker .ff-label { font-weight: 600; }
    .ff-marker .ff-meta  { opacity: .6; font-size: .85em; }
    .ff-marker .ff-actions { margin-left: auto; display: flex; gap: 1em; white-space: nowrap; }
    .ff-marker .ff-view,
    .ff-marker .ff-unfold,
    .ff-marker .ff-plugin-readable {
        text-decoration: underline dotted; cursor: pointer;
    }
    .ff-marker .ff-unfold { color: var(--SmartThemeQuoteColor, #9ad1d5); }
    .ff-marker .ff-plugin-readable { color: #c9a0dc; }
    .ff-marker .ff-plugin-readable.ff-active {
        color: #7fd18f; text-decoration: none; cursor: default; opacity: .85;
    }

    /* 折叠楼层：淡化头部、收起图片/附件/思维链等附属区块 */
    .mes.ff-folded .ch_name { opacity: .55; }
    .mes.ff-folded .mes_img_container,
    .mes.ff-folded .mes_file_container,
    .mes.ff-folded .mes_reasoning_details { display: none !important; }

    /* 工具栏按钮微调 */
    .ff-btn { color: var(--SmartThemeBodyColor, #ddd); }

    /* 原文查看弹窗 */
    .ff-overlay {
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(0, 0, 0, .55);
        display: flex; align-items: center; justify-content: center;
    }
    .ff-dialog {
        display: flex; flex-direction: column;
        width: min(780px, 92vw); max-height: 82vh;
        border-radius: 12px; overflow: hidden;
        background: var(--SmartThemeBlurTintColor, #161616);
        border: 1px solid rgba(160, 160, 160, .25);
        color: var(--SmartThemeBodyColor, #e0e0e0);
        box-shadow: 0 12px 40px rgba(0, 0, 0, .5);
    }
    .ff-head {
        display: flex; align-items: center; gap: 1em;
        padding: .8em 1em; border-bottom: 1px solid rgba(160, 160, 160, .2);
    }
    .ff-title { font-weight: 700; }
    .ff-close { margin-left: auto; cursor: pointer; padding: .2em .5em; border-radius: 6px; }
    .ff-close:hover { background: rgba(255, 255, 255, .1); }
    .ff-body {
        flex: 1; padding: 1em; overflow: auto;
        white-space: pre-wrap; word-break: break-word;
        font-size: .95em; line-height: 1.6;
    }
    .ff-foot {
        display: flex; gap: .8em;
        padding: .8em 1em; border-top: 1px solid rgba(160, 160, 160, .2);
    }
    .ff-btn2 {
        padding: .45em 1.1em; border-radius: 8px; cursor: pointer;
        border: 1px solid rgba(160, 160, 160, .35);
        background: rgba(128, 128, 128, .15); color: inherit; font-size: .9em;
    }
    .ff-btn2:hover { background: rgba(128, 128, 128, .3); }
    </style>`).appendTo('head');

    // ─────────── 工具函数 ───────────
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

    function getMsg(id) {
        try { return getChatMessages(id)?.[0] ?? null; }
        catch (e) { return null; }
    }

    function getFold(id) {
        return getMsg(id)?.data?.[DATA_KEY] ?? null;
    }

    // ═══════════ 核心：折叠 / 还原（数据层，三重隔离） ═══════════

    async function foldMessage(id) {
        const m = getMsg(id);
        if (!m) return toastr.warning(`未找到第 ${id} 楼`);
        if (m.data?.[DATA_KEY]) return; // 已折叠，不重复处理

        // 拉取全部 swipe 消息页（一并折叠，防止从消息页侧泄露原文）
        let swipes = null, swipeId = null;
        try {
            const [sw] = getChatMessages(id, { include_swipes: true });
            if (sw && Array.isArray(sw.swipes) && sw.swipes.length > 0) {
                swipes = sw.swipes.slice();
                swipeId = sw.swipe_id;
            }
        } catch (e) { /* 该楼层无消息页，忽略 */ }

        // 折叠信息：原文 + 消息页 + 时间，存入楼层变量（随聊天文件保存）
        const foldData = { original: m.message, at: Date.now() };
        if (swipes) { foldData.swipes = swipes; foldData.swipe_id = swipeId; }

        const patch = {
            message_id: id,
            message: MARKER_TEXT,      // ② 正文替换为标记
            is_hidden: true,           // ① 排除于提示词，完全不参与上下文注入
            data: { ...m.data, [DATA_KEY]: foldData },  // ③ 原文持久化
        };
        if (swipes) patch.swipes = swipes.map(() => MARKER_TEXT); // 消息页全部替换（等长，索引对齐）

        await setChatMessages([patch], { refresh: 'affected' });
        toastr.success(`第 ${id} 楼已折叠（不参与任何提示词注入）`);
        decorateAll();
    }

    async function unfoldMessage(id) {
        const m = getMsg(id);
        const fold = m?.data?.[DATA_KEY];
        if (!m || !fold) return;

        const data = { ...m.data };
        delete data[DATA_KEY];

        const patch = {
            message_id: id,
            message: typeof fold.original === 'string' ? fold.original : '',
            is_hidden: false,
            data,
        };
        if (Array.isArray(fold.swipes)) {
            patch.swipes = fold.swipes;
            if (typeof fold.swipe_id === 'number') patch.swipe_id = fold.swipe_id;
        }

        await setChatMessages([patch], { refresh: 'affected' });
        toastr.success(`第 ${id} 楼已展开还原`);
        decorateAll();
    }

    // 仅插件可读：数据层恢复原文（插件 / 脚本 / 世界书可读到），
    // 但保持 is_hidden = true（LLM 读不到）、UI 仍为折叠标记条
    async function makePluginReadable(id) {
        const m = getMsg(id);
        const fold = m?.data?.[DATA_KEY];
        if (!m || !fold) return toastr.warning('该楼层未处于折叠状态');
        if (fold.plugin_readable) return toastr.info('该楼层已处于“仅插件可读”状态');

        const data = {
            ...m.data,
            [DATA_KEY]: { ...fold, plugin_readable: true },
        };

        const patch = {
            message_id: id,
            message: typeof fold.original === 'string' ? fold.original : '',
            is_hidden: true,   // 继续排除于提示词 / LLM 上下文
            data,
        };

        // 同时恢复全部 swipe 页原文，插件读 swipe 时也能拿到原样内容
        if (Array.isArray(fold.swipes)) {
            patch.swipes = fold.swipes;
            if (typeof fold.swipe_id === 'number') patch.swipe_id = fold.swipe_id;
        }

        await setChatMessages([patch], { refresh: 'affected' });
        toastr.success(`第 ${id} 楼已恢复原文，但仅插件可读（界面仍折叠，不参与提示词）`);
        scheduleDecorate(150);
    }

    // ═══════════ 显示层：按钮注入 + 极简标记条 ═══════════

    function buildFoldMap() {
        const map = new Map();
        try {
            const msgs = getChatMessages(`0-${getLastMessageId()}`);
            for (const m of msgs) {
                if (m?.data?.[DATA_KEY]) map.set(m.message_id, m.data[DATA_KEY]);
            }
        } catch (e) { /* 聊天未就绪等情况，静默 */ }
        return map;
    }

    function decorateAll() {
        const $chat = $('#chat');
        if (!$chat.length) return;
        const foldMap = buildFoldMap();
        $chat.children('.mes').each((_, el) => {
            const $mes = $(el);
            const id = parseInt($mes.attr('mesid'), 10);
            if (Number.isNaN(id)) return;
            decorateMes($mes, id, foldMap.get(id));
        });
    }

    function decorateMes($mes, id, fold) {
        // 1) 工具栏按钮（.extraMesButtons 为酒馆原生悬浮工具栏容器）
        const $btns = $mes.find('.extraMesButtons').first();
        if ($btns.length) {
            let $btn = $btns.children('.ff-btn').first();
            if (!$btn.length) {
                $btn = $('<div class="mes_button interactable ff-btn fa-solid fa-box-archive"></div>')
                    .appendTo($btns);
            }
            $btn.toggleClass('fa-box-archive', !fold)
                .toggleClass('fa-box-open', !!fold)
                .attr('title', fold
                    ? '已折叠：左键查看原文 / 右键展开还原'
                    : '折叠此楼层（不参与提示词，原文保留可还原）');
        }

        // 2) 极简标记条（接管正文显示区）
        if (fold) {
            $mes.addClass('ff-folded');
            let $card = $mes.find('.ff-marker').first();
            if (!$card.length) {
                $card = buildMarker(id, fold);
                const $text = $mes.find('.mes_text').first();
                if ($text.length) $text.empty().append($card);
                else $mes.append($card); // 兜底：正文容器不存在时直接挂在楼层上
            } else {
                // 已存在标记条：兼容旧实例遗留下的旧标记 + 同步 plugin_readable 状态
                const $acts = $card.find('.ff-actions');
                if (!$card.find('.ff-plugin-readable').length) {
                    $acts.append('<span class="ff-plugin-readable">仅插件可读</span>');
                }
                const $pr = $card.find('.ff-plugin-readable').first();
                const readable = !!fold.plugin_readable;
                $pr.toggleClass('ff-active', readable)
                   .text(readable ? '已恢复原文（仅插件）' : '仅插件可读');
            }
        } else {
            $mes.removeClass('ff-folded');
        }
    }

    function buildMarker(id, fold) {
        const len = (fold.original || '').length;
        const readable = !!fold.plugin_readable;
        const prCls = readable ? 'ff-plugin-readable ff-active' : 'ff-plugin-readable';
        const prTxt = readable ? '已恢复原文（仅插件）' : '仅插件可读';
        return $(`
            <div class="ff-marker" data-mesid="${id}" title="点击查看原文">
                <i class="fa-solid fa-box-archive"></i>
                <span class="ff-label">此楼层已折叠</span>
                <span class="ff-meta">${len} 字</span>
                <span class="ff-actions">
                    <span class="ff-view">查看原文</span>
                    <span class="${prCls}">${prTxt}</span>
                    <span class="ff-unfold">展开还原</span>
                </span>
            </div>`);
    }

    // ═══════════ 原文查看弹窗 ═══════════

    function showOriginal(id) {
        const m = getMsg(id);
        const fold = m?.data?.[DATA_KEY];
        if (!fold) return toastr.warning('该楼层未处于折叠状态');

        $('.ff-overlay').remove(); // 同时只保留一个弹窗
        const time = fold.at ? new Date(fold.at).toLocaleString() : '—';
        const len = (fold.original || '').length;
        const swipeNote = Array.isArray(fold.swipes) ? ` · 共 ${fold.swipes.length} 个消息页` : '';
        const prNote = fold.plugin_readable ? ' · 仅插件可读' : '';

        const $overlay = $(`
            <div class="ff-overlay">
                <div class="ff-dialog" role="dialog">
                    <div class="ff-head">
                        <div class="ff-title">📦 第 ${id} 楼（${esc(m.name)}）原文 · ${len} 字${swipeNote}${prNote} · 折叠于 ${time}</div>
                        <div class="ff-close" title="关闭 (Esc)"><i class="fa-solid fa-xmark"></i></div>
                    </div>
                    <div class="ff-body">${esc(fold.original || '（空）')}</div>
                    <div class="ff-foot">
                        <button class="ff-btn2 ff-copy">复制原文</button>
                        <button class="ff-btn2 ff-restore">展开还原此楼层</button>
                    </div>
                </div>
            </div>`);

        const close = () => { $overlay.remove(); $(document).off('keydown.ffesc'); };
        $overlay.on('click', (e) => { if (e.target === $overlay[0]) close(); });
        $overlay.find('.ff-close').on('click', close);
        $overlay.find('.ff-copy').on('click', async () => {
            try { await navigator.clipboard.writeText(fold.original || ''); toastr.success('原文已复制到剪贴板'); }
            catch (e) { toastr.error('复制失败，请在弹窗中手动选择复制'); }
        });
        $overlay.find('.ff-restore').on('click', async () => { close(); await unfoldMessage(id); });
        $(document).on('keydown.ffesc', (e) => { if (e.key === 'Escape') close(); });

        $('body').append($overlay);
    }

    // ═══════════ 事件绑定（#chat 委托，重入安全） ═══════════

    function bindChatEvents() {
        const $chat = $('#chat');
        if (!$chat.length) { setTimeout(bindChatEvents, 500); return; }
 
        $chat.off('click.ff contextmenu.ff');

        // 工具栏按钮：左键
        $chat.on('click.ff', '.ff-btn', function () {
            const id = parseInt($(this).closest('.mes').attr('mesid'), 10);
            if (Number.isNaN(id)) return;
            if (getFold(id)) showOriginal(id);
            else foldMessage(id);
        });

        // 工具栏按钮：右键 = 快速展开还原
        $chat.on('contextmenu.ff', '.ff-btn', function (e) {
            e.preventDefault();
            const id = parseInt($(this).closest('.mes').attr('mesid'), 10);
            if (!Number.isNaN(id) && getFold(id)) unfoldMessage(id);
        });

        // 标记条：整条点击查看原文；「展开还原」「仅插件可读」单独处理
        $chat.on('click.ff', '.ff-marker', function (e) {
            const id = parseInt(this.dataset.mesid, 10);
            if (Number.isNaN(id)) return;
            if ($(e.target).closest('.ff-unfold').length) return unfoldMessage(id);
            if ($(e.target).closest('.ff-plugin-readable').length) return makePluginReadable(id);
            showOriginal(id);
        });
    }

    // ═══════════ 酒馆事件 + DOM 观察兜底 ═══════════

    let decorateTimer = null;
    function scheduleDecorate(delay = 200) {
        clearTimeout(decorateTimer);
        decorateTimer = setTimeout(decorateAll, delay);
    }

    const disposers = [];
    function registerTavernEvents() {
        const add = (name, fn) => {
            try {
                const r = eventOn(tavern_events[name], fn);
                if (r?.stop) disposers.push(r.stop);
            } catch (e) { console.warn('[楼层折叠] 事件注册失败:', name, e); }
        };
        add('CHAT_CHANGED', () => { setTimeout(decorateAll, 800); setTimeout(decorateAll, 1500);});
        add('USER_MESSAGE_RENDERED',      () => scheduleDecorate(120)); // 新用户楼层
        add('CHARACTER_MESSAGE_RENDERED', () => scheduleDecorate(120)); // 新角色楼层
        add('MESSAGE_UPDATED',            () => scheduleDecorate(120)); // 楼层被更新（含本脚本）
        add('MORE_MESSAGES_LOADED',       () => scheduleDecorate(300)); // 加载更多楼层
    }

    let chatObserver = null;
    function observeChat() {
        const chat = document.getElementById('chat');
        if (!chat) { setTimeout(observeChat, 500); return; }
        // 兜底：酒馆任何原因的全量重绘都会冲掉显示层，观察 DOM 变化后重新应用（幂等）
        chatObserver = new MutationObserver(() => scheduleDecorate(250));
        chatObserver.observe(chat, { childList: true, subtree: true });
    }

    // ═══════════ 实例管理 + 初始化 ═══════════

    window.__FLOOR_FOLD__ = {
        destroy() {
            try { chatObserver?.disconnect(); } catch (e) { /* 忽略 */ }
            disposers.forEach((d) => { try { d(); } catch (e) { /* 忽略 */ } });
            $('#chat').off('.ff');
            $(document).off('keydown.ffesc');
            $('.ff-overlay').remove();
            clearTimeout(decorateTimer);
            // 注：已折叠楼层的标记条与数据保留（数据层状态不因脚本启停而丢失），
            //     重新启用脚本后会自动恢复交互。
        },
    };

    bindChatEvents();
    observeChat();
    registerTavernEvents();
    decorateAll();

    console.log('[楼层折叠] 脚本已启动');
})();
