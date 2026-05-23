// 小耳问问 — WebView front-end
// 注入：window.XIAOER_CTX  / window.XIAOER_GEMINI  / window.xiaoerClose

const MODEL = "gemini-2.5-flash";
// API_BASE 仅用于公开用户的直连路径。
// 私有层（Jane 本机，在国内）开了花销墙计量 → 走 meterOn() 分支：整条请求交给
// Hammerspoon 用 hs.http 走本地代理（→Clash→Google，可靠且透明记账）。
// 不让 webview 自己 fetch 明文 http://127.0.0.1 —— WKWebView 的 ATS 会拦明文，
// 报 "Load failed"；而 hs.http 不受 webview ATS 限制。
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
// ⚠️ window.XIAOER_METER_BASE 是 Hammerspoon 在 didFinishNavigation 里注入的，
// 时机晚于本脚本顶层求值——必须在「提问时」惰性读取，不能在加载时锁成 const。
function meterOn() { return typeof window !== "undefined" && !!window.XIAOER_METER_BASE; }

const $ctxApp    = document.getElementById("ctx-app");
const $ctxMode   = document.getElementById("ctx-mode");
const $ctxBody   = document.getElementById("ctx-body");
const $ctxPrev   = document.getElementById("ctx-preview");
const $ctxTog    = document.getElementById("ctx-toggle");
const $chat      = document.getElementById("chat");
const $form      = document.getElementById("input-form");
const $input     = document.getElementById("input");
const $send      = document.getElementById("btn-send");
const $close     = document.getElementById("btn-close");
const $lookupHead= document.getElementById("lookup-head");
const $lookupTerm= document.getElementById("lookup-term");
const $followBar = document.getElementById("followup-bar");
const $btnFollow = document.getElementById("btn-followup");

// 这些在 xiaoerStart() 里赋值（等 Hammerspoon 注入完 ctx 再启动）
let ctx = null;
let API_KEY = "";
let isLookupMode = false;
// history 只存纯文本对话，每次请求时把当前 ctx 的图/文拼到最新一轮
// 这样切换页面/选词时旧图不会重复发，省 token
const history = []; // [{ role: 'user'|'model', text: '...' }]

// ── 初始化上下文显示 ───────────────────────────────────────────────
function initContext() {
  // $ctxApp 写死 "Xiaoer Ask"，不再随抓的应用变；当前应用名在分隔条里显示
  $ctxMode.textContent = ({
    browser: "WEB", screenshot: "SHOT", file: "FILE", none: "--",
  })[ctx.mode] || ctx.mode.toUpperCase();

  const parts = [];
  if (ctx.title) parts.push(`【标题】${ctx.title}`);
  if (ctx.url) parts.push(`【URL】${ctx.url}`);
  if (ctx.text) parts.push(`【正文】${ctx.text.slice(0, 1500)}${ctx.text.length > 1500 ? "…" : ""}`);
  $ctxBody.textContent = parts.join("\n\n");
  if (ctx.image_base64) {
    const img = new Image();
    img.src = `data:image/png;base64,${ctx.image_base64}`;
    $ctxBody.appendChild(img);
  }
}

$ctxTog.addEventListener("click", () => {
  $ctxPrev.classList.toggle("collapsed");
  $ctxTog.textContent = $ctxPrev.classList.contains("collapsed")
    ? "[+] 展开上下文" : "[-] 收起上下文";
});

// ── system instruction（按模式生成）─────────────────────────────
function buildSystemInstruction() {
  if (isLookupMode) {
    return `你是 Jane 的阅读伴侣。Jane 正在阅读，刚刚划选了一段文字，希望你**用 3-5 句话直接解释**这段文字是什么意思。

规则：
- 中文，简洁直接，不要废话不要寒暄
- 优先用「她正在读的内容」作为上下文判断词义（同一个词在不同语境下含义不同）
- 如果当前上下文里没解释这个词，正常用通用知识回答，并在末尾用一行小字「（基于通用知识）」
- 代码/术语用反引号包裹
- 不要重复她划选的原文，直接给解释
- 答案 80 字到 200 字之间

当前阅读环境：
- 应用：${ctx.app}${ctx.title ? `\n- 标题：${ctx.title}` : ""}${ctx.url ? `\n- URL：${ctx.url}` : ""}`;
  }
  // 对话模式
  let s = `你是 Jane 的阅读伴侣。Jane 正在阅读，需要你快速、准确地回答她对当前内容的问题。

规则：
- 中文回答，简洁直接
- 优先用她正在读的内容作为上下文
- 代码/术语用反引号包裹
- 答案 3-5 句话，除非她明确要求展开

当前阅读环境：
- 应用：${ctx.app}
- 模式：${ctx.mode}`;
  if (ctx.title) s += `\n- 标题：${ctx.title}`;
  if (ctx.url) s += `\n- URL：${ctx.url}`;
  return s;
}

