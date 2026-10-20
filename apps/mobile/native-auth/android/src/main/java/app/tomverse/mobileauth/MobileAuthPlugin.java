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
    private JSONObject post(String path, JSONObject body) throws Exception {
        validateOrigin();
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + path).openConnection();
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(20000);
        connection.setRequestMethod("POST"); connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("Cookie", "");
        try {
            try (var output = connection.getOutputStream()) { output.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new Exception("AUTH_REQUEST_REFUSED");
            if (status == 204) return new JSONObject();
            try (var input = connection.getInputStream()) {
                ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] chunk = new byte[1024]; int count;
                while ((count = input.read(chunk)) != -1) { output.write(chunk, 0, count); if (output.size() > 16384) throw new Exception("AUTH_RESPONSE_TOO_LARGE"); }
                byte[] bytes = output.toByteArray();
                return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
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
        main.post(() -> {
            if (pendingLogin != null) { call.reject("Sign-in already in progress", "LOGIN_IN_PROGRESS"); return; }
            try {
                validateOrigin(); verifier = random(); state = random(); pendingLogin = call;
                String challenge = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
                Uri url = Uri.parse(origin + "/auth/mobile").buildUpon().appendQueryParameter("code_challenge", challenge).appendQueryParameter("state", state).build();
                getActivity().startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE));
                main.postDelayed(() -> { if (pendingLogin == call) { pendingLogin = null; verifier = null; state = null; call.reject("Sign-in expired", "LOGIN_EXPIRED"); } }, 180000);
            } catch (Exception e) { pendingLogin = null; verifier = null; state = null; call.reject("Could not open sign-in", "LOGIN_UNAVAILABLE"); }
        });
    }
    @Override protected void handleOnNewIntent(Intent intent) {
        Uri url = intent.getData();
        if (url == null || pendingLogin == null || !(origin + "/auth/mobile/callback").equals(url.buildUpon().clearQuery().fragment(null).build().toString())) return;
        Uri fragment = Uri.parse("https://callback.invalid/?" + url.getEncodedFragment());
        String returnedState = fragment.getQueryParameter("state"); String grant = fragment.getQueryParameter("grant");
        if (returnedState == null || grant == null || state == null || !MessageDigest.isEqual(state.getBytes(StandardCharsets.UTF_8), returnedState.getBytes(StandardCharsets.UTF_8))) return;
        PluginCall call = pendingLogin; String codeVerifier = verifier;
        pendingLogin = null; verifier = null; state = null;
        queue.execute(() -> {
            try { clear(); accept(post("/api/auth/mobile/exchange", new JSONObject().put("grant", grant).put("codeVerifier", codeVerifier).put("platform", "android").put("deviceLabel", android.os.Build.MODEL))); call.resolve(); }
            catch (Exception e) { try { clear(); } catch (Exception ignored) {} call.reject("Sign-in failed. Start again.", "LOGIN_FAILED"); }
        });
    }
    @PluginMethod public void signOut(PluginCall call) {
        main.post(() -> { if (pendingLogin != null) { pendingLogin.reject("Sign-in cancelled", "LOGIN_CANCELLED"); pendingLogin = null; verifier = null; state = null; } });
        queue.execute(() -> {
            try { String current = store.read(); clear(); if (current != null) post("/api/auth/mobile/logout", new JSONObject().put("refreshToken", current)); call.resolve(); }
            catch (Exception e) { try { clear(); } catch (Exception ignored) {} call.reject("Signed out locally; device revocation could not be confirmed", "LOGOUT_UNCONFIRMED"); }
        });
    }
}
