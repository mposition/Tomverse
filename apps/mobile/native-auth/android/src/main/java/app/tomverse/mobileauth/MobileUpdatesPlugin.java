package app.tomverse.mobileauth;

import android.app.Activity;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.play.core.appupdate.AppUpdateInfo;
import com.google.android.play.core.appupdate.AppUpdateManager;
import com.google.android.play.core.appupdate.AppUpdateManagerFactory;
import com.google.android.play.core.appupdate.AppUpdateOptions;
import com.google.android.play.core.install.InstallStateUpdatedListener;
import com.google.android.play.core.install.model.AppUpdateType;
import com.google.android.play.core.install.model.InstallStatus;
import com.google.android.play.core.install.model.UpdateAvailability;

@CapacitorPlugin(name = "MobileUpdates")
public class MobileUpdatesPlugin extends Plugin {
    private AppUpdateManager manager;
    private ActivityResultLauncher<IntentSenderRequest> launcher;
    private PluginCall pending;
    private int version;
    private final InstallStateUpdatedListener listener = state -> emit(snapshot(state.installStatus(), false));

    @Override public void load() {
        manager = createManager();
        launcher = registerLauncher();
        manager.registerListener(listener);
    }

    AppUpdateManager createManager() { return AppUpdateManagerFactory.create(getContext()); }
    ActivityResultLauncher<IntentSenderRequest> registerLauncher() {
        return getActivity().registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), this::onResult);
    }
    void onResult(ActivityResult result) {
        if (pending == null) return;
        PluginCall call = pending; pending = null;
        if (result.getResultCode() == Activity.RESULT_OK || result.getResultCode() == Activity.RESULT_CANCELED) {
            call.resolve(new JSObject().put("accepted", result.getResultCode() == Activity.RESULT_OK));
        } else call.reject("Play update flow failed", "UPDATE_UNAVAILABLE");
    }
    void emit(JSObject value) { notifyListeners("stateChanged", value); }
    void onMain(Runnable action) { getActivity().runOnUiThread(action); }

    private JSObject snapshot(int status, boolean available) {
        String state = status == InstallStatus.DOWNLOADED ? "downloaded"
            : status == InstallStatus.PENDING || status == InstallStatus.DOWNLOADING || status == InstallStatus.INSTALLING ? "downloading"
            : available ? "available" : "none";
        return new JSObject().put("state", state).put("versionCode", version);
    }
    private JSObject snapshot(AppUpdateInfo info) {
        version = info.availableVersionCode();
        return snapshot(info.installStatus(), info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE
            && info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE));
    }

    @PluginMethod public void check(PluginCall call) {
        manager.getAppUpdateInfo().addOnSuccessListener(info -> call.resolve(snapshot(info)))
            .addOnFailureListener(error -> call.reject("Play update check unavailable", "UPDATE_UNAVAILABLE"));
    }
    @PluginMethod public void start(PluginCall call) {
        onMain(() -> {
            if (pending != null) { call.reject("Update flow already open", "UPDATE_BUSY"); return; }
            pending = call;
            // Each attempt needs fresh AppUpdateInfo; Play owns eligibility and user consent.
            manager.getAppUpdateInfo().addOnSuccessListener(info -> {
                if (pending != call) return;
                if (!snapshot(info).getString("state").equals("available")) {
                    pending = null; call.reject("No flexible update available", "UPDATE_UNAVAILABLE"); return;
                }
                try {
                    if (!manager.startUpdateFlowForResult(info, launcher, AppUpdateOptions.newBuilder(AppUpdateType.FLEXIBLE).build())) {
                        pending = null; call.reject("Could not open Play update", "UPDATE_UNAVAILABLE");
                    }
                } catch (Exception error) {
                    pending = null; call.reject("Could not open Play update", "UPDATE_UNAVAILABLE");
                }
            }).addOnFailureListener(error -> {
                if (pending == call) pending = null;
                call.reject("Play update unavailable", "UPDATE_UNAVAILABLE");
            });
        });
    }
    @PluginMethod public void complete(PluginCall call) {
        manager.getAppUpdateInfo().addOnSuccessListener(info -> {
            if (info.installStatus() != InstallStatus.DOWNLOADED) {
                call.reject("Update has not downloaded", "UPDATE_NOT_READY"); return;
            }
            manager.completeUpdate().addOnSuccessListener(ignored -> call.resolve())
                .addOnFailureListener(error -> call.reject("Could not complete update", "UPDATE_UNAVAILABLE"));
        }).addOnFailureListener(error -> call.reject("Play update unavailable", "UPDATE_UNAVAILABLE"));
    }
    @Override protected void handleOnResume() {
        if (manager != null) manager.getAppUpdateInfo().addOnSuccessListener(info -> emit(snapshot(info)));
    }
    @Override protected void handleOnDestroy() {
        if (manager != null) manager.unregisterListener(listener);
        if (launcher != null) launcher.unregister();
        if (pending != null) { pending.reject("Activity closed", "UPDATE_CANCELLED"); pending = null; }
    }
}
