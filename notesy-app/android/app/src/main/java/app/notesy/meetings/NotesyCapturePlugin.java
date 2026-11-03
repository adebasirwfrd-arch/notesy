package app.notesy.meetings;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Bridge to CaptureService for src/lib/native-capture.ts. */
@CapacitorPlugin(name = "NotesyCapture")
public class NotesyCapturePlugin extends Plugin {
    private static NotesyCapturePlugin current;

    @Override
    public void load() {
        current = this;
    }

    static void notifyEnded() {
        if (current != null) current.notifyListeners("screenEnded", new JSObject());
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (Boolean.TRUE.equals(call.getBoolean("screen", false))) {
            MediaProjectionManager mpm = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            startActivityForResult(call, mpm.createScreenCaptureIntent(), "onProjection");
            return;
        }
        launch(call, false, 0, null);
    }

    @ActivityCallback
    private void onProjection(PluginCall call, ActivityResult result) {
        if (call == null) return;
        boolean ok = result.getResultCode() == Activity.RESULT_OK && result.getData() != null;
        launch(call, ok, result.getResultCode(), ok ? result.getData() : null);
    }

    private void launch(PluginCall call, boolean screen, int code, Intent data) {
        Intent i = new Intent(getContext(), CaptureService.class)
            .putExtra("screen", screen)
            .putExtra("intervalMs", call.getInt("intervalMs", 3000))
            .putExtra("sensitivity", call.getFloat("sensitivity", 0.5f));
        if (screen) i.putExtra("code", code).putExtra("data", data);
        try {
            if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(i);
            else getContext().startService(i);
        } catch (RuntimeException e) {
            call.reject("Layanan rekam tidak bisa dimulai: " + e.getMessage());
            return;
        }
        JSObject r = new JSObject();
        r.put("screen", screen);
        call.resolve(r);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), CaptureService.class));
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        if (CaptureService.instance != null) CaptureService.instance.pause();
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        if (CaptureService.instance != null) CaptureService.instance.resume();
        call.resolve();
    }

    @PluginMethod
    public void captureNow(PluginCall call) {
        CaptureService s = CaptureService.instance;
        if (s == null || !s.hasScreen()) {
            call.reject("Layar tidak sedang direkam.");
            return;
        }
        s.requestCapture();
        call.resolve();
    }

    @PluginMethod
    public void takeSlides(PluginCall call) {
        JSArray list = new JSArray();
        CaptureService s = CaptureService.instance;
        if (s != null) {
            for (CaptureService.Frame f : s.drain()) {
                JSObject o = new JSObject();
                o.put("t", f.t);
                o.put("data", f.data);
                o.put("width", f.width);
                o.put("height", f.height);
                o.put("auto", f.auto);
                list.put(o);
            }
        }
        JSObject r = new JSObject();
        r.put("slides", list);
        call.resolve(r);
    }
}
