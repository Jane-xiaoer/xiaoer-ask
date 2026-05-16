// 小耳问问 — WebView front-end
// 注入：window.XIAOER_CTX  / window.XIAOER_GEMINI  / window.xiaoerClose

const MODEL = "gemini-2.5-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

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
    generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
  };

  const url = `${API_BASE}/models/${MODEL}:streamGenerateContent?alt=sse&key=${API_KEY}`;

  let acc = "";
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      aiBubble.classList.remove("thinking");
      setError(`API ${resp.status}: ${txt.slice(0, 200)}`);
      isAsking = false;
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
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
          const j = JSON.parse(data);
          const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || "";
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
  } catch (e) {
    aiBubble.classList.remove("thinking");
    setError(`网络错误: ${e.message}`);
    isAsking = false;
    return;
  }
  aiBubble.classList.remove("thinking");
  aiBubble.classList.remove("streaming");
  isAsking = false;
  if (!acc) { setError("AI 没返回内容"); return; }
  history.push({ role: "model", text: acc });
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
