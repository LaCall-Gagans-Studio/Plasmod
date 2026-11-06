// タスクの行（一覧・ツリーで共通）
import { useEffect, useState } from "react";
import type { AppTask, AppTaskLinks, AppTaskStatus, Snapshot } from "../shared/types";
import { FolderIcon, json } from "./memo-fields";
import { openTaskMenu } from "./taskmenu";
import { CopyRef, useLongPress } from "./touch";
import { Avatar, profileOf } from "./ui";

/** 状態は4つ（Inbox・Todo・AI-Driven・Done）。不要は Done の理由なので、札では Done にまとめて小さく添える */
export const STATUS_LABEL: Record<AppTaskStatus, string> = { inbox: "Inbox", todo: "Todo", doing: "AI-Driven", done: "Done", dismissed: "Done" };

export const OPEN: AppTaskStatus[] = ["inbox", "todo", "doing"];

export const SOURCE_LABEL: Record<string, string> = { mail: "メール", beeper: "Beeper", ops: "ops", app: "", digest: "まとめ", kanban: "カンバン", perm: "承認", note: "メモ" };

export const STATUS_DOT: Record<AppTaskStatus, string> = {
  inbox: "var(--color-ring-orange)",
  todo: "var(--color-ink)",
  doing: "var(--color-ring-lime)",
  done: "var(--color-dot-done)",
  dismissed: "var(--color-line-2)",
};

/** 今日（日本時間）の YYYY-MM-DD */
/** 期限順の区切り */
export function dueBucket(due: string | null, now = Date.now()): string {
  if (!due) return "期日なし";
  const t = today(now);
  if (due < t) return "期限切れ";
  if (due === t) return "今日";
  if (due === today(now + 86_400_000)) return "明日";
  const j = new Date(now + 9 * 3600_000);
  const dow = (j.getUTCDay() + 6) % 7;
  const sunday = new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate() - dow + 6)).toISOString().slice(0, 10);
  return due <= sunday ? "今週" : "来週以降";
}
export const BUCKETS = ["期限切れ", "今日", "明日", "今週", "来週以降", "期日なし"];
export const BUCKET_CLS: Record<string, string> = { 期限切れ: "text-red-ink", 今日: "text-orange-ink" };

export function today(now = Date.now()): string {
  return new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
}

/** 期日の見せ方: 過ぎた（赤）・今日（橙）・明日・日付 */
export function dueLabel(due: string | null, now = Date.now()): { text: string; tone: "late" | "today" | "soon" | "later" } | null {
  if (!due) return null;
  const t = today(now);
  const tomorrow = today(now + 86_400_000);
  if (due < t) return { text: `${Number(due.slice(5, 7))}/${Number(due.slice(8, 10))} 期限切れ`, tone: "late" };
  if (due === t) return { text: "今日まで", tone: "today" };
  if (due === tomorrow) return { text: "明日まで", tone: "soon" };
  return { text: `${Number(due.slice(5, 7))}/${Number(due.slice(8, 10))}`, tone: "later" };
}

export const DUE_CLS = { late: "text-red-ink font-semibold", today: "text-orange-ink font-semibold", soon: "text-ink-2", later: "text-mute" } as const;

/** 状態の丸。押すと完了（完了なら「やる」に戻す）。開いているサブタスクがあれば、その数を中に出す */
export function CheckDot({ t, onToggle }: { t: AppTask; onToggle: () => void }) {
  const done = t.status === "done" || t.status === "dismissed";
  const n = done ? 0 : (t.openChildren ?? 0);
  return (
    <button
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      aria-label={done ? `「${t.title}」をやるに戻す` : `「${t.title}」を完了にする${n ? `（サブタスク ${n} 件）` : ""}`}
      className={`flex size-5 flex-none items-center justify-center rounded-full border-[1.5px] font-bold tabular-nums leading-none ${n > 9 ? "text-[8.5px]" : "text-[10px]"}`}
      style={{ borderColor: STATUS_DOT[t.status], background: done ? STATUS_DOT[t.status] : "transparent", color: done ? "var(--color-paper)" : "var(--color-ink-2)" }}
    >
      {done ? "✓" : n ? (n > 99 ? "99" : n) : ""}
    </button>
  );
}

