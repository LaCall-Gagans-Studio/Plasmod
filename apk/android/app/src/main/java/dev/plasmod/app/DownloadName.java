package dev.plasmod.app;

import java.net.URLDecoder;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 保存するファイルの名前を Content-Disposition から取り出す。
 * サーバーは日本語の名前のため filename*=UTF-8''… で返すが、URLUtil.guessFileName はこれを読まず、
 * URL の末尾と octet-stream から「hermes.bin」を作ってしまう。
 */
final class DownloadName {
    private static final Pattern EXTENDED = Pattern.compile("filename\\*\\s*=\\s*UTF-8''([^;\\s]+)", Pattern.CASE_INSENSITIVE);

    private DownloadName() {}

    /** 読めない・安全でない名前なら null。保存先の外に出ないよう、パスの部分は捨てる */
    static String fromContentDisposition(String contentDisposition) {
        if (contentDisposition == null) return null;
        Matcher m = EXTENDED.matcher(contentDisposition);
        if (!m.find()) return null;
        String name;
        try {
            name = URLDecoder.decode(m.group(1).replace("+", "%2B"), "UTF-8");
        } catch (Exception e) {
            return null;
        }
        name = name.substring(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1).trim();
        return name.isEmpty() || name.startsWith(".") ? null : name;
    }

    /** 拡張子（小文字）。無ければ空文字 */
    static String extension(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }
}
