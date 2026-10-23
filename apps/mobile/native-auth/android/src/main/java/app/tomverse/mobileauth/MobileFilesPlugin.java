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

/** File writes require the user's system document picker; no path is accepted. */
@CapacitorPlugin(name = "MobileFiles")
public class MobileFilesPlugin extends Plugin {
    private final AtomicBoolean saving = new AtomicBoolean(false);
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
