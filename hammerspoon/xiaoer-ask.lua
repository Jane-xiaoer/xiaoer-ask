-- ════════════════════════════════════════════════════════════════
-- 小耳问问 (xiaoer-ask) — Option+A 划词问 AI
-- ════════════════════════════════════════════════════════════════

local M = {}
-- 动态推导项目根目录（脚本自己所在目录的上一级）
local sourcePath = debug.getinfo(1, "S").source:sub(2)  -- 去掉前导 "@"
local PROJECT_DIR = sourcePath:gsub("/hammerspoon/xiaoer%-ask%.lua$", "")
local LOG_PATH    = "/tmp/xiaoer-ask.log"

-- ── 日志 ─────────────────────────────────────────────────────────
local function log(...)
  local f = io.open(LOG_PATH, "a")
  if f then
    f:write(os.date("%H:%M:%S") .. " hs: ")
    for i = 1, select("#", ...) do
      f:write(tostring(select(i, ...)) .. " ")
    end
    f:write("\n")
    f:close()
  end
end

-- ── 读计量代理 base（私有 .env 里的 XIAOER_METER_BASE，gitignore，公开用户没有则官方直连）──
local function readMeterBase()
  local f = io.open(PROJECT_DIR .. "/.env", "r")
  if not f then return nil end
  for line in f:lines() do
    local v = line:match("^%s*XIAOER_METER_BASE%s*=%s*(.+)$")
    if v then f:close(); return (v:gsub("^%s+", ""):gsub("%s+$", ""):gsub("^['\"]", ""):gsub("['\"]$", "")) end
  end
  f:close()
  return nil
end

-- ── 读 Gemini key（按优先级查找；缓存）────────────────────────────
-- 1. 项目本地 .env（公共用户用这条）
-- 2. ~/.shared-skills/api-registry/.env（原作者本地兼容）
-- 3. 系统环境变量 GEMINI_API_KEY
local function readGeminiKey()
  local cached = hs.settings.get("xiaoer_ask_gemini_key")
  if cached and #cached > 10 then return cached end

  local function trim(s) return (s:gsub("^%s+", ""):gsub("%s+$", ""):gsub("^['\"]", ""):gsub("['\"]$", "")) end

  local function parseEnvFile(path)
    local f = io.open(path, "r")
    if not f then return nil end
    for line in f:lines() do
      local v = line:match("^%s*GEMINI_API_KEY%s*=%s*(.+)$")
      if v then f:close(); return trim(v) end
    end
    f:close()
    return nil
  end

  -- 1. 项目本地 .env
  local k = parseEnvFile(PROJECT_DIR .. "/.env")
  -- 2. fallback: 用户全局
  if not k or #k < 10 then
    k = parseEnvFile(os.getenv("HOME") .. "/.shared-skills/api-registry/.env")
  end
  -- 3. fallback: 系统环境
  if not k or #k < 10 then
    k = os.getenv("GEMINI_API_KEY")
  end

  if k and #k > 10 then
    hs.settings.set("xiaoer_ask_gemini_key", k)
    return k
  end
  return nil
end

-- ── 抓选中文本（保存→⌘C→读→恢复）───────────────────────────────
local function grabSelection()
  local prev = hs.pasteboard.readString() or ""
  -- 写入哨兵让我们知道是否真的被 ⌘C 覆盖
  local sentinel = "__XIAOER_ASK_NO_SEL_" .. tostring(math.random(99999)) .. "__"
  hs.pasteboard.setContents(sentinel)
  hs.eventtap.keyStroke({"cmd"}, "c", 0)
  hs.timer.usleep(120 * 1000)  -- 120ms 等剪贴板
  local got = hs.pasteboard.readString() or ""
  -- 恢复
  hs.pasteboard.setContents(prev)
  if got == sentinel or got == "" then
    return ""
  end
  return got
end

