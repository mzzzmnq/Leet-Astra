// ==UserScript==
// @name         openleet · 题目 AI 助手
// @namespace    opencode-leet
// @version      3.0.0
// @description  在 LeetCode 题目页嵌入 AI 对话面板：分步提示 / 讲代码+复杂度 / Debug 报错 / 代码批注 / Python 知识点。纯前端，直接用你自己的 API key。
// @author       opencode-leet
// @match        https://leetcode.com/problems/*
// @match        https://leetcode.cn/problems/*
// @match        https://www.leetcode.com/problems/*
// @match        https://www.leetcode.cn/problems/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

/**
 * openleet（独立版）
 * =======================
 * 一个纯前端用户脚本：在 LeetCode 题目页右下角注入对话面板，直接调用 OpenAI 兼容
 * 接口，不需要任何本地服务。
 *
 *   browser (leetcode.com)  --GM_xmlhttpRequest-->  <baseUrl>/chat/completions
 *
 * **默认供应商是智谱 GLM-4.5-Flash（免费、国内直连）**；
 * 想改用 OpenCode Go，在 ⚙ 里把接口地址换成 https://opencode.ai/zen/go/v1 即可
 * （代码会自动给 OpenCode Go 补上 x-opencode-session 头）。
 *
 * 为什么必须用 GM_xmlhttpRequest：多数模型服务不返回 CORS 头，页面里的 fetch 会被
 * 浏览器拦；油猴的 GM_xmlhttpRequest 在扩展层发请求，可绕过 CORS。API key 存在
 * 油猴自己的存储里（GM_setValue），不写进页面、只发给你配置的那个端点。
 *
 * 五种 skill：
 *   hint    分步提示（Socratic）
 *   explain 讲代码 + 复杂度
 *   debug   Debug 报错
 *   knowledge Python 语法与知识点
 *   annotate  当前代码批注、提示与错误定位
 *
 * 注意：必须通过 Tampermonkey 安装。若检测不到 GM_xmlhttpRequest（例如被当作普通
 * 网页脚本加载），会退回 fetch —— 那样会因 CORS 失败。
 * 元数据里的 `@connect *` 是为了支持「用户自定义接口地址」；只发给配置的那个端点。
 */
