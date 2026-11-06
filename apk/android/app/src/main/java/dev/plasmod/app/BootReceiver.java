package dev.plasmod.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 再起動・アプリの更新のあとに、通知の受け取りを再開する */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
        if (Prefs.enabled(context) && Prefs.server(context) != null) NotifyService.start(context);
    }
}
