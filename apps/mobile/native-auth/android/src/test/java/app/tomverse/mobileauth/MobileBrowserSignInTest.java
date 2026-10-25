package app.tomverse.mobileauth;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Looper;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.ActivityResultCaller;
import androidx.activity.result.ActivityResultCallback;
import androidx.activity.result.ActivityResultRegistry;
import androidx.activity.result.contract.ActivityResultContract;
import androidx.browser.auth.AuthTabIntent;
import androidx.core.app.ActivityOptionsCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONObject;
import org.junit.After;
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
public class MobileBrowserSignInTest {
    private static final String STATE = "s".repeat(43);
    private static final String GRANT = "g".repeat(43);
    private static final String CALLBACK = "https://tomverse.app/auth/mobile/callback";
    private final Fixture plugin = new Fixture();

    private static class Fixture extends MobileAuthPlugin {
        String browser = "synthetic.browser";
        int exchanges, accepted, cleared;
        JSONObject exchange;
        @Override public Context getContext() { return RuntimeEnvironment.getApplication(); }
        @Override String browserPackage() { return browser; }
        @Override JSONObject request(String path, JSONObject body, String language) throws Exception {
            if (path.equals("/api/auth/mobile/email") && body == null) return new JSONObject().put("browserSignIn", true);
            assertEquals("/api/auth/mobile/exchange", path);
            exchanges++; exchange = body;
            return new JSONObject().put("accessToken", "synthetic-access").put("refreshToken", "native-only").put("expiresIn", 600);
        }
        @Override void accept(JSONObject body) { accepted++; }
        @Override void clear() { cleared++; }
        void unsolicitedIntent(Intent intent) { super.handleOnNewIntent(intent); }
    }
    private static class Call extends PluginCall {
        final CountDownLatch done = new CountDownLatch(1);
        String error;
        Call() { super(null, "MobileAuth", "browser-test", "signIn", new JSObject()); }
        @Override public void resolve() { done.countDown(); }
        @Override public void reject(String message, String code) { error = code; done.countDown(); }
        void await() throws Exception { assertTrue(done.await(5, TimeUnit.SECONDS)); }
    }
    private static class Launcher implements ActivityResultCaller {
        Intent launched;
        ActivityResultContract<?, ?> contract;
        @Override public <I, O> ActivityResultLauncher<I> registerForActivityResult(ActivityResultContract<I, O> contract, ActivityResultCallback<O> callback) {
            this.contract = contract;
            return new ActivityResultLauncher<I>() {
                @Override public void launch(I intent, ActivityOptionsCompat options) { launched = (Intent) intent; }
                @Override public void unregister() {}
                @Override public ActivityResultContract<I, ?> getContract() { return contract; }
            };
        }
        @Override public <I, O> ActivityResultLauncher<I> registerForActivityResult(ActivityResultContract<I, O> contract, ActivityResultRegistry registry, ActivityResultCallback<O> callback) {
            return registerForActivityResult(contract, callback);
        }
        ActivityResultLauncher<Intent> register(MobileAuthPlugin plugin) { return AuthTabIntent.registerActivityResultLauncher(this, plugin::handleBrowserResult); }
    }
    private void field(String name, Object value) throws Exception {
        Field field = MobileAuthPlugin.class.getDeclaredField(name); field.setAccessible(true); field.set(plugin, value);
    }
    private Object field(String name) throws Exception {
        Field field = MobileAuthPlugin.class.getDeclaredField(name); field.setAccessible(true); return field.get(plugin);
    }
    private Call pending() throws Exception {
        Call call = new Call(); field("origin", "https://tomverse.app"); field("pendingLogin", call);
        field("state", STATE); field("verifier", "v".repeat(43)); field("pendingGeneration", 0L);
        return call;
    }
    private AuthTabIntent.AuthResult result(int code, String uri) {
        Launcher launcher = new Launcher(); launcher.register(plugin);
        return (AuthTabIntent.AuthResult) launcher.contract.parseResult(code, uri == null ? null : new Intent().setData(Uri.parse(uri)));
    }
    @After public void closeQueue() throws Exception { ((ExecutorService) field("queue")).shutdownNow(); }

