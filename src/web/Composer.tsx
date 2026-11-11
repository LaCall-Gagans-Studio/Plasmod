// 発言の入力欄（添付・音声つき）
import { type ReactNode, useEffect, useRef, useState } from "react";
import { submit, takeShared, useSharedVersion } from "./outbox";
import { MicButton } from "./speech";
import { Icon } from "./ui";
import { recall, remember } from "./session-data";
import { Thumb } from "./SessionBody";
import { continueList } from "./list-continue";

const PICK_ACCEPT = "image/*,application/pdf,text/*,application/zip,application/json,.md,.csv,.docx,.xlsx,.pptx";

/** ＋ のメニューに並べるもの。写真はスマホの写真選択、ファイルはファイル選択が開く */
const pickers: { id: string; label: string; accept: string; icon: ReactNode }[] = [
  { id: "camera", label: "カメラ", accept: "image/*", icon: <><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></> },
  { id: "photo", label: "写真", accept: "image/*,video/*", icon: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M20.5 16l-5-5-8.5 8.5" /></> },
  { id: "file", label: "ファイル", accept: PICK_ACCEPT, icon: <path d="M20 11.5l-8 8a5 5 0 01-7-7l8.5-8.5a3.5 3.5 0 015 5L10 17.5a2 2 0 01-3-3L14.5 7" /> },
];

/** 入力欄。写真（カメラ）・ファイル・共有メニューから受け取ったものを添えて送れる。送信したら入力欄はすぐ空になる（吹き出しは送信中として先に出る） */
export function Composer({ onSend, placeholder, busy, draftKey }: { onSend: (text: string, files: File[]) => void; placeholder: string; busy?: boolean; draftKey?: string }) {
  // 書きかけは端末に覚えておく（別の画面に行っても、アプリを閉じても残る）。送ったら消す
  const storeKey = draftKey ? `gh-draft:${draftKey}` : null;
  const keyRef = useRef(storeKey);
  const [text, setTextState] = useState(() => (storeKey ? (recall(storeKey) ?? "") : ""));
  useEffect(() => {
    keyRef.current = storeKey;
    setTextState(storeKey ? (recall(storeKey) ?? "") : "");
  }, [storeKey]);
  const setText = (v: string | ((x: string) => string)) =>
    setTextState((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      if (keyRef.current) remember(keyRef.current, next || null);
      return next;
    });
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  // ＋ で開く添付のメニュー（カメラ・写真・ファイルを選ぶ）
  const [menu, setMenu] = useState(false);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const sharedVersion = useSharedVersion();
  useEffect(() => {
    const got = takeShared();
    if (got.files.length) setFiles((x) => [...x, ...got.files]);
    if (got.text) setText((x) => [x, got.text].filter(Boolean).join("\n"));
  }, [sharedVersion]);

  const add = (list: FileList | File[] | null) => {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;
    const big = picked.find((f) => f.size > 25 * 1024 * 1024);
    if (big) return setError(`${big.name} は 25MB を超えている`);
    setError(null);
    setFiles((x) => [...x, ...picked].slice(0, 10));
  };
  const canSend = !busy && (text.trim() !== "" || files.length > 0);
  const submitNow = () => {
    if (!canSend) return;
    onSend(text.trim(), files);
    setText("");
    setFiles([]);
    setError(null);
  };
  const attachBtn = "flex size-8 flex-none cursor-pointer items-center justify-center rounded-full text-mute hover:text-ink";
  // 改行では送らない（送るのはボタンか Ctrl/⌘+Enter）。高さは中身に合わせて6行まで伸ばす
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 6 * 20)}px`;
  }, [text]);
  return (
    <div className="relative flex flex-col gap-1.5">
      {menu && (
        <>
          {/* 外を押したら閉じる */}
          <button type="button" aria-label="閉じる" className="fixed inset-0 z-10 cursor-default" onClick={() => setMenu(false)} />
          <div role="menu" className="gh-rise absolute bottom-full left-0 z-20 mb-2 flex gap-1 rounded-2xl border border-line-2 bg-panel p-1.5 shadow-xl">
            {pickers.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  inputs.current[p.id]?.click();
                }}
                className="flex w-[72px] flex-col items-center gap-1 rounded-xl px-2 py-2.5 text-[11.5px] text-ink hover:bg-chip"
              >
                <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">{p.icon}</svg>
                {p.label}
              </button>
            ))}
          </div>
        </>
      )}
      {error && <div className="text-xs text-orange-ink" role="alert">{error}</div>}
      {files.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto pb-0.5" aria-label="添付">
          {files.map((f, i) => <Thumb key={`${f.name}${i}`} f={f} onRemove={() => setFiles((x) => x.filter((_, j) => j !== i))} />)}
        </div>
      )}
      <form
        className="flex min-h-12 items-end gap-1 rounded-md border border-line-2 py-1.5 pl-1 pr-2 font-mono"
        onSubmit={(e) => {
          e.preventDefault();
          submitNow();
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          add(e.dataTransfer.files);
        }}
      >
        <button
          type="button"
          onClick={() => setMenu((x) => !x)}
          aria-label={menu ? "添付のメニューを閉じる" : "添付する（カメラ・写真・ファイル）"}
          aria-expanded={menu}
          className={attachBtn}
        >
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true" className={`transition-transform duration-200 ${menu ? "rotate-45" : ""}`}><path d="M12 5v14M5 12h14" /></svg>
        </button>
        {pickers.map((p) => (
          <input key={p.id} ref={(el) => void (inputs.current[p.id] = el)} type="file" multiple={p.id !== "camera"} accept={p.accept} {...(p.id === "camera" ? { capture: "environment" as const } : {})} className="hidden" onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
        ))}
        <span className="flex h-8 items-center text-[#D97757]">&gt;</span>
        <label className="flex min-h-8 min-w-0 flex-1 items-center">
          <span className="sr-only">メッセージ</span>
          <textarea
            ref={area}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submitNow();
                return;
              }
              // 日本語入力の確定の Enter には触れない。修飾キーつきも対象外（送信は Ctrl/⌘+Enter のまま）
              if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return;
              const el = e.currentTarget;
              const edit = continueList(el.value, el.selectionStart, el.selectionEnd);
              if (!edit) return;
              e.preventDefault();
              setText(edit.value);
              requestAnimationFrame(() => el.setSelectionRange(edit.caret, edit.caret));
            }}
            onPaste={(e) => {
              const imgs = Array.from(e.clipboardData.files);
              if (imgs.length) {
                e.preventDefault();
                add(imgs);
              }
            }}
            placeholder={placeholder}
            disabled={busy}
            className="block w-full resize-none bg-transparent py-1.5 text-[13px] leading-5 text-ink outline-none disabled:opacity-50"
          />
        </label>
        <MicButton onText={(t) => setText((x) => x + t)} size={36} />
        <button type="submit" disabled={!canSend} aria-label="送る" className="flex size-9 items-center justify-center rounded-full bg-ink text-paper disabled:opacity-30">
          <Icon name="send" size={16} />
        </button>
      </form>
    </div>
  );
}
