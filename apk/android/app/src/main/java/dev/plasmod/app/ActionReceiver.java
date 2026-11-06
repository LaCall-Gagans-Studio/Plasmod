package dev.plasmod.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** 通知のボタン（進めて・許可など）: Tailscale 越しに本人としてカードに返す（/api/cards/:key/act） */
public class ActionReceiver extends BroadcastReceiver {
    static final String EXTRA_KEY = "key";
    static final String EXTRA_OPTION = "option";
    static final String EXTRA_LABEL = "label";
    static final String EXTRA_NOTIFICATION = "notification";

    @Override
    public void onReceive(Context context, Intent intent) {
        final PendingResult pending = goAsync();
        final Context app = context.getApplicationContext();
        final String key = intent.getStringExtra(EXTRA_KEY);
        final String option = intent.getStringExtra(EXTRA_OPTION);
        final String label = intent.getStringExtra(EXTRA_LABEL);
        final int nid = intent.getIntExtra(EXTRA_NOTIFICATION, 0);
        new Thread(() -> {
            String result;
            try {
                String server = Prefs.server(app);
                if (server == null || key == null || option == null) throw new IllegalStateException("設定が無い");
                URL url = new URL(server + "/api/cards/" + URLEncoder.encode(key, "UTF-8").replace("+", "%20") + "/act");
                HttpURLConnection c = (HttpURLConnection) url.openConnection();
                c.setConnectTimeout(10_000);
                c.setReadTimeout(30_000);
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                try (OutputStream o = c.getOutputStream()) {
                    o.write(new JSONObject().put("option", option).toString().getBytes(StandardCharsets.UTF_8));
                }
                int code = c.getResponseCode();
                c.disconnect();
                result = code == 200 ? "「" + label + "」で返しました" : code == 404 ? "もう判断済みでした" : "返せませんでした（HTTP " + code + "）。アプリで開いてください";
            } catch (Exception e) {
                result = "返せませんでした（Tailscale を確かめてください）";
            }
            try {
                NotificationManagerCompat.from(app).notify(nid, new NotificationCompat.Builder(app, NotifyService.CH_CARD)
                    .setSmallIcon(R.drawable.ic_stat_hermes)
                    .setContentTitle("Plasmod")
                    .setContentText(result)
                    .setSilent(true)
                    .setAutoCancel(true)
                    .setTimeoutAfter(result.startsWith("「") || result.startsWith("もう") ? 4_000 : 0)
                    .setContentIntent(NotifyService.openIntent(app, null, nid))
                    .build());
            } catch (SecurityException ignored) {
                // 通知の許可が無い
            }
            pending.finish();
        }).start();
    }
}
