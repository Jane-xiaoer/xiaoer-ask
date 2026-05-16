#!/bin/bash
# capture-context.sh
# 抓当前阅读上下文，输出 JSON 到 stdout
# 参数: $1 = selection text (可空), $2 = output dir for shot
# 输出 JSON: { app, title, mode, text, image_path, url, error }

set -uo pipefail

SELECTION="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TMPDIR="${2:-$PROJECT_DIR/tmp}"
mkdir -p "$TMPDIR"
SHOT_PATH="$TMPDIR/last-shot.png"
LOG="/tmp/xiaoer-ask.log"

log() { echo "[$(date '+%H:%M:%S')] capture: $*" >> "$LOG"; }
json_escape() { python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'; }

# ── 1. 抓 frontmost 应用 + 窗口标题 ────────────────────────────────
APP=$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null)
TITLE=$(osascript -e 'tell application "System Events" to get title of front window of first application process whose frontmost is true' 2>/dev/null || echo "")
log "app=$APP title=$TITLE"

MODE=""
TEXT=""
IMAGE_PATH=""
URL=""
ERR=""

# ── 2. 分支：浏览器 ─────────────────────────────────────────────────
case "$APP" in
  "Brave Browser"|"Google Chrome"|"Arc"|"Microsoft Edge")
    MODE="browser"
    URL=$(osascript -e "tell application \"$APP\" to get URL of active tab of front window" 2>/dev/null || echo "")
    ;;
  "Safari")
    MODE="browser"
    URL=$(osascript -e 'tell application "Safari" to get URL of current tab of front window' 2>/dev/null || echo "")
    ;;
esac

if [[ "$MODE" == "browser" && -n "$URL" ]]; then
  log "browser URL: $URL"

  # 公众号
  if [[ "$URL" == *"mp.weixin.qq.com"* ]]; then
    log "wechat article, UA spoof curl"
    HTML=$(curl -sL --max-time 8 \
      -A "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.0" \
      "$URL" 2>/dev/null)
    # 提 #js_content 文本
    TEXT=$(echo "$HTML" | python3 -c "
import sys, re
html = sys.stdin.read()
m = re.search(r'<div[^>]*id=\"js_content\"[^>]*>(.*?)</div>\s*<script', html, re.DOTALL)
if m:
    body = m.group(1)
    body = re.sub(r'<[^>]+>', ' ', body)
    body = re.sub(r'\s+', ' ', body).strip()
    print(body[:8000])
" 2>/dev/null || echo "")
  fi

  # 通用公开站点：curl + readability (python)
  if [[ -z "$TEXT" ]]; then
    log "curl + readability"
    HTML=$(curl -sL --max-time 8 \
      -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" \
      "$URL" 2>/dev/null)
    if [[ -n "$HTML" ]]; then
      TEXT=$(echo "$HTML" | python3 -c "
import sys, re
html = sys.stdin.read()
# 砍 script/style
html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL|re.IGNORECASE)
html = re.sub(r'<style[^>]*>.*?</style>', '', html, flags=re.DOTALL|re.IGNORECASE)
# 优先 main/article
m = re.search(r'<(?:main|article)[^>]*>(.*?)</(?:main|article)>', html, re.DOTALL|re.IGNORECASE)
body = m.group(1) if m else html
body = re.sub(r'<[^>]+>', ' ', body)
body = re.sub(r'\s+', ' ', body).strip()
print(body[:8000])
" 2>/dev/null || echo "")
    fi
  fi

  # 还没东西：截图兜底
  if [[ -z "$TEXT" || ${#TEXT} -lt 100 ]]; then
    log "browser fallback to screenshot"
    screencapture -x -o "$SHOT_PATH" 2>/dev/null
    IMAGE_PATH="$SHOT_PATH"
    TEXT=""
  fi

# ── 3. 分支：本地文件（Typora/Obsidian/iA Writer/VSCode 等编辑器） ──
elif [[ "$APP" == "Typora" || "$APP" == "Obsidian" || "$APP" == "iA Writer" || "$APP" == "Code" || "$APP" == "Visual Studio Code" ]]; then
  MODE="file"
  log "editor: try reading file from title"
  # 标题可能是「filename.md - AppName」或「filename.md」
  FNAME=$(echo "$TITLE" | sed -E 's/ [—–-] [^—–-]+$//' | sed -E 's/^.*[/]//')
  # 尝试从常见位置搜
  FPATH=""
  for d in "$HOME/Desktop" "$HOME/Documents" "$HOME/projects" "$HOME/.claude/memories"; do
    found=$(find "$d" -name "$FNAME" -type f 2>/dev/null | head -1)
    if [[ -n "$found" ]]; then FPATH="$found"; break; fi
  done
  if [[ -n "$FPATH" && -r "$FPATH" ]]; then
    TEXT=$(head -c 8000 "$FPATH")
  else
    log "file not found, screenshot fallback"
    screencapture -x -o "$SHOT_PATH" 2>/dev/null
    IMAGE_PATH="$SHOT_PATH"
  fi

# ── 4. 兜底：截屏喂多模态 ────────────────────────────────────────
else
  MODE="screenshot"
  log "screenshot mode for $APP"
  screencapture -x -o "$SHOT_PATH" 2>/dev/null
  IMAGE_PATH="$SHOT_PATH"
fi

# ── 5. 输出 JSON（用 env vars 传，避免引号转义炸） ───────────────────
export X_APP="$APP" X_TITLE="$TITLE" X_MODE="$MODE" X_SELECTION="$SELECTION"
export X_TEXT="$TEXT" X_IMAGE_PATH="$IMAGE_PATH" X_URL="$URL"

python3 <<'PYEOF'
import json, base64, os, time
img_b64 = ""
ip = os.environ.get("X_IMAGE_PATH", "")
if ip and os.path.exists(ip):
    with open(ip, "rb") as f:
        img_b64 = base64.b64encode(f.read()).decode()

print(json.dumps({
    "app": os.environ.get("X_APP", ""),
    "title": os.environ.get("X_TITLE", ""),
    "mode": os.environ.get("X_MODE", ""),
    "selection": os.environ.get("X_SELECTION", ""),
    "text": os.environ.get("X_TEXT", ""),
    "image_path": ip,
    "image_base64": img_b64,
    "url": os.environ.get("X_URL", ""),
    "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
}, ensure_ascii=False))
PYEOF
