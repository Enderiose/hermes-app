# Hermes Mobile (Android client)

**English** | [简体中文](README.md)

A mobile WebView client for Hermes Web UI / Ekko Studio. Built without Gradle: aapt2 + javac + d8 + zipalign + apksigner.

- Artifact: `out/HermesMobile.apk`
- Version source of truth: `VERSION` (edit this one file; build.sh injects it into the manifest, the Java source, and the web page)
- Pre-build config: `config.env` (default server address, likewise injected into the Java source and the web page by build.sh)

## Pre-build config (config.env)

Everything you may want to change before a build lives in one file. Copy the example first:

```bash
cp config.env.example config.env
```

`config.env` is **a local file that never enters the repository** (it is `.gitignore`d, because everyone's server
address differs); the repo only ships the example `config.env.example`:

```bash
# config.env
DEFAULT_BASE_URL=http://192.168.1.100:6060
```

- `DEFAULT_BASE_URL`: prefilled in the login form, and the fallback used when the app has not stored a server address on this device yet. The example holds a placeholder — put your own in, e.g. the LAN address `http://<your-LAN-IP>:6060`, or `https://your-domain:port` behind a reverse proxy.
- Must be a full origin (include `http://` or `https://`, no trailing slash), with the actual port your server listens on.
- Injected in three places at build time: the generated `BuildInfo.java` (the native `getBase()` default), the
  login input in `index.html`, and the address fallback in `app.js`. No more per-file copies — edit `config.env`
  and rebuild.
- Parsing rules: one `KEY=VALUE` per line, `#` starts a comment, no quotes around values. A missing `config.env`
  prints `cp config.env.example config.env`; a missing, empty, or non-`http(s)://` `DEFAULT_BASE_URL` fails the
  build; the build log prints `== default base url ... ==` so you can confirm.
- The launcher name is fixed to `HermesApp` (`app/res/values/strings.xml` and `android:label` in the manifest); it is not read from this file.

## Signing key (important)

The repository contains **no usable signing key** — only a template:

```bash
cp signing.jks.example signing.jks
```

- `signing.jks.example` is a **freshly generated test key** (self-signed, alias `hermes`, password `android`). It is only good enough for sideloading your own builds and self-testing — it is **not** a release key.
- The real `signing.jks` is secret-equivalent, is ignored by `.gitignore`, and must never enter the repository. **Do not commit it.**
- A self-signed certificate's fingerprint decides Android's upgrade compatibility: an APK signed with the template key **cannot be installed over** an app of the same package name signed elsewhere with a different key (you get `INSTALL_FAILED_UPDATE_INCOMPATIBLE`; the old app must be uninstalled first). To upgrade an existing install, use the original real key, or uninstall the old app.
- If `signing.jks` is missing, `build.sh` generates a new one in place with `keytool` (same `android` password), so a plain build still produces an APK — the signing identity is just new every time.

## Build

```bash
bash build.sh          # requires JDK 17+ and Android SDK build-tools 34.0.0
```

The SDK path defaults to `/opt/android-sdk` and can be overridden: `ANDROID_SDK=/path/to/sdk bash build.sh`.

Output: `out/HermesMobile.apk` (signed).

## Layout

```
config.env.example               pre-build config example (cp to config.env and edit; config.env is ignored, never committed)
VERSION                          version source of truth (edit this one file)
app/AndroidManifest.xml          manifest (version placeholders @VERSION_NAME@ / @VERSION_CODE@, app name HermesApp)
app/java/com/enderiose/hermes/   MainActivity (WebView shell + native bridge: file picker / download / back key)
app/res/                         icons and theme resources (strings.xml: launcher name)
app/assets/www/                  the single-page front end (index.html + app.css + app.js)
  └ build.sh inlines all three into inline.html and packs it into the APK (the page loads with the server's origin)
scripts/                         smoke and verification scripts (real server + Playwright)
tests/                           Playwright verification suites (real server + real run)
scripts/smoke_test.py            smoke test: session list / chat / WeCom / new session / model list
out/                             build output directory (only .gitkeep is committed, contents are ignored)
```

## Tests

Requires a running Hermes server (default `http://127.0.0.1:6060`) and a `.model-run-token`.

```bash
export PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/.playwright
/opt/hermes/.venv/bin/python scripts/smoke_test.py
/opt/hermes/.venv/bin/python tests/queue_single_place.py   # queued messages appear only in the queue area
/opt/hermes/.venv/bin/python tests/tool_group_live.py      # live tool grouping (drives the real socket handler)
/opt/hermes/.venv/bin/python tests/tool_group_e2e.py       # real run: tool grouping end to end (sends a message)
/opt/hermes/.venv/bin/python tests/wecom_group.py          # WeCom session tool grouping
/opt/hermes/.venv/bin/python tests/category_manage.py      # session category CRUD (sends a message)
```

Conventions: every script creates its own temporary session/category and deletes it when done; assertions are made
against what the server reports back, not against the DOM alone.
Connecting a socket from Playwright needs `--disable-features=LocalNetworkAccessChecks`
(otherwise headless Chromium's local-network restriction makes the websocket fail outright while REST still works).
