package com.enderiose.hermes;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebChromeClient.FileChooserParams;
import android.webkit.ConsoleMessage;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;

/**
 * Hermes 移动版：单 Activity + WebView。
 *
 * 关键点：页面必须带着“服务器 origin”加载（loadDataWithBaseURL），否则页面 origin 是
 * file:// / null，Studio 的 socket.io 会直接 403/400「origin not allowed」——实时同步与
 * 流式输出都会失效。base URL 存在 SharedPreferences，由 JS 通过 Android.setBase() 改写。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "hermes_mobile";
    private static final String KEY_BASE = "base_url";
    // 默认服务器地址：构建期由 config.env 的 DEFAULT_BASE_URL 注入（见 BuildInfo）
    private static final String DEFAULT_BASE = BuildInfo.DEFAULT_BASE;

    private WebView webView;

    private static final int REQ_PICK_IMAGE = 1001;
    private static final int REQ_CAPTURE_IMAGE = 1002;
    private String capturePhotoPath = null;
    private ValueCallback<Uri[]> pendingCallback = null;

    /** 命名静态类（避免匿名类/内部类触发本工具链 d8 的 NPE）。 */
    static class InnerWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme();
            if (scheme == null || "http".equals(scheme) || "https".equals(scheme) || "file".equals(scheme)) {
                return false;
            }
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, uri);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                view.getContext().startActivity(i);
            } catch (Exception ignored) {
            }
            return true;
        }
    }

    /**
     * WebChromeClient：接管 <input type=file>，弹出系统相册/拍照选择器。
     * Android 5.0+ 走 onShowFileChooser(ValueCallback<Uri[]>)。
     * 注：本类必须是 static 嵌套类且方法内不用匿名类 —— d8 34.0.0 对非 static 内部类
     * 中的 lambda / 实现泛型接口的匿名类会 NPE（见 skill android-apk-build）。
     */
    static class InnerChromeClient extends WebChromeClient {
        private final MainActivity activity;

        InnerChromeClient(MainActivity activity) {
            this.activity = activity;
        }

        public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback,
                                         FileChooserParams fileChooserParams) {
            activity.startImagePicker(filePathCallback, fileChooserParams);
            return true;
        }

        /** 把网页 console 输出转发到 logcat（tag=HermesApp）。
         *  页面里的报错否则只存在于 WebView 内部，插线看 logcat 也看不到。 */
        public boolean onConsoleMessage(ConsoleMessage cm) {
            android.util.Log.i("HermesApp", "[console] " + cm.message()
                    + " @" + cm.sourceId() + ":" + cm.lineNumber());
            return true;
        }
    }

    /** JS 桥（static 嵌套类：非 static 内部类 + lambda 会触发本工具链 d8 的 NPE）。 */
    static class Bridge {
        private final MainActivity activity;

        Bridge(MainActivity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public String getBase() {
            return activity.storedBase();
        }

        @JavascriptInterface
        public void setBase(final String url) {
            activity.setStoredBase(url);
        }

        @JavascriptInterface
        public void finishApp() {
            activity.runOnUiThread(() -> activity.finish());
        }

        /** 消息里的链接：优先外置浏览器；不行就下载目录；都不行用系统默认处理。 */
        @JavascriptInterface
        public void openUrl(final String url) {
            if (url == null) return;
            final Uri uri = Uri.parse(url);
            if (uri == null || uri.getScheme() == null) return;
            activity.runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, uri);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    activity.startActivity(i);
                } catch (Exception ignored) {
                }
            });
        }

        @JavascriptInterface
        public void keepScreenOn(final boolean on) {
            activity.runOnUiThread(() -> activity.webView.setKeepScreenOn(on));
        }

        /**
         * 读系统剪贴板里的图片，返回 JSON 串 {"dataUrl":"data:image/...;base64,...","name":"..."}，
         * 没有图片返回 ""。
         * 为什么需要它：Android WebView 的 paste 事件对图片往往不带 clipboardData.files，
         * 只靠 JS 的 paste 事件拿不到手机相册/截图里的图。
         */
        @JavascriptInterface
        public String getClipboardImage() {
            final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
            final String[] out = new String[]{""};
            activity.runOnUiThread(() -> {
                try {
                    out[0] = activity.readClipboardImage();
                } catch (Exception ignored) {
                    out[0] = "";
                } finally {
                    latch.countDown();
                }
            });
            try {
                latch.await(3, java.util.concurrent.TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
            }
            return out[0];
        }
    }

    /** 从系统剪贴板取图片并转 data URL（在 UI 线程调用）。 */
    String readClipboardImage() {
        try {
            android.content.ClipboardManager cm =
                (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (cm == null || !cm.hasPrimaryClip()) return "";
            android.content.ClipData clip = cm.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return "";
            Uri uri = clip.getItemAt(0).getUri();
            if (uri == null) return "";
            android.content.ContentResolver cr = getContentResolver();
            String type = cr.getType(uri);
            if (type == null) type = "image/png";
            if (!type.startsWith("image/")) return "";
            InputStream in = cr.openInputStream(uri);
            if (in == null) return "";
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
                if (bos.size() > 20 * 1024 * 1024) { in.close(); return ""; }
            }
            in.close();
            byte[] bytes = bos.toByteArray();
            if (bytes.length == 0) return "";
            String b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP);
            String name = "pasted-" + System.currentTimeMillis() + ".png";
            return "{\"dataUrl\":\"data:" + type + ";base64," + b64 + "\",\"name\":\"" + name + "\"}";
        } catch (Exception e) {
            return "";
        }
    }

    String storedBase() {
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        return sp.getString(KEY_BASE, DEFAULT_BASE);
    }

    void setStoredBase(String url) {
        String normalized = url == null ? "" : url.trim();
        if (normalized.endsWith("/")) normalized = normalized.substring(0, normalized.length() - 1);
        if (normalized.isEmpty()) return;
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_BASE, normalized).apply();
        runOnUiThread(this::loadApp);
    }

    private String readAsset(String path) {
        StringBuilder sb = new StringBuilder();
        try (InputStream is = getAssets().open(path);
             BufferedReader br = new BufferedReader(new InputStreamReader(is, "UTF-8"))) {
            String line;
            while ((line = br.readLine()) != null) {
                sb.append(line).append('\n');
            }
        } catch (IOException e) {
            return null;
        }
        return sb.toString();
    }

    private void loadApp() {
        String html = readAsset("www/inline.html");
        String base = storedBase();
        if (html == null) {
            webView.loadDataWithBaseURL(base + "/", "<h3>assets/www/inline.html missing</h3>", "text/html", "UTF-8", null);
            return;
        }
        webView.loadDataWithBaseURL(base + "/", html, "text/html", "UTF-8", null);
    }

    /**
     * <input type=file> 被触发时弹出选择器：相册 + 拍照（用 ACTION_CHOOSER 合并）。
     * 回调结果在 onActivityResult 回给 WebView。
     */
    void startImagePicker(ValueCallback<Uri[]> filePathCallback, FileChooserParams params) {
        if (filePathCallback == null) return;
        // 上一个还没消费，先取消
        if (pendingCallback != null) {
            try { pendingCallback.onReceiveValue(null); } catch (Exception ignored) {}
            pendingCallback = null;
        }
        pendingCallback = filePathCallback;

        Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        pick.setType("image/*");

        Intent chooser = Intent.createChooser(pick, "选择图片");
        try {
            startActivityForResult(chooser, REQ_PICK_IMAGE);
        } catch (Exception e) {
            if (pendingCallback != null) {
                pendingCallback.onReceiveValue(null);
                pendingCallback = null;
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK_IMAGE || pendingCallback == null) return;
        ValueCallback<Uri[]> cb = pendingCallback;
        pendingCallback = null;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            cb.onReceiveValue(null);
            return;
        }
        cb.onReceiveValue(new Uri[]{data.getData()});
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " HermesMobile/" + BuildInfo.VERSION);

        webView.setWebChromeClient(new InnerChromeClient(this));
        webView.setWebViewClient(new InnerWebViewClient());
        webView.addJavascriptInterface(new Bridge(this), "Android");
        webView.setBackgroundColor(0xFF0F1115);
        loadApp();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            // 优先让 SPA 处理返回（视图切换），未消费时退出应用。
            // 不用 implements ValueCallback<String> 的类：本工具链 d8 解析 android.jar 泛型签名会 NPE。
            webView.evaluateJavascript(
                "(function(){ try { if (window.__onBack && window.__onBack()) return '1'; } catch(e){} return '0'; })()",
                value -> {
                    if (!"\"1\"".equals(value)) {
                        finish();
                    }
                });
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onPause() {
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