/** 一覧の1行。長押し（PC は右クリック）でメニュー（開く・完了・期日・不要・削除） */
export function TaskRow({ t, selected, href, onToggle, snap, expand, onChanged }: { t: AppTask; selected: boolean; href: string; onToggle: () => void; snap: Snapshot | null; expand?: { open: boolean; onToggle: () => void }; onChanged?: () => void }) {
  const press = useLongPress(() => openTaskMenu(t, onChanged));
  const d = dueLabel(t.due);
  const src = t.source === "imported" ? "" : (SOURCE_LABEL[t.source] ?? t.source);
  const agent = t.status === "doing" && t.agent && snap ? profileOf(snap.agents, t.agent) : null;
  return (
    <a href={href} {...press} aria-current={selected ? "page" : undefined} className={`mx-2 flex min-w-0 select-none items-start gap-2.5 rounded-lg px-2.5 py-2 text-ink no-underline [-webkit-touch-callout:none] ${selected ? "bg-chip" : "hover:bg-chip/60"}`}>
      <span className="pt-0.5"><CheckDot t={t} onToggle={onToggle} /></span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={`text-[13.5px] leading-snug ${t.status === "done" || t.status === "dismissed" ? "text-mute line-through" : "font-medium"}`}>{t.title}</span>
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-mute">
          {t.ref && <CopyRef text={t.ref} className="font-mono text-[10.5px]" />}
          {t.status === "inbox" && <span className="font-semibold text-orange-ink">Inbox</span>}
          {t.status === "dismissed" && <span>不要</span>}
          {d && <span className={DUE_CLS[d.tone]}>{d.text}</span>}
          {t.project && <span className="flex items-center gap-1"><FolderIcon size={11} />{t.project}</span>}
          {t.tags?.map((g) => <span key={g} className="text-blue">#{g}</span>)}
          {src && <span className="rounded bg-chip px-1.5 text-[10.5px]">{src}</span>}
          {agent && (
            <span className="flex items-center gap-1"><Avatar p={agent} size={14} />{agent.name}・AI-Driven</span>
          )}
        </span>
      </span>
      {expand && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            expand.onToggle();
          }}
          aria-expanded={expand.open}
          aria-label={`「${t.title}」のサブタスクを${expand.open ? "畳む" : "開く"}`}
          className="-my-1 -mr-1.5 flex size-8 flex-none items-center justify-center rounded-md text-mute hover:bg-chip hover:text-ink"
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true" className={`transition-transform ${expand.open ? "rotate-90" : ""}`}><path d="M9 6l6 6-6 6" /></svg>
        </button>
      )}
    </a>
  );
}

/** 一覧に親も入っているサブタスクを外す（親の下に畳んで出すので） */
export function topLevel(ts: AppTask[], all: AppTask[] = ts): AppTask[] {
  const ids = new Set(all.map((t) => t.id));
  return ts.filter((t) => !t.parentId || !ids.has(t.parentId));
}

/** 一覧の1件。サブタスクがあれば普段は畳んでおき、開いたときに取りに行く（孫も同じように開ける） */
export function TaskNode({ t, snap, onToggle, onChanged, href = (x) => `#/todo/${x.id}`, selectedId = null, hideProject = false }: { t: AppTask; snap: Snapshot | null; onToggle: (t: AppTask) => Promise<unknown> | void; onChanged?: () => void; href?: (t: AppTask) => string; selectedId?: number | null; hideProject?: boolean }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<AppTask[] | null>(null);
  const [bump, setBump] = useState(0);
  const has = (t.openChildren ?? 0) > 0;
  useEffect(() => {
    if (!open) return;
    fetch(`/api/apptasks/${t.id}`)
      .then((r) => json<{ links: AppTaskLinks }>(r))
      .then((r) => setChildren(r.links.children))
      .catch(() => setChildren([]));
  }, [open, t.id, t.openChildren, t.updatedAt, bump]);
  const row = hideProject ? { ...t, project: null } : t;
  return (
    <li>
      <TaskRow t={row} selected={t.id === selectedId} href={href(t)} onToggle={() => onToggle(t)} onChanged={onChanged} snap={snap} expand={has || open ? { open, onToggle: () => setOpen((x) => !x) } : undefined} />
      {open && (
        <ul className="m-0 ml-6 list-none border-l border-line p-0">
          {children === null && <li className="px-5 py-1.5 text-[12px] text-mute">読み込み中…</li>}
          {children?.map((c) => (
            <TaskNode key={c.id} t={{ ...c, project: c.project === t.project ? null : c.project }} snap={snap} href={href} selectedId={selectedId} onToggle={(x) => Promise.resolve(onToggle(x)).then(() => setBump((b) => b + 1))} onChanged={() => { onChanged?.(); setBump((b) => b + 1); }} />
          ))}
        </ul>
      )}
    </li>
  );
}