    @Test public void opensAnHttpsAuthTabWithTheExistingWebLoginRequest() throws Exception {
        Launcher launcher = new Launcher(); field("browserLauncher", launcher.register(plugin)); field("origin", "https://tomverse.app");
        Call call = new Call(); plugin.signIn(call);
        for (int i = 0; i < 500 && launcher.launched == null; i++) { Shadows.shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(10); }
        assertNotNull(launcher.launched);
        assertEquals("synthetic.browser", launcher.launched.getPackage());
        assertEquals("/auth/mobile", launcher.launched.getData().getPath());
        assertEquals("https", launcher.launched.getData().getScheme());
        assertEquals(43, launcher.launched.getData().getQueryParameter("code_challenge").length());
        assertEquals(43, launcher.launched.getData().getQueryParameter("state").length());
        assertEquals("tomverse.app", launcher.launched.getStringExtra(AuthTabIntent.EXTRA_HTTPS_REDIRECT_HOST));
        assertEquals("/auth/mobile/callback", launcher.launched.getStringExtra(AuthTabIntent.EXTRA_HTTPS_REDIRECT_PATH));
        assertTrue(launcher.launched.getBooleanExtra(AuthTabIntent.EXTRA_LAUNCH_AUTH_TAB, false));
        assertEquals(0, plugin.exchanges);
    }
    @Test public void completedAuthTabExchangesTheGrantExactlyOnceAndResolvesOnlyAfterNativeStorage() throws Exception {
        Call call = pending();
        var result = result(AuthTabIntent.RESULT_OK, CALLBACK + "#grant=" + GRANT + "&state=" + STATE);
        plugin.handleBrowserResult(result); plugin.handleBrowserResult(result); call.await();
        assertNull(call.error); assertEquals(1, plugin.exchanges); assertEquals(1, plugin.accepted);
        assertEquals(GRANT, plugin.exchange.getString("grant"));
        assertEquals("v".repeat(43), plugin.exchange.getString("codeVerifier"));
        assertNull(field("pendingLogin")); assertNull(field("verifier")); assertNull(field("state"));
    }
    @Test public void malformedOrUnrelatedReturnsNeverExchangeOrClearExistingCredentials() throws Exception {
        for (String uri : new String[] {
            "https://evil.test/auth/mobile/callback#grant=" + GRANT + "&state=" + STATE,
            CALLBACK + "/extra#grant=" + GRANT + "&state=" + STATE,
            CALLBACK + "?grant=leak#grant=" + GRANT + "&state=" + STATE,
            CALLBACK + "#grant=" + GRANT + "&state=" + "x".repeat(43),
            CALLBACK + "#grant=" + GRANT + "&state=" + STATE + "&grant=" + GRANT,
            CALLBACK + "#grant=invalid&state=" + STATE,
        }) {
            Call call = pending(); plugin.handleBrowserResult(result(AuthTabIntent.RESULT_OK, uri)); call.await();
            assertEquals("LOGIN_FAILED", call.error); assertNull(field("verifier"));
        }
        assertEquals(0, plugin.exchanges); assertEquals(0, plugin.cleared);
    }
    @Test public void cancelledAndUnverifiedAuthTabsRejectWithoutIssuingCredentials() throws Exception {
        for (int code : new int[] { AuthTabIntent.RESULT_CANCELED, AuthTabIntent.RESULT_VERIFICATION_FAILED, AuthTabIntent.RESULT_VERIFICATION_TIMED_OUT }) {
            Call call = pending(); plugin.handleBrowserResult(result(code, null)); call.await();
            assertEquals(code == AuthTabIntent.RESULT_CANCELED ? "LOGIN_CANCELLED" : "LOGIN_VERIFICATION_FAILED", call.error);
            assertNull(field("pendingLogin")); assertNull(field("verifier"));
        }
        assertEquals(0, plugin.exchanges); assertEquals(0, plugin.cleared);
    }
    @Test public void aCancelledSignInGenerationCannotExchangeALateSuccessfulReturn() throws Exception {
        Call call = pending(); ((AtomicLong) field("signInGeneration")).incrementAndGet();
        plugin.handleBrowserResult(result(AuthTabIntent.RESULT_OK, CALLBACK + "#grant=" + GRANT + "&state=" + STATE)); call.await();
        assertEquals("LOGIN_CANCELLED", call.error); assertEquals(0, plugin.exchanges);
    }
    @Test public void unsolicitedAppLinkIntentsCannotCompleteAuthTabSignIn() throws Exception {
        pending(); plugin.unsolicitedIntent(new Intent().setData(Uri.parse(CALLBACK + "#grant=" + GRANT + "&state=" + STATE)));
        assertEquals(0, plugin.exchanges); assertNotNull(field("pendingLogin"));
    }
    @Test public void anUnsupportedBrowserDoesNotFallBackToAnUnmanagedBrowserWindow() throws Exception {
        field("origin", "https://tomverse.app"); plugin.browser = null;
        Launcher launcher = new Launcher(); field("browserLauncher", launcher.register(plugin)); Call call = new Call(); plugin.signIn(call);
        for (int i = 0; i < 500 && call.done.getCount() != 0; i++) { Shadows.shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(10); }
        call.await(); assertEquals("LOGIN_UNAVAILABLE", call.error); assertNull(launcher.launched);
        assertNull(field("pendingLogin")); assertEquals(0, plugin.exchanges);
    }
}