// ── 构造当前轮 user parts（图 + 文 + 选中 + 问题）─────────────
// 每次请求都会用当前 ctx 重新拼，旧轮的图不会重复发
function buildCurrentParts(question) {
  const parts = [];
  if (ctx.image_base64) {
    parts.push({ inline_data: { mime_type: "image/png", data: ctx.image_base64 } });
    const lbl = `（上方截图：Jane 当前阅读 — ${ctx.app}${ctx.title ? " / " + ctx.title : ""}）\n\n`;
    parts.push({ text: lbl });
  }
  if (ctx.text) {
    parts.push({
      text: `Jane 当前阅读的内容（节选 — ${ctx.app}）：\n"""\n${ctx.text.slice(0, 6000)}\n"""\n\n`,
    });
  }
  if (ctx.selection && ctx.selection.trim()) {
    parts.push({ text: `Jane 划选的文字：「${ctx.selection}」\n\n` });
  }
  parts.push({ text: question || "请直接解释 Jane 划选的文字。" });
  return parts;
}

// ── 渲染气泡 ─────────────────────────────────────────────────────
function appendMsg(role, text = "") {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  $chat.appendChild(div);
  $chat.scrollTop = $chat.scrollHeight;
  return div;
}
function setError(msg) { appendMsg("err", `⚠️ ${msg}`); }
function renderMd(el, text) {
  const html = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  el.innerHTML = html;
}

// ── 调 Gemini streaming ─────────────────────────────────────────
let isAsking = false;
async function ask(question) {
  if (!API_KEY) { setError("没有 Gemini API key（注入失败）"); return; }
  if (isAsking) return;  // 上一轮还在流，跳过（auto-watch 时连续划词不会重叠）
  isAsking = true;

  appendMsg("user", question);
  const aiBubble = appendMsg("ai", "");
  aiBubble.classList.add("thinking");

  // 历史轮转纯文本 contents，最后一轮用当前 ctx 拼图文
  const contents = history.map(h => ({
    role: h.role,
    parts: [{ text: h.text }],
  }));
  contents.push({
    role: "user",
    parts: buildCurrentParts(question),
  });
  history.push({ role: "user", text: question });

  const body = {
    system_instruction: { parts: [{ text: buildSystemInstruction() }] },
    contents: contents,
    // ⚠️ Gemini 2.5 Flash 的 thinking token 和回答 token 共享 maxOutputTokens 预算。
    // 之前 1024 太小：模型一思考（动辄 800-980 token）就把预算吃光，回答被砍到
    // 几十 token 就撞上限硬切断。给到 8192，思考 + 长回答都留足；
    // thinkingBudget 限制思考上限，避免它无限膨胀又吃预算。
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 2048 },
    },
  };

  let acc = "";
  try {
    if (meterOn()) {
      // 这台机子开了花销墙 = 在国内：直连 Google 不稳，且 WKWebView ATS 拦明文本地代理。
      // 交给 Lua 用 hs.http 走本地代理（→Clash→Google，可靠且透明记账），一次性拿全文。
      acc = await askViaLua(body);
      aiBubble.classList.remove("thinking");
      renderMd(aiBubble, acc);
      $chat.scrollTop = $chat.scrollHeight;
    } else {
      // 公开用户：webview 直连 Google 流式（ATS 放行 https，无代理需求）
      acc = await askDirectStream(body, aiBubble);
    }
  } catch (e) {
    aiBubble.classList.remove("thinking");
    aiBubble.classList.remove("streaming");
    setError(e.message || String(e));
    isAsking = false;
    return;
  }
  aiBubble.classList.remove("thinking");
  aiBubble.classList.remove("streaming");
  isAsking = false;
  if (!acc) { setError("AI 没返回内容"); return; }
  history.push({ role: "model", text: acc });
}

