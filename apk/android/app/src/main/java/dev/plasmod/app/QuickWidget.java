package dev.plasmod.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

/** ホーム画面のウィジェット「すぐ書く」: 音声メモ（アプリを開かずにメモへ）・アシスタントに頼む（新しいチャット） */
public class QuickWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.widget_quick);
        Intent voice = new Intent(context, VoiceMemoActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        v.setOnClickPendingIntent(R.id.widget_voice, PendingIntent.getActivity(context, 7101, voice, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        v.setOnClickPendingIntent(R.id.widget_ask, NotifyService.openIntent(context, "#/session/default/new", 7102));
        manager.updateAppWidget(ids, v);
    }
}
