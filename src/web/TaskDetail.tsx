// タスクの詳細（本文・つながり・記録）
import type { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppTask, AppTaskEvent, AppTaskLinks, AppTaskList, AppTaskStatus, MemoSummary, Snapshot } from "../shared/types";
import { BodyEditor, FolderIcon, json, TagField } from "./memo-fields";
import { Icon, ago, profileOf } from "./ui";
import { STATUS_LABEL, SOURCE_LABEL, STATUS_DOT, OPEN, UNDONE_LABEL, taskDot, dueLabel, DUE_CLS, TaskRow } from "./TaskRow";
import { createTask, fetchTask, patchTask } from "./task-db";
import { KANBAN_STATUS } from "./Task";
import { CopyRef } from "./touch";
import { PrPanel } from "./PrPanel";
import { Skeleton } from "./loading";
import { ownerName } from "./identity";

type LinkKind = "parent" | "blocks" | "blocked_by" | "related";

const LINK_KINDS: { id: LinkKind; label: string; hint: string }[] = [
  { id: "related", label: "関連", hint: "関係のあるタスク" },
  { id: "blocked_by", label: "待っている", hint: "これが済まないと進められない" },
  { id: "blocks", label: "止めている", hint: "これが済むまで相手が進めない" },
  { id: "parent", label: "親", hint: "このタスクを入れる親" },
];

/** つながりの種類の小さな印（線画） */
function LinkGlyph({ kind }: { kind: LinkKind }) {
  const d: Record<LinkKind, string> = {
    parent: "M8 15V9a3 3 0 013-3h7M15 3l3 3-3 3",
    blocks: "M5 12h9M11 8l4 4-4 4M19 6v12",
    blocked_by: "M19 12h-9M13 8l-4 4 4 4M5 6v12",
    related: "M10 14a4 4 0 005.7 0l2.8-2.8a4 4 0 00-5.7-5.7L11.5 6.8M14 10a4 4 0 00-5.7 0l-2.8 2.8a4 4 0 005.7 5.7l1.3-1.3",
  };
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d[kind]} />
    </svg>
  );
}

