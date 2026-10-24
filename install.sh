#!/bin/bash
# CatCut installer for macOS: Node, ffmpeg (via Homebrew), CatCut itself, then Claude Code and/or Codex.
# Run in Terminal:  curl -fsSL https://raw.githubusercontent.com/thefogusz/CatCut/main/install.sh | bash
# Running it again updates CatCut. Nothing here needs git or coding.

set -euo pipefail

REPO='thefogusz/CatCut'
REF="${CATCUT_REF:-main}"
ROOT="${CATCUT_HOME:-$HOME/Library/Application Support/CatCut}"
APP="$ROOT/app"
STAMP="$(date +%Y%m%d-%H%M%S)"

say() { printf '  \033[36m%s\033[0m\n' "$1"; [ -n "${2:-}" ] && printf '  \033[90m%s\033[0m\n' "$2"; return 0; }
ok() { printf '  \033[32m[OK]\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m[!]\033[0m %s\n' "$1"; }
die() { printf '  \033[31m[x]\033[0m %s\n' "$1"; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

echo
printf '  \033[35mCatCut  =^.^=  ติดตั้ง / install (macOS)\033[0m\n'
echo

# Homebrew is not on PATH in a fresh Terminal right after it was installed
for b in /opt/homebrew/bin /usr/local/bin; do [ -x "$b/brew" ] && PATH="$b:$PATH"; done
brew_install() {
  has brew || die "ไม่พบ Homebrew — ติดตั้งจาก https://brew.sh แล้วรันคำสั่งเดิมอีกครั้ง / Homebrew missing: install it from https://brew.sh, then run again"
  brew install "$1"
}

# 1. Node.js 22+
node_ok=false
if has node && [ "$(node -v | sed -E 's/^v([0-9]+).*/\1/')" -ge 22 ]; then node_ok=true; fi
if ! $node_ok; then say 'กำลังติดตั้ง Node.js ...' 'Installing Node.js'; brew_install node; fi
has node || die 'ติดตั้ง Node.js ไม่สำเร็จ เปิด Terminal ใหม่แล้วรันคำสั่งเดิมอีกครั้ง / Node.js not found: reopen Terminal and run again'
NODE="$(command -v node)"
ok "Node $(node -v)"

# 2. ffmpeg: ffmpeg-full (keg-only, next to any other ffmpeg) brings libass for captions and whisper-cli;
#    CatCut prefers it automatically
FULL=''
for d in /opt/homebrew/opt/ffmpeg-full/bin /usr/local/opt/ffmpeg-full/bin; do [ -x "$d/ffmpeg" ] && FULL="$d"; done
if [ -z "$FULL" ]; then say 'กำลังติดตั้ง ffmpeg-full (มี libass สำหรับซับ และ whisper) ...' 'Installing ffmpeg-full'; brew_install ffmpeg-full; fi
ok 'ffmpeg-full'
MODELS="$ROOT/models"
if ! ls "$MODELS"/ggml-*.bin >/dev/null 2>&1; then
  warn 'ซับอัตโนมัติต้องมีโมเดล whisper (~570 MB) — โหลดด้วยคำสั่งนี้ / captions need a whisper model:'
  echo "    mkdir -p \"$MODELS\" && curl -fL -o \"$MODELS/ggml-large-v3-turbo-q5_0.bin\" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"
fi

# 3. CatCut: download, unpack next to the old copy, then swap (old copy kept until the swap succeeds)
say 'กำลังดาวน์โหลด CatCut ...' 'Downloading CatCut'
mkdir -p "$ROOT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "https://github.com/$REPO/archive/refs/heads/$REF.zip" -o "$TMP/catcut.zip"
unzip -q "$TMP/catcut.zip" -d "$TMP/unpack"
SRC="$(find "$TMP/unpack" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
[ -f "$SRC/dist/bundle/catcut.mjs" ] || die 'ไฟล์ CatCut ไม่ครบ / download is missing dist/bundle/catcut.mjs'
[ -d "$APP" ] && mv "$APP" "$ROOT/app-old-$STAMP"
mv "$SRC" "$APP"
rm -rf "$ROOT"/app-old-*
BUNDLE="$APP/dist/bundle/catcut.mjs"
ok "CatCut -> $APP"

# 4. Claude Code: the plugin brings the MCP server, skill and /catcut:* commands
claude_done=false
if has claude; then
  claude plugin marketplace add "$REPO" >/dev/null 2>&1 || true   # fails harmlessly when already added
  claude plugin marketplace update catcut >/dev/null 2>&1 || true
  if claude plugin install 'catcut@catcut' >/dev/null 2>&1; then claude_done=true; ok 'Claude Code plugin'
  else warn 'Claude Code: ติดตั้งปลั๊กอินอัตโนมัติไม่ได้ ทำตามขั้นด้านล่าง / plugin install failed, see below'; fi
fi

# 5. Codex: MCP server entry + skill (backups kept next to the originals)
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
codex_done=false
toml_str() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"; }
if [ -d "$CODEX_DIR" ]; then
  CFG="$CODEX_DIR/config.toml"
  if [ -f "$CFG" ]; then
    cp "$CFG" "$CFG.bak-catcut-$STAMP"
    # drop an older [mcp_servers.catcut] table (and its sub-tables), keep everything else
    awk '/^[[:space:]]*\[/ { skip = ($0 ~ /^[[:space:]]*\[mcp_servers\.catcut(\.[^]]+)?\][[:space:]]*$/) } !skip' "$CFG.bak-catcut-$STAMP" > "$CFG"
  fi
  { echo; echo '[mcp_servers.catcut]'; echo "command = $(toml_str "$NODE")"; echo "args = [$(toml_str "$BUNDLE"), \"serve\"]"; } >> "$CFG"
  SKILL_DIR="$CODEX_DIR/skills/catcut-editor"
  mkdir -p "$SKILL_DIR"
  [ -f "$SKILL_DIR/SKILL.md" ] && cp "$SKILL_DIR/SKILL.md" "$SKILL_DIR/SKILL.md.bak-$STAMP"
  cp "$APP/skills/catcut-editor/SKILL.md" "$SKILL_DIR/SKILL.md"
  codex_done=true
  ok 'Codex (config.toml + skill)'
fi

# 6. Check
echo
"$NODE" "$BUNDLE" doctor || true
echo
say 'เสร็จแล้ว!' 'Done.'
$codex_done && say 'Codex: ปิดแล้วเปิด Codex ใหม่ แล้วพิมพ์ เช่น "ใช้ CatCut ทำเอฟเฟคหัวใจนีออน 6 วิ"'
if $claude_done; then say 'Claude Code: เปิดใหม่ แล้วพิมพ์ /catcut:motion หัวใจนีออน 6 วิ'
else
  say 'Claude (แอป Claude แท็บ Code หรือ Claude Code): พิมพ์ 2 บรรทัดนี้ในแชท ครั้งเดียวพอ' 'In Claude Code, paste these two lines once:'
  echo '    /plugin marketplace add thefogusz/CatCut'
  echo '    /plugin install catcut@catcut'
fi
say 'After Effects: ครั้งแรกให้เปิด AE แล้วไปที่ After Effects > Settings > Scripting & Expressions ติ๊ก "Allow Scripts to Write Files and Access Network"'
say 'อยากอัปเดต: รันคำสั่งติดตั้งเดิมอีกครั้ง' 'To update, run the same install command again.'
echo
