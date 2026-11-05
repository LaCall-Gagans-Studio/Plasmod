package dev.plasmod.app;

import android.app.DownloadManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;
import android.widget.Toast;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private SpeechBridge speech;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HermesNotifyPlugin.class);
        super.onCreate(savedInstanceState);
        NotifyService.createChannels(this);
        keepPath(getIntent(), false);
        speech = new SpeechBridge(this, getBridge().getWebView());
        getBridge().getWebView().addJavascriptInterface(speech, "HermesSpeechNative");
        // チャットの写真・ファイルの「保存」: WebView はダウンロードを自分では受け取らないので、Android の保存（ダウンロードフォルダ）に渡す。
        // 取りに行くのは Android 自身だが、通り道は同じ Tailscale なので、本人の確認もアプリと同じ
        getBridge().getWebView().setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                String parsed = DownloadName.fromContentDisposition(contentDisposition);
                String name = parsed != null ? parsed : URLUtil.guessFileName(url, contentDisposition, mimeType);
                // サーバーは保存用に octet-stream で返すので、ギャラリーなどが開けるよう種類は拡張子から決める
                String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(DownloadName.extension(name));
                DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url))
                    .setTitle(name)
                    .setMimeType(type != null ? type : mimeType)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(r);
                Toast.makeText(this, "保存しています: " + name, Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(this, "保存できませんでした", Toast.LENGTH_LONG).show();
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == SpeechBridge.REQUEST_MIC && speech != null) {
            speech.onPermission(results.length > 0 && results[0] == android.content.pm.PackageManager.PERMISSION_GRANTED);
        }
    }

    @Override
    public void onDestroy() {
        if (speech != null) speech.destroy();
        super.onDestroy();
    }

    /** アプリで判断してから離れたとき、ウィジェットの枚数を合わせる */
    @Override
    public void onPause() {
        super.onPause();
        CardsWidget.refresh(this);
    }

    /** 開いているときに通知を押した: その画面へ（入口の画面を通さない） */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        keepPath(intent, true);
    }

    private void keepPath(Intent intent, boolean live) {
        String path = intent == null ? null : intent.getStringExtra(NotifyService.EXTRA_PATH);
        if (path == null || path.isEmpty()) return;
        String server = Prefs.server(this);
        if (live && server != null && getBridge() != null) {
            getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(server + "/" + path));
        } else {
            // 起動したところ: 入口の画面がつながったあとに takePath で受け取って開く
            Prefs.setPendingPath(this, path);
        }
    }
}
