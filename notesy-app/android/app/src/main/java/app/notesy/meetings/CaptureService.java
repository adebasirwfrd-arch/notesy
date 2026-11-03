package app.notesy.meetings;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

/**
 * Keeps a meeting recording alive while Notesy is in the background (Android silences the microphone of
 * background apps without a microphone foreground service) and, when allowed, samples the screen for slides.
 * Slide detection mirrors src/lib/slides.ts: wait for the picture to settle, then keep frames unlike any kept before.
 */
public class CaptureService extends Service {
    static CaptureService instance;

    private static final String CHANNEL = "notesy_capture";
    private static final int SIG_W = 96;
    private static final int SIG_H = 54;
    private static final int MAX_SIDE = 1600;
    private static final long MIN_GAP_MS = 6000;

    static class Frame {
        long t;
        String data;
        int width;
        int height;
        boolean auto;
    }

    private final List<Frame> pending = new ArrayList<>();
    private final List<float[]> saved = new ArrayList<>();
    private HandlerThread thread;
    private Handler handler;
    private MediaProjection projection;
    private MediaProjection.Callback projectionCallback;
    private VirtualDisplay display;
    private ImageReader reader;
    private int width;
    private int height;
    private int dpi;
    private float[] prev;
    private long lastSaveT = -MIN_GAP_MS;
    private long startedAt;
    private long pausedTotal;
    private long pausedAt = -1;
    private int intervalMs = 3000;
    private float threshold = 0.075f;
    private volatile boolean captureRequested;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        boolean screen = intent.getBooleanExtra("screen", false);
        intervalMs = Math.max(1000, intent.getIntExtra("intervalMs", 3000));
        float s = Math.min(1f, Math.max(0f, intent.getFloatExtra("sensitivity", 0.5f)));
        threshold = 0.12f - s * 0.09f;
        goForeground(screen);
        instance = this;
        startedAt = SystemClock.elapsedRealtime();
        thread = new HandlerThread("notesy-capture");
        thread.start();
        handler = new Handler(thread.getLooper());
        if (screen) {
            int code = intent.getIntExtra("code", 0);
            Intent data = Build.VERSION.SDK_INT >= 33 ? intent.getParcelableExtra("data", Intent.class) : intent.getParcelableExtra("data");
            handler.post(() -> startProjection(code, data));
        }
        return START_NOT_STICKY;
    }

    private void goForeground(boolean screen) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Rekaman rapat", NotificationManager.IMPORTANCE_LOW));
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        Notification n = b
            .setContentTitle("Notesy merekam rapat")
            .setContentText(screen ? "Mikrofon dan slide di layar sedang direkam." : "Mikrofon sedang direkam.")
            .setSmallIcon(android.R.drawable.presence_audio_online)
            .setContentIntent(pi)
            .setOngoing(true)
            .build();
        if (Build.VERSION.SDK_INT >= 29) {
            int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE | (screen ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION : 0);
            try {
                startForeground(1, n, types);
            } catch (RuntimeException e) {
                // Microphone type needs the audio permission; keep the screen part working without it.
                startForeground(1, n, screen ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION : 0);
            }
        } else {
            startForeground(1, n);
        }
    }

    private void startProjection(int code, Intent data) {
        MediaProjectionManager mpm = getSystemService(MediaProjectionManager.class);
        projection = mpm.getMediaProjection(code, data);
        if (projection == null) {
            NotesyCapturePlugin.notifyEnded();
            return;
        }
        projectionCallback = new MediaProjection.Callback() {
            @Override
            public void onStop() {
                releaseDisplay();
                projection = null;
                NotesyCapturePlugin.notifyEnded();
            }
        };
        projection.registerCallback(projectionCallback, handler);
        measure();
        reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        display = projection.createVirtualDisplay("notesy-slides", width, height, dpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, handler);
        handler.postDelayed(this::tick, intervalMs);
    }

    /** Screen size scaled to at most MAX_SIDE; true when it changed (the phone was rotated). */
    private boolean measure() {
        DisplayMetrics m = new DisplayMetrics();
        ((WindowManager) getSystemService(WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(m);
        float scale = Math.min(1f, (float) MAX_SIDE / Math.max(m.widthPixels, m.heightPixels));
        int w = Math.round(m.widthPixels * scale) & ~1;
        int h = Math.round(m.heightPixels * scale) & ~1;
        boolean changed = w != width || h != height;
        width = w;
        height = h;
        dpi = m.densityDpi;
        return changed;
    }

    private void tick() {
        if (projection == null) return;
        try {
            if (measure() && display != null) {
                ImageReader old = reader;
                reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
                display.resize(width, height, dpi);
                display.setSurface(reader.getSurface());
                old.close();
                prev = null;
            } else if (pausedAt < 0 || captureRequested) {
                sample();
            }
        } catch (RuntimeException e) {
            // A frame can fail while the screen rotates; the next tick tries again.
        }
        handler.postDelayed(this::tick, captureRequested ? 200 : intervalMs);
    }

    private void sample() {
        Image img = reader.acquireLatestImage();
        if (img == null) return;
        Bitmap bmp;
        try {
            bmp = toBitmap(img);
        } finally {
            img.close();
        }
        float[] stats = new float[2];
        float[] sig = signature(bmp, stats);
        boolean manual = captureRequested;
        captureRequested = false;
        float[] before = prev;
        prev = sig;
        if (!manual) {
            if (before == null) return;
            boolean settled = diff(sig, before) < threshold / 3;
            if (!settled || stats[0] < 0.03f || stats[1] < 0.015f) return;
            if (now() - lastSaveT < MIN_GAP_MS) return;
            for (int i = Math.max(0, saved.size() - 30); i < saved.size(); i++) {
                if (diff(sig, saved.get(i)) <= threshold) return;
            }
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.JPEG, 82, out);
        Frame f = new Frame();
        f.t = now();
        f.data = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        f.width = bmp.getWidth();
        f.height = bmp.getHeight();
        f.auto = !manual;
        saved.add(sig);
        lastSaveT = f.t;
        synchronized (pending) {
            pending.add(f);
        }
        bmp.recycle();
    }

    private static Bitmap toBitmap(Image img) {
        Image.Plane plane = img.getPlanes()[0];
        ByteBuffer buf = plane.getBuffer();
        int pixelStride = plane.getPixelStride();
        int rowPadding = plane.getRowStride() - pixelStride * img.getWidth();
        Bitmap padded = Bitmap.createBitmap(img.getWidth() + rowPadding / pixelStride, img.getHeight(), Bitmap.Config.ARGB_8888);
        padded.copyPixelsFromBuffer(buf);
        if (rowPadding == 0) return padded;
        Bitmap cropped = Bitmap.createBitmap(padded, 0, 0, img.getWidth(), img.getHeight());
        padded.recycle();
        return cropped;
    }

    /** Grayscale thumbnail; stats receives mean and standard deviation (blank screens are skipped). */
    private static float[] signature(Bitmap bmp, float[] stats) {
        Bitmap small = Bitmap.createScaledBitmap(bmp, SIG_W, SIG_H, true);
        int[] px = new int[SIG_W * SIG_H];
        small.getPixels(px, 0, SIG_W, 0, 0, SIG_W, SIG_H);
        small.recycle();
        float[] sig = new float[px.length];
        float sum = 0;
        for (int i = 0; i < px.length; i++) {
            int c = px[i];
            float v = (((c >> 16) & 0xff) * 0.299f + ((c >> 8) & 0xff) * 0.587f + (c & 0xff) * 0.114f) / 255f;
            sig[i] = v;
            sum += v;
        }
        float mean = sum / sig.length;
        float var = 0;
        for (float v : sig) var += (v - mean) * (v - mean);
        stats[0] = mean;
        stats[1] = (float) Math.sqrt(var / sig.length);
        return sig;
    }

    private static float diff(float[] a, float[] b) {
        float d = 0;
        for (int i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
        return d / a.length;
    }

    /** Meeting time in ms, excluding pauses, so it lines up with the recorder's clock. */
    private long now() {
        long paused = pausedTotal + (pausedAt >= 0 ? SystemClock.elapsedRealtime() - pausedAt : 0);
        return SystemClock.elapsedRealtime() - startedAt - paused;
    }

    boolean hasScreen() {
        return projection != null;
    }

    void pause() {
        if (pausedAt < 0) pausedAt = SystemClock.elapsedRealtime();
    }

    void resume() {
        if (pausedAt >= 0) {
            pausedTotal += SystemClock.elapsedRealtime() - pausedAt;
            pausedAt = -1;
        }
    }

    void requestCapture() {
        captureRequested = true;
    }

    List<Frame> drain() {
        synchronized (pending) {
            List<Frame> out = new ArrayList<>(pending);
            pending.clear();
            return out;
        }
    }

    private void releaseDisplay() {
        if (display != null) display.release();
        display = null;
        if (reader != null) reader.close();
        reader = null;
    }

    @Override
    public void onDestroy() {
        if (projection != null) {
            if (projectionCallback != null) projection.unregisterCallback(projectionCallback);
            projection.stop();
        }
        projection = null;
        releaseDisplay();
        if (thread != null) thread.quitSafely();
        instance = null;
        super.onDestroy();
    }
}
