package dev.plasmod.app;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** 入口の画面（www/index.html）から呼ぶ: 通知の受け取りを始める・通知から来た行き先を受け取る */
@CapacitorPlugin(name = "HermesNotify", permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") })
public class HermesNotifyPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String server = call.getString("server");
        if (server == null || !server.startsWith("https://")) {
            call.reject("server が要る");
            return;
        }
        Prefs.setServer(getContext(), server);
        Prefs.setEnabled(getContext(), true);
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        begin(call);
    }

    private void begin(PluginCall call) {
        NotifyService.start(getContext());
        // つなぎっぱなしを電池の最適化に止められないよう、初回だけ「最適化しない」を聞く
        PowerManager pm = (PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);
        String pkg = getContext().getPackageName();
        boolean exempt = pm != null && pm.isIgnoringBatteryOptimizations(pkg);
        if (!exempt && !Prefs.askedBattery(getContext())) {
            Prefs.setAskedBattery(getContext());
            try {
                getActivity().startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + pkg)));
            } catch (Exception ignored) {
                // 端末がこの画面を持っていない
            }
        }
        JSObject r = new JSObject();
        r.put("notifications", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED);
        r.put("batteryExempt", exempt);
        call.resolve(r);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Prefs.setEnabled(getContext(), false);
        NotifyService.stop(getContext());
        call.resolve();
    }

    /** 通知を押して起動したときの行き先（#/card/… など）。一度読んだら消える */
    @PluginMethod
    public void takePath(PluginCall call) {
        JSObject r = new JSObject();
        String p = Prefs.takePendingPath(getContext());
        r.put("path", p == null ? "" : p);
        call.resolve(r);
    }
}
