package app.tomverse.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.SharedPreferences;
import android.view.WindowManager;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Screenshots remain available when device verification is enabled for sign-in. */
@RunWith(AndroidJUnit4.class)
public class ScreenCaptureTest {
    @Test public void deviceSignInPreferenceDoesNotBlockScreenCapture() {
        Context context = ApplicationProvider.getApplicationContext();
        SharedPreferences preferences = context.getSharedPreferences("tomverse-device-security", 0);
        boolean existed = preferences.contains("enabled");
        boolean previous = preferences.getBoolean("enabled", false);
        assertTrue(preferences.edit().putBoolean("enabled", true).commit());
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> assertEquals(0,
                activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE));
            assertTrue(preferences.getBoolean("enabled", false));
        } finally {
            SharedPreferences.Editor editor = preferences.edit();
            if (existed) editor.putBoolean("enabled", previous); else editor.remove("enabled");
            assertTrue(editor.commit());
        }
    }
}
