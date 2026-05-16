# Architecture · xiaoer-ask

Press **Option+A** while reading anything → AI sees your screen → instant answer in a floating panel.

## Trigger flow

```
Option+A
 ↓ Hammerspoon (~/.hammerspoon/init.lua dofile xiaoer-ask.lua)
 ↓ grabSelection (⌘C save → simulate → read → restore clipboard, 120ms delay)
 ↓ scripts/capture-context.sh
 │   ├─ Browser  → AppleScript URL → readability extract / WeChat UA spoof
 │   ├─ Editor   → resolve file path from window title → read directly
 │   └─ Other    → screencapture full screen (multimodal feed)
 ↓ hs.webview floating panel (480x620, centered, floating level)
 ↓ Hammerspoon injects via navigationCallback didFinishNavigation:
 │   window.XIAOER_CTX / XIAOER_GEMINI / xiaoerClose
 │   then calls window.xiaoerStart()
 ↓ app.js branches: lookup mode (has selection) vs chat mode
 ↓ Gemini 2.5 Flash streamGenerateContent SSE
```

## Two UX modes

- **Lookup mode** (selection exists): top shows `[释义] xxx` → auto-fires "explain xxx" → streaming answer → "[C] continue asking" button at bottom → click to enter chat mode
- **Chat mode** (no selection / after continue): input box visible, free-form Q&A

## Persistent panel (v1.5+)

Once the panel is open, Option+A doesn't open a second one — it **refreshes context in place**:
- New selection → auto-explain in same conversation (with `📍 switched → app` divider)
- No selection → re-capture screenshot, wait for user question
- Mouse drag selection while panel is open → **auto-watch eventtap captures it and refreshes**, no need to press Option+A

## Send-time recapture

When user submits in chat input, JS asks Lua to silently re-capture the current screen first, so the AI always sees the latest state. Chip flashes "JUST CAPTURED" for 1.8s as feedback.

## Why this stack

- **LLM = Gemini 2.5 Flash**: native multimodal (feeds raw screenshot, no OCR layer needed), fast, cheap, free tier covers daily use
- **UI = Hammerspoon `hs.webview`**: zero new dependencies if you already use Hammerspoon
- **context = bash**: app detection + AppleScript + curl all native shell terrain
- **No build step**: pure HTML/CSS/JS, edit and reload

## Key gotchas (learned the hard way)

- `hs.webview:allowTextEntry(true)` **must** be set or textareas don't accept keyboard input (default false)
- Hammerspoon is `LSUIElement` → its windows don't auto-activate → must explicitly `hsApp:activate(true)` after `:show()` for textareas to receive focus
- `-webkit-app-region: drag` doesn't work in Hammerspoon's WKWebView (Electron-specific) — must use native `titled` window for drag

## Debug entry points

- Log: `tail -f /tmp/xiaoer-ask.log` (Hammerspoon + capture-context both write here)
- Last screenshot: `tmp/last-shot.png`
- Last context: `tmp/last-context.json`
- WebView console: right-click → Inspect Element (developerExtras enabled)
- Manual trigger: `hs -c "xiaoerAsk.trigger()"`
- Manual close: `hs -c "xiaoerAsk.close()"`

## File layout

```
xiaoer-ask/
├── README.md
├── LICENSE
├── ARCHITECTURE.md           (this file)
├── .env.example
├── .gitignore
├── hammerspoon/
│   └── xiaoer-ask.lua        (hotkey + panel mgmt + auto-watch + window drag)
├── scripts/
│   └── capture-context.sh    (app detect + URL extract + screencap → JSON)
├── webview/
│   ├── index.html            (chat UI structure)
│   ├── app.js                (Gemini SSE streaming + modes + animations)
│   └── style.css             (electric blue + cream + lemon yellow theme)
└── tmp/                      (runtime captures, gitignored)
```

## Editing tips

- Modified `webview/*` → just close + reopen panel (Esc → Option+A); files reload from disk
- Modified `hammerspoon/xiaoer-ask.lua` → `hs -c 'hs.reload()'`
- Modified `scripts/capture-context.sh` → no reload needed (spawned fresh each time)
