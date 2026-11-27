// メモとタスクで共通の入力部品
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useId, useRef, useState } from "react";
import { memoExtensions } from "./live-preview";

export { json, FolderIcon, TagIcon } from "./memo-light";

/**
 * プロジェクトの選択（メモ・タスク共通）。入力の途中では何も作らない:
 * 検索ボックスで絞って選ぶか、「新しく追加」を選んだときだけ新しい名前が決まる
 */
export function ProjectField({ value, options, onChange, readOnly }: { value: string; options: string[]; onChange: (v: string) => void; readOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  const term = q.trim();
  const names = [...new Set([...options, ...(value ? [value] : [])])];
  const hits = names.filter((n) => n.toLowerCase().includes(term.toLowerCase()));
  // 並び: 未仕訳（外す）→ 一致したプロジェクト → 新しく追加（検索語があって、同じ名前がまだ無いとき）
  const items: { key: string; label: string; v: string; add?: boolean }[] = [
    ...(term ? [] : [{ key: "none", label: "未仕訳", v: "" }]),
    ...hits.map((n) => ({ key: `p:${n}`, label: n, v: n })),
    ...(term && !names.some((n) => n === term) ? [{ key: "add", label: `＋ 「${term}」を新しく追加`, v: term, add: true }] : []),
  ];
  const close = () => {
    setOpen(false);
    setQ("");
    setHi(0);
  };
  const pick = (v: string) => {
    if (v !== value) onChange(v);
    close();
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && close();
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  return (
    <div ref={box} className="relative min-w-0 flex-1">
      <button
        type="button"
        disabled={readOnly}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`プロジェクト: ${value || "未仕訳"}`}
        className={`flex min-h-8 w-full min-w-0 items-center gap-1 bg-transparent text-left outline-none disabled:cursor-default ${value ? "text-ink" : "text-mute"}`}
      >
        <span className="truncate">{value || "未仕訳"}</span>
        {!readOnly && <span className="ml-auto flex-none text-[10px] text-mute" aria-hidden="true">▾</span>}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-full min-w-56 max-w-80 rounded-xl border border-line-2 bg-panel p-1.5 shadow-lg">
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setHi(0);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "ArrowDown") (e.preventDefault(), setHi((h) => Math.min(h + 1, items.length - 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setHi((h) => Math.max(h - 1, 0)));
              else if (e.key === "Enter") {
                e.preventDefault();
                const it = items[hi];
                if (it) pick(it.v);
              } else if (e.key === "Escape") close();
            }}
            placeholder="プロジェクトを検索"
            aria-label="プロジェクトを検索"
            aria-controls={id}
            className="mb-1 min-h-9 w-full rounded-lg border border-line-2 bg-panel-2 px-2.5 text-[13.5px] text-ink outline-none focus:border-ink"
          />
          <div id={id} role="listbox" className="flex max-h-60 flex-col overflow-y-auto">
            {items.map((it, i) => (
              <button
                key={it.key}
                type="button"
                role="option"
                aria-selected={!it.add && it.v === value}
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(it.v)}
                className={`flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[13.5px] ${i === hi ? "bg-chip" : ""} ${it.add ? "font-semibold text-blue" : it.v ? "text-ink" : "text-mute"}`}
              >
                <span className="truncate">{it.label}</span>
                {!it.add && it.v === value && <span className="ml-auto flex-none text-[12px]" aria-hidden="true">✓</span>}
              </button>
            ))}
            {items.length === 0 && <div className="px-2 py-2 text-[12.5px] text-mute">当てはまるプロジェクトはありません</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export function TagField({ tags, onChange, suggestions }: { tags: string[]; onChange: (t: string[]) => void; suggestions: string[] }) {
  const [text, setText] = useState("");
  const add = (raw: string) => {
    const vs = raw.split(/[,、\s]+/).map((v) => v.replace(/^#+/, "").trim()).filter(Boolean);
    const next = [...tags];
    for (const v of vs) if (!next.includes(v)) next.push(v);
    if (next.length !== tags.length) onChange(next);
    setText("");
  };
  return (
    <div className="flex min-h-8 min-w-0 flex-1 flex-wrap items-center gap-1">
      {tags.map((t) => (
        <span key={t} className="flex items-center rounded-full bg-blue-soft py-0.5 pl-2 pr-0.5 text-[12.5px] text-blue">
          #{t}
          <button onClick={() => onChange(tags.filter((x) => x !== t))} aria-label={`タグ ${t} を外す`} className="flex size-5 items-center justify-center rounded-full opacity-60 hover:opacity-100">
            ×
          </button>
        </span>
      ))}
      <input
        value={text}
        list="memo-tags"
        onChange={(e) => (/[,、\s]$/.test(e.target.value) ? add(e.target.value) : setText(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            add(text);
          } else if (e.key === "Backspace" && !text && tags.length) onChange(tags.slice(0, -1));
        }}
        onBlur={() => text.trim() && add(text)}
        placeholder={tags.length ? "" : "未仕訳"}
        aria-label="タグ"
        className="min-w-20 flex-1 bg-transparent py-1 text-[13.5px] text-ink outline-none placeholder:text-mute"
      />
      <datalist id="memo-tags">
        {suggestions.filter((s) => !tags.includes(s)).map((s) => <option key={s} value={s} />)}
      </datalist>
    </div>
  );
}

/** Markdown の本文のエディタ（ライブプレビュー） */
export function BodyEditor({
  initial,
  onChange,
  viewRef,
  autoFocus,
  readOnly,
  minClass = "min-h-[50vh]",
  hint = "書きはじめる…",
  makeTask = null,
}: {
  initial: string;
  onChange: (t: string) => void;
  viewRef: React.MutableRefObject<EditorView | null>;
  autoFocus: boolean;
  readOnly: boolean;
  minClass?: string;
  hint?: string;
  /** チェックの行（- [ ] …）をタスクにする。作ったタスクの番号を返す */
  makeTask?: ((title: string) => Promise<string | null>) | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const makeRef = useRef(makeTask);
  makeRef.current = makeTask;
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: initial, extensions: [memoExtensions((t) => changeRef.current(t), hint, makeTask ? (title) => makeRef.current?.(title) ?? Promise.resolve(null) : null), EditorView.editable.of(!readOnly)] }),
    });
    viewRef.current = view;
    if (autoFocus) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 開いたときの中身だけで作る（以後はエディタが持つ）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={host} className={minClass} />;
}