/** つなぐ相手を題名か番号で探す（開いているもの＋完了） */
function LinkPicker({ selfId, exclude, onPick, onClose }: { selfId: number; exclude: Set<number>; onPick: (kind: LinkKind, t: AppTask) => Promise<boolean>; onClose: () => void }) {
  const [kind, setKind] = useState<LinkKind>("related");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<AppTask[]>([]);
  useEffect(() => {
    const p = new URLSearchParams({ status: "inbox,todo,doing,done" });
    if (q.trim()) p.set("q", q.trim());
    const tm = setTimeout(
      () =>
        fetch(`/api/apptasks?${p}`)
          .then((r) => json<AppTaskList>(r))
          .then((l) => setHits(l.tasks.filter((t) => t.id !== selfId && !exclude.has(t.id)).slice(0, 8)))
          .catch(() => setHits([])),
      q ? 180 : 0,
    );
    return () => clearTimeout(tm);
  }, [q, selfId, exclude]);
  return (
    <div className="mt-1 overflow-hidden rounded-xl border border-line-2 bg-panel shadow-sm">
      <div className="flex gap-1 border-b border-line p-1.5" role="radiogroup" aria-label="つなぎ方">
        {LINK_KINDS.map((k) => (
          <button key={k.id} role="radio" aria-checked={kind === k.id} title={k.hint} onClick={() => setKind(k.id)} className={`flex h-8 flex-1 items-center justify-center gap-1 rounded-lg text-[12px] ${kind === k.id ? "bg-ink font-semibold text-paper" : "text-ink-2 hover:bg-chip"}`}>
            <LinkGlyph kind={k.id} />
            {k.label}
          </button>
        ))}
      </div>
      <div className="px-3 pt-2 text-[11px] text-mute">{LINK_KINDS.find((k) => k.id === kind)!.hint}</div>
      <label className="mx-2 mt-1 flex h-9 items-center gap-2 rounded-lg bg-chip px-2.5 text-mute">
        <Icon name="search" size={14} />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onClose()} placeholder="題名か番号（TASK-123）で探す" aria-label="つなぐタスクを探す" className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-mute" />
      </label>
      <ul className="m-0 max-h-64 list-none overflow-y-auto p-1">
        {hits.length === 0 && <li className="px-3 py-2 text-[12.5px] text-mute">当てはまるタスクはありません</li>}
        {hits.map((t) => (
          <li key={t.id}>
            <button onClick={() => void onPick(kind, t).then((ok) => ok && setQ(""))} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-chip/70">
              <span className="size-2 flex-none rounded-full" style={{ background: taskDot(t) }} />
              <span className="w-[58px] flex-none font-mono text-[11px] text-mute">{t.ref ?? `#${t.id}`}</span>
              <span className={`min-w-0 flex-1 truncate ${t.status === "done" ? "text-mute line-through" : "text-ink"}`}>{t.title}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex justify-end border-t border-line px-2 py-1.5">
        <button onClick={onClose} className="rounded-md px-2.5 py-1 text-[12px] text-mute hover:text-ink">閉じる</button>
      </div>
    </div>
  );
}

/** 親・サブタスク・待っている／止めている・関連。親は見出しの上にパンくずで、ほかは種類ごとの1枚の板に */
function LinksSection({ id, task, links, snap, onChanged }: { id: number; task: AppTask; links: AppTaskLinks; snap: Snapshot | null; onChanged: (l: AppTaskLinks, ev?: AppTaskEvent[]) => void }) {
  const [picking, setPicking] = useState(false);
  const [sub, setSub] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const post = async (path: string, body: unknown) => {
    try {
      const r = await json<{ links: AppTaskLinks; events?: AppTaskEvent[] }>(await fetch(`/api/apptasks/${id}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      setErr(null);
      onChanged(r.links, r.events);
      return true;
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      return false;
    }
  };
  const refresh = async () => {
    const r = await fetchTask(id);
    onChanged(r.links, r.events);
  };
  const addSub = async () => {
    const title = sub.trim();
    if (!title) return;
    await createTask({ title, parentId: id });
    setSub("");
    await refresh();
  };
  const pick = (kind: LinkKind, t: AppTask) => (kind === "parent" ? post("parent", { parent: t.id }) : post("link", { other: t.id, kind, on: true }));
  const linked = useMemo(() => new Set([...(links.parent ? [links.parent.id] : []), ...links.children.map((t) => t.id), ...links.blocks.map((t) => t.id), ...links.blockedBy.map((t) => t.id), ...links.related.map((t) => t.id)]), [links]);
  const groups: [LinkKind, string, AppTask[], (t: AppTask) => void][] = [
    ["blocked_by", "待っている", links.blockedBy, (t) => void post("link", { other: t.id, kind: "blocked_by", on: false })],
    ["blocks", "止めている", links.blocks, (t) => void post("link", { other: t.id, kind: "blocks", on: false })],
    ["related", "関連", links.related, (t) => void post("link", { other: t.id, kind: "related", on: false })],
  ];
  const left = links.children.filter((c) => c.status !== "done").length;
  const row = (kind: LinkKind, t: AppTask, remove: () => void) => (
    <li key={t.id} className="group flex items-center gap-2.5 px-3 py-2">
      <span className={kind === "blocked_by" && t.status !== "done" ? "text-orange-ink" : "text-mute"}><LinkGlyph kind={kind} /></span>
      <a href={`#/todo/${t.id}`} className="flex min-w-0 flex-1 items-center gap-2 text-[13px] no-underline">
        <span className="size-2 flex-none rounded-full" style={{ background: taskDot(t) }} title={STATUS_LABEL[t.status]} />
        <span className="flex-none font-mono text-[11px] text-mute">{t.ref ? <CopyRef text={t.ref} /> : `#${t.id}`}</span>
        <span className={`min-w-0 flex-1 truncate ${t.status === "done" ? "text-mute line-through" : "text-ink"}`}>{t.title}</span>
      </a>
      <button onClick={remove} aria-label={`${t.ref ?? t.id} とのつながりを外す`} className="flex size-7 flex-none items-center justify-center rounded-md text-mute opacity-60 hover:bg-chip hover:text-ink hover:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
        <Icon name="close" size={14} />
      </button>
    </li>
  );
  return (
    <section className="mt-5 flex flex-col gap-4" aria-label="つながり">
      {/* 親: パンくずのように */}
      {links.parent && (
        <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-mute">
          <LinkGlyph kind="parent" />
          <a href={`#/todo/${links.parent.id}`} className="min-w-0 truncate text-ink-2 no-underline hover:text-ink">
            <span className="font-mono text-[11px]">{links.parent.ref ? <CopyRef text={links.parent.ref} /> : null}</span> {links.parent.title}
          </a>
          <button onClick={() => void post("parent", { parent: null })} aria-label="親から外す" className="flex size-6 flex-none items-center justify-center rounded text-mute hover:bg-chip hover:text-ink"><Icon name="close" size={12} /></button>
        </div>
      )}

      {/* サブタスク */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-[12px] font-semibold text-mute">
          サブタスク
          {links.children.length > 0 && (
            <>
              <span className="h-1 w-16 overflow-hidden rounded-full bg-line" aria-hidden="true">
                <span className="block h-full rounded-full bg-lime" style={{ width: `${((links.children.length - left) / links.children.length) * 100}%` }} />
              </span>
              <span className="font-normal tabular-nums">{links.children.length - left}/{links.children.length}</span>
            </>
          )}
        </div>
        <div className="rounded-xl border border-line bg-panel">
          {links.children.length > 0 && (
            <ul className="m-0 list-none p-0 py-0.5">
              {links.children.map((c) => (
                <li key={c.id}>
                  <TaskRow t={{ ...c, project: c.project === task.project ? null : c.project }} selected={false} href={`#/todo/${c.id}`} onChanged={() => void refresh()} onToggle={() => void fetch(`/api/apptasks/${c.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: c.status === "done" ? "todo" : "done" }) }).then(refresh)} snap={snap} />
                </li>
              ))}
            </ul>
          )}
          <label className={`flex h-10 items-center gap-2 px-4 text-mute ${links.children.length ? "border-t border-line" : ""}`}>
            <span aria-hidden="true" className="text-[16px] leading-none">＋</span>
            <span className="sr-only">サブタスクを追加</span>
            <input value={sub} onChange={(e) => setSub(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void addSub()} placeholder="サブタスクを追加" className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-mute" />
          </label>
        </div>
      </div>

      {/* 待っている・止めている・関連 */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center text-[12px] font-semibold text-mute">
          つながり
          {!picking && (
            <button onClick={() => setPicking(true)} className="ml-auto flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-normal text-ink-2 hover:bg-chip">
              <span aria-hidden="true">＋</span>つなぐ
            </button>
          )}
        </div>
        {groups.some(([, , ts]) => ts.length) ? (
          <div className="flex flex-col gap-2">
            {groups.map(([kind, label, ts, remove]) =>
              ts.length ? (
                <div key={kind} className="rounded-xl border border-line bg-panel">
                  <div className="px-3 pt-2 text-[11px] text-mute">{label}<span className="ml-1 tabular-nums">{ts.length}</span></div>
                  <ul className="m-0 list-none divide-y divide-line p-0">{ts.map((t) => row(kind, t, () => remove(t)))}</ul>
                </div>
              ) : null,
            )}
          </div>
        ) : (
          !picking && <div className="rounded-xl border border-dashed border-line-2 px-3 py-2.5 text-[12.5px] text-mute">待っている・止めている・関連のタスクはありません</div>
        )}
        {picking && <LinkPicker selfId={id} exclude={linked} onPick={pick} onClose={() => setPicking(false)} />}
        {err && <div className="text-[12px] text-orange-ink" role="alert">{err}</div>}
      </div>
    </section>
  );
}

const KIND_LABEL: Record<AppTaskEvent["kind"], string> = { create: "登録", update: "更新", reopen: "BackLog へ", decide: "判断", kanban: "任せ中へ", done: "完了", comment: "コメント", ignored: "無視" };

function StatusButton({ status, on, outlined, onPick }: { status: AppTaskStatus; on: boolean; outlined?: boolean; onPick: () => void }) {
  return (
    <button
      role="radio"
      aria-checked={on}
      onClick={() => !on && onPick()}
      className={`flex flex-none items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-1.5 text-[12px] min-[390px]:px-2 ${on ? "border-ink bg-ink font-semibold text-paper" : `${outlined ? "border-line-2" : "border-transparent"} text-ink-2 hover:border-ink`}`}
    >
      <span className="size-1.5 flex-none rounded-full" style={{ background: STATUS_DOT[status] }} />
      {STATUS_LABEL[status]}
    </button>
  );
}

export function TaskDetail({ id, snap, onChanged, onBack }: { id: number; snap: Snapshot | null; onChanged: () => void; onBack: () => void }) {
  const [task, setTask] = useState<AppTask | null>(null);
  const [events, setEvents] = useState<AppTaskEvent[]>([]);
  const [card, setCard] = useState<string | null>(null);
  const [links, setLinks] = useState<AppTaskLinks | null>(null);
  const [mentions, setMentions] = useState<MemoSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  const [comment, setComment] = useState("");
  const viewRef = useRef<EditorView | null>(null);
  const [offlineView, setOfflineView] = useState(false);
  const base = useRef<number | undefined>(undefined);
  const pending = useRef<{ title?: string; body?: string; project?: string | null; due?: string | null; tags?: string[] }>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetchTask(id);
      setOfflineView(!!r.local);
      setTask(r.task);
      setEvents(r.events);
      setLinks(r.links);
      setMentions(r.memos ?? []);
      setCard(r.card);
      base.current = r.task.updatedAt;
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      setSaving("saving");
      try {
        const t = await patchTask(id, { ...body, baseUpdatedAt: base.current });
        base.current = t.updatedAt;
        setTask(t);
        setSaving("saved");
        setError(null);
        onChanged();
        const r = await fetchTask(id);
        if (!r.local) {
          setEvents(r.events);
          setCard(r.card);
        }
      } catch (e) {
        setSaving("error");
        setError(String(e instanceof Error ? e.message : e));
      }
    },
    [id, onChanged],
  );

  // 題・本文・プロジェクト・期日は、止まって 0.8 秒で保存する
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    pending.current = {};
    if (Object.keys(p).length) await patch(p);
  }, [patch]);
  const edit = (p: typeof pending.current) => {
    pending.current = { ...pending.current, ...p };
    setTask((t) => (t ? ({ ...t, ...p } as AppTask) : t));
    setSaving("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 800);
  };
  useEffect(() => () => void flush(), [flush]);

  const setStatus = async (status: AppTaskStatus) => {
    await flush();
    await patch({ status });
  };

  const sendComment = async () => {
    const text = comment.trim();
    if (!text) return;
    try {
      const r = await json<{ task: AppTask; events: AppTaskEvent[] }>(
        await fetch(`/api/apptasks/${id}/comment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }),
      );
      setEvents(r.events);
      setComment("");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const who = (a: string) => {
    if (a === "app") return ownerName();
    if (a.startsWith("imported:")) return a.slice("imported:".length);
    if (a === "github") return "GitHub";
    if (a === "kanban") return "カンバン";
    const id2 = a.startsWith("hermes/") ? a.slice("hermes/".length) : a;
    return snap ? profileOf(snap.agents, id2).name : id2;
  };
  const d = task ? dueLabel(task.due) : null;
  // 前のツールから移したものは出どころを出さない
  const src = task ? (task.source === "imported" ? "" : (SOURCE_LABEL[task.source] ?? task.source)) : "";
  const closed = task?.status === "done";
  const kanbanCard = task?.kanbanId ? snap?.board?.tasks.find((b) => b.id === task.kanbanId) : undefined;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-ground">
      <div className="flex items-center gap-1 px-2 pb-1 pt-[max(env(safe-area-inset-top),10px)]">
        <button onClick={onBack} aria-label="一覧へ" className="flex size-11 flex-none items-center justify-center text-ink-2 lg:hidden">
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
        <span className="min-w-0 flex-1 truncate px-2 text-[12.5px] text-mute"><span className="font-mono">{task?.ref ? <CopyRef text={task.ref} /> : `#${id}`}</span>{src ? ` · ${src}` : ""}{task ? ` · 登録 ${ago(task.createdAt)}（${who(task.createdBy)}）` : ""}</span>
        <span className={`flex-none px-2 text-[11.5px] ${saving === "error" ? "text-orange-ink" : "text-mute"}`} role="status" aria-live="polite">
          {saving === "saving" ? "保存中…" : saving === "saved" ? "保存済み" : saving === "dirty" ? "編集中" : ""}
        </span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-10 [overflow-wrap:anywhere] md:px-10">
        <div className="mx-auto w-full max-w-[860px]">
          {error && <div className="mb-3 rounded-lg bg-orange-soft px-3 py-2 text-xs text-orange-ink" role="alert">{error}</div>}
          {offlineView && <div className="mb-3 rounded-lg bg-chip px-3 py-2 text-xs text-ink-2">オフラインです。題・本文・期日・状態は端末に残して、つながったら送ります。記録・コメント・つながりはオンラインのときだけ使えます。</div>}
          {!task && !error && <Skeleton />}
          {task && (
            <>
              {card && (
                <a href={`#/card/${encodeURIComponent(card)}`} className="mb-3 flex items-center gap-2 rounded-xl border border-orange/40 bg-orange-soft px-3 py-2.5 text-[13px] font-semibold text-orange-ink no-underline">
                  BackLog にあります。カードで選ぶ <span className="ml-auto">›</span>
                </a>
              )}
              <textarea
                value={task.title}
                onChange={(e) => edit({ title: e.target.value.replace(/\n/g, "") })}
                onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && (e.preventDefault(), viewRef.current?.focus())}
                rows={1}
                aria-label="題"
                ref={(el) => {
                  if (el) {
                    el.style.height = "auto";
                    el.style.height = `${el.scrollHeight}px`;
                  }
                }}
                className={`mt-2 block w-full resize-none overflow-hidden bg-transparent text-[21px] font-bold leading-tight tracking-tight outline-none ${closed ? "text-mute line-through" : "text-ink"}`}
              />

              {/* 状態 */}
              <div className="mt-5 flex max-w-[440px] items-center gap-1" role="radiogroup" aria-label="状態">
                <div className={`relative flex min-w-0 flex-1 items-center justify-between rounded-full border p-0.5 ${closed ? "border-line" : "border-ink"}`} role="group" aria-label={UNDONE_LABEL}>
                  <span className={`absolute -top-2 left-3 bg-ground px-1 text-[10px] font-semibold leading-none ${closed ? "text-mute" : "text-ink"}`}>{UNDONE_LABEL}</span>
                  {OPEN.map((s) => (
                    <StatusButton key={s} status={s} on={task.status === s} onPick={() => void setStatus(s)} />
                  ))}
                </div>
                <StatusButton status="done" on={task.status === "done"} outlined onPick={() => void setStatus("done")} />
              </div>
              {closed && (
                <button
                  aria-pressed={task.doneReason === "unneeded"}
                  onClick={() => void patch({ status: "done", doneReason: task.doneReason === "unneeded" ? null : "unneeded" })}
                  className={`mt-1.5 rounded-full border px-3 py-1 text-[12px] ${task.doneReason === "unneeded" ? "border-ink font-semibold text-ink" : "border-line text-mute hover:border-ink"}`}
                >
                  理由: 不要
                </button>
              )}

              {/* プロパティ */}
              <div className="mt-4 flex flex-col gap-0.5 border-b border-line pb-4 text-[13.5px]">
                <div className="flex items-center gap-3">
                  <span className="flex w-28 flex-none items-center gap-2 text-mute"><FolderIcon />プロジェクト</span>
                  <input value={task.project ?? ""} onChange={(e) => edit({ project: e.target.value || null })} placeholder="なし" aria-label="プロジェクト" className="min-h-8 min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-mute" />
                </div>
                <div className="flex items-start gap-3">
                  <span className="flex min-h-8 w-28 flex-none items-center gap-2 text-mute">#　タグ</span>
                  <TagField tags={task.tags} onChange={(tags) => edit({ tags })} suggestions={[]} />
                </div>
                <div className="flex items-center gap-3">
                  <span className="flex w-28 flex-none items-center gap-2 text-mute"><Icon name="calendar" size={14} />期日</span>
                  <input type="date" value={task.due ?? ""} onChange={(e) => edit({ due: e.target.value || null })} aria-label="期日" className="min-h-8 bg-transparent text-ink outline-none" />
                  {d && <span className={`text-[12px] ${DUE_CLS[d.tone]}`}>{d.text}</span>}
                </div>
                {task.url && task.source !== "imported" && (
                  <div className="flex items-center gap-3">
                    <span className="flex w-28 flex-none items-center gap-2 text-mute">リンク</span>
                    <span className="min-w-0 flex-1 truncate text-ink-2">
                      {src}
                      {task.url && <a href={task.url} target="_blank" rel="noopener noreferrer" className="ml-2 text-blue">開く ↗</a>}
                    </span>
                  </div>
                )}
                {task.source === "github" && task.url && !closed && <PrPanel url={task.url} />}
                {task.kanbanId && (
                  <div className="flex items-center gap-3">
                    <span className="flex w-28 flex-none items-center gap-2 text-mute">カンバン</span>
                    <a href={`#/task/${encodeURIComponent(task.kanbanId)}`} className="min-w-0 truncate text-blue">{task.kanbanId}{task.agent && snap ? `（${profileOf(snap.agents, task.agent).name}）` : ""}</a>
                    {kanbanCard && <span className={`flex-none rounded-full px-2 py-0.5 text-[10.5px] ${KANBAN_STATUS[kanbanCard.status]?.cls ?? "bg-chip text-mute"}`}>{KANBAN_STATUS[kanbanCard.status]?.label ?? kanbanCard.status}</span>}
                  </div>
                )}
                {task.status === "doing" && !task.kanbanId && (
                  <div className="flex items-center gap-3">
                    <span className="flex w-28 flex-none items-center gap-2 text-mute">カンバン</span>
                    <span className="text-mute">なし（エージェントが直接進めている）</span>
                  </div>
                )}
              </div>

              {links && <LinksSection id={id} task={task} links={links} snap={snap} onChanged={(l, ev) => { setLinks(l); if (ev) setEvents(ev); onChanged(); }} />}

              <div className="pt-4">
                <BodyEditor initial={task.body} onChange={(body) => edit({ body })} viewRef={viewRef} autoFocus={false} readOnly={false} minClass="min-h-[96px] [&_.cm-content]:!pb-6" hint="メモ・手順（Markdown）" />
              </div>

              {/* このタスクに触れているメモ（本文に [[番号]] があるもの） */}
              <section className="mt-6 border-t border-line pt-4" aria-label="関連するメモ">
                <div className="flex items-baseline pb-2 text-[12px] font-semibold text-mute">
                  このタスクに触れているメモ
                  {task.ref && (
                    <a href={`#/memo/new?${new URLSearchParams({ link: task.ref, ...(task.project ? { project: task.project } : {}) })}`} className="ml-auto font-normal text-ink-2">＋ メモを書く</a>
                  )}
                </div>
                {mentions.length === 0 && <div className="text-[12.5px] text-mute">まだありません。メモに [[{task.ref ?? "TASK-123"}]] と書くと、ここに出ます</div>}
                {mentions.map((m) => (
                  <a key={m.id} href={`#/memo/${m.id}`} className="-mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13.5px] text-ink no-underline hover:bg-chip/60">
                    <Icon name="memo" size={14} />
                    <span className="min-w-0 flex-1 truncate">{m.title}</span>
                    <span className="flex-none text-[11px] text-mute">{ago(m.updatedAt)}</span>
                  </a>
                ))}
              </section>

              {/* 記録とコメント */}
              <section className="mt-6 border-t border-line pt-4" aria-label="記録">
                <div className="pb-2 text-[12px] font-semibold text-mute">記録</div>
                <div className="mb-3 flex items-center gap-2 rounded-lg border border-line-2 bg-panel px-3">
                  <input
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void sendComment()}
                    placeholder="コメントを残す（Enter）"
                    aria-label="コメント"
                    className="min-h-10 min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-mute"
                  />
                </div>
                <ol className="m-0 flex list-none flex-col gap-2 p-0">
                  {events.map((e) => (
                    <li key={e.id} className="flex gap-2 text-[12.5px]">
                      <span className="w-20 flex-none tabular-nums text-mute">{new Date(e.at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                      <span className="min-w-0 flex-1 text-ink-2">
                        <span className="font-semibold text-ink">{who(e.author)}</span> {KIND_LABEL[e.kind]}
                        {e.text && <span className="whitespace-pre-wrap text-ink-2"> — {e.text}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
