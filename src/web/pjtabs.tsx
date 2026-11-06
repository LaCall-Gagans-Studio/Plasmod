// プロジェクト・メモ・タスクの画面で共通の上の列: 「プロジェクト｜メモ｜タスク」の切り替えと、＋・歯車。
// 選んだときは白い背景が滑って動く（画面が切り替わっても、前の位置から動かす）。
import { useEffect, useState } from "react";
import { t as tr } from "./i18n";

export type PjTab = "pj" | "memos" | "tasks";

const TABS: { id: PjTab; label: string; href: string }[] = [
  { id: "pj", label: "プロジェクト", href: "#/pj" },
  { id: "memos", label: "メモ", href: "#/memos" },
  { id: "tasks", label: "タスク", href: "#/todos" },
];

/** 前の画面で選ばれていた位置（画面が作り直されても、そこから動かす） */
let lastIndex: number | null = null;

export function PjTabs({ current, onPlus, plusLabel }: { current: PjTab; onPlus: () => void; plusLabel: string }) {
  const idx = Math.max(0, TABS.findIndex((t) => t.id === current));
  const [pos, setPos] = useState(lastIndex ?? idx);
  // 切り替え先の画面を先に読み込んでおく（押してから読み込むと、白い背景が動き出すまで間があく）
  useEffect(() => {
    void import("./Projects");
    void import("./Memos");
    void import("./AppTasks");
  }, []);
  useEffect(() => {
    // 前の位置で一度描いてから、次の描画で今の位置へ（transition が効く）
    const r = requestAnimationFrame(() => setPos(idx));
    lastIndex = idx;
    return () => cancelAnimationFrame(r);
  }, [idx]);
  return (
    <div className="flex items-center gap-1.5 px-3 pb-2 pt-[max(env(safe-area-inset-top),12px)]">
      <div role="tablist" aria-label="見方" className="relative grid min-w-0 flex-1 grid-cols-3 rounded-full bg-chip p-0.5 text-[12.5px]">
        <span
          aria-hidden="true"
          className="absolute bottom-0.5 left-0.5 top-0.5 rounded-full bg-panel shadow-sm transition-transform duration-300 ease-[cubic-bezier(.2,.8,.2,1)]"
          style={{ width: "calc((100% - 4px) / 3)", transform: `translateX(${pos * 100}%)` }}
        />
        {TABS.map((t, i) => (
          <a
            key={t.id}
            role="tab"
            aria-selected={i === idx}
            href={t.href}
            onClick={() => setPos(i)}
            className={`relative z-10 truncate rounded-full py-1.5 text-center no-underline transition-colors duration-300 ${i === idx ? "font-semibold text-ink" : "text-ink-2"}`}
          >
            {tr(t.label)}
          </a>
        ))}
      </div>
      <button onClick={onPlus} aria-label={plusLabel} title={plusLabel} className="flex size-8 flex-none items-center justify-center rounded-full bg-ink text-paper">
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      <a href="#/pj/settings" aria-label="プロジェクトとタグの設定" title="プロジェクトとタグの設定" className="flex size-8 flex-none items-center justify-center rounded-full text-ink-2 hover:bg-chip">
        <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></svg>
      </a>
    </div>
  );
}
