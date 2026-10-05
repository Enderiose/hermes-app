# Hermes Mobile（Android 客户端）

[English](README_EN.md) | **简体中文**

Hermes Web UI / Ekko Studio 的移动端 WebView 客户端。无 Gradle 构建：aapt2 + javac + d8 + zipalign + apksigner。

- 产物：`out/HermesMobile.apk`
- 版本真源：`VERSION`（改这一个文件即可，manifest / Java / 网页三处由 build.sh 注入）
- 构建前配置：`config.env`（默认服务器地址，同样由 build.sh 注入 Java / 网页）

## 构建前配置（config.env）

构建前要改的设置集中在一个文件里，先复制示例：

```bash
cp config.env.example config.env
```

`config.env` 是**本机文件、不进仓库**（`.gitignore` 忽略，因为每个人的服务器地址不同）；仓库里只有示例 `config.env.example`：

```bash
# config.env
DEFAULT_BASE_URL=http://192.168.1.100:6060
```

- `DEFAULT_BASE_URL`：登录页的预填值，也是应用在本机还没保存过服务器地址时的回退值。示例里是占位地址，
  改成你自己的 —— 比如局域网 `http://<你的内网IP>:6060`，或经反向代理的 `https://your-domain:port`。
- 必须是完整 origin（带 `http://` 或 `https://`、不要结尾斜杠），端口写服务端的实际端口。
- 构建时注入三处：生成的 `BuildInfo.java`（原生 `getBase()` 的默认值）、`index.html` 的登录页输入框、
  `app.js` 的地址回退值。源码里不再各写一份，改完 `config.env` 重新构建即可。
- 解析规则：`KEY=VALUE` 一行一条，`#` 开头是注释，值不要加引号。`config.env` 不存在时会提示
  `cp config.env.example config.env`；`DEFAULT_BASE_URL` 缺失、为空或不是 `http(s)://` 前缀时构建直接失败；
  构建日志会打印 `== default base url ... ==` 便于确认。
- 应用显示名固定为 `HermesApp`（`app/res/values/strings.xml` 与 manifest 的 `android:label`），不从这个文件读。

## 签名密钥（重要）

仓库里**没有**可用的签名密钥，只有一个模板：

```bash
cp signing.jks.example signing.jks
```

- `signing.jks.example` 是一副**全新生成的测试密钥**（自签名，alias `hermes`，口令 `android`），只能用来给自己侧载安装/自测，**不是**发布密钥。
- 真正的 `signing.jks` 属于机密等价物，已被 `.gitignore` 忽略，永远不会进仓库；**不要提交它**。
- 自签名证书的指纹决定了 Android 的升级兼容性：用模板密钥签的 APK **无法覆盖安装**在别处用别的密钥签过的同包名应用（会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，只能先卸载）。要给已有安装升级，请用当初那副真实密钥，或者先卸载旧应用。
- 如果 `signing.jks` 不存在，`build.sh` 会用 `keytool` 就地生成一副新的（口令同样是 `android`），所以直接跑构建也能出包，只是签名身份每次都是新的。

## 构建

```bash
bash build.sh          # 需要 JDK 17+ 与 Android SDK build-tools 34.0.0
```

SDK 路径默认 `/opt/android-sdk`，可用环境变量覆盖：`ANDROID_SDK=/path/to/sdk bash build.sh`。

输出 `out/HermesMobile.apk`（已签名）。

## 结构

```
config.env.example               构建期配置示例（cp 成 config.env 后本地改；config.env 被忽略、不提交）
VERSION                          版本号真源（改这一个文件即可）
app/AndroidManifest.xml          清单（版本号占位符 @VERSION_NAME@ / @VERSION_CODE@、应用名 HermesApp）
app/java/com/enderiose/hermes/   MainActivity（WebView 壳 + 原生桥：文件选择/下载/返回键）
app/res/                         图标与主题资源（strings.xml：应用显示名）
app/assets/www/                  前端单页（index.html + app.css + app.js）
  └ build.sh 会把三者内联成 inline.html 打进 APK（页面以服务器 origin 加载）
scripts/                         冒烟与验证脚本（真服务端 + Playwright）
tests/                           Playwright 验证脚本（真服务端 + 真实 run）
scripts/smoke_test.py            冒烟：列表/聊天/企微/新建会话/模型列表
out/                             构建产物目录（仓库里只保留 .gitkeep，内容被忽略）
```

## 测试

需要一个在跑的 Hermes 服务端（默认 `http://127.0.0.1:6060`）与 `.model-run-token`。

```bash
export PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/.playwright
/opt/hermes/.venv/bin/python scripts/smoke_test.py
/opt/hermes/.venv/bin/python tests/queue_single_place.py   # 排队消息只出现在排队区
/opt/hermes/.venv/bin/python tests/tool_group_live.py      # 实时工具整合（驱动真实 socket handler）
/opt/hermes/.venv/bin/python tests/tool_group_e2e.py       # 真实 run：工具整合端到端（会发一条消息）
/opt/hermes/.venv/bin/python tests/wecom_group.py          # 企微会话工具整合
/opt/hermes/.venv/bin/python tests/category_manage.py      # 会话分类 CRUD（会发一条消息）
```

约定：每条脚本用自己新建的临时会话/分类，跑完自动删除；断言以服务端回读为准，不只看 DOM。
Playwright 里连 socket 需要 `--disable-features=LocalNetworkAccessChecks`
（否则 headless Chromium 的本地网络限制会让 websocket 直接失败，REST 却正常）。
