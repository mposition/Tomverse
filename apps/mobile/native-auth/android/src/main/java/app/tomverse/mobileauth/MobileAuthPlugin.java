package app.tomverse.mobileauth;

import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;
import android.app.KeyguardManager;
import android.os.Build;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import java.util.concurrent.atomic.AtomicLong;

/** The serial queue is the sole owner of rotating credentials and access-token memory. */
@CapacitorPlugin(name = "MobileAuth")
public class MobileAuthPlugin extends Plugin {
    private final ExecutorService queue = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private SecureSessionStore store;
    private String origin;
    private String accessToken;
    private long expiresAt;
    private String verifier;
    private String state;
    private PluginCall pendingLogin;
    private final AtomicLong signInGeneration = new AtomicLong();
    private long pendingGeneration;
    private BiometricPrompt devicePrompt;
    private long devicePromptGeneration;
    private boolean cancelledRevocationUnconfirmed;
    private boolean lockEnabled() { return getContext().getSharedPreferences("tomverse-device-security", 0).getBoolean("enabled", false); }
    private boolean deviceAvailable() {
        KeyguardManager manager = (KeyguardManager) getContext().getSystemService(android.content.Context.KEYGUARD_SERVICE);
        return manager != null && manager.isDeviceSecure();
    }
    @PluginMethod public void getDeviceSecurity(PluginCall call) {
        queue.execute(() -> {
            try { call.resolve(new JSObject().put("available", deviceAvailable()).put("enabled", lockEnabled()).put("locked", false)); }
            catch (Exception error) { call.reject("Device security unavailable", "DEVICE_SECURITY_UNAVAILABLE"); }
        });
    }
    private void authenticateDevice(PluginCall call, long generation, Runnable success) {
        main.post(() -> {
            if (!currentSignIn(generation)) { call.reject("Sign-in cancelled", "LOGIN_CANCELLED"); return; }
            if (!deviceAvailable()) { call.reject("Configure device security first", "DEVICE_SECURITY_UNAVAILABLE"); return; }
            if (devicePrompt != null) { call.reject("Authentication already open", "DEVICE_AUTH_BUSY"); return; }
            try {
                int authenticators = Build.VERSION.SDK_INT >= 30 ? BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL : BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
                devicePromptGeneration = generation;
                devicePrompt = new BiometricPrompt(getActivity(), ContextCompat.getMainExecutor(getContext()), new BiometricPrompt.AuthenticationCallback() {
                    @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        if (devicePromptGeneration == generation) devicePrompt = null;
                        success.run();
                    }
                    @Override public void onAuthenticationError(int code, CharSequence message) { if (devicePromptGeneration == generation) devicePrompt = null; call.reject("Authentication cancelled", "DEVICE_AUTH_CANCELLED"); }
                });
                devicePrompt.authenticate(new BiometricPrompt.PromptInfo.Builder().setTitle("Tomverse").setSubtitle(call.getString("reason", "Verify your Tomverse sign-in")).setAllowedAuthenticators(authenticators).build());
            } catch (Exception error) { if (devicePromptGeneration == generation) devicePrompt = null; call.reject("Device authentication unavailable", "DEVICE_SECURITY_UNAVAILABLE"); }
        });
    }
    @PluginMethod public void setDeviceLock(PluginCall call) {
        queue.execute(() -> {
            try { if (store.read() == null) { call.reject("Sign in first", "SIGN_IN_REQUIRED"); return; } }
            catch (Exception error) { call.reject("Sign in first", "SIGN_IN_REQUIRED"); return; }
            boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled"));
            if (enabled && !deviceAvailable()) { call.reject("Configure device security first", "DEVICE_SECURITY_UNAVAILABLE"); return; }
            if (!getContext().getSharedPreferences("tomverse-device-security", 0).edit().putBoolean("enabled", enabled).commit()) { call.reject("Could not save security preference", "DEVICE_SECURITY_UNAVAILABLE"); return; }
            call.resolve();
        });
    }
    @PluginMethod public void unlockDevice(PluginCall call) {
        // Retained bridge method for compatibility; valid sessions do not relock.
        call.resolve();
    }

    /** Device proof gates fresh sign-in, never a valid session or token rotation. */
    private long nextSignIn() { synchronized (signInGeneration) { return signInGeneration.incrementAndGet(); } }
    private boolean currentSignIn(long generation) { return generation == signInGeneration.get(); }
    private void acceptSignIn(JSONObject body, long generation) throws Exception {
        synchronized (signInGeneration) {
            if (currentSignIn(generation)) { accept(body); return; }
        }
        // A cancelled in-flight exchange may have minted a family. Revoke its unused credential once.
        String secret = body.optString("refreshToken");
        if (!secret.isEmpty()) { try { post("/api/auth/mobile/logout", new JSONObject().put("refreshToken", secret)); } catch (Exception error) { cancelledRevocationUnconfirmed = true; } }
        throw new AuthFailure("LOGIN_CANCELLED");
    }
    private void runSignIn(PluginCall call, long generation, Runnable action) {
        queue.execute(() -> {
            if (!currentSignIn(generation)) { call.reject("Sign-in cancelled", "LOGIN_CANCELLED"); return; }
            if (!lockEnabled()) { action.run(); return; }
            authenticateDevice(call, generation, () -> queue.execute(() -> {
                if (!currentSignIn(generation)) { call.reject("Sign-in cancelled", "LOGIN_CANCELLED"); return; }
                action.run();
            }));
        });
    }

    @Override public void load() {
        store = new SecureSessionStore(getContext());
        origin = getConfig().getString("apiOrigin", "https://tomverse.app");
    }
    private void validateOrigin() throws Exception {
        Uri uri = Uri.parse(origin);
        if (!"https".equals(uri.getScheme()) || !Arrays.asList("tomverse.app", "dev.tomverse.app", "staging.tomverse.app").contains(uri.getHost())
            || uri.getPort() != -1 || uri.getUserInfo() != null || (uri.getPath() != null && !uri.getPath().isEmpty()) || uri.getQuery() != null || uri.getFragment() != null) throw new Exception("INVALID_API_ORIGIN");
    }
    private String random() { byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes); return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING); }
    private static class AuthFailure extends Exception {
        final String code;
        AuthFailure(String code) { super("Authentication request refused"); this.code = code; }
    }
    private String refusalCode(int status, JSONObject body) {
        if (status == 429) return "MOBILE_RATE_LIMITED";
        String code = body.optString("code");
        if (Arrays.asList("EMAIL_CODE_INVALID", "EMAIL_CODE_LOCKED", "EMAIL_ACCOUNT_NOT_FOUND", "MOBILE_LOGIN_REFUSED", "TURNSTILE_REQUIRED", "TURNSTILE_FAILED", "TURNSTILE_UNAVAILABLE", "SEND_FAILED").contains(code)) return code;
        return status == 404 || status == 503 || "INVALID_REQUEST_ORIGIN".equals(code) ? "MOBILE_LOGIN_UNAVAILABLE" : "MOBILE_LOGIN_FAILED";
    }
    private JSONObject post(String path, JSONObject body) throws Exception { return request(path, body, null); }
    private JSONObject request(String path, JSONObject body, String language) throws Exception {
        validateOrigin();
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + path).openConnection();
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(20000);
        connection.setRequestMethod(body == null ? "GET" : "POST"); connection.setRequestProperty("Content-Type", "application/json");
        if (language != null && Arrays.asList("en", "ko", "zh", "de", "fr", "es", "pt").contains(language)) connection.setRequestProperty("Accept-Language", language);
        connection.setRequestProperty("Cookie", "");
        try {
            if (body != null) { connection.setDoOutput(true); try (var output = connection.getOutputStream()) { output.write(body.toString().getBytes(StandardCharsets.UTF_8)); } }
            int status = connection.getResponseCode();
            if (status == 204) return new JSONObject();
            boolean success = status >= 200 && status < 300;
            try (var input = success ? connection.getInputStream() : connection.getErrorStream()) {
                if (input == null) throw new AuthFailure(refusalCode(status, new JSONObject()));
                ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] chunk = new byte[1024]; int count;
                while ((count = input.read(chunk)) != -1) { output.write(chunk, 0, count); if (output.size() > 16384) throw new AuthFailure(refusalCode(status, new JSONObject())); }
                byte[] bytes = output.toByteArray();
                JSONObject result;
                try { result = new JSONObject(new String(bytes, StandardCharsets.UTF_8)); }
                catch (Exception invalid) { throw new AuthFailure(refusalCode(status, new JSONObject())); }
                if (!success) throw new AuthFailure(refusalCode(status, result));
                return result;
            }
        } finally { connection.disconnect(); }
    }
    private void accept(JSONObject body) throws Exception {
        String nextAccess = body.getString("accessToken"); String nextSecret = body.getString("refreshToken");
        long ttl = body.getLong("expiresIn");
        if (nextAccess.isEmpty() || nextSecret.isEmpty() || ttl < 1 || ttl > 600) throw new Exception("INVALID_SESSION");
        store.write(nextSecret); accessToken = nextAccess; expiresAt = System.currentTimeMillis() + ttl * 1000;
    }
    private void clear() throws Exception { accessToken = null; expiresAt = 0; store.clear(); }
    @PluginMethod public void hasSession(PluginCall call) {
        queue.execute(() -> { try { call.resolve(new JSObject().put("signedIn", store.read() != null)); }
            catch (Exception e) { try { clear(); } catch (Exception ignored) {} call.resolve(new JSObject().put("signedIn", false)); } });
    }
    @PluginMethod public void getAccessToken(PluginCall call) {
        queue.execute(() -> {
            try {
                String rejected = call.getString("rejectedAccessToken");
                if (rejected != null && rejected.equals(accessToken)) { accessToken = null; expiresAt = 0; }
                if (accessToken == null || expiresAt <= System.currentTimeMillis() + 30000) {
                    String current = store.read(); if (current == null) throw new Exception("SIGN_IN_REQUIRED");
                    // Persist consumption BEFORE sending. An unknown outcome requires sign-in, never replay.
                    clear(); accept(post("/api/auth/mobile/refresh", new JSONObject().put("refreshToken", current)));
                }
                call.resolve(new JSObject().put("accessToken", accessToken).put("expiresAt", expiresAt));
            } catch (Exception e) { try { clear(); } catch (Exception ignored) {} call.reject("Sign-in required", "SIGN_IN_REQUIRED"); }
        });
    }
    @PluginMethod public void signIn(PluginCall call) {
        long generation = nextSignIn();
        queue.execute(() -> {
            try {
                if (!request("/api/auth/mobile/email", null, null).optBoolean("browserSignIn")) throw new AuthFailure("MOBILE_LOGIN_UNAVAILABLE");
                openBrowser(call, generation);
            } catch (Exception e) { call.reject("Sign-in is not available on this server", "MOBILE_LOGIN_UNAVAILABLE"); }
        });
    }
    private void openBrowser(PluginCall call, long generation) {
        main.post(() -> {
            if (!currentSignIn(generation)) { call.reject("Sign-in cancelled", "LOGIN_CANCELLED"); return; }
            if (pendingLogin != null) { call.reject("Sign-in already in progress", "LOGIN_IN_PROGRESS"); return; }
            try {
                validateOrigin(); verifier = random(); state = random(); pendingLogin = call; pendingGeneration = generation;
                String challenge = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
                Uri url = Uri.parse(origin + "/auth/mobile").buildUpon().appendQueryParameter("code_challenge", challenge).appendQueryParameter("state", state).build();
                getActivity().startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE));
                main.postDelayed(() -> { if (pendingLogin == call) { pendingLogin = null; verifier = null; state = null; call.reject("Sign-in expired", "LOGIN_EXPIRED"); } }, 180000);
            } catch (Exception e) { pendingLogin = null; verifier = null; state = null; call.reject("Could not open sign-in", "LOGIN_UNAVAILABLE"); }
        });
    }
    private void requireEmailSupport() throws Exception {
        try {
            JSONObject support = request("/api/auth/mobile/email", null, null);
            if (!support.optBoolean("ok") || !support.optBoolean("emailCode")) throw new AuthFailure("MOBILE_LOGIN_UNAVAILABLE");
        } catch (AuthFailure unsupported) { throw new AuthFailure("MOBILE_LOGIN_UNAVAILABLE"); }
    }
    @PluginMethod public void requestEmailCode(PluginCall call) {
        queue.execute(() -> {
            try {
                String email = call.getString("email");
                if (email == null || email.length() > 320) throw new AuthFailure("MOBILE_LOGIN_FAILED");
                // This read cannot send mail. An undeployed route may be caught
                // by NextAuth (400) rather than returning a conventional 404.
                requireEmailSupport();
                request("/api/auth/mobile/email", new JSONObject().put("action", "request").put("email", email), call.getString("language"));
                call.resolve();
            } catch (Exception e) { call.reject("Could not send sign-in code", e instanceof AuthFailure ? ((AuthFailure)e).code : "MOBILE_LOGIN_FAILED"); }
        });
    }
    @PluginMethod public void verifyEmailCode(PluginCall call) {
        long generation = nextSignIn();
        runSignIn(call, generation, () -> {
            try {
                String email = call.getString("email"); String code = call.getString("code");
                if (email == null || email.length() > 320 || code == null || !code.matches("[0-9]{6}")) throw new AuthFailure("EMAIL_CODE_INVALID");
                clear();
                acceptSignIn(post("/api/auth/mobile/email", new JSONObject().put("action", "verify").put("email", email).put("code", code).put("platform", "android").put("deviceLabel", android.os.Build.MODEL)), generation);
                call.resolve();
            } catch (Exception e) { try { clear(); } catch (Exception ignored) {} call.reject("Could not verify sign-in code", e instanceof AuthFailure ? ((AuthFailure)e).code : "MOBILE_LOGIN_FAILED"); }
        });
    }
    @Override protected void handleOnNewIntent(Intent intent) {
        Uri url = intent.getData();
        if (url == null || pendingLogin == null || !(origin + "/auth/mobile/callback").equals(url.buildUpon().clearQuery().fragment(null).build().toString())) return;
        Uri fragment = Uri.parse("https://callback.invalid/?" + url.getEncodedFragment());
        String returnedState = fragment.getQueryParameter("state"); String grant = fragment.getQueryParameter("grant");
        if (returnedState == null || grant == null || state == null || !MessageDigest.isEqual(state.getBytes(StandardCharsets.UTF_8), returnedState.getBytes(StandardCharsets.UTF_8))) return;
        PluginCall call = pendingLogin; String codeVerifier = verifier; long generation = pendingGeneration;
        pendingLogin = null; verifier = null; state = null;
        runSignIn(call, generation, () -> {
            try { clear(); acceptSignIn(post("/api/auth/mobile/exchange", new JSONObject().put("grant", grant).put("codeVerifier", codeVerifier).put("platform", "android").put("deviceLabel", android.os.Build.MODEL)), generation); call.resolve(); }
            catch (Exception e) { try { clear(); } catch (Exception ignored) {} call.reject("Sign-in failed. Start again.", e instanceof AuthFailure ? ((AuthFailure)e).code : "LOGIN_FAILED"); }
        });
    }
    @PluginMethod public void signOut(PluginCall call) {
        long cancelledGeneration = nextSignIn();
        main.post(() -> {
            if (devicePrompt != null && devicePromptGeneration < cancelledGeneration) { devicePrompt.cancelAuthentication(); devicePrompt = null; }
            if (pendingLogin != null && pendingGeneration < cancelledGeneration) { pendingLogin.reject("Sign-in cancelled", "LOGIN_CANCELLED"); pendingLogin = null; verifier = null; state = null; }
        });
        queue.execute(() -> {
            try { String current = store.read(); clear(); if (current != null) post("/api/auth/mobile/logout", new JSONObject().put("refreshToken", current)); if (cancelledRevocationUnconfirmed) { cancelledRevocationUnconfirmed = false; throw new Exception("LOGOUT_UNCONFIRMED"); } call.resolve(); }
            catch (Exception e) { try { clear(); } catch (Exception ignored) {} call.reject("Signed out locally; device revocation could not be confirmed", "LOGOUT_UNCONFIRMED"); }
        });
    }
}
