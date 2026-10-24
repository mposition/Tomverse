package app.tomverse.shell;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.test.platform.app.InstrumentationRegistry;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import app.tomverse.mobileauth.MobileAuthPlugin;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLStreamHandler;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import org.junit.After;
import org.junit.Before;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real Android Keystore and plugin queue, with all network traffic replaced in this test process. */
@RunWith(AndroidJUnit4.class)
public class DeviceSignInTest {
    private static int refreshes;
    private static int verifications;
    private static int exchanges;
    private static int revocations;
    private static volatile boolean failRevocation;
    private static volatile CountDownLatch verificationEntered;
    private static volatile CountDownLatch verificationRelease;
    private final List<TestPlugin> plugins = new ArrayList<>();
    private Context context;

    @BeforeClass public static void isolateNetwork() {
        URL.setURLStreamHandlerFactory(protocol -> "https".equals(protocol) ? new URLStreamHandler() {
            @Override protected HttpURLConnection openConnection(URL url) {
                if (!"tomverse.app".equals(url.getHost()) || !List.of("/api/auth/mobile/refresh", "/api/auth/mobile/email", "/api/auth/mobile/exchange", "/api/auth/mobile/logout").contains(url.getPath())) {
                    throw new AssertionError("External requests are forbidden in the native fixture");
                }
                return new HttpURLConnection(url) {
                    private final ByteArrayOutputStream body = new ByteArrayOutputStream();
                    @Override public void connect() {}
                    @Override public void disconnect() {}
                    @Override public boolean usingProxy() { return false; }
                    @Override public OutputStream getOutputStream() { return body; }
                    @Override public int getResponseCode() { if (url.getPath().endsWith("logout")) { revocations++; return failRevocation ? 503 : 204; } return 200; }
                    @Override public InputStream getInputStream() {
                        if (url.getPath().endsWith("refresh")) refreshes++;
                        else if (url.getPath().endsWith("exchange")) exchanges++;
                        else {
                            verifications++;
                            if (verificationEntered != null) {
                                verificationEntered.countDown();
                                try { if (!verificationRelease.await(5, TimeUnit.SECONDS)) throw new AssertionError("Fixture release timed out"); }
                                catch (InterruptedException error) { throw new AssertionError(error); }
                            }
                        }
                        return new ByteArrayInputStream(("{\"accessToken\":\"synthetic-access\",\"refreshToken\":\"synthetic-rotation-" + refreshes + "\",\"expiresIn\":600}").getBytes(java.nio.charset.StandardCharsets.UTF_8));
                    }
                };
            }
        } : null);
    }

    @Before public void prepare() {
        Context target = ApplicationProvider.getApplicationContext();
        context = new ContextWrapper(target) {
            @Override public SharedPreferences getSharedPreferences(String name, int mode) {
                return super.getSharedPreferences("device-sign-in-test-" + name, mode);
            }
        };
        context.getSharedPreferences("tomverse-device-security", 0).edit().clear().commit();
        context.getSharedPreferences("tomverse.mobile.session.v1", 0).edit().clear().commit();
        refreshes = 0; verifications = 0; exchanges = 0; revocations = 0; failRevocation = false; verificationEntered = null; verificationRelease = null;
    }

    @After public void finish() throws Exception {
        for (TestPlugin plugin : plugins) ((ExecutorService) field("queue").get(plugin)).shutdownNow();
        context.getSharedPreferences("tomverse-device-security", 0).edit().clear().commit();
        context.getSharedPreferences("tomverse.mobile.session.v1", 0).edit().clear().commit();
    }

    private static Field field(String name) throws Exception {
        Field value = MobileAuthPlugin.class.getDeclaredField(name); value.setAccessible(true); return value;
    }
    private TestPlugin plugin() throws Exception {
        TestPlugin plugin = new TestPlugin(context);
        Class<?> type = Class.forName("app.tomverse.mobileauth.SecureSessionStore");
        Constructor<?> constructor = type.getDeclaredConstructor(Context.class); constructor.setAccessible(true);
        field("store").set(plugin, constructor.newInstance(context)); field("origin").set(plugin, "https://tomverse.app");
        plugins.add(plugin); return plugin;
    }
    private void seed(TestPlugin plugin) throws Exception {
        Object store = field("store").get(plugin);
        Method write = store.getClass().getDeclaredMethod("write", String.class); write.setAccessible(true);
        write.invoke(store, "synthetic-only-refresh");
    }
    private static class TestPlugin extends MobileAuthPlugin {
        private final Context context;
        TestPlugin(Context context) { this.context = context; }
        @Override public Context getContext() { return context; }
        void callback(Intent intent) { handleOnNewIntent(intent); }
        void background() { handleOnPause(); }
        void resume() { handleOnResume(); }
    }
    private static class Call extends PluginCall {
        private final CountDownLatch completed = new CountDownLatch(1);
        JSObject result; String code;
        Call(JSObject data) { super(null, "MobileAuth", "test", "test", data); }
        @Override public void resolve(JSObject data) { result = data; completed.countDown(); }
        @Override public void resolve() { completed.countDown(); }
        @Override public void reject(String message, String errorCode, Exception exception, JSObject data) { code = errorCode; completed.countDown(); }
        Call waitForResult() throws Exception { assertTrue("Native callback timed out", completed.await(5, TimeUnit.SECONDS)); return this; }
    }

