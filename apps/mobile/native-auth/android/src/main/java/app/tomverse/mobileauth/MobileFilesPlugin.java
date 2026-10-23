package app.tomverse.mobileauth;

import android.app.Activity;
import android.content.Intent;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.atomic.AtomicBoolean;
import java.net.HttpURLConnection;
import java.net.URI;
import java.util.Iterator;
import org.json.JSONObject;

/** File writes require the user's system document picker; no path is accepted. */
@CapacitorPlugin(name = "MobileFiles")
public class MobileFilesPlugin extends Plugin {
    private final AtomicBoolean saving = new AtomicBoolean(false);
    @PluginMethod public void uploadFile(PluginCall call) {
        bridge.execute(() -> {
            HttpURLConnection connection = null;
            try {
                String raw = call.getString("url", "");
                URI url = new URI(raw);
                String encoded = call.getString("data", "");
                if (!"https".equals(url.getScheme()) || url.getHost() == null || !url.getHost().matches("[a-z0-9-]+\\.r2\\.cloudflarestorage\\.com") ||
                    url.getRawUserInfo() != null || url.getPort() != -1 || url.getFragment() != null || raw.length() > 8192 ||
                    url.getRawQuery() == null || !url.getRawQuery().contains("X-Amz-Signature=") || encoded.length() > 90_000_000) throw new Exception();
                JSONObject headers = call.getObject("headers");
                if (headers == null || headers.length() > 12) throw new Exception();
                for (Iterator<String> keys = headers.keys(); keys.hasNext();) {
                    String key = keys.next(); String value = headers.getString(key);
                    if (!key.matches("(?i)(content-type|x-amz-[a-z0-9-]+)") || value.length() > 2048 || value.contains("\r") || value.contains("\n")) throw new Exception();
                }
                byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
                if (bytes.length > 64 * 1024 * 1024) throw new Exception();
                connection = (HttpURLConnection) url.toURL().openConnection();
                connection.setInstanceFollowRedirects(false); connection.setRequestMethod("PUT");
                connection.setRequestProperty("Cookie", "");
                connection.setConnectTimeout(25000); connection.setReadTimeout(45000); connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(bytes.length);
                for (Iterator<String> keys = headers.keys(); keys.hasNext();) { String key = keys.next(); connection.setRequestProperty(key, headers.getString(key)); }
                try (var output = connection.getOutputStream()) { output.write(bytes); }
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) throw new Exception();
                call.resolve();
            } catch (Exception error) { call.reject("File upload failed", "UPLOAD_FAILED"); }
            finally { if (connection != null) connection.disconnect(); }
        });
    }
    @PluginMethod public void saveFile(PluginCall call) {
        String name = call.getString("filename", "download");
        String data = call.getString("data", "");
        if (name.isEmpty() || name.equals(".") || name.equals("..") || name.length() > 160 || name.matches(".*[\\\\/\\p{Cntrl}].*") || data.length() > 90_000_000) {
            call.reject("File cannot be saved", "FILE_INVALID"); return;
        }
        if (!saving.compareAndSet(false, true)) { call.reject("A save is already open", "FILE_SAVE_BUSY"); return; }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mediaType", "application/octet-stream"));
        intent.putExtra(Intent.EXTRA_TITLE, name);
        try { startActivityForResult(call, intent, "fileChosen"); }
        catch (Exception error) { saving.set(false); call.reject("Could not open file picker", "FILE_SAVE_FAILED"); }
    }

    @ActivityCallback private void fileChosen(PluginCall call, ActivityResult result) {
        if (call == null) { saving.set(false); return; }
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            saving.set(false);
            call.reject("Save cancelled", "FILE_SAVE_CANCELLED"); return;
        }
        bridge.execute(() -> {
            try {
                byte[] bytes = Base64.decode(call.getString("data", ""), Base64.NO_WRAP);
                if (bytes.length > 64 * 1024 * 1024) throw new Exception("File too large");
                try (var output = getContext().getContentResolver().openOutputStream(result.getData().getData(), "w")) {
                    if (output == null) throw new Exception("No output stream");
                    output.write(bytes);
                }
                call.resolve();
            } catch (Exception error) { call.reject("File could not be saved", "FILE_SAVE_FAILED"); }
            finally { saving.set(false); }
        });
    }
}