// ── 经 Lua → 本地花销墙代理（hs.http，国内可靠 + 自动记账）──────────
// Lua 收到 "llm:{id,body}" → hs.http POST 代理 streamGenerateContent →
// 把完整 SSE body 注回 window.__xiaoerLLM(id, status, text)。这里用 Promise 等它。
const __llmPending = {};
let __llmSeq = 0;
// Lua 注入单个对象 { id, status, body }（body = 完整 SSE 文本）
window.__xiaoerLLM = function(o) {
  const { id, status, body: payload } = o || {};
  const p = __llmPending[id];
  if (!p) return;
  delete __llmPending[id];
  if (status !== 200) { p.reject(new Error(`API ${status}: ${String(payload).slice(0, 200)}`)); return; }
  // payload 是完整 SSE 文本，逐行拼出答案
  let acc = "";
  for (const line of String(payload).split("\n")) {
    if (!line.startsWith("data:")) continue;
    const d = line.slice(5).trim();
    if (!d || d === "[DONE]") continue;
    try { acc += JSON.parse(d)?.candidates?.[0]?.content?.parts?.[0]?.text || ""; } catch (e) {}
  }
  p.resolve(acc);
};
function askViaLua(body) {
  return new Promise((resolve, reject) => {
    const id = "q" + (++__llmSeq);
    __llmPending[id] = { resolve, reject };
    setTimeout(() => {
      if (__llmPending[id]) { delete __llmPending[id]; reject(new Error("网络错误: 本地代理超时")); }
    }, 30000);
    try {
      window.webkit.messageHandlers.xiaoer.postMessage("llm:" + JSON.stringify({ id, body }));
    } catch (e) {
      delete __llmPending[id];
      reject(new Error("无法连接本地代理：" + e.message));
    }
  });
}

// ── webview 直连 Google 流式（公开用户路径）─────────────────────────
async function askDirectStream(body, aiBubble) {
  const url = `${API_BASE}/models/${MODEL}:streamGenerateContent?alt=sse&key=${API_KEY}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Xiaoer-Tool": "xiaoer-ask" },
    body: JSON.stringify(body),
  }).catch((e) => { throw new Error(`网络错误: ${e.message}`); });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`API ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", acc = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const text = JSON.parse(data)?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (text) {
          acc += text;
          if (aiBubble.classList.contains("thinking")) {
            aiBubble.classList.remove("thinking");
            aiBubble.classList.add("streaming");
          }
          renderMd(aiBubble, acc);
          $chat.scrollTop = $chat.scrollHeight;
        }
      } catch (e) {}
    }
  }
  return acc;
}

// ── 切到对话模式 ─────────────────────────────────────────────────
function enterChatMode() {
  document.body.classList.remove("mode-lookup");
  document.body.classList.add("mode-chat");
  $followBar.hidden = true;
  $form.hidden = false;
  $input.focus();
}

// ── 分隔条：标记上下文切换 ────────────────────────────────────────
function insertContextDivider() {
  const div = document.createElement("div");
  div.className = "ctx-divider";
  let label = `switched → ${ctx.app}`;
  if (ctx.selection && ctx.selection.trim()) {
    const s = ctx.selection.trim();
    label += `  ·  sel "${s.length > 24 ? s.slice(0, 24) + "…" : s}"`;
  }
  div.textContent = label;
  $chat.appendChild(div);
  $chat.scrollTop = $chat.scrollHeight;
}

$btnFollow.addEventListener("click", enterChatMode);

// ── 表单（对话模式）──────────────────────────────────────────────
$form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $input.value.trim();
  if (!q) return;
  $input.value = "";
  $input.style.height = "auto";
  $send.disabled = true;

  // ⭐ 提交前先让 Lua 重抓一次画面，AI 看到的就是 Jane 现在屏幕上的内容
  // 这样 Jane 切到新页/滚到新位置后只要在输入框问"这页讲啥"就行，无需 Option+A
  await requestRecapture();

  await ask(q);
  $send.disabled = false;
  $input.focus();
});

// 回车不发送（Jane 要求），只能点「发送」按钮提交。Enter = 换行

$input.addEventListener("input", () => {
  $input.style.height = "auto";
  $input.style.height = Math.min($input.scrollHeight, 120) + "px";
});

$close.addEventListener("click", () => window.xiaoerClose?.());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.xiaoerClose?.();
});

