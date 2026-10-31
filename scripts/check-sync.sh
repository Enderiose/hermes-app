#!/usr/bin/env bash
# 同步前自检：本机工作副本 ↔ 对侧工作副本（容器 / SMB 挂载）的差异。
#
# 背景（2026-10-24 实际踩到）：
#   往对侧同步时是「整文件覆盖」。如果对侧在上一轮之后**又修过**东西
#   （例如 1.0.0 里 hermes 修好的 previewText()），覆盖就会把它冲掉，
#   而且编译能过、只有跑起来才发现会话列表又变成一堆 JSON。
#
# 用法：
#   scripts/check-sync.sh                      # 默认对侧 /home/agent/.hermes/hermes-app
#   scripts/check-sync.sh /v/hermes/hermes_data/hermes-app   # Windows/MSYS 挂载
#
# 退出码：0 = 一致；1 = 有差异（先看 diff，确认方向，必要时先把对侧修复带回来）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OTHER="${1:-/home/agent/.hermes/hermes-app}"

if [ ! -d "$OTHER" ]; then
  echo "对侧路径不存在：$OTHER" >&2
  exit 2
fi

FILES=(
  VERSION
  build.sh
  README.md
  README_EN.md
  app/AndroidManifest.xml
  app/java/com/enderiose/hermes/MainActivity.java
  app/java/com/enderiose/hermes/SimpleFileProvider.java
  app/assets/www/app.js
  app/assets/www/app.css
  app/assets/www/index.html
)

# 关键符号：两侧都必须存在。缺一个基本就是被单向覆盖冲掉了。
SYMS=(
  previewText
  openMessageActions
  formatQuoted
  forkSessionFlow
  speakText
  setPillText
  wbLoadLogs
  MIN_STUDIO_VERSION
)

echo "本机：$ROOT"
echo "对侧：$OTHER"
echo
echo "== 文件差异 =="
any=0
for f in "${FILES[@]}"; do
  if [ ! -f "$ROOT/$f" ] || [ ! -f "$OTHER/$f" ]; then
    echo "MISSING $f"
    any=1
    continue
  fi
  if ! cmp -s "$ROOT/$f" "$OTHER/$f"; then
    echo "DIFF    $f"
    diff -u "$ROOT/$f" "$OTHER/$f" | sed -n '1,60p' || true
    any=1
  fi
done
[ "$any" -eq 0 ] && echo "（无文件差异）"

echo
echo "== 关键符号检查（app.js）=="
miss=0
for s in "${SYMS[@]}"; do
  a=$(grep -c "$s" "$ROOT/app/assets/www/app.js" 2>/dev/null || true)
  b=$(grep -c "$s" "$OTHER/app/assets/www/app.js" 2>/dev/null || true)
  a=${a:-0}; b=${b:-0}
  if [ "$a" -eq 0 ] || [ "$b" -eq 0 ]; then
    echo "MISS    $s  本机=$a 对侧=$b"
    miss=1
  fi
done
[ "$miss" -eq 0 ] && echo "（两侧都含全部关键符号）"

if [ "$any" -eq 1 ] || [ "$miss" -eq 1 ]; then
  echo
  echo "⚠ 有差异。同步前先逐条看上面的 diff："
  echo "  · 对侧独有的修复 → 先带回本机（反向同步），再重新跑本脚本"
  echo "  · 本机独有的改动 → 才允许覆盖对侧"
  exit 1
fi

echo
echo "OK: 两侧一致，可以安全同步"
