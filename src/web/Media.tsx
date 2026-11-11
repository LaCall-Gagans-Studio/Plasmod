// チャットに出す写真・ファイル。画像はその場に表示してタップで拡大、PDF・その他は開く／保存。
import { IconButton } from "./sheet";
import { useEffect, useState } from "react";
import type { MediaItem } from "../shared/types";
import { RichText } from "./markdown";

const isMarkdown = (m: MediaItem) => m.kind === "file" && /\.(md|markdown)$/i.test(m.name);
const PREVIEW_MAX = 512 * 1024;

const dl = (url: string) => url + (url.includes("?") ? "&" : "?") + "dl=1";
const size = (n?: number) => (n == null ? "" : n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function Image({ m, onOpen }: { m: MediaItem; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  if (broken)
    return (
      <span className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-[11px] text-mute">
        🖼 {m.name}（表示できなかった）
        <IconButton name="download" label="保存" href={dl(m.url)} size={16} className="!size-7" />
      </span>
    );
  return (
    <button type="button" onClick={onOpen} aria-label={`${m.name} を拡大`} className="block max-w-full overflow-hidden rounded-xl border border-line bg-chip">
      <img src={m.url} alt={m.name} loading="lazy" onError={() => setBroken(true)} className="block max-h-64 max-w-full object-contain" />
    </button>
  );
}

function Lightbox({ m, onClose }: { m: MediaItem; onClose: () => void }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [onClose]);
  return (
    <div role="dialog" aria-label={m.name} className="fixed inset-0 z-50 flex flex-col bg-black/90" onClick={onClose}>
      <div className="flex items-center gap-3 px-4 pb-2 pt-[max(env(safe-area-inset-top),12px)] text-[12px] text-white/80">
        <span className="min-w-0 flex-1 truncate">{m.name}</span>
        <a href={dl(m.url)} onClick={(e) => e.stopPropagation()} className="rounded-md border border-white/30 px-2.5 py-1.5">保存</a>
        <IconButton name="close" label="閉じる" onClick={onClose} />
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-2">
        <img src={m.url} alt={m.name} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
      </div>
    </div>
  );
}

/** Markdown の下見。PC では右側のパネル（チャットはそのまま操作できる）、スマホでは全画面。見た目は返事と同じ RichText（HTML は解釈しない） */
function MarkdownPreview({ m, onClose }: { m: MediaItem; onClose: () => void }) {
  const [state, setState] = useState<{ text: string; cut: boolean } | "loading" | "error">("loading");
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [onClose]);
  useEffect(() => {
    const ac = new AbortController();
    setState("loading");
    fetch(m.url, { signal: ac.signal })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => setState({ text: t.slice(0, PREVIEW_MAX), cut: t.length > PREVIEW_MAX }))
      .catch((e) => e?.name !== "AbortError" && setState("error"));
    return () => ac.abort();
  }, [m.url]);
  return (
    <div role="dialog" aria-label={`${m.name} のプレビュー`} className="fixed inset-0 z-50 flex flex-col bg-paper md:inset-y-0 md:left-auto md:right-0 md:w-[min(560px,45vw)] md:border-l md:border-line md:shadow-xl">
      <div className="flex items-center gap-3 border-b border-line px-4 pb-2 pt-[max(env(safe-area-inset-top),12px)] text-[12px] text-ink-2">
        <span className="min-w-0 flex-1 truncate font-semibold text-ink">{m.name}</span>
        <IconButton name="download" label="保存" href={dl(m.url)} tone="chip" />
        <button type="button" onClick={onClose} aria-label="閉じる" className="flex size-9 items-center justify-center text-[18px]">×</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[13px] leading-6 text-ink">
        {state === "loading" && <span className="text-mute">読み込み中…</span>}
        {state === "error" && <span className="text-orange-ink" role="alert">読み込めなかった。「保存」から取り出せる</span>}
        {typeof state === "object" && (
          <>
            <RichText text={state.text} />
            {state.cut && <div className="mt-3 text-[11px] text-mute">長いので先頭だけ表示している。全文は「保存」から</div>}
          </>
        )}
      </div>
    </div>
  );
}

function FileCard({ m, onPreview }: { m: MediaItem; onPreview?: () => void }) {
  return (
    <span className="flex max-w-full items-center gap-2.5 rounded-xl border border-line bg-panel px-3 py-2 text-[12px] text-ink-2">
      <span aria-hidden="true" className="text-[18px]">{m.kind === "pdf" ? "📕" : "📄"}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-ink">{m.name}</span>
        {m.size != null && <span className="text-[10.5px] text-mute">{size(m.size)}</span>}
      </span>
      {onPreview && <IconButton name="eye" label="プレビュー" onClick={onPreview} tone="chip" className="!size-8" size={16} />}
      {m.kind === "pdf" && <IconButton name="external" label="開く" href={m.url} external tone="chip" className="!size-8" size={16} />}
      <IconButton name="download" label="保存" href={dl(m.url)} tone="chip" className="!size-8" size={16} />
    </span>
  );
}

export function MediaList({ items }: { items: MediaItem[] }) {
  const [open, setOpen] = useState<MediaItem | null>(null);
  if (!items.length) return null;
  return (
    <div className="mt-1.5 flex flex-col items-start gap-1.5">
      {items.map((m) => (m.kind === "image" ? <Image key={m.url} m={m} onOpen={() => setOpen(m)} /> : <FileCard key={m.url} m={m} onPreview={isMarkdown(m) ? () => setOpen(m) : undefined} />))}
      {open && isMarkdown(open) && <MarkdownPreview m={open} onClose={() => setOpen(null)} />}
      {open && !isMarkdown(open) && <Lightbox m={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
