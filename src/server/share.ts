// 共有メニュー（PWA の Web Share Target）から受け取ったものを一時的に置く。
// アプリがチャットの添付として取り込んだら、ここからは消す。
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShareInfo } from "../shared/types";

export const SHARE_LIMITS = { files: 10, fileBytes: 25 * 1024 * 1024, totalBytes: 60 * 1024 * 1024, ttlMs: 7 * 86400_000 };

const ID_RE = /^[0-9a-f]{24}$/;

/** 保存・添付に使う安全なファイル名 */
export function safeName(name: string, fallback = "file"): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\x00-\x1f]/g, "").replace(/^\.+/, "").trim();
  return (base || fallback).slice(0, 100);
}

export interface ShareFile {
  name: string;
  type: string;
  data: Uint8Array;
}

export class ShareStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(id: string) {
    if (!ID_RE.test(id)) throw new Error("不正な ID");
    return join(this.dir, id);
  }

  save(meta: { title?: string; text?: string; url?: string }, files: ShareFile[]): string {
    checkFiles(files);
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex");
    const d = this.path(id);
    mkdirSync(join(d, "files"), { recursive: true });
    const names: { name: string; type: string; size: number }[] = [];
    files.forEach((f, i) => {
      writeFileSync(join(d, "files", String(i)), f.data);
      names.push({ name: safeName(f.name, `file-${i + 1}`), type: f.type || "application/octet-stream", size: f.data.length });
    });
    const info: ShareInfo = {
      id,
      title: (meta.title ?? "").slice(0, 300),
      text: (meta.text ?? "").slice(0, 8000),
      url: (meta.url ?? "").slice(0, 2000),
      files: names,
      createdAt: Date.now(),
    };
    writeFileSync(join(d, "meta.json"), JSON.stringify(info));
    return id;
  }

  get(id: string): ShareInfo | null {
    try {
      return JSON.parse(readFileSync(join(this.path(id), "meta.json"), "utf8")) as ShareInfo;
    } catch {
      return null;
    }
  }

  file(id: string, n: number): ShareFile | null {
    const info = this.get(id);
    const f = info?.files[n];
    if (!info || !f || !Number.isInteger(n)) return null;
    return { name: f.name, type: f.type, data: readFileSync(join(this.path(id), "files", String(n))) };
  }

  files(id: string): ShareFile[] {
    const info = this.get(id);
    return info ? info.files.map((_, i) => this.file(id, i)!).filter(Boolean) : [];
  }

  remove(id: string) {
    rmSync(this.path(id), { recursive: true, force: true });
  }

  /** 送らずに放っておかれたものを片付ける */
  sweep(now = Date.now()) {
    for (const id of readdirSync(this.dir)) {
      if (!ID_RE.test(id)) continue;
      try {
        if (now - statSync(join(this.dir, id)).mtimeMs > SHARE_LIMITS.ttlMs) this.remove(id);
      } catch {
        // 消えていれば良い
      }
    }
  }
}

/** 件数と大きさの上限（保存前・送信前の検査） */
export function checkFiles(files: { name: string; data: Uint8Array }[]) {
  if (files.length > SHARE_LIMITS.files) throw new Error(`ファイルは ${SHARE_LIMITS.files} 個まで`);
  let total = 0;
  for (const f of files) {
    if (f.data.length > SHARE_LIMITS.fileBytes) throw new Error(`${f.name} が 25MB を超えている`);
    total += f.data.length;
  }
  if (total > SHARE_LIMITS.totalBytes) throw new Error("合計が 60MB を超えている");
}

/** 画像だけインライン表示。それ以外はダウンロード扱い（ブラウザに HTML などとして解釈させない） */
export const INLINE_IMAGE = /^image\/(png|jpeg|gif|webp)$/;

export function fileResponse(name: string, type: string, data: Uint8Array, inline = true): Response {
  const image = inline && INLINE_IMAGE.test(type);
  return new Response(new Blob([data as Uint8Array<ArrayBuffer>]), {
    headers: {
      "Content-Type": image ? type : "application/octet-stream",
      "Content-Disposition": `${image ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=600",
    },
  });
}
