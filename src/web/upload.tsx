// 添付を送るときの進み具合。fetch はアップロードの進み具合を取れないので、ファイルがあるときだけ XHR で送る。
import type { ReactNode } from "react";

/** 送った割合（0〜1）。1 になったあとはサーバーの処理待ち */
export type Progress = (ratio: number) => void;

/** FormData を POST して、返事を JSON で受ける。onProgress にアップロードの割合を渡す */
export function upload(url: string, body: FormData, onProgress: Progress): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.upload.onload = () => onProgress(1);
    xhr.onload = () => {
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        // 中継のエラーページは JSON でない
      }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, json });
    };
    xhr.onerror = () => reject(new Error("つながらなかった"));
    xhr.ontimeout = () => reject(new Error("時間切れ"));
    xhr.send(body);
  });
}

const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

/**
 * 送っている間のバー。ratio が 1 未満なら進み具合（％）、1 ならサーバーの処理待ちとして流れる縞を出す。
 * files を渡すと、名前と合計の大きさも出す
 */
export function UploadBar({ ratio, files, children }: { ratio: number; files?: File[]; children?: ReactNode }) {
  const waiting = ratio >= 1;
  const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  const total = files?.reduce((a, f) => a + f.size, 0) ?? 0;
  return (
    <div className="flex w-full flex-col gap-1" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-[11px] text-mute">
        <span className="gh-spin inline-block size-3 flex-none rounded-full border-2 border-line-2 border-t-ink" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {children ?? (files?.length ? `📎 ${files.length === 1 ? files[0].name : `${files.length} 件`}（${fmtSize(total)}）` : "")}
        </span>
        <span className="flex-none font-mono">{waiting ? "受け取り中…" : `${pct}%`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-line">
        {waiting ? (
          <div className="gh-stripes h-full w-full rounded-full" />
        ) : (
          <div className="h-full rounded-full bg-ink transition-[width] duration-200 ease-out" style={{ width: `${Math.max(3, pct)}%` }} />
        )}
      </div>
    </div>
  );
}
