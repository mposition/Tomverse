package app.tomverse.mobileauth;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** All state and all credential mutations run on one native serial queue. */
@CapacitorPlugin(name = "MobileAuth")
public class MobileAuthPlugin extends Plugin {
    private static final String KEY_ALIAS = "tomverse.mobile.auth.v1";
    private final ExecutorService queue = Executors.newSingleThreadExecutor();
    private String accessToken;
    private long expiresAt;
    private String verifier;
    private long verifierExpiresAt;

    boolean enabled() { return getConfig().getBoolean("enabled", false); }

    private String origin() throws Exception {
        URI uri = new URI(getConfig().getString("apiOrigin", "https://tomverse.app"));
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null ||
            uri.getQuery() != null || uri.getFragment() != null ||
            !(uri.getPath().isEmpty() || "/".equals(uri.getPath()))) throw new Exception("Invalid origin");
        return "https://" + uri.getRawAuthority();
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences("tomverse_mobile_auth", Context.MODE_PRIVATE);
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(KEY_ALIAS, null);
    }

    void save(String credential) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] data = new JSONObject().put("origin", origin()).put("credential", credential)
            .toString().getBytes(StandardCharsets.UTF_8);
        String value = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." +
            Base64.encodeToString(cipher.doFinal(data), Base64.NO_WRAP);
        if (!preferences().edit().putString("sealed", value).commit()) throw new Exception("Store failed");
    }

    String stored() throws Exception {
        String value = preferences().getString("sealed", null);
        if (value == null) return null;
        String[] parts = value.split("\\.", 2);
        if (parts.length != 2) throw new Exception("Invalid store");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
        JSONObject data = new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
        if (!origin().equals(data.getString("origin"))) throw new Exception("Origin changed");
        return data.getString("credential");
    }

    boolean clear() {
        accessToken = null; expiresAt = 0; verifier = null; verifierExpiresAt = 0;
        // Either deleting the record or destroying its key makes it unusable.
        boolean removed = preferences().edit().remove("sealed").commit();
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
            store.deleteEntry(KEY_ALIAS);
            return true;
        } catch (Exception ignored) { return removed; }
    }

    JSONObject post(String path, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(origin() + path).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10_000); connection.setReadTimeout(15_000);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Connection", "close");
            connection.setDoOutput(true);
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (var output = connection.getOutputStream()) { output.write(bytes); }
            int status = connection.getResponseCode();
            if (status == 204) return new JSONObject();
            if (status != 200) throw new Exception("Request refused");
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[2048];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > 32_768) throw new Exception("Response too large");
                    output.write(buffer, 0, count);
                }
                return new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8));
            }
        } finally { connection.disconnect(); }
    }

    private void accept(JSONObject tokens) throws Exception {
        String nextAccess = tokens.getString("accessToken");
        String nextRefresh = tokens.getString("refreshToken");
        int seconds = tokens.getInt("expiresIn");
        if (nextAccess.isEmpty() || nextAccess.length() > 16_384 || nextRefresh.isEmpty() ||
            nextRefresh.length() > 512 || seconds < 1 || seconds > 600) throw new Exception("Invalid session");
        save(nextRefresh);
        accessToken = nextAccess; expiresAt = System.currentTimeMillis() + seconds * 1000L;
    }

    private interface Work { void run() throws Exception; }
    private void perform(PluginCall call, Work work) {
        queue.execute(() -> {
            try {
                if (!enabled()) throw new Exception("Disabled");
                work.run();
            } catch (Exception ignored) {
                // Validation and read failures must preserve the existing session.
                call.reject("Mobile session unavailable. Connect your account again.", "MOBILE_AUTH_UNAVAILABLE");
            }
        });
    }

    private void mutateSession(String path, JSONObject body) throws Exception {
        try { accept(post(path, body)); }
        catch (Exception failure) {
            // A single-use mutation may have completed. Never retain/replay it.
            clear(); throw failure;
        }
    }

    @PluginMethod public void beginSignIn(PluginCall call) {
        perform(call, () -> {
            if (stored() != null) throw new Exception("Already signed in");
            byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes);
            verifier = Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
            verifierExpiresAt = System.currentTimeMillis() + 10 * 60_000L;
            String challenge = Base64.encodeToString(MessageDigest.getInstance("SHA-256")
                .digest(verifier.getBytes(StandardCharsets.US_ASCII)), Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
            call.resolve(new JSObject().put("url", origin() + "/mobile/connect?codeChallenge=" + challenge));
        });
    }

    @PluginMethod public void completeSignIn(PluginCall call) {
        perform(call, () -> {
            if (stored() != null) throw new Exception("Already signed in");
            String grant = call.getString("grant");
            if (grant == null || grant.isEmpty() || grant.length() > 512 || verifier == null ||
                verifierExpiresAt <= System.currentTimeMillis()) throw new Exception("Invalid pairing");
            String proof = verifier; verifier = null; verifierExpiresAt = 0;
            mutateSession("/api/auth/mobile/exchange", new JSONObject().put("grant", grant)
                .put("codeVerifier", proof).put("platform", "android").put("deviceLabel", "Android"));
            call.resolve();
        });
    }

    @PluginMethod public void getAccessToken(PluginCall call) {
        perform(call, () -> {
            if (accessToken == null || expiresAt <= System.currentTimeMillis() + 5_000) {
                String credential = stored();
                if (credential == null) throw new Exception("No session");
                // Consume local state before the remote single-use write, including crash recovery.
                if (!clear()) throw new Exception("Could not consume local session");
                mutateSession("/api/auth/mobile/refresh", new JSONObject().put("refreshToken", credential));
            }
            call.resolve(new JSObject().put("accessToken", accessToken).put("expiresAt", expiresAt));
        });
    }

    @PluginMethod public void hasSession(PluginCall call) {
        queue.execute(() -> {
            try { call.resolve(new JSObject().put("signedIn", enabled() && stored() != null)); }
            catch (Exception ignored) {
                // Let the UI retry without offering to replace a locked session.
                call.reject("Could not read the device session. Try again.", "MOBILE_AUTH_UNAVAILABLE");
            }
        });
    }

    @PluginMethod public void signOut(PluginCall call) {
        queue.execute(() -> {
            String credential = null;
            try { credential = stored(); } catch (Exception ignored) {}
            boolean cleared = clear();
            try { if (enabled() && credential != null) post("/api/auth/mobile/logout", new JSONObject().put("refreshToken", credential)); }
            catch (Exception ignored) { /* Local sign-out is complete; do not retry an unknown mutation. */ }
            if (cleared) call.resolve();
            else call.reject("Could not clear the device session.", "MOBILE_AUTH_UNAVAILABLE");
        });
    }
}
