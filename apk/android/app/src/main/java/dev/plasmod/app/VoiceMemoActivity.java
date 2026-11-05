package dev.plasmod.app;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognizerIntent;
import android.widget.Toast;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Locale;
import org.json.JSONObject;

/**
 * ウィジェットの「音声メモ」: Android の音声入力を開き、話した内容をそのままアプリのメモにする（アプリの画面は開かない）。
 * 画面は透明で、終わったらすぐ閉じる
 */
public class VoiceMemoActivity extends Activity {
    private static final int REQ = 1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ja-JP")
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "メモにすることを話してください");
        try {
            startActivityForResult(i, REQ);
        } catch (Exception e) {
            Toast.makeText(this, "音声入力が使えない（Google の音声入力などを入れてください）", Toast.LENGTH_LONG).show();
            finish();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        ArrayList<String> r = data == null ? null : data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        if (requestCode != REQ || resultCode != RESULT_OK || r == null || r.isEmpty() || r.get(0).trim().isEmpty()) {
            finish();
            return;
        }
        final String text = r.get(0).trim();
        final String stamp = new SimpleDateFormat("M/d HH:mm", Locale.JAPAN).format(new Date());
        final String title = "音声メモ " + stamp + "：" + (text.length() > 24 ? text.substring(0, 24) + "…" : text);
        final android.content.Context app = getApplicationContext();
        new Thread(() -> {
            String msg;
            try {
                Api.call(app, "POST", "/api/memos", new JSONObject().put("title", title).put("body", text).toString());
                msg = "メモに入れました: " + (text.length() > 30 ? text.substring(0, 30) + "…" : text);
            } catch (Exception e) {
                msg = "メモに入れられませんでした（Tailscale を確かめてください）";
            }
            final String m = msg;
            runOnUiThread(() -> {
                Toast.makeText(app, m, Toast.LENGTH_LONG).show();
                finish();
            });
        }).start();
    }
}