(function () {
  "use strict";

  const IS_LEETCODE = /(^|\.)leetcode\.(com|cn)$/.test(location.hostname);
  const IS_DEMO = new URLSearchParams(location.search).has("ocleet");
  if (!IS_LEETCODE && !IS_DEMO) return;
  if (window.__OCLEET_MOUNTED__) return;
  window.__OCLEET_MOUNTED__ = true;

  /* ------------------------------------------------------------------ shims */
  const PAGE = (() => {
    try {
      return typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;
    } catch {
      return window;
    }
  })();

  function addStyle(css) {
    if (typeof GM_addStyle === "function") {
      try {
        return GM_addStyle(css);
      } catch {
        /* fall through */
      }
    }
    const el = document.createElement("style");
    el.textContent = css;
    document.head.appendChild(el);
    return el;
  }

  const store = {
    get(key, def) {
      try {
        if (typeof GM_getValue === "function") return GM_getValue(key, def);
      } catch {
        /* ignore */
      }
      try {
        const raw = localStorage.getItem("ocleet:" + key);
        return raw == null ? def : JSON.parse(raw);
      } catch {
        return def;
      }
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === "function") {
          GM_setValue(key, value);
          return true;
        }
      } catch {
        // Do not report a successful fallback write that GM_getValue would
        // never read back on the next visit.
        return false;
      }
      try {
        localStorage.setItem("ocleet:" + key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
  };

  /* ----------------------------------------------------------------- config */
  const DEFAULTS = {
    apiKey: "", // 兼容旧配置（会迁移到下面的 keys）
    // 默认用智谱 GLM-4.5-Flash（免费、国内直连、实测较稳）。
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4.5-flash",
    includeCode: true,
    autoRead: true,
    mode: "hint",
    fontSize: 14,
    // 每个供应商各存一把 key —— 切换供应商时不会把 A 家的 key 发到 B 家
    keys: { zhipu: "", opencode: "" },
    // ---- 导出到 LeetNote ----
    leetnoteUrl: "http://127.0.0.1:8080",
    leetnoteToken: "",
    includeAi: true,
  };
  const cfg = { ...DEFAULTS, ...(store.get("config") || {}) };
  if (!cfg.keys) cfg.keys = { zhipu: "", opencode: "" };
  const saveCfg = () => store.set("config", cfg);

  // 可切换的供应商（下拉里用）。模型候选见 modelsForBase()。
  const PROVIDERS = {
    zhipu: { label: "智谱 GLM（免费）", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
    opencode: { label: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go/v1" },
  };
  const goBase = () => (cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, "");
  const chatUrl = () => goBase() + "/chat/completions";
  const usageUrl = () => goBase() + "/usage";
  // 只有 OpenCode Go 需要专用会话头，也只有它有 /usage 可用来校验 key。
  const isOpenCode = () => /opencode\.ai/i.test(goBase());
  const currentProvider = () => (isOpenCode() ? "opencode" : "zhipu");

  // OpenCode Go 的模型候选（走 OpenAI 兼容 /chat/completions；MiniMax/Qwen 走
  // /messages、Grok/Muse 走 /responses，不在这个列表里）。
  const OPENCODE_MODELS = [
    { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-flash-vision-exp", label: "DeepSeek V4 Flash Vision Exp" },
    { id: "glm-5.3-flash", label: "GLM-5.3-Flash" },
    { id: "glm-5.3", label: "GLM-5.3" },
    { id: "glm-5.2", label: "GLM-5.2" },
    { id: "glm-5.1", label: "GLM-5.1" },
    { id: "glm-5", label: "GLM-5" },
    { id: "kimi-k3", label: "Kimi K3" },
    { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
    { id: "kimi-k2.6", label: "Kimi K2.6" },
    { id: "kimi-k2.5", label: "Kimi K2.5" },
    { id: "longcat-2.0", label: "LongCat-2.0" },
    { id: "longcat-2.5-preview-free", label: "LongCat 2.5 Preview Free" },
    { id: "step-5-preview-free", label: "Step 5 Preview Free" },
    { id: "mimo-v2.6-flash", label: "MiMo-V2.6-Flash" },
    { id: "mimo-v2.6-pro", label: "MiMo-V2.6-Pro" },
    { id: "mimo-v2.5", label: "MiMo-V2.5" },
    { id: "mimo-v2.5-pro", label: "MiMo-V2.5-Pro" },
    { id: "mimo-v2-pro", label: "MiMo-V2 Pro" },
    { id: "mimo-v2-omni", label: "MiMo V2 Omni" },
    { id: "hy4-preview", label: "Hy4 preview" },
    { id: "hy3", label: "Hy3" },
    { id: "space-bunny", label: "Space Bunny" },
  ];

  // 智谱（默认供应商）的模型候选。
  // glm-4.5-flash 免费且实测较稳；glm-4.7-flash 也免费但常被限流。
  const ZHIPU_MODELS = [
    { id: "glm-4.5-flash", label: "GLM-4.5-Flash（免费·较稳）" },
    { id: "glm-4.7-flash", label: "GLM-4.7-Flash（免费·常限流）" },
    { id: "glm-4.7", label: "GLM-4.7（付费）" },
    { id: "glm-4.5-air", label: "GLM-4.5-Air（付费）" },
    { id: "glm-4.5", label: "GLM-4.5（付费）" },
  ];

  // 按当前 base_url 选模型候选；换供应商就换一套。
  function modelsForBase() {
    const base = goBase();
    if (/bigmodel\.cn/i.test(base)) return ZHIPU_MODELS;
    if (/opencode\.ai/i.test(base)) return OPENCODE_MODELS;
    return ZHIPU_MODELS;
  }

  /* ----------------------------------------------------------------- skills */
  const BASE_SYSTEM = [
    "你是一个嵌入在 LeetCode 题目页里的编程助教，只围绕当前这道题帮助用户，用简体中文回答。",
    "当前题目信息会附在本条消息后面。",
    "要求：",
    "- 不要编造题目里没有的约束；不确定就明确说不确定。",
    "- 代码放进 Markdown 代码块；行内术语用反引号；公式尽量用简单文字或反引号。",
    "- 回复显示在小窗口：默认正文不超过 180 个汉字，最多 3 个短要点；先说结论，不写开场白、总结、重复追问或大段标题。此前回复即使很长，也按此简短规则回答。",
    "- 只讲当前问题涉及的 1–2 个核心考点，结合用户代码说明它们在本题中的作用；不要复述题目、逐行讲解或扩展无关知识。",
    "- 仅在必要时给一个最小代码片段，默认不超过 8 行，不重复粘贴用户代码。用户明确要求详细解释、完整解法或使用代码批注模式时，才按需放宽代码长度。",
  ].join("\n");

  const SKILLS = {
    hint: {
      label: "分步提示",
      tip: "我不会直接给答案，一次只推进一步。",
      placeholder: "说一下你卡在哪，或直接点发送拿第一步提示…",
      quick: "给我第一步提示",
      system: [
        "模式：分步提示（Socratic）。",
        "- 目标是引导用户自己想到解法，而不是直接给答案。",
        "- 只给一个核心考点和一条可操作的下一步提示；需要引导时最多问一个具体问题，不问是否继续。",
        "- 除非用户明确说“给完整解法”，不要输出可直接提交的完整代码。",
        "- 用户卡住时，用一个小例子或反例来引导。",
      ].join("\n"),
    },
    explain: {
      label: "讲代码+复杂度",
      tip: "简要讲清代码考点、关键逻辑和复杂度。",
      placeholder: "可以贴一段代码，或直接让我讲当前编辑器里的代码…",
      quick: "简要说明当前代码涉及的核心考点、关键逻辑和时空复杂度",
      system: [
        "模式：讲代码 + 复杂度。",
        "- 优先说明本题考察的知识点，以及当前代码中最关键的一处逻辑如何运用它；不逐段展开。",
        "- 用一行给出时间、空间复杂度和简短依据；用户只问局部语法时不额外分析整个算法。",
        "- 代码没写完或有问题时，只指出最关键的问题，不把缺失代码当作已实现。",
        "- 除非用户要求，不要直接重写整段代码。",
      ].join("\n"),
    },
    debug: {
      label: "Debug 报错",
      tip: "把报错或失败用例贴进来，我来定位问题。",
      placeholder: "贴上报错信息 / 失败的用例（输入、期望输出、实际输出）…",
      quick: "帮我找出当前代码里的 bug",
      system: [
        "模式：Debug 报错。",
        "- 优先根据用户给的报错、失败用例和当前代码定位根因。",
        "- 只说明最可能的根因、相关易错知识点和最小修改（尽量只改必要的几行）。",
        "- 缺少定位依据时，只询问一项最关键的信息，不罗列猜测和检查清单。",
        "- 不要顺手重写整个解法。",
      ].join("\n"),
    },
    annotate: {
      label: "代码批注",
      tip: "给当前代码加注释、提示和错误标记，可复制结果。",
      placeholder: "可直接点发送批注当前代码，或说明重点：边界条件、循环逻辑…",
      quick: "请给当前编辑器代码添加简短注释，标出关键知识点、提示和可能的错误。",
      system: [
        "模式：代码批注。",
        "- 批注对象只取本次系统消息中的用户当前代码，不能使用历史对话中的旧代码或其他解法替代。",
        "- 输出完整的带批注代码，允许超过默认 8 行限制；保留原代码、缩进、变量名和已有注释，只新增符合当前语言语法的注释，不修复或重写代码。",
        "- 在相关代码行上方添加简短注释，使用【知识点】、【提示】、【错误】或【待确认】标记。默认只批注最关键的 3–5 处，不逐行翻译；没有必要时可以更少。",
        "- 围绕题目考察点说明代码的作用。确定的错误才标【错误】，简要说明触发条件或反例；无法确认时标【待确认】，不要编造报错、约束或运行结果。",
        "- 提示只指出下一步修改方向，不直接提供替代解法。没有发现明确错误就不要硬加错误标记。",
        "- 注释放在完整语句外，不插入字符串、多行字面量、续行表达式或其他会改变语法/语义的位置。",
        "- 只输出一个带对应语言标记的 Markdown 代码块，代码块外最多补一句必要说明。",
      ].join("\n"),
    },
    knowledge: {
      label: "Python 知识点",
      tip: "直接问 Python 语法，也可先读取当前代码。",
      placeholder: "例如：nums[::-1] 是什么意思？enumerate 怎么用？is 和 == 有什么区别？",
      quick: "用简单例子讲解 Python 列表切片的用法",
      system: [
        "你是一位耐心的 Python 编程老师，用简体中文解释 Python 语法、内置函数、标准库和语言特性。",
        "模式：Python 知识点。",
        "- 优先回答用户最新询问的知识点，不需要围绕 LeetCode 题目；此前的解题对话只在与本次问题相关时参考。",
        "- 默认使用 Python 3；涉及版本差异时说明适用版本，不确定时明确说明。",
        "- 回复显示在小窗口：默认正文不超过 180 个汉字，最多 3 个短要点。先用一句话回答，只讲本次询问的 1–2 个知识点；不写开场白、总结或重复追问。此前回复即使很长，也按此简短规则回答。",
        "- 优先用用户代码中的表达式说明语法作用；必要时才给一个不超过 5 行的最小 Python 示例和预期输出，易错点最多补充一条。",
        "- 代码使用带 python 标记的 Markdown 代码块，行内语法用反引号；输出是推导结果，不要声称已经运行代码。",
        "- 用户贴出代码时，只解释与问题有关的关键表达式；比较写法时只说关键区别，不展开所有用法。",
        "- 用户明确要求详细解释时才放宽长度；除非用户要求，不要展开整道算法题的解法。",
        "- 此模式不附带题目；用户点击读取当前代码后，可附带编辑器代码供参考。用户指代的代码未出现在上下文中时，请他粘贴片段或点击读取当前代码。",
      ].join("\n"),
    },
  };

  /* ---------------------------------------------------------------- markdown */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function renderMarkdown(src) {
    const codeBlocks = [];
    let text = String(src || "").replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code) => {
      codeBlocks.push(code.replace(/\n$/, ""));
      return `\u0000CB${codeBlocks.length - 1}\u0000`;
    });

    const inline = (s) =>
      escapeHtml(s)
        .replace(/`([^`]+)`/g, '<code class="ocleet-ic">$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

    const out = [];
    let list = null;
    const flushList = () => {
      if (list) {
        out.push(`<ul>${list.join("")}</ul>`);
        list = null;
      }
    };

    for (const line of text.split("\n")) {
      const cb = line.match(/^\u0000CB(\d+)\u0000$/);
      if (cb) {
        flushList();
        out.push(`<pre class="ocleet-pre"><code>${escapeHtml(codeBlocks[+cb[1]])}</code></pre>`);
        continue;
      }
      const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
      if (li) {
        (list || (list = [])).push(`<li>${inline(li[1])}</li>`);
        continue;
      }
      flushList();
      if (!line.trim()) continue;
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        const level = Math.min(4, h[1].length + 1);
        out.push(`<h${level}>${inline(h[2])}</h${level}>`);
        continue;
      }
      out.push(`<p>${inline(line)}</p>`);
    }
    flushList();
    return out.join("");
  }

  /* --------------------------------------------------------- problem reader */
  function readTitle() {
    for (const sel of ['[data-cy="question-title"]', 'div[class*="text-title-large"]', "h1"]) {
      const el = document.querySelector(sel);
      const text = el && el.textContent.trim();
      if (text && text.length < 200) return text;
    }
    const m = document.title.match(/^\d+\.\s*([^-]+?)\s*[-|]/);
    return m ? m[1].trim() : document.title.split(" - ")[0];
  }

  function readDifficulty() {
    const el = document.querySelector(
      '[class*="text-difficulty-"], [class*="text-olive"], [class*="text-yellow"], [class*="text-pink"]',
    );
    const text = el && el.textContent.trim();
    return text && /^(Easy|Medium|Hard|简单|中等|困难)$/i.test(text) ? text : null;
  }

  function readTags() {
    return Array.from(document.querySelectorAll('a[href*="/tag/"]'))
      .map((a) => a.textContent.trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  function readDescription() {
    let best = "";
    for (const sel of [
      '[data-track-load="description_content"]',
      ".question-content",
      'div[class*="question-content"]',
      'div[class*="description__"]',
    ]) {
      for (const el of document.querySelectorAll(sel)) {
        const text = (el.innerText || "").trim();
        if (text.length > best.length) best = text;
      }
    }
    return best.slice(0, 12_000);
  }

  function readLanguageLabel() {
    const el = document.querySelector('button[class*="lang"], [class*="lang-select"], #lang-select');
    const text = el && el.textContent.trim();
    return text || null;
  }

  let lastCodeEditorNode = null;
  document.addEventListener("focusin", (event) => {
    const node = event.target?.closest?.(".monaco-editor");
    if (node) lastCodeEditorNode = node;
  });

  function visibleEditor(node) {
    return !!node && node.isConnected && node.getClientRects().length > 0;
  }

  function readModel(model) {
    try {
      if (!model || model.isDisposed?.()) return null;
      const code = model.getValue();
      if (typeof code !== "string") return null;
      let lang = null;
      try { lang = model.getLanguageId?.() || null; } catch { /* optional */ }
      // An empty current model is valid: never replace it with old code.
      return { code, lang, codeSource: "model", codeIncomplete: false };
    } catch {
      return null;
    }
  }

  function readCode() {
    try {
      const monaco = PAGE.monaco;
      const api = monaco?.editor;
      // Resolve the editor and its model afresh on every read (including sends
      // and exports). Model length/order does not identify the current editor.
      if (typeof api?.getEditors === "function") {
        const editors = [];
        for (const editor of api.getEditors()) {
          try {
            const node = editor.getDomNode();
            if (!visibleEditor(node)) continue;
            const readOnlyOption = monaco.EditorOption?.readOnly;
            if (readOnlyOption !== undefined && editor.getOption?.(readOnlyOption)) continue;
            const result = readModel(editor.getModel());
            if (result) editors.push({ node, result, focused: editor.hasTextFocus?.() });
          } catch { /* A disposed editor must not hide the remaining editors. */ }
        }
        const pick = editors.find((entry) => entry.focused)
          || editors.find((entry) => entry.node === lastCodeEditorNode)
          || (editors.length === 1 ? editors[0] : null);
        if (pick) return pick.result;
      }
      if (typeof api?.getModels === "function") {
        const candidates = api.getModels().map(readModel).filter(Boolean);
        const codey = candidates.filter((c) => c.lang && c.lang !== "markdown" && c.lang !== "plaintext");
        const pool = codey.length ? codey : candidates;
        // Older Monaco builds may expose only getModels. Accept an unambiguous
        // model, but do not guess between current/previous/diff models.
        if (pool.length === 1) return pool[0];
      }
    } catch {
      /* fall through to DOM */
    }
    const nodes = Array.from(document.querySelectorAll(".monaco-editor")).filter(visibleEditor);
    const node = nodes.find((entry) => entry === lastCodeEditorNode) || (nodes.length === 1 ? nodes[0] : null);
    const lines = node ? Array.from(node.querySelectorAll(".view-line")) : [];
    if (lines.length) return {
      code: lines.map((line) => line.textContent.replace(/\u00a0/g, " ")).join("\n"),
      lang: readLanguageLabel(), codeSource: "dom", codeIncomplete: true,
    };
    return { code: "", lang: readLanguageLabel(), codeSource: "unavailable", codeIncomplete: true };
  }

  function currentSlug() {
    return (location.pathname.match(/\/problems\/([^/]+)/) || [])[1] || null;
  }

  function readProblem() {
    return {
      title: readTitle(),
      slug: currentSlug(),
      difficulty: readDifficulty(),
      tags: readTags(),
      description: readDescription(),
      url: location.href,
    };
  }

  function readChatContext(mode) {
    const problem = mode === "knowledge" ? {} : readProblem();
    const code = cfg.includeCode && (mode !== "knowledge" || codeRequested) ? readCode() : null;
    return { ...problem, ...code };
  }

  /* ------------------------------------------------------------- upstream API */
  function errorText(status, body) {
    let msg = "";
    try {
      const parsed = JSON.parse(body);
      msg = parsed?.message || parsed?.error?.message || parsed?.error?.type || "";
    } catch {
      msg = String(body || "");
    }
    msg = String(msg).slice(0, 300);
    return `请求失败（HTTP ${status}）${msg ? "：" + msg : ""}`;
  }

  function safeJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  function hasGM() {
    return typeof GM_xmlhttpRequest === "function";
  }
  // 取指定供应商自己的 key
  function providerKey(provider) {
    return String((cfg.keys && cfg.keys[provider]) || "").trim().replace(/^Bearer\s+/i, "");
  }
  function cleanKey() {
    return providerKey(currentProvider());
  }

  /**
   * Call OpenCode Go directly via GM_xmlhttpRequest, which bypasses the missing
   * CORS headers. Streams incrementally when the userscript manager exposes
   * partial `responseText` in `onprogress`; otherwise the whole answer lands at
   * `onload` (still parsed and rendered).
   */
  function directChat(payload, onDelta, onReasoning) {
    return new Promise((resolve, reject) => {
      if (!hasGM()) {
        reject(new Error("没有 GM_xmlhttpRequest：请用 Tampermonkey 安装本脚本（普通网页脚本无法绕过目标服务的 CORS）。"));
        return;
      }
      const key = cleanKey();
      if (!key) {
        reject(new Error("还没填 API key：点右上角 ⚙ 填入你的 API Key。"));
        return;
      }

      let lastLen = 0;
      let buffer = "";
      let received = false;
      let settled = false;
      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        fn(arg);
      };

      const consume = (text) => {
        buffer += text;
        let split;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            const json = safeJson(data);
            if (!json) continue;
            if (json.error) {
              settle(reject, new Error(json.error.message || "上游返回错误"));
              return;
            }
            const delta = json.choices && json.choices[0] && json.choices[0].delta;
            if (!delta) continue;
            if (delta.reasoning_content) {
              received = true;
              onReasoning(delta.reasoning_content);
            }
            if (delta.content) {
              received = true;
              onDelta(delta.content);
            }
          }
        }
      };

      GM_xmlhttpRequest({
        method: "POST",
        url: chatUrl(),
        headers: Object.assign(
          {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
            accept: "text/event-stream",
          },
          // 只有 OpenCode Go 需要这个头（不带会 503）；其它供应商不必发
          isOpenCode() ? { "x-opencode-session": "ocleet-" + Date.now() } : {},
        ),
        data: JSON.stringify({ ...payload, stream: true }),
        timeout: 180_000,
        onprogress: (r) => {
          if (typeof r.responseText === "string" && r.responseText.length > lastLen) {
            consume(r.responseText.slice(lastLen));
            lastLen = r.responseText.length;
          }
        },
        onload: (r) => {
          if (r.status < 200 || r.status >= 300) {
            settle(reject, Object.assign(new Error(errorText(r.status, r.responseText)), { ocleetHttp: true }));
            return;
          }
          if (typeof r.responseText === "string" && r.responseText.length > lastLen) {
            consume(r.responseText.slice(lastLen));
            lastLen = r.responseText.length;
          }
          // Manager buffered the whole response: use a normal completion body.
          if (!received) {
            const body = safeJson(r.responseText);
            const msg = body && body.choices && body.choices[0] && body.choices[0].message;
            if (msg) {
              if (msg.reasoning_content) onReasoning(msg.reasoning_content);
              if (msg.content) onDelta(msg.content);
            }
          }
          settle(resolve, true);
        },
        onerror: () => settle(reject, new Error("无法连接模型服务（网络问题或 key 无效）。")),
        ontimeout: () => settle(reject, new Error("请求超时（180 秒）。")),
      });
    });
  }

  /**
   * 校验存储的 key。OpenCode Go 有 /usage 端点（200 好 / 401 坏）；
   * 智谱等其它供应商没有轻量校验端点，只判断「有没有填」，真正的错误在对话时暴露。
   */
  function checkKey() {
    const key = cleanKey();
    if (!key) return Promise.resolve({ ok: false, reason: "no-key" });
    if (!hasGM()) return Promise.resolve({ ok: false, reason: "no-gm" });
    if (!isOpenCode()) return Promise.resolve({ ok: true });
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: usageUrl(),
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        timeout: 20_000,
        onload: (r) => resolve(r.status >= 200 && r.status < 300 ? { ok: true } : { ok: false, reason: "http", status: r.status }),
        onerror: () => resolve({ ok: false, reason: "network" }),
        ontimeout: () => resolve({ ok: false, reason: "timeout" }),
      });
    });
  }

  /* ------------------------------------------------------------------- style */
  const CSS = `
.ocleet-launcher{position:fixed;right:22px;bottom:22px;z-index:2147483000;height:44px;padding:0 18px;border:none;border-radius:22px;cursor:pointer;
  background:linear-gradient(135deg,#5b7cfa,#8a5cf6);color:#fff;font:600 14px/1 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
  box-shadow:0 10px 26px rgba(70,90,220,.4);transition:transform .12s ease,filter .12s ease}
.ocleet-launcher:hover{filter:brightness(1.08);transform:translateY(-1px)}
.ocleet-panel{position:fixed;right:12px;bottom:78px;z-index:2147483000;width:440px;max-width:calc(100% - 24px);height:min(82vh,820px);display:flex;flex-direction:column;
  background:#12141c;color:#e7e9f0;border:1px solid rgba(255,255,255,.1);border-radius:16px;overflow:hidden;
  box-shadow:0 22px 70px rgba(0,0,0,.55);font:13px/1.6 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
.ocleet-panel[hidden]{display:none}
.ocleet-panel,.ocleet-panel *{box-sizing:border-box}
.ocleet-panel> *:not(.ocleet-messages){flex-shrink:0}
.ocleet-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.02);cursor:grab;touch-action:none;user-select:none}
.ocleet-head.ocleet-dragging{cursor:grabbing}
.ocleet-brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:13.5px}
.ocleet-dot{width:8px;height:8px;border-radius:50%;background:#8b90a3}
.ocleet-dot.ok{background:#37d67a;box-shadow:0 0 0 3px rgba(55,214,122,.18)}
.ocleet-dot.err{background:#ff5f6d;box-shadow:0 0 0 3px rgba(255,95,109,.18)}
.ocleet-actions{display:flex;gap:4px}
.ocleet-icon{background:transparent;border:none;color:#9aa0b4;cursor:pointer;font-size:15px;padding:4px 7px;border-radius:8px}
.ocleet-icon:hover{background:rgba(255,255,255,.08);color:#fff}
.ocleet-settings{position:absolute;inset:48px 8px 8px;z-index:2;padding:14px;border:1px solid rgba(255,255,255,.14);border-radius:12px;background:#191c28;overflow-y:auto;display:flex;flex-direction:column;gap:12px;box-shadow:0 12px 32px #0008}
.ocleet-settings[hidden]{display:none}
.ocleet-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#9aa0b4}
.ocleet-field input,.ocleet-field select{background:#0c0e15;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#e7e9f0;padding:6px 8px;font:inherit;font-size:12.5px}
.ocleet-check{display:flex;align-items:center;gap:8px;font-size:12.5px;color:#c3c7d4}
.ocleet-mode-row{display:flex;align-items:center;gap:10px;padding:10px 12px 6px}
.ocleet-mode-row label{font-size:12px;color:#9aa0b4;flex-shrink:0}
.ocleet-mode-select{min-width:0;flex:1;background:#202438;color:#e7e9f0;border:1px solid #454d73;border-radius:8px;padding:7px 9px;font:inherit;font-size:13px}
.ocleet-context{margin:0 12px;border-bottom:1px solid #ffffff12;padding-bottom:8px;max-height:30vh;overflow-y:auto}
.ocleet-context summary,.ocleet-note-tools summary{cursor:pointer;color:#aeb3c4;font-size:12px;padding:5px 0}
.ocleet-context .ocleet-problem{margin:6px 0 0}
.ocleet-font-controls{display:flex;align-items:center;border:1px solid #ffffff18;border-radius:8px;margin-right:5px}
.ocleet-font-controls button{font-size:12px;min-width:28px;min-height:28px}
.ocleet-font-controls output{font-size:11px;color:#b9bed0;min-width:28px;text-align:center}
.ocleet-icon:disabled{opacity:.35;cursor:default}
.ocleet-panel :is(button,select,summary,input,textarea):focus-visible{outline:2px solid #9b90ff;outline-offset:2px}
.ocleet-settings-title{display:flex;justify-content:space-between;align-items:center;font-weight:600}
.ocleet-note-tools{position:relative}
.ocleet-note-menu{position:absolute;bottom:32px;left:0;z-index:1;display:flex;flex-direction:column;gap:8px;padding:10px;min-width:150px;background:#202330;border:1px solid #ffffff25;border-radius:10px;box-shadow:0 8px 25px #0006}
.ocleet-problem{margin:9px 12px 0;padding:7px 10px;border-radius:9px;background:rgba(91,124,250,.1);border:1px solid rgba(91,124,250,.25);font-size:12px;color:#c9cfe4;display:flex;gap:6px;align-items:center}
.ocleet-problem[hidden]{display:none}
.ocleet-diff{font-size:11px;padding:1px 6px;border-radius:6px;background:rgba(255,255,255,.1)}
.ocleet-messages{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:12px;display:flex;flex-direction:column;gap:12px;font-size:var(--ocleet-font-size,14px)}
.ocleet-messages>*{flex-shrink:0}
.ocleet-msg{max-width:100%;padding:9px 11px;border-radius:12px;white-space:normal;word-break:break-word}
.ocleet-msg.user{align-self:flex-end;background:linear-gradient(135deg,#5b7cfa,#7b5cf5);color:#fff;border-bottom-right-radius:4px}
.ocleet-msg.assistant{align-self:flex-start;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08);border-bottom-left-radius:4px}
.ocleet-msg.error{align-self:flex-start;background:rgba(255,95,109,.12);border:1px solid rgba(255,95,109,.35);color:#ffc4ca}
.ocleet-msg p{margin:0 0 7px}.ocleet-msg p:last-child{margin-bottom:0}
.ocleet-msg ul{margin:4px 0 7px;padding-left:20px}
.ocleet-msg h2,.ocleet-msg h3,.ocleet-msg h4{margin:8px 0 5px;font-size:1em}
.ocleet-ic{background:rgba(255,255,255,.12);padding:1px 5px;border-radius:5px;font-family:ui-monospace,Consolas,monospace;font-size:.95em}
.ocleet-pre{position:relative;background:#0a0b11;border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:9px 10px;overflow-x:auto;margin:5px 0}
.ocleet-pre code{font-family:ui-monospace,Consolas,monospace;font-size:var(--ocleet-font-size,14px);white-space:pre}
.ocleet-copy{position:absolute;top:5px;right:5px;background:rgba(255,255,255,.1);border:none;color:#c3c7d4;border-radius:6px;font-size:11px;padding:2px 7px;cursor:pointer}
.ocleet-copy:hover{background:rgba(255,255,255,.2);color:#fff}
.ocleet-reason{margin-bottom:7px;border-left:2px solid rgba(255,255,255,.18);padding-left:8px}
.ocleet-reason summary{cursor:pointer;color:#8f95a8;font-size:11.5px;outline:none}
.ocleet-reason-body{color:#8f95a8;font-size:1em;white-space:pre-wrap;margin-top:5px;max-height:200px;overflow:auto}
.ocleet-muted{color:#8f95a8}
.ocleet-composer{border-top:1px solid rgba(255,255,255,.08);padding:10px 12px 12px;background:rgba(255,255,255,.02)}
.ocleet-composer textarea{display:block;width:100%;resize:vertical;min-height:52px;max-height:min(160px,22vh);background:#0c0e15;border:1px solid rgba(255,255,255,.12);border-radius:10px;color:#e7e9f0;padding:9px 10px;font:inherit;font-size:var(--ocleet-font-size,14px)}
.ocleet-composer textarea:focus{outline:none;border-color:rgba(138,120,255,.6)}
.ocleet-composer-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}
.ocleet-hint{font-size:11.5px;color:#8f95a8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ocleet-btns{display:flex;gap:6px;flex-shrink:0}
.ocleet-context-actions{display:flex;gap:6px;margin-top:6px}
.ocleet-context-actions .ocleet-btn{flex:1;min-width:0}
.ocleet-btn{border-radius:9px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#dfe2ec;padding:8px 11px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:600;line-height:1.3}
.ocleet-btn:hover{background:rgba(255,255,255,.12)}
.ocleet-btn:disabled{opacity:.5;cursor:not-allowed}
.ocleet-btn.primary{background:linear-gradient(135deg,#5b7cfa,#8a5cf6);border-color:transparent;color:#fff}
.ocleet-btn.primary[disabled]{opacity:.55;cursor:default}
.ocleet-cursor{display:inline-block;width:7px;height:14px;background:#8a5cf6;vertical-align:-2px;animation:ocleet-blink 1s steps(2) infinite}
@keyframes ocleet-blink{0%,50%{opacity:1}50.01%,100%{opacity:0}}
@media(max-height:600px){.ocleet-panel{height:calc(100dvh - 24px);bottom:12px}.ocleet-composer{padding:8px 12px}.ocleet-mode-row{padding-top:6px}}
`;

  /* ---------------------------------------------------------------------- UI */
  addStyle(CSS);

  const launcher = document.createElement("button");
  launcher.className = "ocleet-launcher";
  launcher.type = "button";
  launcher.textContent = "⌘ AI 助手";
  document.body.appendChild(launcher);

  const panel = document.createElement("div");
  panel.className = "ocleet-panel";
  panel.setAttribute("data-ocleet", "panel");
  panel.hidden = true;
  panel.innerHTML = `
    <div class="ocleet-head" data-ocleet="drag-handle" title="拖动标题栏移动窗口，双击恢复默认位置">
      <div class="ocleet-brand"><span class="ocleet-dot" data-ocleet="dot"></span><span>openleet</span></div>
      <div class="ocleet-actions">
        <div class="ocleet-font-controls" role="group" aria-label="对话字号">
          <button class="ocleet-icon" type="button" data-ocleet="font-decrease" aria-label="缩小字体" title="缩小字体">A−</button>
          <output data-ocleet="font-size" aria-live="polite"></output>
          <button class="ocleet-icon" type="button" data-ocleet="font-increase" aria-label="放大字体" title="放大字体">A+</button>
        </div>
        <button class="ocleet-icon" type="button" data-ocleet="settings" title="设置">⚙</button>
        <button class="ocleet-icon" type="button" data-ocleet="close" title="关闭">✕</button>
      </div>
    </div>
    <div class="ocleet-settings" data-ocleet="settings-box" hidden>
      <div class="ocleet-settings-title">设置<button class="ocleet-btn" type="button" data-ocleet="settings-done">完成</button></div>
      <label class="ocleet-field"><span>供应商</span><select data-ocleet="provider">
        <option value="zhipu">智谱 GLM（免费）</option>
        <option value="opencode">OpenCode Go</option>
      </select></label>
      <label class="ocleet-field"><span>API Key（当前供应商）</span><input type="password" data-ocleet="apikey" placeholder="粘贴你该供应商的 API Key" autocomplete="off" /></label>
      <label class="ocleet-field"><span>接口地址（一般不用改）</span><input type="text" data-ocleet="baseurl" /></label>
      <label class="ocleet-field"><span>模型</span><select data-ocleet="model"></select></label>
      <label class="ocleet-check"><input type="checkbox" data-ocleet="include-code" /><span>把当前编辑器里的代码发给模型</span></label>
      <label class="ocleet-check"><input type="checkbox" data-ocleet="auto-read" /><span>打开面板时自动读取题目</span></label>
      <label class="ocleet-field"><span>LeetNote 地址</span><input type="text" data-ocleet="leetnote-url" placeholder="http://127.0.0.1:8080" /></label>
      <label class="ocleet-field"><span>LeetNote 令牌（ln_…）</span><input type="password" data-ocleet="leetnote-token" placeholder="ln_…" autocomplete="off" /></label>
      <label class="ocleet-check"><input type="checkbox" data-ocleet="include-ai" /><span>导入时把最近一次 AI 讲解写进笔记正文</span></label>
    </div>
    <div class="ocleet-mode-row"><label for="ocleet-mode">问答模式</label><select id="ocleet-mode" class="ocleet-mode-select" data-ocleet="tabs"></select></div>
    <div style="padding:0 12px 6px"><button class="ocleet-btn" type="button" data-ocleet="open-debugger">逐行调试 · Python 3</button></div>
    <div class="ocleet-hint" data-ocleet="tip" style="padding:0 12px 6px"></div>
    <details class="ocleet-context">
      <summary>题目与代码</summary>
      <div class="ocleet-context-actions">
        <button class="ocleet-btn" type="button" data-ocleet="read">读取题目</button>
        <button class="ocleet-btn" type="button" data-ocleet="read-code">读取当前代码</button>
      </div>
      <div class="ocleet-problem" data-ocleet="problem" hidden></div>
      <div class="ocleet-problem" data-ocleet="code-status" hidden></div>
    </details>
    <div class="ocleet-muted" data-ocleet="chat-status" style="padding:6px 12px 0;font-size:11px" aria-live="polite"></div>
    <div class="ocleet-messages" data-ocleet="messages"></div>
    <div class="ocleet-composer">
      <textarea data-ocleet="input" rows="2" aria-label="消息"></textarea>
      <div class="ocleet-composer-row">
        <details class="ocleet-note-tools" data-ocleet="note-tools"><summary>LeetNote</summary><div class="ocleet-note-menu">
          <button class="ocleet-btn" type="button" data-ocleet="import">存入 LeetNote</button>
          <button class="ocleet-btn" type="button" data-ocleet="start-leetnote" title="通过本机启动器启动 LeetNote 全部服务">启动 LeetNote</button>
        </div></details>
        <div class="ocleet-btns">
          <button class="ocleet-btn" type="button" data-ocleet="clear">清空</button>
          <button class="ocleet-btn primary" type="button" data-ocleet="send">发送</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(panel);

  const $ = (name) => panel.querySelector(`[data-ocleet="${name}"]`);
  const messagesEl = $("messages");
  const inputEl = $("input");
  const sendBtn = $("send");
  const dot = $("dot");
  const problemEl = $("problem");
  const codeStatusEl = $("code-status");
  const chatStatusEl = $("chat-status");
  const tabsEl = $("tabs");
  const modelSelect = $("model");
  const apiKeyInput = $("apikey");
  const providerSelect = $("provider");
  const baseUrlInput = $("baseurl");
  const includeCodeEl = $("include-code");
  const autoReadEl = $("auto-read");
  const settingsBox = $("settings-box");
  const leetnoteUrlInput = $("leetnote-url");
  const leetnoteTokenInput = $("leetnote-token");
  const includeAiEl = $("include-ai");

  /* ----------------------------------------------------------- reading size */
  function applyFontSize(value, persist = false) {
    const number = Number(value);
    cfg.fontSize = Number.isFinite(number) && number > 0 ? Math.max(12, Math.min(22, Math.round(number))) : 14;
    panel.style.setProperty("--ocleet-font-size", cfg.fontSize + "px");
    $("font-size").textContent = cfg.fontSize;
    $("font-decrease").disabled = cfg.fontSize <= 12;
    $("font-increase").disabled = cfg.fontSize >= 22;
    if (persist) saveCfg();
  }
  applyFontSize(cfg.fontSize);
  $("font-decrease").addEventListener("click", () => applyFontSize(cfg.fontSize - 1, true));
  $("font-increase").addEventListener("click", () => applyFontSize(cfg.fontSize + 1, true));

  /* -------------------------------------------------------- panel position */
  function setupPanelDrag(panel, handle) {
    let position = store.get("panel-position", null);
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) position = null;
    let drag = null;
    function place(x, y) {
      const rect = panel.getBoundingClientRect();
      position = {
        x: Math.max(0, Math.min(x, Math.max(0, window.innerWidth - rect.width))),
        y: Math.max(0, Math.min(y, Math.max(0, window.innerHeight - rect.height))),
      };
      Object.assign(panel.style, { left: position.x + "px", top: position.y + "px", right: "auto", bottom: "auto" });
    }
    function restore() {
      if (!panel.hidden && position) place(position.x, position.y);
    }
    function finish(event) {
      if (!drag || (event && event.pointerId !== drag.id)) return;
      const id = drag.id;
      drag = null;
      handle.classList.remove("ocleet-dragging");
      if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
      store.set("panel-position", position);
    }
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.isPrimary === false || event.target.closest("button")) return;
      const rect = panel.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
      handle.setPointerCapture(event.pointerId);
      handle.classList.add("ocleet-dragging");
      event.preventDefault();
    });
    handle.addEventListener("pointermove", event => {
      if (!drag || event.pointerId !== drag.id) return;
      place(event.clientX - drag.x, event.clientY - drag.y);
    });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) handle.addEventListener(name, finish);
    handle.addEventListener("dblclick", event => {
      if (event.target.closest("button")) return;
      finish();
      position = null;
      for (const key of ["left", "top", "right", "bottom"]) panel.style[key] = "";
      store.set("panel-position", null);
    });
    window.addEventListener("resize", () => { finish(); restore(); });
    window.addEventListener("blur", () => finish());
    return restore;
  }
  const restorePanelPosition = setupPanelDrag(panel, $("drag-handle"));

  /* ---------------------------------------------------- conversation state */
  const MAX_SAVED_MESSAGES = 200;
  let history = [];
  let busy = false;
  let conversation = null;
  let activeRequest = null;
  let saveTimer = 0;
  let codeRequested = false;
  let latestCodeContext = null;

  function conversationKey() {
    const slug = currentSlug() || (IS_DEMO ? "demo:" + location.pathname : null);
    return slug ? `conversation:v1:${location.hostname.replace(/^www\./, "")}:${slug}` : null;
  }

  function loadConversation(key) {
    const saved = key ? store.get(key, null) : null;
    const messages = saved?.version === 1 && Array.isArray(saved.messages)
      ? saved.messages.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-MAX_SAVED_MESSAGES).map((m) => ({
          role: m.role,
          content: m.content,
          status: m.role === "user" ? "complete" : (["complete", "error", "interrupted"].includes(m.status) ? m.status : "interrupted"),
          error: typeof m.error === "string" ? m.error : "",
        }))
      : [];
    return { key, messages, draft: saved?.version === 1 && typeof saved.draft === "string" ? saved.draft : "" };
  }

  function saveConversation() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!conversation?.key) {
      chatStatusEl.textContent = "请在题目页使用，对话按题目自动保存";
      return;
    }
    if (history.length > MAX_SAVED_MESSAGES) history.splice(0, history.length - MAX_SAVED_MESSAGES);
    const ok = store.set(conversation.key, {
      version: 1, messages: history, draft: conversation.draft, updatedAt: Date.now(),
    });
    chatStatusEl.textContent = ok ? "本题对话已自动保存" : "对话保存失败，请先复制重要内容再关闭页面";
  }

  function scheduleConversationSave() {
    if (saveTimer) return;
    chatStatusEl.textContent = "正在保存本题对话…";
    saveTimer = setTimeout(saveConversation, 500);
  }

  function flushConversationSave() {
    if (saveTimer) saveConversation();
  }

  function syncConversation(force = false) {
    const key = conversationKey();
    if (!force && conversation && conversation.key === key) return false;
    if (saveTimer) saveConversation();
    activeRequest = null;
    setBusy(false);
    conversation = loadConversation(key);
    history = conversation.messages;
    inputEl.value = conversation.draft;
    resetMessages();
    for (const message of history) {
      if (message.content) addMessage(message.role, message.content);
      if (message.status !== "complete") addMessage("error", message.error || "上次回答未完成，已恢复收到的内容；可以重新提问。");
    }
    chatStatusEl.textContent = key
      ? (history.length || conversation.draft ? "已恢复本题对话和草稿 · 自动保存" : "本题对话和草稿将自动保存")
      : "请在题目页使用，对话按题目自动保存";
    problemEl.hidden = true;
    codeRequested = false;
    latestCodeContext = null;
    codeStatusEl.hidden = true;
    return true;
  }

  function clearConversation() {
    syncConversation();
    activeRequest = null;
    setBusy(false);
    history = [];
    conversation.messages = history;
    conversation.draft = "";
    inputEl.value = "";
    codeRequested = false;
    latestCodeContext = null;
    codeStatusEl.hidden = true;
    saveConversation();
    resetMessages();
  }

  function chatHistory() {
    const messages = history.filter((m) => m.status === "complete")
      .slice(-24).map(({ role, content }) => ({ role, content }));
    // A bounded context should start with a user turn.
    while (messages[0]?.role === "assistant") messages.shift();
    return messages;
  }
  /* ------------------------------------------------------ conversation UI */

  function setStatus(state) {
    dot.classList.remove("ok", "err");
    if (state) dot.classList.add(state);
    dot.title = state === "ok" ? "API key 可用" : state === "err" ? "key 未配置或无效" : "未检测";
  }

  function scroll() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMessage(role, text) {
    const el = document.createElement("div");
    el.className = `ocleet-msg ${role}`;
    if (role === "assistant") el.innerHTML = renderMarkdown(text);
    else el.textContent = text;
    if (role === "assistant") addCopyButtons(el);
    messagesEl.appendChild(el);
    scroll();
    return el;
  }

  function addCopyButtons(container) {
    for (const pre of container.querySelectorAll("pre")) {
      const btn = document.createElement("button");
      btn.className = "ocleet-copy";
      btn.type = "button";
      btn.textContent = "复制";
      btn.addEventListener("click", () => {
        const code = pre.querySelector("code")?.textContent ?? "";
        navigator.clipboard?.writeText(code).then(
          () => {
            btn.textContent = "已复制";
            setTimeout(() => (btn.textContent = "复制"), 1200);
          },
          () => (btn.textContent = "失败"),
        );
      });
      pre.appendChild(btn);
    }
  }

  function addAssistant() {
    const wrap = document.createElement("div");
    wrap.className = "ocleet-msg assistant";

    const reason = document.createElement("details");
    reason.className = "ocleet-reason";
    reason.hidden = true;
    const reasonSummary = document.createElement("summary");
    reasonSummary.textContent = "思考过程";
    const reasonBody = document.createElement("div");
    reasonBody.className = "ocleet-reason-body";
    reason.append(reasonSummary, reasonBody);

    const body = document.createElement("div");
    body.className = "ocleet-body";
    body.innerHTML = '<span class="ocleet-cursor"></span>';
    wrap.append(reason, body);
    messagesEl.appendChild(wrap);
    scroll();

    const state = { content: "", reasoning: "" };
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        body.innerHTML = renderMarkdown(state.content) || '<span class="ocleet-cursor"></span>';
        addCopyButtons(body);
        scroll();
      });
    };
    return {
      onDelta: (d) => {
        state.content += d;
        schedule();
      },
      onReasoning: (d) => {
        state.reasoning += d;
        reason.hidden = false;
        reasonBody.textContent = state.reasoning;
        scroll();
      },
      text: () => state.content,
      done: () => {
        if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
        body.innerHTML = renderMarkdown(state.content) || '<span class="ocleet-muted">（无内容）</span>';
        addCopyButtons(body);
        scroll();
      },
      fail: (msg) => {
        if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
        wrap.classList.remove("assistant");
        wrap.classList.add("error");
        body.textContent = msg;
        scroll();
      },
    };
  }

  function renderProblemChip(problem) {
    if (cfg.mode === "knowledge" || !problem || !problem.title) {
      problemEl.hidden = true;
      return;
    }
    problemEl.hidden = false;
    problemEl.textContent = "";
    const name = document.createElement("span");
    name.textContent = `已读取：${problem.title}`;
    problemEl.appendChild(name);
    if (problem.difficulty) {
      const diff = document.createElement("span");
      diff.className = "ocleet-diff";
      diff.textContent = problem.difficulty;
      problemEl.appendChild(diff);
    }
  }

  function renderCodeChip(code) {
    codeStatusEl.hidden = !code;
    if (!code) return;
    const count = (code.code || "").trim().length;
    codeStatusEl.textContent = `当前代码${code.lang ? `（${code.lang}）` : ""}：${count} 字符${code.codeIncomplete ? " · 未获取完整代码" : ""}${cfg.includeCode ? "" : " · 已关闭发送代码"}`;
  }

  function onReadProblem() {
    syncConversation();
    const problem = readProblem();
    renderProblemChip(problem);
    addMessage("assistant", `已读取题目 **${problem.title || "(未识别)"}**。需要查看编辑器内容时，请点「读取当前代码」。`);
  }

  function onReadCode() {
    syncConversation();
    codeRequested = true;
    latestCodeContext = readCode();
    renderCodeChip(latestCodeContext);
    const codeStatus = latestCodeContext.codeSource === "model"
      ? (latestCodeContext.code.trim() ? "已读取当前编辑器代码。" : "当前编辑器代码为空。")
      : (latestCodeContext.code ? "只读到了编辑器可见的代码片段，可能不完整；可以手动粘贴完整代码。" : "没读到编辑器代码，可以手动贴给我。");
    addMessage("assistant", codeStatus + (cfg.includeCode ? "" : "设置中已关闭发送代码，启用后才会附带到 AI 请求。"));
  }

  const WELCOME = "选择问答模式后直接提问。展开「题目与代码」可分别读取内容；顶部 A− / A+ 调整阅读字号。";

  function resetMessages() {
    messagesEl.textContent = "";
    addMessage("assistant", WELCOME);
  }

  function buildSystem(mode, problem = {}) {
    const knowledge = mode === "knowledge";
    const lines = knowledge ? [SKILLS.knowledge.system] : [BASE_SYSTEM, SKILLS[mode].system, "", "----- 当前题目上下文 -----"];
    if (!knowledge) {
      lines.push(`【题目】${problem.title || "(未识别)"}${problem.difficulty ? `（${problem.difficulty}）` : ""}`);
      if (problem.url) lines.push(`【链接】${problem.url}`);
      if (problem.tags && problem.tags.length) lines.push(`【标签】${problem.tags.join("、")}`);
      lines.push("", "【题目描述】");
      lines.push((problem.description || "(未读取到题目描述；如果题目不是这道，请让用户把题目贴过来)").slice(0, 8000));
    }
    if (cfg.includeCode && (!knowledge || problem.codeSource)) {
      if (problem.codeIncomplete) lines.push("注意：未获取到完整编辑器代码，以下可能仅是可见片段；不要把缺失部分判断为用户未实现。");
      lines.push("", `【用户当前代码${problem.lang ? `（${problem.lang}）` : ""}】`);
      lines.push("```" + (problem.lang || ""));
      lines.push((problem.code || (problem.codeSource === "model" ? "(当前编辑器代码为空)" : "(暂未读取到编辑器代码)")).slice(0, 8000));
      lines.push("```");
    }
    return lines.join("\n");
  }

  function setBusy(value) {
    busy = value;
    sendBtn.disabled = value;
    sendBtn.textContent = value ? "生成中…" : "发送";
  }

  async function onSend() {
    // Capture what the user chose to send before a pending SPA switch restores
    // the destination problem's draft.
    const text = inputEl.value.trim() || (cfg.mode === "annotate" ? SKILLS.annotate.quick : "");
    syncConversation();
    if (busy) return;
    if (!text) return;
    setBusy(true);
    inputEl.value = "";
    conversation.draft = "";
    addMessage("user", text);
    history.push({ role: "user", content: text, status: "complete" });

    const bubble = addAssistant();
    const reply = { role: "assistant", content: "", status: "streaming" };
    history.push(reply);
    const request = { conversation };
    activeRequest = request;
    const isCurrent = () => activeRequest === request && conversation === request.conversation && conversationKey() === conversation.key;
    saveConversation();
    try {
      const problem = readChatContext(cfg.mode);
      if (cfg.mode === "annotate") {
        if (!cfg.includeCode) throw new Error("代码批注需要读取当前代码，请先在设置中启用「把当前编辑器里的代码发给模型」。");
        if (!problem.code || !problem.code.trim()) throw new Error("没有读取到当前代码，请先在题目编辑器中写入代码，再重试批注。");
        if (problem.codeIncomplete) throw new Error("当前只读取到代码片段，暂不能生成完整批注。请确认编辑器完整代码可读取后重试。");
        if (problem.code.length > 8000) throw new Error("当前代码超过 8,000 字符，超出完整批注上限。请缩短代码后重试，或使用讲代码模式询问局部逻辑。");
      }
      renderProblemChip(problem);
      latestCodeContext = problem.codeSource ? problem : null;
      renderCodeChip(latestCodeContext);
      const payload = {
        model: cfg.model,
        stream: true,
        messages: [{ role: "system", content: buildSystem(cfg.mode, problem) }, ...chatHistory()],
      };
      await directChat(payload, (delta) => {
        if (!isCurrent()) return;
        reply.content += delta;
        bubble.onDelta(delta);
        scheduleConversationSave();
      }, (delta) => {
        if (isCurrent()) bubble.onReasoning(delta);
      });
      if (!isCurrent()) return;
      reply.status = "complete";
      bubble.done();
      setStatus("ok");
      saveConversation();
    } catch (err) {
      if (!isCurrent()) return;
      reply.status = reply.content ? "interrupted" : "error";
      reply.error = err.message || String(err);
      if (reply.content) {
        bubble.done();
        addMessage("error", reply.error);
      } else bubble.fail(reply.error);
      setStatus("err");
      saveConversation();
    } finally {
      if (activeRequest === request) {
        activeRequest = null;
        setBusy(false);
      }
    }
  }

  /* ---------------------------------------------------------- LeetNote export */
  // 把当前题目 + 代码（可选带上 AI 讲解）存进本机 LeetNote。
  // 走 GM_xmlhttpRequest：扩展层发请求可绕过 CORS/PNA，本机 :8080 直达。
  function gmFetch(method, url, headers, body) {
    return new Promise((resolve, reject) => {
      if (!hasGM()) {
        reject(new Error("没有 GM_xmlhttpRequest，请通过 Tampermonkey 使用本脚本"));
        return;
      }
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data: body,
        timeout: 20000,
        onload: (r) => resolve(r),
        ontimeout: () => reject(new Error("请求 LeetNote 超时")),
        onerror: () => reject(new Error("连不上 LeetNote，确认它在 " + leetnoteBase() + " 运行")),
      });
    });
  }

  const leetnoteBase = () => (cfg.leetnoteUrl || DEFAULTS.leetnoteUrl).replace(/\/+$/, "");

  async function probeLeetNoteServices() {
    const targets = [
      ["API / 数据库", "http://127.0.0.1:8080/health"],
      ["AI", "http://127.0.0.1:8000/health"],
      ["网页", "http://localhost:5173/"],
    ];
    return Promise.all(targets.map(([name, url]) => new Promise(resolve => {
      GM_xmlhttpRequest({ method: "GET", url, timeout: 2500,
        onload: response => {
          let ready = response.status >= 200 && response.status < 300;
          if (name !== "网页" && ready) {
            try { const data = JSON.parse(response.responseText); ready = data.service === (name === "AI" ? "leetnote-ai" : "leetnote-api") && data.database === "ok"; }
            catch { ready = false; }
          }
          resolve({ name, ready });
        },
        onerror: () => resolve({ name, ready: false }),
        ontimeout: () => resolve({ name, ready: false }),
      });
    })));
  }

  async function startLeetNote() {
    const button = $("start-leetnote");
    if (button.disabled) return;
    if (IS_DEMO) {
      addMessage("assistant", "离线演示不会启动本机服务。实际使用前请按 README 安装 LeetNote 启动器。");
      return;
    }
    if (!/^http:\/\/(?:127\.0\.0\.1|localhost):8080\/?$/i.test(leetnoteBase())) {
      addMessage("assistant", "启动器仅用于本机默认端口的 LeetNote。当前配置不是本机 8080 地址，请在服务所在电脑启动。");
      return;
    }
    button.disabled = true;
    const note = addMessage("assistant", "已请求本机启动器。请允许浏览器打开外部应用；首次使用需按 README 安装启动器。正在检查服务…");
    try {
      const link = document.createElement("a");
      link.href = "openleet-leetnote://start";
      document.body.appendChild(link);
      link.click();
      link.remove();
      const deadline = Date.now() + 240000;
      let states;
      do {
        states = await probeLeetNoteServices();
        if (states.every(service => service.ready)) {
          note.textContent = "LeetNote 的 API / 数据库、AI 和网页服务已就绪。Redis 为可选服务。现在可以点击「存入 LeetNote」。";
          return;
        }
        note.textContent = "等待 LeetNote 启动：" + states.map(service => service.name + (service.ready ? " ✓" : " 等待中")).join("；") + "。数据库恢复时会先等待其就绪，请勿重复点击（最多等待 4 分钟）。";
        await new Promise(resolve => setTimeout(resolve, 2000));
      } while (Date.now() < deadline);
      note.textContent = "未能确认全部服务就绪：" + states.filter(service => !service.ready).map(service => service.name).join("、") + "。请确认本机 openleet 的 scripts 目录也已更新，并允许浏览器打开外部应用。排查日志：%TEMP%\\openleet-leetnote.start.err.log 和 %TEMP%\\openleet-leetnote.start.out.log。";
    } catch (error) {
      note.textContent = "无法启动 LeetNote：" + error.message + "。请按 README 检查本机启动器。";
    } finally {
      button.disabled = false;
    }
  }

  const DIFFICULTY_MAP = { 简单: "Easy", 中等: "Medium", 困难: "Hard" };

  function normalizeDifficulty(raw) {
    if (!raw) return "";
    const t = String(raw).trim();
    const en = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
    if (en === "Easy" || en === "Medium" || en === "Hard") return en;
    return DIFFICULTY_MAP[t] || "";
  }

  // 标题形如「1. 两数之和」/「1.Two Sum」——取出题号；取不到就留空（LeetNote 允许没有题号）
  function parseLeetCodeId(title) {
    const m = String(title || "").match(/^\s*(\d+)\s*[.、]/);
    return m ? Number(m[1]) : null;
  }

  // LeetNote 会自己用题号拼标题；页面标题里已经带了题号，去掉避免「1. 1. Two Sum」
  function cleanTitle(title) {
    return String(title || "")
      .replace(/^\s*\d+\s*[.、]\s*/, "")
      .trim();
  }

  function lastAssistantText() {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i].role === "assistant" && history[i].status === "complete" && history[i].content) return history[i].content;
    }
    return "";
  }

  async function importToLeetNote() {
    syncConversation();
    const token = (cfg.leetnoteToken || "").trim();
    if (!token) {
      addMessage("assistant", "还没配置 LeetNote 令牌。点右上角 ⚙ 填入（在 LeetNote 里用 `go run ./cmd/token -user <用户名>` 生成）。");
      settingsBox.hidden = false;
      return;
    }

    const problem = { ...readProblem(), ...readCode() };
    if (!problem.slug) {
      addMessage("assistant", "没识别到当前题目（slug 为空），请在题目页使用。");
      return;
    }

    const solutions = [];
    if (problem.code && problem.code.trim()) {
      solutions.push({
        language: problem.lang || readLanguageLabel() || "python",
        code: problem.code,
      });
    }

    const body = {
      problem: {
        title_slug: problem.slug,
        title: cleanTitle(problem.title) || problem.slug,
        leetcode_id: parseLeetCodeId(problem.title),
        difficulty: normalizeDifficulty(problem.difficulty),
        url: problem.url,
      },
      content_md: cfg.includeAi ? lastAssistantText() : "",
      solutions,
      source: "openleet",
    };

    const note = addMessage("assistant", "正在存入 LeetNote…");
    try {
      const res = await gmFetch(
        "POST",
        leetnoteBase() + "/api/v1/import/note",
        { "Content-Type": "application/json", Authorization: "Bearer " + token },
        JSON.stringify(body),
      );

      let data = {};
      try {
        data = JSON.parse(res.responseText);
      } catch {
        /* 非 JSON 响应，下面按状态码兜底 */
      }

      if (res.status >= 200 && res.status < 300) {
        const action = data.note_created ? "新建" : "更新";
        const linked = data.problem_created ? "，题目一并新建" : "，已关联已有题目";
        note.innerHTML = renderMarkdown(`✅ 已${action}笔记：**${data.note?.title || problem.title}**${linked}`);
      } else if (res.status === 401) {
        note.innerHTML = renderMarkdown("❌ 令牌无效或已被吊销，去 LeetNote 重新生成后更新 ⚙ 里的配置。");
      } else {
        note.innerHTML = renderMarkdown(`❌ 存入失败（HTTP ${res.status}）：${data.error?.message || ""}`);
      }
    } catch (err) {
      note.innerHTML = renderMarkdown(`❌ 存入失败：${err.message || String(err)}`);
    }
    scroll();
  }

  /* ------------------------------------------------------------------- wiring */
  function renderTabs() {
    if (!Object.hasOwn(SKILLS, cfg.mode)) cfg.mode = "hint";
    tabsEl.textContent = "";
    for (const [key, skill] of Object.entries(SKILLS)) {
      const tab = document.createElement("option");
      tab.value = key;
      tab.textContent = skill.label;
      tabsEl.appendChild(tab);
    }
    tabsEl.value = cfg.mode;
    inputEl.placeholder = SKILLS[cfg.mode].placeholder;
    $("tip").textContent = SKILLS[cfg.mode].tip;
    $("read").disabled = cfg.mode === "knowledge";
    $("read").title = cfg.mode === "knowledge" ? "知识点模式无需题目，可单独读取当前代码" : "只读取题目标题、描述、难度和标签";
    $("read-code").title = "只读取当前编辑器代码；启用发送代码时附带到 AI 请求";
    problemEl.hidden = true;
    renderCodeChip(cfg.mode === "knowledge" && !codeRequested ? null : latestCodeContext);
  }

  function fillModels(models) {
    modelSelect.textContent = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      modelSelect.appendChild(opt);
    }
    if (!models.some((m) => m.id === cfg.model) && models.length) cfg.model = models[0].id;
    modelSelect.value = cfg.model;
  }

  async function verifyKey() {
    if (!hasGM()) {
      setStatus("err");
      addMessage("assistant", "没有检测到 GM_xmlhttpRequest：请通过 Tampermonkey 安装并启用本脚本。");
      return;
    }
    const result = await checkKey();
    setStatus(result.ok ? "ok" : "err");
    if (result.ok) return;
    if (result.reason === "no-key") {
      if (!verifyKey._greeted) {
        verifyKey._greeted = true;
        addMessage("assistant", "还没有配置 API key。点右上角 ⚙，把 OpenCode Go 的 key（`oc_sk_…`）填进去就能开始。");
      }
    } else if (result.reason === "http") {
      addMessage("assistant", `API key 校验失败（HTTP ${result.status}）：key 可能无效或已过期。`);
    } else if (result.reason === "network" || result.reason === "timeout") {
      addMessage("assistant", "连不上模型服务，检查网络或代理。");
    }
  }

  launcher.addEventListener("click", () => {
    syncConversation();
    panel.hidden = !panel.hidden;
    restorePanelPosition();
    if (!panel.hidden && cfg.autoRead && cfg.mode !== "knowledge") {
      const problem = readProblem();
      renderProblemChip(problem);
    }
  });
  $("close").addEventListener("click", () => (panel.hidden = true));
  $("settings").addEventListener("click", () => {
    settingsBox.hidden = !settingsBox.hidden;
    if (!settingsBox.hidden) $("settings-done").focus();
  });
  $("settings-done").addEventListener("click", () => { settingsBox.hidden = true; $("settings").focus(); });
  tabsEl.addEventListener("change", () => {
    cfg.mode = tabsEl.value;
    saveCfg();
    renderTabs();
  });
  panel.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      if (!settingsBox.hidden) { settingsBox.hidden = true; $("settings").focus(); }
      $("note-tools").open = false;
    }
  });
  $("send").addEventListener("click", onSend);
  $("import").addEventListener("click", importToLeetNote);
  $("start-leetnote").addEventListener("click", startLeetNote);
  $("clear").title = "清除本题已保存的对话和草稿";
  $("clear").addEventListener("click", clearConversation);
  $("read").addEventListener("click", onReadProblem);
  $("read-code").addEventListener("click", onReadCode);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });
  inputEl.addEventListener("input", () => {
    const draft = inputEl.value;
    syncConversation();
    inputEl.value = draft;
    conversation.draft = draft;
    scheduleConversationSave();
  });
  window.addEventListener("pagehide", flushConversationSave);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushConversationSave();
  });
  apiKeyInput.addEventListener("change", () => {
    cfg.keys[currentProvider()] = apiKeyInput.value.trim();
    saveCfg();
    verifyKey();
  });
  providerSelect.addEventListener("change", () => {
    const p = providerSelect.value;
    cfg.baseUrl = (PROVIDERS[p] || PROVIDERS.zhipu).baseUrl;
    baseUrlInput.value = cfg.baseUrl;
    // 换供应商：模型候选随之切换（fillModels 会把不在列表里的 cfg.model 换成第一项）
    fillModels(modelsForBase());
    // 载入该供应商自己的 key，避免把 A 家的 key 发到 B 家
    apiKeyInput.value = providerKey(p);
    saveCfg();
    verifyKey();
  });
  baseUrlInput.addEventListener("change", () => {
    cfg.baseUrl = baseUrlInput.value.trim() || DEFAULTS.baseUrl;
    saveCfg();
    // 手动改地址后，供应商下拉与模型候选也跟着变
    providerSelect.value = currentProvider();
    fillModels(modelsForBase());
    saveCfg();
    verifyKey();
  });
  modelSelect.addEventListener("change", () => {
    cfg.model = modelSelect.value;
    saveCfg();
  });
  includeCodeEl.addEventListener("change", () => {
    cfg.includeCode = includeCodeEl.checked;
    saveCfg();
    renderCodeChip(cfg.mode === "knowledge" && !codeRequested ? null : latestCodeContext);
  });
  autoReadEl.addEventListener("change", () => {
    cfg.autoRead = autoReadEl.checked;
    saveCfg();
  });
  leetnoteUrlInput.addEventListener("change", () => {
    cfg.leetnoteUrl = leetnoteUrlInput.value.trim() || DEFAULTS.leetnoteUrl;
    saveCfg();
  });
  leetnoteTokenInput.addEventListener("change", () => {
    cfg.leetnoteToken = leetnoteTokenInput.value.trim();
    saveCfg();
  });
  includeAiEl.addEventListener("change", () => {
    cfg.includeAi = includeAiEl.checked;
    saveCfg();
  });

  // Reflect stored config into the controls.
  // 旧配置迁移：以前只有一个 apiKey，归到「当前供应商」名下后清掉（避免串给别家）
  if (cfg.apiKey) {
    if (!cfg.keys[currentProvider()]) cfg.keys[currentProvider()] = cfg.apiKey;
    cfg.apiKey = "";
    saveCfg();
  }
  providerSelect.value = currentProvider();
  apiKeyInput.value = providerKey(currentProvider());
  baseUrlInput.value = cfg.baseUrl;
  includeCodeEl.checked = cfg.includeCode;
  autoReadEl.checked = cfg.autoRead;
  leetnoteUrlInput.value = cfg.leetnoteUrl;
  leetnoteTokenInput.value = cfg.leetnoteToken;
  includeAiEl.checked = cfg.includeAi;
  renderTabs();
  fillModels(modelsForBase());
  syncConversation(true);

  verifyKey();

  // LeetCode is a SPA: restore the conversation belonging to the new problem.
  setInterval(() => {
    if (!syncConversation()) return;
    pythonDebugger.onRouteChange();
    if (!panel.hidden && cfg.autoRead && cfg.mode !== "knowledge") renderProblemChip(readProblem());
  }, 1200);

  // BEGIN GENERATED DEBUGGER
  const PYTHON_TRACE_SOURCE = "\"\"\"Small, bounded Python tracer used inside the disposable Pyodide worker.\"\"\"\nimport ast\nimport contextlib\nimport inspect\nimport io\nimport itertools\nimport sys\nimport time\nimport tokenize\nimport typing\n\n\nclass ListNode:\n    def __init__(self, val=0, next=None):\n        self.val, self.next = val, next\n\n\nclass TreeNode:\n    def __init__(self, val=0, left=None, right=None):\n        self.val, self.left, self.right = val, left, right\n\n\nclass _Limit(BaseException):\n    pass\n\n\ndef _snapshot(value, depth=0, seen=None):\n    \"\"\"Avoid user-defined repr/iteration/property hooks in debugger snapshots.\"\"\"\n    seen = set() if seen is None else seen\n    kind = type(value)\n    if kind in (type(None), bool, int, float, str):\n        if kind is int and value.bit_length() > 1000:\n            return '<large int>'\n        return repr(value[:200] + ('…' if len(value) > 200 else '')) if kind is str else repr(value)\n    if id(value) in seen:\n        return '<cycle>'\n    if depth >= 3:\n        return '…'\n    seen = seen | {id(value)}\n    render = lambda item: _snapshot(item, depth + 1, seen)\n    if kind in (list, tuple):\n        left, right = ('[', ']') if kind is list else ('(', ')')\n        return left + ', '.join(render(item) for item in value[:20]) + (', …' if len(value) > 20 else '') + right\n    if kind is dict:\n        items = list(itertools.islice(value.items(), 20))\n        return '{' + ', '.join(render(k) + ': ' + render(v) for k, v in items) + (', …' if len(value) > 20 else '') + '}'\n    if kind in (ListNode, TreeNode):\n        fields = ('val', 'next') if kind is ListNode else ('val', 'left', 'right')\n        data = object.__getattribute__(value, '__dict__')\n        return kind.__name__ + '(' + ', '.join(key + '=' + render(data.get(key)) for key in fields) + ')'\n    return '<' + kind.__name__ + '>'\n\n\ndef _inputs(text):\n    if not text.strip():\n        return [], {}\n\n    class Constants(ast.NodeTransformer):\n        def visit_Name(self, node):\n            if node.id in ('true', 'false', 'null'):\n                return ast.copy_location(ast.Constant({'true': True, 'false': False, 'null': None}[node.id]), node)\n            return node\n\n    def literal(node):\n        return ast.literal_eval(Constants().visit(node))\n\n    # NEWLINE ends a logical argument row; NL keeps bracketed values together.\n    rows, tokens = [], []\n    for token in tokenize.generate_tokens(io.StringIO(text).readline):\n        if token.type in (tokenize.INDENT, tokenize.DEDENT, tokenize.ENDMARKER):\n            continue\n        if token.type == tokenize.NEWLINE:\n            rows.append(tokenize.untokenize(tokens).strip())\n            tokens = []\n        elif token.type != tokenize.COMMENT:\n            tokens.append((token.type, token.string))\n    if tokens:\n        rows.append(tokenize.untokenize(tokens).strip())\n    args, kwargs = [], {}\n    for row in rows:\n        if not row:\n            continue\n        call = ast.parse('_input(' + row + ')', mode='eval').body\n        for node in call.args:\n            args.append(literal(node))\n        for item in call.keywords:\n            if item.arg is None or item.arg in kwargs:\n                raise ValueError('Input names must be unique; ** expansion is unsupported')\n            kwargs[item.arg] = literal(item.value)\n    return args, kwargs\n\n\ndef _convert(value, parameter):\n    annotation = parameter.annotation\n    name = annotation if isinstance(annotation, str) else str(annotation)\n    if type(value) is not list:\n        return value\n    if 'ListNode' in name:\n        head = None\n        for item in reversed(value):\n            head = ListNode(item, head)\n        return head\n    if 'TreeNode' in name:\n        if not value or value[0] is None:\n            return None\n        root = TreeNode(value[0])\n        queue, index = [root], 1\n        for parent in queue:\n            for field in ('left', 'right'):\n                if index >= len(value):\n                    return root\n                item = value[index]\n                index += 1\n                if item is not None:\n                    child = TreeNode(item)\n                    setattr(parent, field, child)\n                    queue.append(child)\n        if index < len(value):\n            raise ValueError('Tree input has unreachable nodes')\n        return root\n    return value\n\n\ndef trace_code(code: str, case_text: str, entry: str = ''):\n    events, frame_states, loops = [], {}, {}\n    result = {'events': events, 'result': '', 'stdout': '', 'error': '', 'limited': False, 'entry': entry}\n    started = time.monotonic()\n\n    class Output(io.StringIO):\n        def write(self, text):\n            remaining = 4000 - self.tell()\n            super().write(text[:max(0, remaining)])\n            if len(text) > remaining:\n                raise _Limit('Output limit (4000 characters) reached')\n            return len(text)\n\n    output = Output()\n\n    class Instrument(ast.NodeTransformer):\n        def __init__(self):\n            self.parents = []\n            self.owner = ('<module>', 1)\n\n        def scope(self, node):\n            previous = self.parents, self.owner\n            self.parents = []\n            self.owner = (node.name, min([node.lineno] + [item.lineno for item in node.decorator_list]))\n            self.generic_visit(node)\n            self.parents, self.owner = previous\n            return node\n\n        visit_FunctionDef = scope\n        visit_AsyncFunctionDef = scope\n        visit_ClassDef = scope\n\n        def instrument(self, node):\n            line = node.lineno\n            loops[line] = (node.body[-1].end_lineno, tuple(self.parents), self.owner)\n            self.parents.append(line)\n            self.generic_visit(node)\n            self.parents.pop()\n            injected = ast.Expr(value=ast.Call(func=ast.Name(id='_openleet_tick', ctx=ast.Load()), args=[ast.Constant(line)], keywords=[]))\n            for child in ast.walk(injected):\n                child.lineno = child.end_lineno = 0\n                child.col_offset = child.end_col_offset = 0\n            node.body.insert(0, injected)\n            return node\n\n        visit_For = instrument\n        visit_While = instrument\n\n    def tick(line):\n        frame = sys._getframe(1)\n        state = frame_states.setdefault(id(frame), {})\n        parents = loops[line][1]\n        signature = tuple(state.get(parent, (None, 0))[1] for parent in parents)\n        old_signature, count = state.get(line, (None, 0))\n        state[line] = (signature, count + 1 if signature == old_signature else 1)\n        for child, (_, ancestors, _) in loops.items():\n            if line in ancestors:\n                state.pop(child, None)\n\n    def trace(frame, event, arg):\n        if frame.f_code.co_filename != '<openleet-user>':\n            return trace\n        if time.monotonic() - started > 3:\n            raise _Limit('Execution time limit (3 seconds) reached')\n        if event not in ('line', 'return', 'exception') or frame.f_lineno == 0:\n            return trace\n        if len(events) >= 2000:\n            raise _Limit('Trace limit (2000 events) reached')\n        state = frame_states.setdefault(id(frame), {})\n        depth, parent = 0, frame.f_back\n        while parent:\n            if parent.f_code.co_filename == '<openleet-user>':\n                depth += 1\n            parent = parent.f_back\n        snapshot = {key: _snapshot(value) for key, value in itertools.islice(frame.f_locals.items(), 100)\n                    if not key.startswith('__') and key not in namespace_base}\n        # iteration counts bodies entered so far in this activation. A first\n        # condition/iterator check is 0; body snapshots start at 1.\n        active = [{'line': line, 'iteration': state.get(line, (None, 0))[1]}\n                  for line, (end, _, owner) in loops.items() if line <= frame.f_lineno <= end\n                  and owner == (frame.f_code.co_name, frame.f_code.co_firstlineno)]\n        item = {'line': frame.f_lineno, 'event': 'before' if event == 'line' else event,\n                'locals': snapshot, 'loops': active, 'function': frame.f_code.co_name, 'depth': depth}\n        if event == 'return':\n            item['returnValue'] = _snapshot(arg)\n            frame_states.pop(id(frame), None)\n        elif event == 'exception':\n            item['exception'] = arg[0].__name__ + ': ' + str(arg[1])[:500]\n        events.append(item)\n        return trace\n\n    namespace_base = {name: getattr(typing, name) for name in typing.__all__}\n    namespace_base.update({'ListNode': ListNode, 'TreeNode': TreeNode, '_openleet_tick': tick})\n    namespace = dict(namespace_base)\n    old_trace = sys.gettrace()\n    try:\n        args, kwargs = _inputs(case_text)\n        tree = Instrument().visit(ast.parse(code, filename='<openleet-user>'))\n        compiled = compile(ast.fix_missing_locations(tree), '<openleet-user>', 'exec')\n        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):\n            sys.settrace(trace)\n            exec(compiled, namespace)\n            target = None\n            solution = namespace.get('Solution')\n            candidates = {}\n            if inspect.isclass(solution):\n                instance = solution()\n                candidates.update({name: getattr(instance, name) for name, value in vars(solution).items()\n                                   if not name.startswith('_') and inspect.isfunction(value)})\n            else:\n                candidates.update({name: value for name, value in namespace.items()\n                                   if not name.startswith('_') and inspect.isfunction(value)\n                                   and value.__code__.co_filename == '<openleet-user>'})\n            selected = entry.removeprefix('Solution.')\n            if selected:\n                if selected not in candidates:\n                    raise ValueError('Entry not found: ' + entry)\n                target = candidates[selected]\n            elif len(candidates) == 1:\n                selected, target = next(iter(candidates.items()))\n            elif candidates:\n                raise ValueError('Choose an entry: ' + ', '.join(candidates))\n            elif args or kwargs:\n                raise ValueError('No callable entry found for the supplied inputs')\n            if target:\n                result['entry'] = selected\n                signature = inspect.signature(target)\n                bound = signature.bind(*args, **kwargs)\n                for name, value in bound.arguments.items():\n                    bound.arguments[name] = _convert(value, signature.parameters[name])\n                result['result'] = _snapshot(target(*bound.args, **bound.kwargs))\n    except _Limit as error:\n        result['limited'] = True\n        result['error'] = str(error)\n    except BaseException as error:\n        result['error'] = type(error).__name__ + ': ' + str(error)[:1000]\n    finally:\n        sys.settrace(old_trace)\n        result['stdout'] = output.getvalue()\n    return result\n";
function parseDescriptionCases(text) {
  const cases = [];
  const pattern = /(?:\bInput|输入)\s*[:：]\s*([\s\S]*?)(?:\bOutput|输出)\s*[:：]/gi;
  for (const match of String(text || '').matchAll(pattern)) {
    const input = match[1].trim();
    if (input) cases.push({ name: `题目示例 ${cases.length + 1}`, input, source: 'question' });
  }
  return cases;
}

function readDebugTestCases() {
  const inputSelector = '[data-e2e-locator="console-testcase-input"], [data-cy="testcase-input"]';
  const containerSelector = '[data-e2e-locator="console-testcase"], [data-ocleet-testcase], [role="tabpanel"]';
  const fieldSelector = 'textarea, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), [contenteditable="true"], .monaco-editor';
  const visible = (node) => !!node && node.isConnected !== false
    && !node.closest('.ocleet-panel, [hidden], [aria-hidden="true"]')
    && node.getClientRects().length > 0;
  const isCasePanel = (node) => {
    if (node.getAttribute('role') !== 'tabpanel') return true;
    const labels = (node.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || '').join(' ');
    return /test\s*cases?|测试用例/i.test(`${node.getAttribute('aria-label') || ''} ${labels}`);
  };
  const containers = Array.from(document.querySelectorAll(containerSelector)).filter((node) => visible(node) && isCasePanel(node));
  const roots = containers.filter((node) => !containers.some((other) => other !== node && other.contains(node)));
  const orphans = Array.from(document.querySelectorAll(inputSelector))
    .filter((node) => visible(node) && !roots.some((root) => root.contains(node)));
  const groups = roots.map((root) => [root]);
  if (orphans.length) groups.push(orphans);

  // Only an editor whose DOM belongs to a recognized testcase can supply a model.
  const models = new Map();
  try {
    for (const editor of PAGE.monaco?.editor?.getEditors?.() || []) {
      try {
        const node = editor.getDomNode();
        if (visible(node) && groups.some((group) => group.some((root) => root === node || root.contains(node)))) {
          const model = editor.getModel();
          if (model && !model.isDisposed?.()) models.set(node, model.getValue());
        }
      } catch { /* An editor may be disposed while reading the page. */ }
    }
  } catch { /* DOM inputs remain available when Monaco is inaccessible. */ }

  const results = parseDescriptionCases(readDescription());
  for (const group of groups) {
    const fields = [];
    for (const root of group) {
      const candidates = root.matches(fieldSelector) ? [root] : Array.from(root.querySelectorAll(fieldSelector));
      for (const field of candidates) {
        if (!visible(field) || fields.includes(field)) continue;
        // Monaco's hidden textarea is an accessibility buffer, not the full input.
        if (field.closest('.monaco-editor') && !field.matches('.monaco-editor')) continue;
        if (candidates.some((other) => other !== field && other.contains(field))) continue;
        fields.push(field);
      }
      if (!candidates.length && root.matches(inputSelector)) fields.push(root);
    }
    const values = fields.map((field) => {
      if (field.matches('.monaco-editor')) return models.get(field);
      return typeof field.value === 'string' ? field.value : field.textContent;
    });
    // A missing parameter must not silently shift the remaining arguments.
    if (values.length && values.every((value) => typeof value === 'string' && value.trim())) {
      results.push({ name: `当前可见用例 ${results.filter((item) => item.source === 'visible-testcase').length + 1}`, input: values.map((value) => value.trim()).join('\n'), source: 'visible-testcase' });
    }
  }
  const seen = new Set();
  return results.filter((item) => {
    if (seen.has(item.input)) return false;
    seen.add(item.input);
    return true;
  });
}

// Runs in a new Worker for each case. No model credentials or page data are passed.
function pythonDebugWorker() {
  let engine;
  self.onmessage = async ({ data }) => {
    try {
      if (data.type === 'load') {
        importScripts('https://cdn.jsdelivr.net/pyodide/v0.29.3/full/pyodide.js');
        engine = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.29.3/full/' });
        engine.runPython(data.engine);
        self.postMessage({ type: 'ready' });
      } else if (data.type === 'run' && engine) {
        engine.globals.set('_oc_code', data.code);
        engine.globals.set('_oc_case', data.input);
        engine.globals.set('_oc_entry', data.entry);
        const result = engine.runPython('import json\njson.dumps(trace_code(_oc_code, _oc_case, _oc_entry), ensure_ascii=False)');
        self.postMessage({ type: 'result', result: JSON.parse(result) });
      }
    } catch (error) {
      self.postMessage({ type: 'error', error: String(error.message || error) });
    }
  };
}

function createPythonDebugRun(payload, onStatus) {
  let worker, timer, blobUrl, settled = false, rejectRun;
  const cleanup = () => {
    clearTimeout(timer);
    worker?.terminate();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  };
  const promise = new Promise((resolve, reject) => {
    rejectRun = reject;
    const fail = message => {
      if (settled) return;
      settled = true; cleanup(); reject(new Error(message));
    };
    try {
      blobUrl = URL.createObjectURL(new Blob(['(' + pythonDebugWorker.toString() + ')();'], { type: 'text/javascript' }));
      worker = new Worker(blobUrl);
      worker.onerror = event => { event.preventDefault(); fail('Python 执行线程加载失败。请检查浏览器是否允许 Worker，以及是否能访问 cdn.jsdelivr.net。'); };
      timer = setTimeout(() => fail('Python 环境加载超过 90 秒，请检查网络后重试。'), 90000);
      worker.onmessage = ({ data }) => {
        if (settled) return;
        if (data.type === 'ready') {
          clearTimeout(timer);
          onStatus('正在执行当前用例并记录变量…');
          timer = setTimeout(() => fail('代码执行超过 8 秒，已终止执行线程。请检查死循环或缩小用例。'), 8000);
          worker.postMessage({ type: 'run', ...payload });
        } else if (data.type === 'result') {
          settled = true; cleanup(); resolve(data.result);
        } else if (data.type === 'error') fail(data.error);
      };
      onStatus('首次运行需下载 Python 环境（约十余 MB），正在加载…');
      worker.postMessage({ type: 'load', engine: PYTHON_TRACE_SOURCE });
    } catch (error) { fail('无法创建 Python 执行线程：' + error.message); }
  });
  return { promise, cancel() {
    if (settled) return;
    settled = true; cleanup(); rejectRun(new Error('已停止调试。'));
  } };
}

function installPythonDebugger() {
  addStyle(`
.ocleet-panel.ocleet-debug-open{width:960px;height:88vh;max-height:calc(100vh - 24px)}
.ocleet-debugger{position:absolute;inset:49px 0 0;z-index:3;background:#12141c;display:flex;flex-direction:column;padding:12px;gap:10px;overflow:auto;font-size:var(--ocleet-font-size,14px)}
.ocleet-debugger[hidden]{display:none}
.ocleet-debug-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ocleet-debug-toolbar strong{margin-right:auto}
.ocleet-debugger label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#b9bed0}
.ocleet-debugger :is(select,input,textarea){min-width:0;border:1px solid #ffffff26;border-radius:7px;background:#0b0e16;color:#e7e9f0;padding:7px;font:inherit}
.ocleet-debugger textarea{width:100%;resize:vertical;min-height:62px;max-height:120px;font-family:Consolas,monospace}
.ocleet-debug-case{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.ocleet-debug-status{font-size:12px;color:#c0c8e0;white-space:pre-wrap;overflow-wrap:anywhere}
.ocleet-debug-workspace{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:10px;flex:1;min-height:210px}
.ocleet-debug-code{overflow:auto;border:1px solid #ffffff1a;border-radius:8px;background:#0a0d14;min-width:0;min-height:0;max-height:48vh}
.ocleet-debug-line{display:block;text-align:left;border:0;border-bottom:1px solid #ffffff05;border-radius:0;background:transparent;color:#cbd3e6;padding:3px 8px;white-space:pre;min-width:100%;width:max-content;font:var(--ocleet-font-size,14px)/1.6 Consolas,monospace;cursor:pointer}
.ocleet-debug-line span{display:inline-block;width:3em;color:#78839e;user-select:none}
.ocleet-debug-line.active{background:#394470;color:#fff}
.ocleet-debug-line.visited span{color:#99aaff}
.ocleet-debug-inspect{overflow:auto;min-width:0;max-height:48vh}
.ocleet-debug-vars{margin:8px 0;border-top:1px solid #ffffff20}
.ocleet-debug-vars div{display:grid;grid-template-columns:minmax(60px,auto) 1fr;gap:10px;padding:6px 0;border-bottom:1px solid #ffffff12}
.ocleet-debug-vars dt{color:#9baeff;font-family:Consolas,monospace}
.ocleet-debug-vars dd{margin:2px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:Consolas,monospace}
.ocleet-debug-result{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:110px;overflow:auto;margin:0;color:#bec9df}
@media(max-width:650px){.ocleet-debug-workspace{grid-template-columns:1fr}.ocleet-debug-code,.ocleet-debug-inspect{max-height:32vh}.ocleet-debug-case{grid-template-columns:1fr}}
`);
  const view = document.createElement('section');
  view.className = 'ocleet-debugger';
  view.hidden = true;
  view.setAttribute('aria-label', 'Python 逐行调试');
  view.innerHTML = `
    <div class="ocleet-debug-toolbar"><strong>Python 3 · 逐行调试</strong><button class="ocleet-btn" data-debug="back">返回对话</button></div>
    <div class="ocleet-debug-toolbar"><button class="ocleet-btn" data-debug="read">读取代码与用例</button><button class="ocleet-btn" data-debug="add">添加用例</button><button class="ocleet-btn" data-debug="delete">删除用例</button><button class="ocleet-btn primary" data-debug="run">运行当前用例</button><button class="ocleet-btn" data-debug="stop" disabled>停止</button></div>
    <div class="ocleet-debug-case"><label>测试用例<select data-debug="case" aria-label="调试测试用例"></select></label><label>入口方法（单一方法自动识别）<input data-debug="entry" placeholder="例如 twoSum" autocomplete="off" /></label></div>
    <label>当前用例输入（可编辑；每行一个参数，或 nums=[…], target=9）<textarea data-debug="input" aria-label="调试用例输入" spellcheck="false"></textarea></label>
    <div class="ocleet-debug-status" data-debug="status" role="status">读取后运行用例，再点击代码行查看变量。</div>
    <div class="ocleet-debug-toolbar"><button class="ocleet-btn" data-debug="prev">上一步</button><button class="ocleet-btn" data-debug="next">下一步</button><label>所选行的执行记录<select data-debug="occurrence" aria-label="执行记录"></select></label></div>
    <div class="ocleet-debug-workspace"><div class="ocleet-debug-code" data-debug="code" aria-label="点击代码行查看执行状态"></div><div class="ocleet-debug-inspect"><div data-debug="position" class="ocleet-debug-status">尚未运行</div><dl class="ocleet-debug-vars" data-debug="vars"></dl><pre class="ocleet-debug-result" data-debug="result"></pre></div></div>`;
  panel.appendChild(view);
  const el = name => view.querySelector(`[data-debug="${name}"]`);
  let cases = [], selected = 0, snapshot = '', events = [], cursor = -1, activeRun = null;
  let pageKey = location.pathname, runVersion = 0, lineButtons = [];
  const savedKey = () => 'debug-cases:' + location.hostname + ':' + (currentSlug() || location.pathname);
  const status = text => { el('status').textContent = text; };
  function saveCases() {
    store.set(savedKey(), cases.filter(c => c.manual).slice(0, 30).map(c => ({ name: c.name, input: c.input })));
  }
  function cancel() {
    runVersion++;
    activeRun?.cancel(); activeRun = null;
    el('run').disabled = false; el('stop').disabled = true;
  }
  function invalidate() {
    cancel(); events = []; cursor = -1;
    el('vars').replaceChildren(); el('result').textContent = '';
    el('position').textContent = '输入已更新，请运行当前用例。';
    el('occurrence').replaceChildren();
    for (const button of lineButtons) button.classList.remove('active', 'visited');
    el('prev').disabled = el('next').disabled = true;
  }
  function populateCases() {
    el('case').replaceChildren();
    for (const [i, c] of cases.entries()) {
      const option = document.createElement('option'); option.value = i;
      option.textContent = c.name + (c.manual ? ' · 手动' : c.source === 'question' ? ' · 题目示例' : ' · 页面用例');
      el('case').appendChild(option);
    }
    selected = Math.max(0, Math.min(selected, cases.length - 1));
    el('case').value = String(selected);
    el('input').value = cases[selected]?.input || '';
  }
  function getCode() {
    const data = readCode();
    if (!data.code?.trim()) throw new Error('未读取到代码。请先在题目编辑器中输入 Python 3 代码。');
    if (data.codeIncomplete) throw new Error('仅获取到代码片段。请等完整编辑器加载后再读取。');
    if (data.lang && !/^(python(?:\s*3)?|py)$/i.test(data.lang.trim())) throw new Error('逐行调试支持 Python 3，请切换题目编辑器语言。当前语言：' + data.lang);
    if (data.code.length > 30000) throw new Error('当前代码超过 30,000 字符，请缩小后调试。');
    return data.code;
  }
  function renderCode() {
    el('code').replaceChildren(); lineButtons = [];
    snapshot.split('\n').forEach((line, index) => {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'ocleet-debug-line';
      button.setAttribute('aria-label', '第 ' + (index + 1) + ' 行：' + line);
      const number = document.createElement('span'); number.textContent = index + 1;
      button.append(number, document.createTextNode(line || ' '));
      button.addEventListener('click', () => selectLine(index + 1));
      el('code').appendChild(button); lineButtons.push(button);
    });
  }
  function refresh() {
    invalidate();
    try {
      snapshot = getCode(); renderCode();
      const imported = readDebugTestCases();
      const retained = cases.filter(c => c.manual || c.source === 'visible-testcase');
      const merged = [...retained];
      for (const item of imported) {
        if (!merged.some(c => c.input.trim() === item.input.trim())) merged.push(item);
      }
      cases = merged.slice(0, 40);
      if (!cases.length) cases.push({ name: '用例 1', input: '', manual: true });
      populateCases();
      status(`已读取 ${snapshot.split('\n').length} 行代码、${imported.length} 个页面用例。手动新增的页面用例请先切到该用例，再点「读取代码与用例」；也可在此添加。`);
    } catch (error) { status(error.message); }
  }
  function selectLine(line) {
    const indices = events.flatMap((event, i) => event.line === line ? [i] : []);
    for (const [i, button] of lineButtons.entries()) button.classList.toggle('active', i + 1 === line);
    if (!indices.length) {
      cursor = -1;
      el('prev').disabled = el('next').disabled = true;
      el('occurrence').replaceChildren(); el('vars').replaceChildren();
      el('position').textContent = `第 ${line} 行没有执行记录（空行、注释、未执行分支或尚未运行）。`;
      return;
    }
    showEvent(indices.includes(cursor) ? cursor : indices[0]);
  }
  function showEvent(index) {
    cursor = index;
    const event = events[index]; if (!event) return;
    for (const [i, button] of lineButtons.entries()) button.classList.toggle('active', i + 1 === event.line);
    el('occurrence').replaceChildren();
    let visit = 0;
    events.forEach((item, i) => {
      if (item.line !== event.line) return;
      const option = document.createElement('option'); option.value = i;
      option.textContent = `第 ${++visit} 次到达 · ${item.function} · ${item.event === 'return' ? '返回' : item.event === 'exception' ? '异常' : '执行前'}`;
      el('occurrence').appendChild(option);
    });
    el('occurrence').value = index;
    const loops = (event.loops || []).map(loop => `第 ${loop.line} 行循环：第 ${loop.iteration} 次`).join('；');
    el('position').textContent = `步骤 ${index + 1}/${events.length} · 第 ${event.line} 行 · ${event.function} · 调用深度 ${event.depth}\n${event.event === 'before' ? '该行执行前的变量（下一步查看后续状态）' : event.event === 'return' ? '函数返回：' + event.returnValue : '此行抛出异常：' + event.exception}${loops ? '\n' + loops : ''}`;
    el('vars').replaceChildren();
    for (const [name, value] of Object.entries(event.locals || {})) {
      const row = document.createElement('div'), key = document.createElement('dt'), val = document.createElement('dd');
      key.textContent = name; val.textContent = value; row.append(key, val); el('vars').appendChild(row);
    }
    el('prev').disabled = index <= 0; el('next').disabled = index >= events.length - 1;
  }
  async function run() {
    invalidate();
    const version = runVersion, path = location.pathname;
    try {
      if (pageKey !== location.pathname) { onRouteChange(); throw new Error('题目已切换，请重新读取代码与用例。'); }
      snapshot = getCode(); renderCode();
      if (el('input').value.length > 16000) throw new Error('用例输入过长，请缩小后重试。');
      el('run').disabled = true; el('stop').disabled = false;
      activeRun = createPythonDebugRun({ code: snapshot, input: el('input').value, entry: el('entry').value.trim() }, status);
      const result = await activeRun.promise;
      if (version !== runVersion || path !== location.pathname) return;
      events = result.events || [];
      const visited = new Set(events.map(event => event.line));
      lineButtons.forEach((button, i) => button.classList.toggle('visited', visited.has(i + 1)));
      el('result').textContent = `返回值：${result.result}\n${result.error ? '错误：' + result.error + '\n' : ''}${result.stdout ? '标准输出：\n' + result.stdout : ''}`;
      status(`${result.error ? '执行结束，发生错误。' : '执行完成。'}记录 ${events.length} 步。点击代码行查看每次到达时的变量。${result.limited ? '已达到记录限制，轨迹不完整。' : ''}${readCode().code !== snapshot ? '编辑器代码已改变；当前结果对应本次运行的代码快照。' : ''}`);
      if (events.length) showEvent(0);
    } catch (error) {
      if (version === runVersion && path === location.pathname) status(error.message);
    } finally {
      if (version === runVersion) { activeRun = null; el('run').disabled = false; el('stop').disabled = true; }
    }
  }
  el('run').addEventListener('click', run);
  el('stop').addEventListener('click', () => { cancel(); status('已停止。可缩小用例后重新运行。'); });
  el('read').addEventListener('click', refresh);
  el('case').addEventListener('change', () => { invalidate(); selected = Number(el('case').value); el('input').value = cases[selected]?.input || ''; });
  el('entry').addEventListener('input', invalidate);
  el('input').addEventListener('input', () => {
    invalidate();
    if (!cases[selected]) cases.push({ name: '用例 1', input: '', manual: true });
    cases[selected].input = el('input').value; cases[selected].manual = true; saveCases();
  });
  el('add').addEventListener('click', () => {
    if (cases.filter(c => c.manual).length >= 30) return status('最多保存 30 个手动用例，请先删除不需要的用例。');
    invalidate(); cases.push({ name: '自定义 ' + (cases.length + 1), input: '', manual: true }); selected = cases.length - 1; populateCases(); saveCases(); el('input').focus();
  });
  el('delete').addEventListener('click', () => { invalidate(); cases.splice(selected, 1); populateCases(); saveCases(); });
  el('prev').addEventListener('click', () => { if (cursor > 0) showEvent(cursor - 1); });
  el('next').addEventListener('click', () => { if (cursor < events.length - 1) showEvent(cursor + 1); });
  el('occurrence').addEventListener('change', () => showEvent(Number(el('occurrence').value)));
  function loadSavedCases() {
    const saved = store.get(savedKey(), []);
    cases = Array.isArray(saved) ? saved.filter(c => c && typeof c.input === 'string' && typeof c.name === 'string').slice(0, 30).map(c => ({ ...c, manual: true })) : [];
  }
  function onRouteChange() {
    invalidate(); pageKey = location.pathname; snapshot = ''; renderCode(); el('entry').value = '';
    loadSavedCases(); populateCases(); status('题目已切换，请读取新题目的代码与用例。');
  }
  $('open-debugger').addEventListener('click', () => {
    if (pageKey !== location.pathname) onRouteChange();
    view.hidden = false; panel.classList.add('ocleet-debug-open'); restorePanelPosition();
    if (!snapshot) { loadSavedCases(); refresh(); }
  });
  el('back').addEventListener('click', () => { cancel(); view.hidden = true; panel.classList.remove('ocleet-debug-open'); restorePanelPosition(); });
  window.addEventListener('pagehide', cancel);
  invalidate();
  return { onRouteChange };
}

  const pythonDebugger = installPythonDebugger();
  // END GENERATED DEBUGGER
})();
