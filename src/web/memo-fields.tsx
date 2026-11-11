// メモとタスクで共通の入力部品
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { memoExtensions } from "./live-preview";

export { json, FolderIcon, TagIcon } from "./memo-light";

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
        placeholder={tags.length ? "" : "なし"}
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