    @Test public void aLatePkceCallbackCannotResurrectTheSessionAfterSignOut() throws Exception {
        TestPlugin plugin = plugin(); Call login = new Call(new JSObject()); Call logout = new Call(new JSObject());
        field("pendingLogin").set(plugin, login); field("state").set(plugin, "fixture-state"); field("verifier").set(plugin, "fixture-verifier"); field("pendingGeneration").setLong(plugin, 0);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            plugin.signOut(logout);
            plugin.callback(new Intent(Intent.ACTION_VIEW, Uri.parse("https://tomverse.app/auth/mobile/callback#state=fixture-state&grant=fixture-grant")));
        });
        logout.waitForResult(); login.waitForResult();
        assertNull(logout.code); assertEquals("LOGIN_CANCELLED", login.code); assertEquals(0, exchanges);
        Call session = new Call(new JSObject()); plugin.hasSession(session); session.waitForResult(); assertFalse(session.result.getBool("signedIn"));
    }

    @Test public void signOutDuringEmailVerificationDiscardsAndRevokesTheUnusedSession() throws Exception {
        cancelledVerification(false);
    }
    @Test public void failedRevocationOfAnInflightLoginIsReportedAsUnconfirmedLogout() throws Exception {
        cancelledVerification(true);
    }
    private void cancelledVerification(boolean refuseLogout) throws Exception {
        TestPlugin plugin = plugin(); verificationEntered = new CountDownLatch(1); verificationRelease = new CountDownLatch(1); failRevocation = refuseLogout;
        Call login = new Call(new JSObject().put("email", "fixture@example.invalid").put("code", "123456"));
        plugin.verifyEmailCode(login); assertTrue(verificationEntered.await(5, TimeUnit.SECONDS));
        Call logout = new Call(new JSObject()); plugin.signOut(logout); verificationRelease.countDown();
        login.waitForResult(); logout.waitForResult();
        assertEquals("LOGIN_CANCELLED", login.code); assertEquals(refuseLogout ? "LOGOUT_UNCONFIRMED" : null, logout.code); assertEquals(1, revocations);
        Call session = new Call(new JSObject()); plugin.hasSession(session); session.waitForResult(); assertFalse(session.result.getBool("signedIn"));
    }

    @Test public void validSessionRestoresAcrossColdStartAndBackgroundWithoutDeviceProof() throws Exception {
        context.getSharedPreferences("tomverse-device-security", 0).edit().putBoolean("enabled", true).commit();
        TestPlugin first = plugin(); seed(first);
        Call token = new Call(new JSObject()); first.getAccessToken(token); token.waitForResult();
        assertNull(token.code); assertEquals("synthetic-access", token.result.getString("accessToken")); assertEquals(1, refreshes);
        first.background(); Thread.sleep(31_000); first.resume();
        Call resumed = new Call(new JSObject()); first.getAccessToken(resumed); resumed.waitForResult();
        assertNull(resumed.code); assertEquals(1, refreshes);
        TestPlugin restarted = plugin();
        Call restored = new Call(new JSObject()); restarted.getAccessToken(restored); restored.waitForResult();
        assertNull(restored.code); assertEquals(2, refreshes);
        Call security = new Call(new JSObject()); restarted.getDeviceSecurity(security); security.waitForResult();
        assertTrue(security.result.getBool("enabled")); assertFalse(security.result.getBool("locked"));
    }

    @Test public void enabledDeviceProofRefusesFreshSignInBeforeConsumingTheEmailCode() throws Exception {
        context.getSharedPreferences("tomverse-device-security", 0).edit().putBoolean("enabled", true).commit();
        TestPlugin plugin = plugin();
        // No attached Activity can present device proof. Fresh verification must refuse, never bypass it.
        Call call = new Call(new JSObject().put("email", "fixture@example.invalid").put("code", "123456"));
        plugin.verifyEmailCode(call); call.waitForResult();
        assertEquals("DEVICE_SECURITY_UNAVAILABLE", call.code); assertEquals(0, verifications);
    }

    @Test public void disabledDeviceProofAllowsFreshSignInButMissingSessionStillRequiresLogin() throws Exception {
        TestPlugin plugin = plugin();
        Call absent = new Call(new JSObject()); plugin.getAccessToken(absent); absent.waitForResult();
        assertEquals("SIGN_IN_REQUIRED", absent.code); assertEquals(0, refreshes);
        Call call = new Call(new JSObject().put("email", "fixture@example.invalid").put("code", "123456"));
        plugin.verifyEmailCode(call); call.waitForResult(); assertNull(call.code); assertEquals(1, verifications);
        Call session = new Call(new JSObject()); plugin.hasSession(session); session.waitForResult(); assertTrue(session.result.getBool("signedIn"));
    }
}
