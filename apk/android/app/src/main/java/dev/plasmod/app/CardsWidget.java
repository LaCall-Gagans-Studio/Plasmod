package dev.plasmod.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.view.View;
import android.widget.RemoteViews;
import org.json.JSONObject;

/**
 * ホーム画面のウィジェット「判断待ち」: 枚数と一番上の1枚。押すとそのカード（無ければホーム）を開く。
 * 30分おき（Android の決まり）と、通知が来たとき・アプリから戻ったときに読み直す
 */
public class CardsWidget extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        final PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                refreshNow(context);
            } finally {
                pending.finish();
            }
        }).start();
    }

    /** 裏で読み直す（どこからでも呼べる） */
    static void refresh(Context context) {
        final Context app = context.getApplicationContext();
        new Thread(() -> refreshNow(app)).start();
    }

    private static void refreshNow(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        int[] ids = m.getAppWidgetIds(new ComponentName(c, CardsWidget.class));
        if (ids.length == 0) return;
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_cards);
        String path = "";
        try {
            JSONObject o = new JSONObject(Api.call(c, "GET", "/api/widget", null));
            int count = o.optInt("count", 0);
            v.setTextViewText(R.id.widget_count, String.valueOf(count));
            JSONObject top = o.optJSONObject("top");
            if (top != null) {
                v.setTextViewText(R.id.widget_title, top.optString("title"));
                v.setTextViewText(R.id.widget_meta, top.optString("agent") + " · " + top.optString("label"));
                v.setViewVisibility(R.id.widget_meta, View.VISIBLE);
                path = top.optString("path", "");
            } else {
                v.setTextViewText(R.id.widget_title, "判断待ちはありません");
                v.setViewVisibility(R.id.widget_meta, View.GONE);
            }
        } catch (Exception e) {
            v.setTextViewText(R.id.widget_count, "–");
            v.setTextViewText(R.id.widget_title, "つながっていません");
            v.setTextViewText(R.id.widget_meta, "Tailscale を確かめてください");
            v.setViewVisibility(R.id.widget_meta, View.VISIBLE);
        }
        PendingIntent open = NotifyService.openIntent(c, path.isEmpty() ? null : path, 7001);
        v.setOnClickPendingIntent(R.id.widget_root, open);
        m.updateAppWidget(ids, v);
    }
}
