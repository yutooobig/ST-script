/**
 * ============================================================
 *  扩展更新检测优化（酒馆助手 / Tavern Helper 全局脚本）
 * ============================================================
 *  功能：
 *   1. 打开「扩展详情」面板时，默认只检测【已启用】的扩展更新，
 *      禁用中的扩展自动跳过（完全不发请求），大幅缩短检测等待；
 *   2. 在面板工具栏新增【检测所有扩展】按钮，点击后补查所有
 *      被跳过的禁用扩展，检测结果与原版 UI 完全一致；
 *   3. 「Update all / Update enabled / 单个扩展的更新按钮」等
 *      原有功能不受任何影响。
 *
 *  原理：
 *   酒馆打开扩展详情面板时会调用 checkForUpdatesManual，对所有
 *   第三方扩展逐个请求 /api/extensions/version（服务端要对每个
 *   扩展执行 git fetch 远程仓库，因此装得越多检测越慢）。本脚本
 *   在主页面上轻量 hook fetch，把「禁用扩展」的检测请求替换为
 *   本地假响应（isUpToDate: true，与"非 git 仓库"扩展的返回格式
 *   一致，原生逻辑会安全处理）。补查按钮则直接用 jQuery XHR 发
 *   真实请求（XHR 不经过被 hook 的 fetch，且自动携带 CSRF Token）。
 *
 *  兼容：SillyTavern 1.12.x ~ 1.19.x。若面板结构变化，脚本自动
 *  退化为不生效，不会影响任何原版功能。
 *
 *  安装：酒馆助手 → 脚本 → 导入 → 启用。
 * ============================================================
 */
