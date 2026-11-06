package dev.plasmod.app;

import android.content.Context;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** VPS（Tailscale の住所）の API を呼ぶ（ウィジェット・音声メモ用）。本人の確認は Tailscale がする */
final class Api {
    private Api() {}

    static String call(Context c, String method, String path, String jsonBody) throws Exception {
        String server = Prefs.server(c);
        if (server == null) throw new IllegalStateException("サーバーの住所が無い（アプリを一度開く）");
        HttpURLConnection h = (HttpURLConnection) new URL(server + path).openConnection();
        h.setConnectTimeout(10_000);
        h.setReadTimeout(20_000);
        h.setRequestMethod(method);
        h.setUseCaches(false);
        if (jsonBody != null) {
            h.setDoOutput(true);
            h.setRequestProperty("Content-Type", "application/json");
            try (OutputStream o = h.getOutputStream()) {
                o.write(jsonBody.getBytes(StandardCharsets.UTF_8));
            }
        }
        try {
            int code = h.getResponseCode();
            if (code < 200 || code >= 300) throw new IllegalStateException("HTTP " + code);
            try (InputStream in = h.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return out.toString("UTF-8");
            }
        } finally {
            h.disconnect();
        }
    }
}
