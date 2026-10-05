#!/usr/bin/env bash
# Hermes 移动版 APK 构建（无 Gradle：aapt2 + javac + d8 + apksigner）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_SDK:-/opt/android-sdk}"  # 可用环境变量覆盖 SDK 路径
BT="$SDK/build-tools/34.0.0"
PLAT="$SDK/platforms/android-34/android.jar"
PKG=com.enderiose.hermes
OUT="$ROOT/out"
GEN="$OUT/gen"
OBJ="$OUT/obj"
DEX="$OUT/dex"

# 版本真源：$ROOT/VERSION。versionCode 取 major*100 + minor（0.2 -> 2）
VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
[ -n "$VERSION" ] || { echo "VERSION file empty"; exit 1; }
IFS='.' read -r VMAJOR VMINOR <<< "$VERSION"
VMINOR="${VMINOR:-0}"
VERSION_CODE=$((VMAJOR * 100 + VMINOR))
echo "== version ${VERSION} (code ${VERSION_CODE}) =="

# 构建期配置真源：$ROOT/config.env。只解析 KEY=VALUE（不 source，免得配置里的命令被执行）。
CONF="$ROOT/config.env"
[ -f "$CONF" ] || {
  echo "config.env not found: $CONF"
  echo "→ 先执行：cp config.env.example config.env ，再按需修改 DEFAULT_BASE_URL"
  exit 1
}
DEFAULT_BASE_URL=""
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  line="${line#"${line%%[![:space:]]*}"}"      # 去行首空白
  case "$line" in ''|'#'*) continue ;; esac
  key="${line%%=*}"; val="${line#*=}"
  key="$(printf '%s' "$key" | tr -d '[:space:]')"
  val="$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//')"
  case "$key" in
    DEFAULT_BASE_URL) DEFAULT_BASE_URL="$val" ;;
    *) echo "config.env: 忽略未知键 $key" ;;
  esac
done < "$CONF"
[ -n "$DEFAULT_BASE_URL" ] || { echo "config.env: DEFAULT_BASE_URL 缺失或为空"; exit 1; }
case "$DEFAULT_BASE_URL" in
  http://*|https://*) ;;
  *) echo "config.env: DEFAULT_BASE_URL 必须以 http:// 或 https:// 开头（当前：$DEFAULT_BASE_URL）"; exit 1 ;;
esac
echo "== default base url ${DEFAULT_BASE_URL} =="

command -v java >/dev/null || { echo "java not found"; exit 1; }
[ -f "$PLAT" ] || { echo "android.jar not found: $PLAT"; exit 1; }

rm -rf "$OUT"
mkdir -p "$GEN" "$OBJ" "$DEX"

echo "== 1/6 aapt2 compile resources =="
"$BT/aapt2" compile --dir "$ROOT/app/res" -o "$OUT/res.zip"

echo "== 1.5/6 注入版本号到 manifest =="
# AndroidManifest.xml 里写占位符，构建时按 VERSION 替换，保证版本只有 VERSION 一个真源
sed -e "s/@VERSION_NAME@/${VERSION}/g" -e "s/@VERSION_CODE@/${VERSION_CODE}/g" \
  "$ROOT/app/AndroidManifest.xml" > "$OUT/AndroidManifest.xml"
grep -q "android:versionName=\"${VERSION}\"" "$OUT/AndroidManifest.xml" \
  || { echo "manifest 版本号注入失败"; exit 1; }

echo "== 2/6 aapt2 link =="
"$BT/aapt2" link -o "$OUT/app.unsigned.apk" \
  -I "$PLAT" \
  --manifest "$OUT/AndroidManifest.xml" \
  "$OUT/res.zip" \
  --java "$GEN" \
  --min-sdk-version 24 --target-sdk-version 34

echo "== 3/6 javac =="
# 版本号 + 默认服务器地址注入：生成 BuildInfo.java，避免 Java / manifest / 网页三处各写一份导致漂移
mkdir -p "$OUT/gen/com/enderiose/hermes"
cat > "$OUT/gen/com/enderiose/hermes/BuildInfo.java" <<JAVA
package com.enderiose.hermes;

public final class BuildInfo {
    public static final String VERSION = "${VERSION}";
    public static final int VERSION_CODE = ${VERSION_CODE};
    public static final String DEFAULT_BASE = "${DEFAULT_BASE_URL}";
}
JAVA
find "$ROOT/app/java" "$GEN" -name '*.java' > "$OUT/sources.txt"
javac --release 17 -encoding UTF-8 -classpath "$PLAT" -d "$OBJ" @"$OUT/sources.txt"