// ── 启动入口（由 Hammerspoon 在注入 ctx 后调用）─────────────────
window.xiaoerStart = function() {
  ctx = window.XIAOER_CTX || {
    app: "调试模式", title: "", mode: "none",
    selection: "", text: "", image_base64: "", url: "",
  };
  API_KEY = window.XIAOER_GEMINI || "";
  isLookupMode = !!(ctx.selection && ctx.selection.trim());

  initContext();

  if (isLookupMode) {
    $lookupHead.hidden = false;
    const sel = ctx.selection.trim();
    $lookupTerm.textContent = sel.length > 80 ? sel.slice(0, 80) + "…" : sel;
    $followBar.hidden = false;
    $form.hidden = true;
    ask(`解释「${sel}」`);
  } else {
    enterChatMode();
  }
};

// ── 刷新入口 ──────────────────────────────────────────────────────
// Hammerspoon 注入新 XIAOER_CTX + window.__XIAOER_REFRESH_MODE 后调这个
// mode = "normal" → auto-watch / 手动 Option+A：插分隔条、可能自动问
// mode = "silent" → 发送前重抓：只更新 ctx，resolve 等待中的 Promise
window.xiaoerRefresh = function() {
  const mode = window.__XIAOER_REFRESH_MODE || "normal";
  ctx = window.XIAOER_CTX || ctx;
  initContext();

  if (mode === "silent") {
    // 静默：清掉旧的「关于 xxx」标签
    $lookupHead.hidden = true;
    // chip 上闪一下「📸 已重抓」+ 朱砂脉冲动画
    $ctxMode.classList.add("flashing");
    $ctxMode.textContent = `JUST CAPTURED`;
    setTimeout(() => {
      $ctxMode.classList.remove("flashing");
      $ctxMode.textContent = ({
        browser: "WEB", screenshot: "SHOT", file: "FILE", none: "--",
      })[ctx.mode] || ctx.mode.toUpperCase();
    }, 1800);
    // 完成 recapture Promise，让 form submit 流程继续
    if (window.__xiaoerRecaptureResolve) {
      const r = window.__xiaoerRecaptureResolve;
      window.__xiaoerRecaptureResolve = null;
      r();
    }
    return;
  }

  // normal 模式：插分隔条 + 自动问（如果有划选）
  insertContextDivider();
  const sel = ctx.selection && ctx.selection.trim();
  if (sel) {
    $lookupHead.hidden = false;
    $lookupTerm.textContent = sel.length > 80 ? sel.slice(0, 80) + "…" : sel;
    enterChatMode();
    ask(`解释「${sel}」`);
  } else {
    $lookupHead.hidden = true;
    enterChatMode();
  }
};

// ── 静默重抓：让 Lua 现场抓一张新截图，更新 ctx ────────────────────
function requestRecapture() {
  return new Promise((resolve) => {
    // 必须在 postMessage 之前注册 resolver
    window.__xiaoerRecaptureResolve = resolve;
    try {
      window.webkit.messageHandlers.xiaoer.postMessage("recapture");
    } catch (e) {
      // 不在 Hammerspoon 里跑（独立调试）→ 直接 resolve
      window.__xiaoerRecaptureResolve = null;
      resolve();
    }
    // 安全超时：3 秒还没回就放弃，用现有 ctx 发
    setTimeout(() => {
      if (window.__xiaoerRecaptureResolve === resolve) {
        window.__xiaoerRecaptureResolve = null;
        resolve();
      }
    }, 3000);
  });
}

// 调试用：如果直接打开 index.html（无 Hammerspoon），延迟自启
if (!window.XIAOER_CTX) {
  // 给 Hammerspoon 注入 200ms 窗口；超时还没注入就用调试默认值启动
  setTimeout(() => { if (!ctx) window.xiaoerStart(); }, 250);
}

// （拖动改用 CSS -webkit-app-region: drag，NSWindow 原生通道，零延迟）

// ── placeholder 轮播（让输入框"活"着）─────────────────────────────
const PLACEHOLDERS = [
  "想问点什么…（点「发送」提交，回车换行）",
  "试试划个新词，我会自动解释",
  "切到新页面就问「这页讲啥」",
  "继续追问到清楚为止",
];
let __phIdx = 0;
setInterval(() => {
  // 用户正在输入或聚焦时不切，避免分心
  if (document.activeElement === $input) return;
  if ($input.value) return;
  __phIdx = (__phIdx + 1) % PLACEHOLDERS.length;
  $input.placeholder = PLACEHOLDERS[__phIdx];
}, 4200);