-- ── 调 capture-context.sh ───────────────────────────────────────
local function captureContext(selection)
  local cmd = string.format(
    "%s/scripts/capture-context.sh %s",
    PROJECT_DIR,
    "'" .. (selection or ""):gsub("'", "'\\''") .. "'"
  )
  log("capture cmd len:", #cmd)
  local handle = io.popen(cmd .. " 2>/dev/null")
  if not handle then return nil end
  local out = handle:read("*a")
  handle:close()
  -- 落到 tmp 方便调试
  local f = io.open(PROJECT_DIR .. "/tmp/last-context.json", "w")
  if f then f:write(out); f:close() end
  return out
end

-- ── 浮窗实例（单例） ─────────────────────────────────────────────
local activeWebview = nil
local activeUserContent = nil

-- ── Auto-watch（浮窗开着时自动监听新选中）──────────────────────
local autoTaps = {}      -- 存 eventtap 实例
local mouseDownPos = nil
local lastAutoSel = ""   -- 最近一次 auto 触发的 selection，避免重复触发同一段

-- （已撤回手动窗口拖动 — native title bar 自带拖动）

-- mode: "normal" = 插分隔条 + 可能自动问  /  "silent" = 只更新 ctx（发送前刷新用）
local function refreshContext(selection, mode)
  if not activeWebview then return end
  mode = mode or "normal"
  local ctxJson = captureContext(selection or "")
  if not ctxJson or #ctxJson < 10 then return end
  local js = string.format([[
    window.XIAOER_CTX = %s;
    window.__XIAOER_REFRESH_MODE = "%s";
    if (typeof window.xiaoerRefresh === 'function') {
      window.xiaoerRefresh();
    }
  ]], ctxJson, mode)
  activeWebview:evaluateJavaScript(js)
  -- 不抢焦点：不调 :bringToFront / :activate / :focus
end

-- 兼容旧调用名
local function refreshWithSelection(selection)
  refreshContext(selection, "normal")
end

local function attemptAutoExplain()
  if not activeWebview then return end

  -- 用 sentinel 抓选中，立即还原剪贴板
  local prev = hs.pasteboard.readString() or ""
  local sentinel = "__XIAOER_AUTO_" .. tostring(math.random(99999)) .. "__"
  hs.pasteboard.setContents(sentinel)
  hs.eventtap.keyStroke({"cmd"}, "c", 0)
  hs.timer.usleep(80 * 1000)
  local sel = hs.pasteboard.readString() or ""
  hs.pasteboard.setContents(prev)

  if sel == sentinel or sel == "" then return end
  sel = sel:gsub("^%s+", ""):gsub("%s+$", "")
  if #sel < 2 or #sel > 500 then return end  -- 太短/太长大概率不是术语
  if sel == lastAutoSel then return end       -- 同一段已经讲过了
  lastAutoSel = sel
  log("auto-trigger:", sel:sub(1, 40))
  refreshWithSelection(sel)
end

local function isInsideWebview(point)
  if not activeWebview then return false end
  local f = activeWebview:frame()
  return point.x >= f.x and point.x <= f.x + f.w
     and point.y >= f.y and point.y <= f.y + f.h
end

local function startAutoWatch()
  if #autoTaps > 0 then return end  -- 已经在监听
  log("starting auto-watch")

  local downTap = hs.eventtap.new({hs.eventtap.event.types.leftMouseDown}, function(event)
    mouseDownPos = event:location()
    return false
  end)

  local upTap = hs.eventtap.new({hs.eventtap.event.types.leftMouseUp}, function(event)
    if isDraggingWindow then return false end  -- 正在拖窗口，别误判成选词
    if not mouseDownPos then return false end
    local up = event:location()
    local dx = math.abs(up.x - mouseDownPos.x)
    local dy = math.abs(up.y - mouseDownPos.y)
    mouseDownPos = nil
    -- 不是拖拽（普通点击）→ 跳过
    if dx < 4 and dy < 4 then return false end
    -- 在浮窗内部点的 → 跳过（用户在跟浮窗交互）
    if isInsideWebview(up) then return false end
    hs.timer.doAfter(0.18, attemptAutoExplain)
    return false
  end)

  -- 双击选词也要捕获
  local dblTap = hs.eventtap.new({hs.eventtap.event.types.leftMouseDoubleClick}, function(event)
    if isInsideWebview(event:location()) then return false end
    hs.timer.doAfter(0.18, attemptAutoExplain)
    return false
  end)

  downTap:start(); upTap:start(); dblTap:start()
  autoTaps = {downTap, upTap, dblTap}
end

local function stopAutoWatch()
  if #autoTaps == 0 then return end
  log("stopping auto-watch")
  for _, t in ipairs(autoTaps) do pcall(function() t:stop() end) end
  autoTaps = {}
  mouseDownPos = nil
  lastAutoSel = ""
end

local function closeWebview()
  stopAutoWatch()
  if activeWebview then
    activeWebview:delete()
    activeWebview = nil
  end
  activeUserContent = nil
end

local function showWebview(contextJson, apiKey)
  if activeWebview then closeWebview() end

  -- 屏幕居中，宽 480 高 620
  local screen = hs.screen.mainScreen():frame()
  local w, h = 480, 620
  local rect = {
    x = screen.x + (screen.w - w) / 2,
    y = screen.y + (screen.h - h) / 2,
    w = w, h = h,
  }

  -- usercontent：让 JS 可以通过 webkit.messageHandlers 调回 Lua
  activeUserContent = hs.webview.usercontent.new("xiaoer")
  activeUserContent:setCallback(function(msg)
    local body = msg.body
    if type(body) ~= "string" then return end
    if body == "close" then
      closeWebview()
    elseif body == "recapture" then
      -- JS 在发送提问前要求重新抓画面（静默：不插分隔条不自动问）
      log("recapture requested by webview")
      refreshContext("", "silent")
    elseif body:sub(1, 4) == "llm:" then
      -- 国内路径：浮窗够不到明文本地代理（WKWebView ATS 拦），直连 Google 又不稳。
      -- 改由 Lua 用 hs.http 走本地花销墙代理（→Clash→Google，可靠 + 透明记账），
      -- 拿到完整 SSE body 注回 window.__xiaoerLLM(id, status, body)。
      local ok, req = pcall(function() return hs.json.decode(body:sub(5)) end)
      if not (ok and req and req.id and req.body) then log("llm: bad payload"); return end
      local function reply(status, payload)
        -- ⚠️ hs.json.encode 只吃 table（不能直接编码字符串）。把参数打包成 table 编码，
        -- 得到的合法 JSON 直接当 JS 对象字面量注入（字符串转义由编码器负责）。
        local js = "window.__xiaoerLLM(" ..
          hs.json.encode({ id = req.id, status = tonumber(status) or 0, body = payload or "" }) .. ")"
        -- 推出当前回调栈再注入，避免 message handler 重入
        hs.timer.doAfter(0, function()
          if activeWebview then activeWebview:evaluateJavaScript(js) end
        end)
      end
      local base = readMeterBase()
      if not base then reply(0, "无本地代理（XIAOER_METER_BASE 未配置）"); return end
      -- 不带 key：花销墙代理会自己追加（带了会变成双 key 被 Google 拒）
      local url = base .. "/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
      hs.http.asyncPost(url, hs.json.encode(req.body),
        { ["Content-Type"] = "application/json", ["X-Xiaoer-Tool"] = "xiaoer-ask" },
        function(status, respBody)
          if status ~= 200 then
            log("llm: proxy " .. tostring(status) .. " " .. tostring(respBody and respBody:sub(1, 120)))
          end
          reply(status, respBody)
        end)
    end
  end)

  activeWebview = hs.webview.new(rect, {
    developerExtrasEnabled = true,
  }, activeUserContent)
    -- 纯 titled —— native title bar 白条 + traffic lights 在顶，拖动靠它
    :windowStyle({"titled", "closable", "resizable"})
    :allowTextEntry(true)  -- ⭐ 默认 false，textarea 不能输入！
    :allowGestures(false)
    :allowNewWindows(false)
    :level(hs.drawing.windowLevels.floating)
    :titleVisibility("hidden")
    :shadow(true)
    :closeOnEscape(false)
    :windowCallback(function(action)
      -- 用户点 ✕ / Cmd+W 手动关闭时同步状态
      if action == "closing" then
        stopAutoWatch()
        activeWebview = nil
        activeUserContent = nil
      end
    end)

    :navigationCallback(function(action, _, _, info)
      if action == "didFinishNavigation" then
        -- 注入上下文 + API key + close handler
        local js = string.format([[
          window.XIAOER_CTX = %s;
          window.XIAOER_GEMINI = "%s";
          window.XIAOER_METER_BASE = "%s";
          window.xiaoerClose = function() {
            window.webkit.messageHandlers.xiaoer.postMessage("close");
          };
          // 等 app.js 加载完后调起动入口
          if (typeof window.xiaoerStart === 'function') {
            window.xiaoerStart();
          } else {
            // app.js 还没加载完？再等一帧
            requestAnimationFrame(() => window.xiaoerStart && window.xiaoerStart());
          }
        ]],
          contextJson or "{}",
          (apiKey or ""):gsub('"', '\\"'),
          (readMeterBase() or ""):gsub('"', '\\"')
        )
        activeWebview:evaluateJavaScript(js)
      end
    end)
    :url("file://" .. PROJECT_DIR .. "/webview/index.html")
    :show()
    :bringToFront(true)

  -- 强制 Hammerspoon app 激活 + 窗口聚焦
  -- 必须激活 Hammerspoon app（LSUIElement 不自动抢焦点），否则 textarea 收不到键盘
  hs.timer.doAfter(0.08, function()
    if not activeWebview then return end
    local hsApps = hs.application.applicationsForBundleID("org.hammerspoon.Hammerspoon")
    if hsApps and hsApps[1] then
      hsApps[1]:activate(true)  -- true = bring all windows forward
    end
    local win = activeWebview:hswindow()
    if win then
      win:raise()
      win:focus()
    end
  end)

  -- 浮窗一旦开了 → 启动全局划词监听
  startAutoWatch()
end

-- 暴露 close 方便外部清理
function M.close() closeWebview() end

-- ── 把浮窗带到前面 + 激活 Hammerspoon（输入框能用的关键）─────────
local function focusWebview()
  if not activeWebview then return end
  activeWebview:bringToFront(true)
  hs.timer.doAfter(0.05, function()
    if not activeWebview then return end
    local hsApps = hs.application.applicationsForBundleID("org.hammerspoon.Hammerspoon")
    if hsApps and hsApps[1] then hsApps[1]:activate(true) end
    local win = activeWebview:hswindow()
    if win then win:raise(); win:focus() end
  end)
end

-- ── 入口：抓上下文 + 起浮窗 / 刷新已有浮窗 ─────────────────────
function M.trigger()
  log("trigger pressed")

  local apiKey = readGeminiKey()
  if not apiKey then
    hs.alert.show("xiaoer-ask: 找不到 GEMINI_API_KEY")
    log("no api key")
    return
  end

  -- 1. 抓选中（要在浮窗还没抢焦点之前做）
  local selection = grabSelection()
  log("selection:", #selection, "chars")
  -- 同步 auto-watch 的 lastAutoSel，防止手动触发后 mouseUp 又被自动捕获重复触发
  if #selection > 0 then lastAutoSel = selection end

  -- 2. 抓上下文
  hs.alert.closeAll()
  local placeholder = hs.alert.show("👂 抓取阅读上下文…", 5)

  hs.timer.doAfter(0.01, function()
    local ctxJson = captureContext(selection)
    hs.alert.closeSpecific(placeholder)
    if not ctxJson or #ctxJson < 10 then
      hs.alert.show("xiaoer-ask: 抓取失败，看 /tmp/xiaoer-ask.log")
      log("capture returned empty")
      return
    end
    log("ctx json len:", #ctxJson)

    if activeWebview then
      -- 浮窗已开 → 注入新上下文 + 调 refresh，复用同一会话
      log("refreshing existing webview")
      local js = string.format([[
        window.XIAOER_CTX = %s;
        if (typeof window.xiaoerRefresh === 'function') {
          window.xiaoerRefresh();
        }
      ]], ctxJson)
      activeWebview:evaluateJavaScript(js)
      focusWebview()
    else
      -- 浮窗没开 → 新建
      showWebview(ctxJson, apiKey)
    end
  end)
end

-- ── 注册热键 ─────────────────────────────────────────────────────
function M.start()
  hs.hotkey.bind({"alt"}, "A", M.trigger)
  log("xiaoer-ask loaded, Option+A bound")
end

-- 自启动
M.start()

-- 暴露成全局，方便 hs CLI 调试
_G.xiaoerAsk = M

return M
