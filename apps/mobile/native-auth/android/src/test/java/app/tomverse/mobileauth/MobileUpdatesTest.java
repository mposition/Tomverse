package app.tomverse.mobileauth;

import static org.junit.Assert.*;
import android.app.Activity;
import android.content.Context;
import android.os.Looper;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContract;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.app.ActivityOptionsCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.google.android.play.core.appupdate.AppUpdateManager;
import com.google.android.play.core.appupdate.testing.FakeAppUpdateManager;
import com.google.android.play.core.install.model.InstallErrorCode;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
@LooperMode(LooperMode.Mode.PAUSED)
public class MobileUpdatesTest {
    private final Fixture plugin = new Fixture();
    private static class Fixture extends MobileUpdatesPlugin {
        final FakeAppUpdateManager fake = new FakeAppUpdateManager(RuntimeEnvironment.getApplication());
        JSObject event;
        boolean unregistered;
        @Override public Context getContext() { return RuntimeEnvironment.getApplication(); }
        @Override AppUpdateManager createManager() { return fake; }
        @Override void onMain(Runnable action) { action.run(); }
        @Override void emit(JSObject value) { event = value; }
        @Override ActivityResultLauncher<IntentSenderRequest> registerLauncher() {
            return new ActivityResultLauncher<>() {
                @Override public void launch(IntentSenderRequest request, ActivityOptionsCompat options) {}
                @Override public void unregister() { unregistered = true; }
                @Override public ActivityResultContract<IntentSenderRequest, ?> getContract() { return new ActivityResultContracts.StartIntentSenderForResult(); }
            };
        }
    }
    private static class Call extends PluginCall {
        JSObject value;
        boolean resolved;
        String error;
        Call() { super(null, "MobileUpdates", "updates-test", "check", new JSObject()); }
        @Override public void resolve(JSObject value) { this.value = value; resolved = true; }
        @Override public void resolve() { resolved = true; }
        @Override public void reject(String message, String code) { error = code; }
    }
    private void idle() { Shadows.shadowOf(Looper.getMainLooper()).idle(); }
    @Before public void setup() { plugin.load(); }
    @After public void cleanup() { plugin.handleOnDestroy(); }
    private Call check() { Call call = new Call(); plugin.check(call); idle(); return call; }
    private Call start() { Call call = new Call(); plugin.start(call); idle(); return call; }
    private void download() {
        plugin.fake.setUpdateAvailable(19);
        start(); plugin.fake.userAcceptsUpdate(); idle();
        plugin.onResult(new ActivityResult(Activity.RESULT_OK, null));
        plugin.fake.downloadStarts(); plugin.fake.downloadCompletes(); idle();
    }

    @Test public void launchChecksNeverOpenPlayConsentOrInstallAnUpdate() {
        assertEquals("none", check().value.getString("state"));
        plugin.fake.setUpdateAvailable(19);
        Call result = check();
        assertEquals("available", result.value.getString("state"));
        assertEquals(Integer.valueOf(19), result.value.getInteger("versionCode"));
        assertFalse(plugin.fake.isConfirmationDialogVisible());
        assertFalse(plugin.fake.isInstallSplashScreenVisible());
    }
    @Test public void cancellationReturnsToTheAppAndASecondAttemptUsesFreshInfo() throws Exception {
        plugin.fake.setUpdateAvailable(19);
        Call first = start(); assertTrue(plugin.fake.isConfirmationDialogVisible());
        Call concurrent = start(); assertEquals("UPDATE_BUSY", concurrent.error);
        plugin.fake.userRejectsUpdate(); plugin.onResult(new ActivityResult(Activity.RESULT_CANCELED, null));
        assertEquals(Boolean.FALSE, first.value.getBoolean("accepted"));
        Call retry = start(); assertNull(retry.error); assertTrue(plugin.fake.isConfirmationDialogVisible());
        plugin.fake.userAcceptsUpdate(); plugin.onResult(new ActivityResult(Activity.RESULT_OK, null));
        assertEquals(Boolean.TRUE, retry.value.getBoolean("accepted"));
    }
    @Test public void aDownloadedUpdateIsReportedAndOnlyExplicitCompletionInstallsIt() {
        download();
        assertEquals("downloaded", plugin.event.getString("state"));
        assertEquals("downloaded", check().value.getString("state"));
        assertFalse(plugin.fake.isInstallSplashScreenVisible());
        plugin.event = null; plugin.handleOnResume(); idle();
        assertEquals("downloaded", plugin.event.getString("state"));
        Call finish = new Call(); plugin.complete(finish); idle();
        assertTrue(finish.resolved); assertTrue(plugin.fake.isInstallSplashScreenVisible());
    }
    @Test public void anUnavailableOrUndownloadedUpdateCannotBeStartedOrCompleted() {
        assertEquals("UPDATE_UNAVAILABLE", start().error);
        Call finish = new Call(); plugin.complete(finish); idle();
        assertEquals("UPDATE_NOT_READY", finish.error); assertFalse(plugin.fake.isInstallSplashScreenVisible());
    }
    @Test public void playErrorsReturnWithoutStartingAnUpdate() {
        plugin.fake.setInstallErrorCode(InstallErrorCode.ERROR_APP_NOT_OWNED);
        assertEquals("UPDATE_UNAVAILABLE", check().error);
        assertEquals("UPDATE_UNAVAILABLE", start().error);
        assertFalse(plugin.fake.isConfirmationDialogVisible());
    }
    @Test public void aFailedPlayFlowIsNotReportedAsUserCancellation() {
        plugin.fake.setUpdateAvailable(19); Call call = start();
        plugin.onResult(new ActivityResult(com.google.android.play.core.install.model.ActivityResult.RESULT_IN_APP_UPDATE_FAILED, null));
        assertEquals("UPDATE_UNAVAILABLE", call.error); assertFalse(call.resolved);
    }
    @Test public void destroyingTheActivityCancelsAnOpenRequestAndUnregistersTheLauncher() {
        plugin.fake.setUpdateAvailable(19); Call call = start();
        plugin.handleOnDestroy(); assertEquals("UPDATE_CANCELLED", call.error); assertTrue(plugin.unregistered);
    }
}
