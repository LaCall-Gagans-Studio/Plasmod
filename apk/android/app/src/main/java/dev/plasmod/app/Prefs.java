package dev.plasmod.app;

import android.content.Context;
import android.content.SharedPreferences;

/** 端末に残す設定: サーバーの住所・通知を受けるか・最後に受け取った通知の番号・開きたい画面 */
final class Prefs {
    private Prefs() {}

    private static SharedPreferences sp(Context c) {
        return c.getSharedPreferences("hermes", Context.MODE_PRIVATE);
    }

    static String server(Context c) {
        return sp(c).getString("server", null);
    }

    static void setServer(Context c, String v) {
        sp(c).edit().putString("server", v).apply();
    }

    static boolean enabled(Context c) {
        return sp(c).getBoolean("enabled", false);
    }

    static void setEnabled(Context c, boolean v) {
        sp(c).edit().putBoolean("enabled", v).apply();
    }

    /** -1 は「まだ一度もつないでいない」（サーバーの今の番号から先だけ受け取る） */
    static long lastId(Context c) {
        return sp(c).getLong("lastId", -1);
    }

    static void setLastId(Context c, long v) {
        sp(c).edit().putLong("lastId", v).apply();
    }

    /** 通知を押して起動したときの行き先（入口の画面が受け取る） */
    static void setPendingPath(Context c, String v) {
        sp(c).edit().putString("pendingPath", v).apply();
    }

    static String takePendingPath(Context c) {
        String v = sp(c).getString("pendingPath", null);
        sp(c).edit().remove("pendingPath").apply();
        return v;
    }

    static boolean askedBattery(Context c) {
        return sp(c).getBoolean("askedBattery", false);
    }

    static void setAskedBattery(Context c) {
        sp(c).edit().putBoolean("askedBattery", true).apply();
    }
}
