// チャットに出す写真・ファイル。画像はその場に表示してタップで拡大、PDF・その他は開く／保存。
import { useEffect, useState } from "react";
import type { MediaItem } from "../shared/types";

const dl = (url: string) => url + (url.includes("?") ? "&" : "?") + "dl=1";
const size = (n?: number) => (n == null ? "" : n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function Image({ m, onOpen }: { m: MediaItem; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  if (broken)
    return (
      <span className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-[11px] text-mute">
        🖼 {m.name}（表示できなかった）
        <a href={dl(m.url)} className="underline">保存</a>
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
        <button type="button" onClick={onClose} aria-label="閉じる" className="flex size-9 items-center justify-center text-[18px]">×</button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-2">
        <img src={m.url} alt={m.name} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
      </div>
    </div>
  );
}

function FileCard({ m }: { m: MediaItem }) {
  return (
    <span className="flex max-w-full items-center gap-2.5 rounded-xl border border-line bg-panel px-3 py-2 text-[12px] text-ink-2">
      <span aria-hidden="true" className="text-[18px]">{m.kind === "pdf" ? "📕" : "📄"}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-ink">{m.name}</span>
        {m.size != null && <span className="text-[10.5px] text-mute">{size(m.size)}</span>}
      </span>
      {m.kind === "pdf" && <a href={m.url} target="_blank" rel="noopener noreferrer" className="flex-none rounded-md border border-line-2 px-2 py-1">開く</a>}
      <a href={dl(m.url)} className="flex-none rounded-md border border-line-2 px-2 py-1">保存</a>
    </span>
  );
}

export function MediaList({ items }: { items: MediaItem[] }) {
  const [open, setOpen] = useState<MediaItem | null>(null);
  if (!items.length) return null;
  return (
    <div className="mt-1.5 flex flex-col items-start gap-1.5">
      {items.map((m) => (m.kind === "image" ? <Image key={m.url} m={m} onOpen={() => setOpen(m)} /> : <FileCard key={m.url} m={m} />))}
      {open && <Lightbox m={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
