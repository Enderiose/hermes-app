package com.enderiose.hermes;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;

/**
 * 最小 FileProvider：只服务 App 私有 cacheDir/camera 下的拍照输出。
 *
 * 为什么不用 androidx.core.content.FileProvider：
 *   本工程没有 Gradle/依赖管理（aapt2 + javac + d8），拿不到 androidx 的类。
 * 为什么需要它：Android 7+ 不允许把 file:// URI 交给相机（FileUriExposedException），
 *   必须用 content:// + 临时授权。这样"拍摄"才能拿到全尺寸照片，而不是缩略图。
 *
 * 只暴露 cacheDir/camera 一层，不接受任意路径，避免成为任意文件读取面。
 */
public class SimpleFileProvider extends ContentProvider {

    public static final String AUTHORITY_SUFFIX = ".files";
    private static final String SUB_DIR = "camera";

    /** 由目标文件得到 content:// URI（文件名唯一，够用且不需要编码）。 */
    public static Uri uriFor(Context ctx, File file) {
        return new Uri.Builder()
                .scheme("content")
                .authority(ctx.getPackageName() + AUTHORITY_SUFFIX)
                .appendPath(SUB_DIR)
                .appendPath(file.getName())
                .build();
    }

    private File fileFor(Uri uri) throws FileNotFoundException {
        if (uri == null) throw new FileNotFoundException("null uri");
        java.util.List<String> seg = uri.getPathSegments();
        if (seg == null || seg.size() != 2 || !SUB_DIR.equals(seg.get(0))) {
            throw new FileNotFoundException("unsupported uri: " + uri);
        }
        String name = seg.get(1);
        // 防穿越：只接受纯文件名
        if (name.isEmpty() || name.contains("/") || name.contains("..")) {
            throw new FileNotFoundException("bad name: " + name);
        }
        File dir = new File(getContext().getCacheDir(), SUB_DIR);
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, name);
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = fileFor(uri);
        int flags;
        if (mode != null && mode.contains("w")) {
            flags = ParcelFileDescriptor.MODE_CREATE
                    | ParcelFileDescriptor.MODE_READ_WRITE
                    | ParcelFileDescriptor.MODE_TRUNCATE;
        } else {
            flags = ParcelFileDescriptor.MODE_READ_ONLY;
        }
        return ParcelFileDescriptor.open(f, flags);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        File f;
        try {
            f = fileFor(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        String[] cols = projection != null ? projection
                : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor c = new MatrixCursor(cols, 1);
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
            else row[i] = null;
        }
        c.addRow(row);
        return c;
    }

    @Override
    public String getType(Uri uri) {
        String n = uri != null ? uri.getLastPathSegment() : null;
        if (n != null && n.toLowerCase().endsWith(".png")) return "image/png";
        if (n != null && n.toLowerCase().endsWith(".webp")) return "image/webp";
        if (n != null && n.toLowerCase().endsWith(".heic")) return "image/heic";
        return "image/jpeg";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
