package dev.plasmod.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import java.util.ArrayList;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 画面（VPS から読むページ）に Android の音声認識を渡す。WebView には Web Speech API が無いので。
 * 止められるまで聞き続ける: 1回の認識が終わる・無音で切れる・通信が切れても、つなぎ直す。
 * 画面には window.__hermesSpeech({type, text?, error?}) で知らせる。
 * 呼べるのは、設定したサーバーのページだけ。
 */
public class SpeechBridge {
    static final int REQUEST_MIC = 4101;
    private static final int MAX_BACKOFF_MS = 5000;

    private final Activity activity;
    private final WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private SpeechRecognizer rec;
    private boolean wanted;
    private int backoff = 0;

    SpeechBridge(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
    }

    @JavascriptInterface
    public boolean available() {
        return SpeechRecognizer.isRecognitionAvailable(activity);
    }

    @JavascriptInterface
    public void start() {
        main.post(() -> {
            if (!allowedPage()) return;
            if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                activity.requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_MIC);
                return;
            }
            wanted = true;
            backoff = 0;
            listen();
        });
    }

    @JavascriptInterface
    public void stop() {
        main.post(() -> {
            wanted = false;
            main.removeCallbacksAndMessages(null);
            if (rec != null) rec.stopListening(); // 話した分は onResults で届く
            else emit("end", null, null);
        });
    }

    /** 机に置いて話し続けられるよう、画面を消さない */
    @JavascriptInterface
    public void keepAwake(boolean on) {
        main.post(() -> {
            if (!allowedPage()) return;
            if (on) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    void onPermission(boolean granted) {
        if (granted) start();
        else emit("error", null, "not-allowed");
    }

    void destroy() {
        wanted = false;
        main.removeCallbacksAndMessages(null);
        release();
    }

    private boolean allowedPage() {
        String server = Prefs.server(activity);
        String url = web.getUrl();
        return server != null && url != null && (url.equals(server) || url.startsWith(server + "/"));
    }

    private void release() {
        if (rec != null) {
            rec.destroy();
            rec = null;
        }
    }

    private void listen() {
        if (!wanted) return;
        release();
        rec = SpeechRecognizer.createSpeechRecognizer(activity);
        rec.setRecognitionListener(listener);
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ja-JP")
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            // 話の切れ目で止まりにくくする（効くかは端末の認識エンジンによる）
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 5000L)
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 5000L);
        if (Build.VERSION.SDK_INT >= 33) {
            i.putExtra(RecognizerIntent.EXTRA_ENABLE_FORMATTING, RecognizerIntent.FORMATTING_OPTIMIZE_QUALITY);
        }
        rec.startListening(i);
    }

    private void again(int delayMs) {
        if (!wanted) {
            release();
            emit("end", null, null);
            return;
        }
        main.postDelayed(this::listen, delayMs);
    }

    private static String first(Bundle b) {
        ArrayList<String> r = b == null ? null : b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return r == null || r.isEmpty() ? "" : r.get(0);
    }

    private void emit(String type, String text, String error) {
        try {
            JSONObject o = new JSONObject().put("type", type);
            if (text != null) o.put("text", text);
            if (error != null) o.put("error", error);
            web.post(() -> web.evaluateJavascript("window.__hermesSpeech&&window.__hermesSpeech(" + o + ")", null));
        } catch (JSONException ignored) {
            // 固定のキーと文字列だけなので起きない
        }
    }

    private final RecognitionListener listener = new RecognitionListener() {
        @Override public void onReadyForSpeech(Bundle p) { emit("listening", null, null); }
        @Override public void onBeginningOfSpeech() { backoff = 0; }
        @Override public void onRmsChanged(float v) {}
        @Override public void onBufferReceived(byte[] b) {}
        @Override public void onEndOfSpeech() {}
        @Override public void onEvent(int t, Bundle p) {}

        @Override
        public void onPartialResults(Bundle b) {
            String s = first(b);
            if (!s.isEmpty()) emit("partial", s, null);
        }

        @Override
        public void onResults(Bundle b) {
            String s = first(b);
            if (!s.isEmpty()) emit("final", s, null);
            again(0);
        }

        @Override
        public void onError(int code) {
            switch (code) {
                case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                    wanted = false;
                    release();
                    emit("error", null, "not-allowed");
                    emit("end", null, null);
                    return;
                case SpeechRecognizer.ERROR_NO_MATCH:
                case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                    again(0); // 黙っていただけ
                    return;
                default:
                    // 通信・認識サービスの不調: 間を空けてつなぎ直す
                    emit("retry", null, String.valueOf(code));
                    backoff = Math.min(MAX_BACKOFF_MS, backoff == 0 ? 500 : backoff * 2);
                    again(backoff);
            }
        }
    };
}
