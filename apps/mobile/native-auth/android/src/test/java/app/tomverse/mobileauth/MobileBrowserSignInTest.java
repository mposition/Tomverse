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
        int launches;
        ActivityResultContract<?, ?> contract;
        @Override public <I, O> ActivityResultLauncher<I> registerForActivityResult(ActivityResultContract<I, O> contract, ActivityResultCallback<O> callback) {
            this.contract = contract;
            return new ActivityResultLauncher<I>() {
                @Override public void launch(I intent, ActivityOptionsCompat options) { launched = (Intent) intent; launches++; }
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
        field("browserActive", true);
        field("state", STATE); field("verifier", "v".repeat(43)); field("pendingGeneration", 0L);
        return call;
    }
    private AuthTabIntent.AuthResult result(int code, String uri) {
        Launcher launcher = new Launcher(); launcher.register(plugin);
        return (AuthTabIntent.AuthResult) launcher.contract.parseResult(code, uri == null ? null : new Intent().setData(Uri.parse(uri)));
    }
    private Call launch(Launcher launcher) throws Exception {
        field("browserLauncher", launcher.register(plugin)); field("origin", "https://tomverse.app");
        int expected = launcher.launches + 1;
        Call call = new Call(); plugin.signIn(call);
        for (int i = 0; i < 500 && launcher.launches < expected; i++) { Shadows.shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(10); }
        assertEquals(expected, launcher.launches); return call;
    }
    private String callback(Launcher launcher) {
        return CALLBACK + "#grant=" + GRANT + "&state=" + launcher.launched.getData().getQueryParameter("state");
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
    @Test public void aCancelledAuthTabNeverRetriesOrIssuesCredentials() throws Exception {
        Call call = pending(); plugin.handleBrowserResult(result(AuthTabIntent.RESULT_CANCELED, null)); call.await();
        assertEquals("LOGIN_CANCELLED", call.error);
        assertNull(field("pendingLogin")); assertNull(field("verifier"));
        assertEquals(0, plugin.exchanges); assertEquals(0, plugin.cleared);
    }
    private void awaitLaunches(Launcher launcher, int count) throws Exception {
        for (int i = 0; i < 500 && launcher.launches < count; i++) { Shadows.shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(10); }
        assertEquals(count, launcher.launches);
    }
    @Test public void verificationFailuresRetryOnlyOnceAndNeverAcceptUnverifiedCredentials() throws Exception {
        for (int code : new int[] { AuthTabIntent.RESULT_VERIFICATION_FAILED, AuthTabIntent.RESULT_VERIFICATION_TIMED_OUT }) {
            Launcher launcher = new Launcher(); Call call = launch(launcher);
            String firstState = launcher.launched.getData().getQueryParameter("state");
            String firstChallenge = launcher.launched.getData().getQueryParameter("code_challenge");
            plugin.handleBrowserResult(result(code, null)); awaitLaunches(launcher, 2);
            assertNotEquals(firstState, launcher.launched.getData().getQueryParameter("state"));
            assertNotEquals(firstChallenge, launcher.launched.getData().getQueryParameter("code_challenge"));
            assertEquals(0, plugin.exchanges);
            plugin.handleBrowserResult(result(code, null)); call.await();
            assertEquals("LOGIN_VERIFICATION_FAILED", call.error);
            assertEquals(2, launcher.launches); assertEquals(0, plugin.accepted);
            assertNull(field("pendingLogin")); assertNull(field("verifier"));
        }
    }
    @Test public void aVerifiedRetryExchangesOnceAndDoesNotInheritTheFirstTabsTimeout() throws Exception {
        Launcher launcher = new Launcher(); Call call = launch(launcher);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(120, TimeUnit.SECONDS);
        plugin.handleBrowserResult(result(AuthTabIntent.RESULT_VERIFICATION_TIMED_OUT, null)); awaitLaunches(launcher, 2);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(60, TimeUnit.SECONDS);
        assertSame(call, field("pendingLogin")); assertNull(call.error);
        plugin.handleBrowserResult(result(AuthTabIntent.RESULT_OK, callback(launcher))); call.await();
        assertNull(call.error); assertEquals(1, plugin.exchanges); assertEquals(1, plugin.accepted);
    }
    @Test public void aCancelledSignInGenerationCannotExchangeALateSuccessfulReturn() throws Exception {
        Call call = pending(); ((AtomicLong) field("signInGeneration")).incrementAndGet();
        plugin.handleBrowserResult(result(AuthTabIntent.RESULT_OK, CALLBACK + "#grant=" + GRANT + "&state=" + STATE)); call.await();
        assertEquals("LOGIN_CANCELLED", call.error); assertEquals(0, plugin.exchanges);
    }
    @Test public void anExpiredTabKeepsItsResultSlotUntilItsLateResultIsConsumed() throws Exception {
        Launcher launcher = new Launcher();
        for (int code : new int[] { AuthTabIntent.RESULT_OK, AuthTabIntent.RESULT_CANCELED, AuthTabIntent.RESULT_VERIFICATION_FAILED }) {
            Call expired = launch(launcher); String oldCallback = callback(launcher);
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(180, TimeUnit.SECONDS); expired.await();
            assertEquals("LOGIN_EXPIRED", expired.error); assertEquals(true, field("browserActive"));
            int launches = launcher.launches; int exchanges = plugin.exchanges;
            Call blocked = new Call(); plugin.signIn(blocked); blocked.await();
            assertEquals("LOGIN_IN_PROGRESS", blocked.error); assertEquals(launches, launcher.launches);
            plugin.handleBrowserResult(result(code, code == AuthTabIntent.RESULT_OK ? oldCallback : null));
            assertEquals(false, field("browserActive")); assertEquals(exchanges, plugin.exchanges);
            Call fresh = launch(launcher);
            plugin.handleBrowserResult(result(AuthTabIntent.RESULT_OK, callback(launcher))); fresh.await();
            assertNull(fresh.error); assertEquals(exchanges + 1, plugin.exchanges);
        }
    }
    @Test public void signOutKeepsTheOldTabIsolatedUntilItReturnsThenAllowsFreshSignIn() throws Exception {
        field("store", new SecureSessionStore(plugin.getContext()));
        Launcher launcher = new Launcher(); Call old = launch(launcher); String oldCallback = callback(launcher);
        Call logout = new Call(); plugin.signOut(logout); logout.await();
        Shadows.shadowOf(Looper.getMainLooper()).idle(); old.await();
        assertEquals("LOGIN_CANCELLED", old.error); assertEquals(true, field("browserActive"));
        Call blocked = new Call(); plugin.signIn(blocked); blocked.await();
        assertEquals("LOGIN_IN_PROGRESS", blocked.error); assertEquals(1, launcher.launches);
        plugin.handleBrowserResult(result(AuthTabIntent.RESULT_OK, oldCallback));
        assertEquals(0, plugin.exchanges);
        Call fresh = launch(launcher);
        plugin.handleBrowserResult(result(AuthTabIntent.RESULT_OK, callback(launcher))); fresh.await();
        assertNull(fresh.error); assertEquals(1, plugin.exchanges);
    }
    @Test public void aConcurrentBrowserRequestCannotInvalidateTheActiveAttempt() throws Exception {
        Launcher launcher = new Launcher(); Call first = launch(launcher);
        Call second = new Call(); plugin.signIn(second); second.await();
        assertEquals("LOGIN_IN_PROGRESS", second.error); assertEquals(1, launcher.launches);
        plugin.handleBrowserResult(result(AuthTabIntent.RESULT_OK, callback(launcher))); first.await();
        assertNull(first.error); assertEquals(1, plugin.exchanges);
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