(() => {
    // ---------------- 可按需修改的配置 ----------------
    const BUTTON_TEXT = '检测所有扩展';   // 按钮文字
    const CONCURRENCY = 5;                // 补查并发数（与酒馆原生一致）

    // ---------------- 运行环境 ----------------
    // 酒馆助手脚本运行在与主页面同源的 iframe 中：
    // window.$ 即主页面的 jQuery（可直接查主页面 DOM、自动带 CSRF Token）
    const parentWindow = window.parent;
    const parentDoc = parentWindow.document;

    // ---------------- 共享状态（挂主页面，脚本重载不会错乱） ----------------
    const state = (parentWindow.__TH_EXT_UPDATE_STATE__ ??= {
        skipped: [],          // 本轮面板打开期间被跳过的扩展 [{ externalId, global }]
        currentToolbar: null, // 当前轮次的面板工具栏元素（用于识别新一轮检测）
        checking: false,
    });

    // ---------------- 小工具 ----------------
    const toast = (msg) => {
        try {
            const t = parentWindow.toastr || (typeof toastr !== 'undefined' ? toastr : null);
            if (t) t.info(msg, '', { timeOut: 5000 });
            else console.log('[扩展检测优化]', msg);
        } catch { /* ignore */ }
    };

    // 禁用扩展列表（元素为完整名：third-party/xxx）
    function getDisabledExtensions() {
        try {
            return parentWindow.SillyTavern.getContext().extensionSettings?.disabledExtensions ?? [];
        } catch {
            return [];
        }
    }

    // 在当前「扩展详情」面板中按 data-name（/xxx 短名）查找扩展条目
    function findBlock(externalId) {
        const info = parentDoc.querySelector('.extensions_info');
        if (!info) return null;
        for (const el of info.querySelectorAll('.extension_block')) {
            if (el.dataset?.name === externalId) return el;
        }
        return null;
    }

    // ---------------- 核心：hook 主页面 fetch ----------------
    // 只拦截「POST /api/extensions/version 且扩展处于禁用状态」的请求，
    // 其余任何请求一律原样放行；判断过程抛错时也放行（保底不影响原版功能）。
    function installFetchHook() {
        if (parentWindow.__TH_EXT_FETCH_HOOKED__) return;
        parentWindow.__TH_EXT_FETCH_HOOKED__ = true;

        const origFetch = parentWindow.fetch.bind(parentWindow);
        parentWindow.__TH_EXT_ORIG_FETCH__ = origFetch; // 供补查绕过 hook 使用

        parentWindow.fetch = function (input, init) {
            try {
                const url = typeof input === 'string' ? input
                    : (input && typeof input.url === 'string') ? input.url : '';
                const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();

                if (method === 'POST'
                    && url.includes('/api/extensions/version')
                    && typeof init?.body === 'string') {

                    const body = JSON.parse(init.body);
                    if (typeof body?.extensionName === 'string'
                        && getDisabledExtensions().includes('third-party' + body.extensionName)) {

                        // 识别新一轮检测（面板每次打开都会生成全新的工具栏元素）。
                        // 在 hook 内同步判定，先于本轮所有记录，无竞态。
                        const toolbar = parentDoc.querySelector('.extensions_info .extensions_toolbar');
                        if (toolbar && toolbar !== state.currentToolbar) {
                            state.currentToolbar = toolbar;
                            state.skipped.length = 0; // 丢弃上一轮的记录
                        }

                        // 记录跳过信息，供「检测所有扩展」按钮补查
                        state.skipped.push({
                            externalId: body.extensionName,
                            global: !!body.global,
                        });

                        // 记住该条目此刻的原始版本号（原生逻辑稍后会追加 " (-)" 尾巴）
                        const block = findBlock(body.extensionName);
                        const versionEl = block?.querySelector('.extension_version');
                        if (versionEl && versionEl.dataset.thOrigVersion === undefined) {
                            versionEl.dataset.thOrigVersion = versionEl.textContent;
                        }

                        // 返回与「非 git 仓库扩展」一致的安全假响应：
                        // isUpToDate=true → 不显示更新按钮；空字段与原生容错路径完全兼容
                        return Promise.resolve(new parentWindow.Response(
                            JSON.stringify({
                                currentBranchName: '',
                                currentCommitHash: '',
                                isUpToDate: true,
                                remoteUrl: '',
                            }),
                            { status: 200, headers: { 'Content-Type': 'application/json' } },
                        ));
                    }
                }
            } catch (err) {
                console.warn('[扩展检测优化] 拦截判断异常，已放行原始请求：', err);
            }
            return origFetch(input, init);
        };
    }

    // ---------------- 面板工具栏：注入「检测所有扩展」按钮 ----------------
    function injectButton(toolbar) {
        if (toolbar.querySelector('.th-ext-check-all')) return;
        const btn = parentDoc.createElement('button');
        btn.className = 'menu_button menu_button_icon th-ext-check-all';
        btn.textContent = BUTTON_TEXT;
        btn.title = '打开扩展面板时，默认只检测已启用的扩展（禁用的自动跳过）。\n点击此按钮：补查所有被跳过的禁用扩展。';
        btn.addEventListener('click', onCheckAllClick);
        toolbar.insertBefore(btn, toolbar.firstChild); // 放在 Update all 左侧
    }

    async function onCheckAllClick() {
        if (state.checking) {
            toast('正在检测中，请稍候…');
            return;
        }
        // 面板自带的初始检测（已启用扩展）尚未结束时，先等它跑完
        if (parentDoc.querySelector('.extensions_info .fa-spinner')) {
            toast('正在等待已启用扩展的检测完成，请稍候再点击…');
            return;
        }
        // 去重后作为本次补查目标
        const targets = [...new Map(
            state.skipped.splice(0).map(x => [x.externalId, x]),
        ).values()];

        if (targets.length === 0) {
            toast('没有需要补查的扩展（当前没有被跳过的禁用扩展）');
            return;
        }

        state.checking = true;
        const btn = parentDoc.querySelector('.extensions_toolbar .th-ext-check-all');
        if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
        try {
            toast(`开始检测所有被跳过的扩展（共 ${targets.length} 个）…`);
            const queue = targets.slice();
            const worker = async () => {
                while (queue.length > 0) {
                    const item = queue.shift();
                    await checkOne(item);
                }
            };
            await Promise.all(
                Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()),
            );
            toast(`检测完成（共 ${targets.length} 个）`);
        } finally {
            state.checking = false;
            if (btn) { btn.disabled = false; btn.style.opacity = ''; }
        }
    }

    // 对单个被跳过的扩展发起真实检测请求
    async function checkOne({ externalId, global }) {
        try {
            const data = await postVersion(externalId, !!global);
            applyResult(externalId, data);
        } catch (err) {
            console.warn('[扩展检测优化] 补查失败：', externalId, err);
        }
    }

    // 发请求：优先用主页面的 jQuery XHR（自动附带 X-CSRF-Token，
    // 且 XHR 不经过被 hook 的 fetch）；不可用时退回原生 fetch + 手动取 CSRF。
    async function postVersion(extensionName, global) {
        if (typeof $ === 'function' && $.ajax) {
            return await $.ajax({
                url: '/api/extensions/version',
                method: 'POST',
                contentType: 'application/json',
                data: JSON.stringify({ extensionName, global }),
            });
        }
        const origFetch = parentWindow.__TH_EXT_ORIG_FETCH__;
        const tokenResp = await origFetch('/csrf-token');
        const { token } = await tokenResp.json();
        const resp = await origFetch('/api/extensions/version', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify({ extensionName, global }),
        });
        return await resp.json();
    }

    // 把补查结果写回面板 DOM（复刻原生 checkForUpdatesManual 的 UI 更新逻辑）
    function applyResult(externalId, data) {
        if (!data) return;
        const block = findBlock(externalId);
        if (!block) return;

        // 有更新 → 显示下载按钮 + 名称高亮（与原版一致）
        if (data.isUpToDate === false) {
            block.querySelector('.btn_update')?.classList.remove('displayNone');
            block.querySelector('.extension_name')?.classList.add('update_available');
        }

        // 版本显示：先还原为快照的原始版本号，再追加真实 分支-哈希
        const versionEl = block.querySelector('.extension_version');
        if (versionEl) {
            const base = versionEl.dataset.thOrigVersion
                ?? versionEl.textContent.replace(/\s*\([^()]*\)\s*$/, '');
            const branch = typeof data.currentBranchName === 'string' ? data.currentBranchName : '';
            const hash = typeof data.currentCommitHash === 'string' ? data.currentCommitHash.slice(0, 7) : '';
            versionEl.textContent = `${base} (${branch}-${hash})`;
        }

        // 仓库链接（与原版一致）
        const originLink = block.querySelector('a');
        if (originLink && typeof data.remoteUrl === 'string' && data.remoteUrl) {
            try {
                const u = new URL(data.remoteUrl);
                if (u.protocol === 'https:' || u.protocol === 'http:') {
                    originLink.href = u.href;
                    originLink.target = '_blank';
                    originLink.rel = 'noopener noreferrer';
                }
            } catch { /* 非法链接，忽略 */ }
        }
    }

    // ---------------- 监听「扩展详情」面板打开/重开，注入按钮 ----------------
    // 面板每次打开（包括切换排序、更新扩展后导致的重开）都会生成全新的
    // 工具栏元素；轮次识别与跳过记录的重置在 fetch hook 内同步完成，
    // 此处仅负责注入按钮（幂等）。
    let lastToolbar = null;
    const observer = new MutationObserver((mutations) => {
        // 只有新增节点才可能引入面板，快速短路减少开销
        let hasAdded = false;
        for (const m of mutations) {
            if (m.addedNodes.length > 0) { hasAdded = true; break; }
        }
        if (!hasAdded) return;

        const toolbar = parentDoc.querySelector('.extensions_toolbar');
        if (!toolbar || toolbar === lastToolbar) return;

        lastToolbar = toolbar;
        state.checking = false;
        injectButton(toolbar);
    });

    // ---------------- 启动 ----------------
    installFetchHook();
    observer.observe(parentDoc.body, { childList: true, subtree: true });
    console.log('[扩展检测优化] 脚本已启动：扩展详情面板默认只检测已启用的扩展，工具栏可一键补查全部');
})();