echo "== 4/6 d8 dex =="
find "$OBJ" -name '*.class' > "$OUT/classes.txt"
"$BT/d8" --release --lib "$PLAT" --output "$DEX" $(cat "$OUT/classes.txt")

echo "== 5/6 pack assets + dex =="
# 单文件 HTML：把 css/js/socket.io 全部内联，供 WebView 用 loadDataWithBaseURL(服务器 origin) 加载
# 助手头像：官方图标以 data URI 内联（页面 base URL 指向服务器，相对路径资源会 404）
BOT_DATA_URI=$(cat "$ROOT/app/assets/www/hermes-bot-datauri.txt")
APP_VERSION="$VERSION" DEFAULT_BASE_URL="$DEFAULT_BASE_URL" python3 - "$ROOT/app" "$BOT_DATA_URI" <<'PY'
import os, sys
appdir, icon = sys.argv[1], sys.argv[2]
www = os.path.join(appdir, 'assets', 'www')
html = open(os.path.join(www, 'index.html'), encoding='utf-8').read()
css = open(os.path.join(www, 'app.css'), encoding='utf-8').read()
js = open(os.path.join(www, 'app.js'), encoding='utf-8').read()
js = js.replace('src="hermes-bot.png"', 'src="__HERMES_BOT_ICON__"')
js = js.replace("'__APP_VERSION__'", "'" + os.environ.get('APP_VERSION', '') + "'")
base_url = os.environ.get('DEFAULT_BASE_URL', '')
if not base_url:
    raise SystemExit('config.env 未提供 DEFAULT_BASE_URL')
js = js.replace('__DEFAULT_BASE_URL__', base_url)
html = html.replace('<link rel="stylesheet" href="app.css">', '<style>\n' + css + '\n</style>')
html = html.replace('<script src="app.js"></script>', '<script>\n' + js + '\n</script>')
# socket.io 客户端保持外部引用 /socket.io/socket.io.js（同源、由服务端提供），不内联
html = html.replace('__HERMES_BOT_ICON__', icon)
html = html.replace('__DEFAULT_BASE_URL__', base_url)
if '__HERMES_BOT_ICON__' in html:
    raise SystemExit('助手头像 data URI 注入失败')
if '__APP_VERSION__' in html:
    raise SystemExit('版本号注入失败')
if '__DEFAULT_BASE_URL__' in html:
    raise SystemExit('默认服务器地址注入失败')
open(os.path.join(www, 'inline.html'), 'w', encoding='utf-8').write(html)
print('inline.html bytes:', len(html.encode('utf-8')))
PY

python3 - "$OUT/app.unsigned.apk" "$OUT/app.build.apk" "$DEX/classes.dex" "$ROOT/app" <<'PY'
import os, shutil, sys, zipfile
src, dst, dex, appdir = sys.argv[1:5]
shutil.copyfile(src, dst)
with zipfile.ZipFile(dst, 'a') as z:
    z.write(dex, 'classes.dex', compress_type=zipfile.ZIP_STORED)
    # inline.html 已把 css/js/助手头像全部内联，是唯一需要打进包的网页资源
    z.write(os.path.join(appdir, 'assets/www/inline.html'), 'assets/www/inline.html',
            compress_type=zipfile.ZIP_DEFLATED)
print('packed')
PY
"$BT/zipalign" -f 4 "$OUT/app.build.apk" "$OUT/app.aligned.apk"
cp "$OUT/app.aligned.apk" "$OUT/app.build.apk"

echo "== 6/6 sign =="
KS="$ROOT/signing.jks"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -alias hermes -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass android -keypass android \
    -dname "CN=Hermes Mobile, OU=Temp, O=Ekko, L=LAN, ST=NA, C=CN" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out "$OUT/HermesMobile.apk" "$OUT/app.build.apk"

"$BT/apksigner" verify --print-certs "$OUT/HermesMobile.apk" | head -3
echo "== badging =="
"$BT/aapt2" dump badging "$OUT/HermesMobile.apk" | head -4
ls -la "$OUT/HermesMobile.apk"
touch "$OUT/.gitkeep"   # 上面 rm -rf 把占位文件删了，补回来免得每次构建都变成删除

echo "BUILD_OK: $OUT/HermesMobile.apk"
