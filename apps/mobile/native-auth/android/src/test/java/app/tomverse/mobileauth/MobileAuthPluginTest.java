package app.tomverse.mobileauth;

import static org.junit.Assert.*;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;

/** Execute the actual plugin queue/validation/rotation with isolated store and HTTP ports. */
public class MobileAuthPluginTest {
    private final Fixture plugin = new Fixture();

    private static class Fixture extends MobileAuthPlugin {
        String credential = "existing-native-session";
        boolean readFails, requestFails, clearFails;
        int clears, requests;
        @Override boolean enabled() { return true; }
        @Override String stored() throws Exception {
            if (readFails) throw new Exception("Store locked");
            return credential;
        }
        @Override boolean clear() {
            clears++;
            if (clearFails) return false;
            credential = null; return true;
        }
        @Override void save(String next) { credential = next; }
        @Override JSONObject post(String path, JSONObject body) throws Exception {
            requests++;
            if (requestFails) throw new Exception("Unknown remote outcome");
            return new JSONObject().put("accessToken", "short-lived-access")
                .put("refreshToken", "next-native-session").put("expiresIn", 600);
        }
    }

    private static class Call extends PluginCall {
        final CountDownLatch done = new CountDownLatch(1);
        JSObject response;
        boolean rejected;
        Call(JSObject data) { super(null, "MobileAuth", "test", "test", data); }
        Call() { this(new JSObject()); }
        @Override public void resolve() { done.countDown(); }
        @Override public void resolve(JSObject result) { response = result; done.countDown(); }
        @Override public void reject(String message, String code) { rejected = true; done.countDown(); }
        void await() throws Exception { assertTrue("Plugin call did not settle", done.await(5, TimeUnit.SECONDS)); }
    }

    private void setField(String name, Object value) throws Exception {
        Field field = MobileAuthPlugin.class.getDeclaredField(name); field.setAccessible(true); field.set(plugin, value);
    }
    private void proof() throws Exception {
        setField("verifier", "a".repeat(43));
        setField("verifierExpiresAt", System.currentTimeMillis() + 60_000);
    }
    @After public void closeQueue() throws Exception {
        Field field = MobileAuthPlugin.class.getDeclaredField("queue"); field.setAccessible(true);
        ((ExecutorService) field.get(plugin)).shutdownNow();
    }

    @Test public void beginningAnotherConnectionPreservesExistingSession() throws Exception {
        Call call = new Call(); plugin.beginSignIn(call); call.await();
        assertTrue(call.rejected); assertEquals("existing-native-session", plugin.credential);
        assertEquals(0, plugin.clears); assertEquals(0, plugin.requests);
    }
    @Test public void invalidPairingCannotDeleteOrReplaceAnExistingSession() throws Exception {
        proof();
        Call call = new Call(new JSObject().put("grant", "some-code"));
        plugin.completeSignIn(call); call.await();
        assertTrue(call.rejected); assertEquals("existing-native-session", plugin.credential);
        assertEquals(0, plugin.clears); assertEquals(0, plugin.requests);
    }
    @Test public void aLockedStoreCanBeRetriedWithoutLosingItsSession() throws Exception {
        plugin.readFails = true;
        Call session = new Call(); plugin.hasSession(session); session.await();
        assertTrue(session.rejected); assertNull(session.response);
        Call token = new Call(); plugin.getAccessToken(token); token.await(); assertTrue(token.rejected);
        assertEquals("existing-native-session", plugin.credential); assertEquals(0, plugin.clears);
        plugin.readFails = false;
        Call retry = new Call(); plugin.hasSession(retry); retry.await();
        assertTrue(retry.response.getBoolean("signedIn")); assertEquals(0, plugin.requests);
    }
    @Test public void failedLocalConsumptionNeverStartsRotation() throws Exception {
        plugin.clearFails = true;
        Call call = new Call(); plugin.getAccessToken(call); call.await();
        assertTrue(call.rejected); assertEquals(0, plugin.requests);
        assertEquals("existing-native-session", plugin.credential);
    }
    @Test public void unknownRotationOutcomeIsNotRetainedOrReplayed() throws Exception {
        plugin.requestFails = true;
        Call call = new Call(); plugin.getAccessToken(call); call.await();
        assertTrue(call.rejected); assertNull(plugin.credential); assertEquals(1, plugin.requests);
        Call retry = new Call(); plugin.getAccessToken(retry); retry.await();
        assertTrue(retry.rejected); assertEquals(1, plugin.requests);
    }
    @Test public void unknownExchangeOutcomeConsumesTheProofOnce() throws Exception {
        plugin.credential = null; plugin.requestFails = true; proof();
        Call call = new Call(new JSObject().put("grant", "one-time-code"));
        plugin.completeSignIn(call); call.await(); assertTrue(call.rejected);
        Call retry = new Call(new JSObject().put("grant", "one-time-code"));
        plugin.completeSignIn(retry); retry.await();
        assertTrue(retry.rejected); assertEquals(1, plugin.requests); assertNull(plugin.credential);
    }
    @Test public void successfulRotationReturnsOnlyTheShortLivedAccessGrant() throws Exception {
        Call call = new Call(); plugin.getAccessToken(call); call.await();
        assertFalse(call.rejected); assertEquals("next-native-session", plugin.credential);
        assertEquals("short-lived-access", call.response.getString("accessToken"));
        assertEquals(2, call.response.length()); assertFalse(call.response.has("refreshToken"));
    }
}
