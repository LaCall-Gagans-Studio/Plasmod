// エージェントが出した写真・ファイルをチャットで見られるようにする（取り出しの窓口）。
// 実際のパス検査は持ち主の側でやる: 開発エージェントは bridge（会話の記録に載ったファイルだけ、~/work と /tmp の中、鍵や .env は拒否）、
// Hermes は仲介（~/.hermes などの許可した場所の中、鍵や .env・DB は拒否）。ここはその結果を、安全な形で返すだけ。
import type { MediaItem } from "../shared/types";
import type { BridgeClient } from "./bridge";
import { safeName } from "./share";

export const MEDIA_MAX = 15 * 1024 * 1024;

const IMAGE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

const ext = (name: string) => (name.split(".").pop() ?? "").toLowerCase();

/** 拡張子から見た種類。SVG はスクリプトを含められるので画像として出さない（ダウンロード扱い） */
export function mediaKind(name: string): MediaItem["kind"] {
  const e = ext(name);
  if (IMAGE[e]) return "image";
  if (e === "pdf") return "pdf";
  return "file";
}

/** MEDIA: などで渡された名前・パスから、表示用の名前 */
export const mediaName = (path: string) => safeName(path, "file");

const startsWith = (d: Uint8Array, s: string) => s.split("").every((c, i) => d[i] === c.charCodeAt(0));

/** 取り出したファイルの返し方。画像と（中身が本当に PDF の）PDF だけ画面で開き、それ以外はダウンロード */
export function mediaResponse(name: string, data: Uint8Array, download = false): Response {
  const k = mediaKind(name);
  const pdf = k === "pdf" && startsWith(data, "%PDF");
  const inline = !download && (k === "image" || pdf);
  const type = inline ? (k === "image" ? IMAGE[ext(name)] : "application/pdf") : "application/octet-stream";
  return new Response(new Blob([data as Uint8Array<ArrayBuffer>]), {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "X-Content-Type-Options": "nosniff",
      ...(pdf ? {} : { "Content-Security-Policy": "sandbox; default-src 'none'" }),
      "Cache-Control": "private, max-age=600",
    },
  });
}

export interface MediaSources {
  bridge: BridgeClient | null;
  /** 仲介の media-read（Hermes のファイル）。無ければ null */
  hermesRead: ((path: string) => Promise<Uint8Array>) | null;
}

export class MediaService {
  constructor(private src: MediaSources) {}

  /** 開発エージェントの会話に載ったファイル（thread の msg 番目のメッセージの i 番目） */
  async dev(thread: string, msg: string, i: number): Promise<{ name: string; data: Uint8Array }> {
    if (!this.src.bridge) throw new Error("plasmod-bridge が設定されていない");
    if (!/^\d{1,24}$/.test(thread) || !/^[\w-]{1,64}$/.test(msg) || !Number.isInteger(i) || i < 0 || i > 99) throw new Error("不正な指定");
    const r = await this.src.bridge.request({ type: "file", thread, msg, i }, 60_000);
    const data = Buffer.from(String(r.data ?? ""), "base64");
    if (data.length > MEDIA_MAX) throw new Error("大きすぎて開けない");
    return { name: safeName(String(r.name ?? "file")), data };
  }

  async hermes(path: string): Promise<{ name: string; data: Uint8Array }> {
    if (!this.src.hermesRead) throw new Error("仲介が設定されていない");
    if (!path.startsWith("/") || path.length > 1000 || path.includes("\0")) throw new Error("不正なパス");
    const data = await this.src.hermesRead(path);
    return { name: mediaName(path), data };
  }
}

export const devUrl = (thread: string, msg: string, i: number) => `/api/media/dev/${thread}/${encodeURIComponent(msg)}/${i}`;
export const hermesUrl = (path: string) => `/api/media/hermes?path=${encodeURIComponent(path)}`;
