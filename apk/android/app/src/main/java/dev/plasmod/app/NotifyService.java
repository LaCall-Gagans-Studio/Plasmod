package dev.plasmod.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * VPS（Tailscale の住所）の /api/notify/stream につなぎっぱなしにして、通知を出す。
 * Android の決まりで、つないでいる間は「接続中」の小さな常駐表示が出る。
 */
public class NotifyService extends Service {
    static final String TAG = "HermesNotify";
    static final String EXTRA_PATH = "dev.plasmod.app.PATH";
    static final String CH_CONN = "connection";
    static final String CH_CARD = "cards";
    static final String CH_REPLY = "replies";
    static final String CH_SYSTEM = "system";
    static final int ONGOING_ID = 1;

    private volatile boolean running;
    private volatile HttpURLConnection conn;
    private Thread worker;

    public static void start(Context c) {
        ContextCompat.startForegroundService(c, new Intent(c, NotifyService.class));
    }

    public static void stop(Context c) {
        c.stopService(new Intent(c, NotifyService.class));
    }

    /** 通知の番号: 同じ key は同じ番号（上書き・消すため）。常駐表示の 1 とは重ならない */
    static int idFor(String key) {
        return (key.hashCode() & 0x3fffffff) + 1000;
    }

    static void createChannels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        NotificationChannel conn = new NotificationChannel(CH_CONN, "接続中の表示", NotificationManager.IMPORTANCE_MIN);
        conn.setDescription("VPS につながっている間の常駐表示（音・バイブなし）");
        nm.createNotificationChannel(conn);
        nm.createNotificationChannel(new NotificationChannel(CH_CARD, "BackLog", NotificationManager.IMPORTANCE_HIGH));
        nm.createNotificationChannel(new NotificationChannel(CH_REPLY, "エージェントの返事", NotificationManager.IMPORTANCE_DEFAULT));
        nm.createNotificationChannel(new NotificationChannel(CH_SYSTEM, "デプロイ・root など", NotificationManager.IMPORTANCE_DEFAULT));
    }

    /** 押すとアプリを開いて、path（#/card/… など）へ */
    static PendingIntent openIntent(Context c, String path, int requestCode) {
        Intent i = new Intent(c, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (path != null) i.putExtra(EXTRA_PATH, path);
        return PendingIntent.getActivity(c, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification ongoing(String text) {
        return new NotificationCompat.Builder(this, CH_CONN)
            .setSmallIcon(R.drawable.ic_stat_hermes)
            .setContentTitle("Plasmod")
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(openIntent(this, null, 0))
            .build();
    }

    private void setOngoing(String text) {
        try {
            NotificationManagerCompat.from(this).notify(ONGOING_ID, ongoing(text));
        } catch (SecurityException e) {
            // 通知の許可が無い（常駐表示が出ないだけ）
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ServiceCompat.startForeground(this, ONGOING_ID, ongoing("つないでいます…"),
            Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING : 0);
        if (worker == null) {
            running = true;
            worker = new Thread(this::loop, "hermes-notify");
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        HttpURLConnection c = conn;
        if (c != null) c.disconnect();
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** つなぐ → 切れたら少し待ってつなぎ直す（5秒から倍々で最大1分） */
    private void loop() {
        long wait = 5_000;
        while (running) {
            String server = Prefs.server(this);
            if (server == null || !Prefs.enabled(this)) {
                stopSelf();
                return;
            }
            try {
                stream(server);
                wait = 5_000;
            } catch (Exception e) {
                Log.w(TAG, "切れた: " + e);
                setOngoing("つながっていません（Tailscale を確かめてください）");
            }
            if (!running) return;
            try {
                Thread.sleep(wait);
            } catch (InterruptedException e) {
                return;
            }
            wait = Math.min(wait * 2, 60_000);
        }
    }

    private void stream(String server) throws Exception {
        long last = Prefs.lastId(this);
        URL url = new URL(server + "/api/notify/stream" + (last >= 0 ? "?since=" + last : ""));
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        conn = c;
        c.setConnectTimeout(10_000);
        // サーバーは 25 秒ごとに ping を送る。70 秒なにも来なければ切れたとみなす
        c.setReadTimeout(70_000);
        c.setRequestProperty("Accept", "text/event-stream");
        c.setUseCaches(false);
        try {
            int code = c.getResponseCode();
            if (code != 200) throw new IllegalStateException("HTTP " + code);
            setOngoing("接続中");
            BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
            String event = null;
            StringBuilder data = new StringBuilder();
            String line;
            while (running && (line = r.readLine()) != null) {
                if (line.isEmpty()) {
                    if (event != null) handle(event, data.toString());
                    event = null;
                    data.setLength(0);
                } else if (line.startsWith("event:")) {
                    event = line.substring(6).trim();
                } else if (line.startsWith("data:")) {
                    if (data.length() > 0) data.append('\n');
                    data.append(line.substring(5).startsWith(" ") ? line.substring(6) : line.substring(5));
                }
            }
            throw new IllegalStateException("サーバーが切った");
        } finally {
            c.disconnect();
            conn = null;
        }
    }

    private void handle(String event, String data) {
        try {
            if (event.equals("ping")) return;
            JSONObject o = new JSONObject(data);
            if (event.equals("hello")) {
                // 初めての端末: 今ある分は出さず、ここから先だけ
                if (Prefs.lastId(this) < 0) Prefs.setLastId(this, o.optLong("last", 0));
                return;
            }
            long id = o.optLong("id", -1);
            if (event.equals("notice")) show(o);
            else if (event.equals("clear")) NotificationManagerCompat.from(this).cancel(idFor(o.optString("key")));
            // BackLog が増えた・減ったら、ウィジェットも読み直す
            if (event.equals("clear") || "card".equals(o.optString("kind"))) CardsWidget.refresh(this);
            if (id > Prefs.lastId(this)) Prefs.setLastId(this, id);
        } catch (Exception e) {
            Log.w(TAG, "読めない通知: " + e);
        }
    }

    private void show(JSONObject n) {
        String key = n.optString("key");
        String kind = n.optString("kind");
        String path = n.optString("path", "");
        int id = idFor(key);
        String channel = kind.equals("card") ? CH_CARD : kind.equals("reply") ? CH_REPLY : CH_SYSTEM;
        int pr = n.optInt("priority", 3);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, channel)
            .setSmallIcon(R.drawable.ic_stat_hermes)
            .setContentTitle(n.optString("title"))
            .setContentText(n.optString("message"))
            .setStyle(new NotificationCompat.BigTextStyle().bigText(n.optString("message")))
            .setPriority(pr >= 5 ? NotificationCompat.PRIORITY_MAX : pr >= 4 ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(openIntent(this, path, id));
        JSONArray actions = n.optJSONArray("actions");
        if (actions != null) {
            for (int i = 0; i < actions.length() && i < 3; i++) {
                JSONObject a = actions.optJSONObject(i);
                if (a == null) continue;
                String label = a.optString("label");
                if (a.has("option")) {
                    Intent ai = new Intent(this, ActionReceiver.class)
                        .putExtra(ActionReceiver.EXTRA_KEY, key)
                        .putExtra(ActionReceiver.EXTRA_OPTION, a.optString("option"))
                        .putExtra(ActionReceiver.EXTRA_LABEL, label)
                        .putExtra(ActionReceiver.EXTRA_NOTIFICATION, id);
                    PendingIntent pi = PendingIntent.getBroadcast(this, id * 4 + i, ai, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                    b.addAction(0, label, pi);
                } else if (a.has("path")) {
                    b.addAction(0, label, openIntent(this, a.optString("path"), id * 4 + i));
                }
            }
        }
        try {
            NotificationManagerCompat.from(this).notify(id, b.build());
        } catch (SecurityException e) {
            Log.w(TAG, "通知の許可が無い");
        }
    }
}
