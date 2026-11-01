package com.shadowagent.voice;

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
import java.io.IOException;

public final class ExportProvider extends ContentProvider {
    public static Uri uri(Context context, File file) throws IOException {
        File root = context.getCacheDir().getCanonicalFile();
        String path = file.getCanonicalPath();
        if (!path.startsWith(root.getPath() + File.separator) || !file.getName().endsWith(".zip")) throw new IOException("Not an exported ZIP");
        String relative = path.substring(root.getPath().length() + 1);
        return new Uri.Builder().scheme("content").authority(context.getPackageName() + ".exports").appendPath(relative).build();
    }
    @Override public boolean onCreate() { return true; }
    private File resolve(Uri uri) throws FileNotFoundException {
        try {
            if (uri.getPathSegments().size() != 1) throw new IOException();
            File root = getContext().getCacheDir().getCanonicalFile();
            File file = new File(root, uri.getPathSegments().get(0)).getCanonicalFile();
            if (!file.getPath().startsWith(root.getPath() + File.separator) || !file.getName().endsWith(".zip") || !file.isFile()) throw new IOException();
            return file;
        } catch (Exception e) { throw new FileNotFoundException("Export unavailable"); }
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("Read only");
        return ParcelFileDescriptor.open(resolve(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
        try { File file = resolve(uri); MatrixCursor c = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}); c.addRow(new Object[]{file.getName(), file.length()}); return c; }
        catch (FileNotFoundException e) { return null; }
    }
    @Override public String getType(Uri uri) { return "application/zip"; }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
