package app.tomverse.mobileauth;

import static org.junit.Assert.*;
import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public class MobileEmailSignupTest {
    private final Fixture plugin = new Fixture();
    private static class Fixture extends MobileAuthPlugin {
        boolean signup = true;
        int probes, accepted, posts;
        JSONObject verified;
        @Override public Context getContext() { return RuntimeEnvironment.getApplication(); }
        @Override JSONObject request(String path, JSONObject body, String language) throws Exception {
            assertEquals("/api/auth/mobile/email", path);
            if (body == null) { probes++; return new JSONObject().put("ok", true).put("emailCode", true).put("emailSignup", signup); }
            posts++; verified = body;
            return new JSONObject().put("accessToken", "synthetic-access").put("refreshToken", "native-only").put("expiresIn", 600);
        }
        @Override void accept(JSONObject body) { accepted++; }
        @Override void clear() {}
    }
    private static class Call extends PluginCall {
        final CountDownLatch done = new CountDownLatch(1);
        String error;
        Call(JSObject options) { super(null, "MobileAuth", "signup-test", "verifyEmailCode", options); }
        @Override public void resolve() { done.countDown(); }
        @Override public void reject(String message, String code) { error = code; done.countDown(); }
        void await() throws Exception { assertTrue(done.await(10, TimeUnit.SECONDS)); }
    }
    private JSObject options() { return new JSObject().put("email", "new@example.com").put("code", "123456"); }
    @After public void closeQueue() throws Exception {
        Field field = MobileAuthPlugin.class.getDeclaredField("queue"); field.setAccessible(true);
        ((ExecutorService) field.get(plugin)).shutdownNow();
    }
    @Test public void existingSignInDoesNotSendSignupIntentOrRequireANewCapability() throws Exception {
        plugin.signup = false; Call call = new Call(options()); plugin.verifyEmailCode(call); call.await();
        assertNull(call.error); assertEquals(0, plugin.probes); assertEquals(1, plugin.posts); assertEquals(1, plugin.accepted);
        assertFalse(plugin.verified.has("intent")); assertFalse(plugin.verified.has("termsAccepted"));
    }
    @Test public void explicitSignupChecksCapabilityAndKeepsTokensInsideNativeAcceptance() throws Exception {
        Call call = new Call(options().put("intent", "signup").put("termsAccepted", true));
        plugin.verifyEmailCode(call); call.await();
        assertNull(call.error); assertEquals(1, plugin.probes); assertEquals(1, plugin.posts); assertEquals(1, plugin.accepted);
        assertEquals("signup", plugin.verified.getString("intent")); assertTrue(plugin.verified.getBoolean("termsAccepted"));
        assertEquals("android", plugin.verified.getString("platform"));
    }
    @Test public void missingTermsCannotRequestSignup() throws Exception {
        Call call = new Call(options().put("intent", "signup")); plugin.verifyEmailCode(call); call.await();
        assertEquals("MOBILE_SIGNUP_TERMS_REQUIRED", call.error); assertEquals(0, plugin.probes); assertEquals(0, plugin.posts); assertEquals(0, plugin.accepted);
    }
    @Test public void falseTermsCannotRequestSignup() throws Exception {
        Call call = new Call(options().put("intent", "signup").put("termsAccepted", false)); plugin.verifyEmailCode(call); call.await();
        assertEquals("MOBILE_SIGNUP_TERMS_REQUIRED", call.error); assertEquals(0, plugin.posts); assertEquals(0, plugin.accepted);
    }
    @Test public void olderServersCannotAccidentallyReceiveSignupPayloads() throws Exception {
        plugin.signup = false; Call call = new Call(options().put("intent", "signup").put("termsAccepted", true));
        plugin.verifyEmailCode(call); call.await();
        assertEquals("MOBILE_SIGNUP_UNAVAILABLE", call.error); assertEquals(1, plugin.probes); assertEquals(0, plugin.posts); assertEquals(0, plugin.accepted);
    }
}
