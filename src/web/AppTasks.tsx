// タスク（TASK-173 段階2）: 一覧（状態・プロジェクト・語で絞る、すぐ追加、チェックで完了）と、1件の中身。
// 広い画面では一覧と中身を左右に並べる。見回りが登録したもの（メール・Beeper・ops）も、画面で足したものも同じ一覧。
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppTask, AppTaskList, AppTaskStatus, Snapshot } from "../shared/types";
import { FolderIcon, json } from "./memo-fields";
import { PjTabs } from "./pjtabs";
import { AddField } from "./AddField";
import { createTask, fetchTaskList, patchTask, taskSync, TaskSyncBadge } from "./task-db";
import { Icon, Nav, RAIL } from "./ui";
import { BUCKETS, BUCKET_CLS, STATUS_LABEL, UNDONE_LABEL, OPEN, STATUS_DOT, dueBucket, topLevel, TaskNode } from "./TaskRow";
import { TaskDetail } from "./TaskDetail";
import { Skeleton } from "./loading";

function hashParams(): URLSearchParams {
  return new URLSearchParams(location.hash.split("?")[1] ?? "");
}

function listHref(p: URLSearchParams, id?: number | null) {
  const s = p.toString();
  return `${id ? `#/todo/${id}` : "#/todos"}${s ? `?${s}` : ""}`;
}

type SyncInfo = { enabled: boolean; mode?: string; at?: number | null; ok?: boolean; error?: string | null; counts?: Record<string, number> };

/** PR での自動完了に失敗しているときだけ出す。押すと今すぐ確かめる */
function SyncLine({ onSynced }: { onSynced: () => void }) {
  const [s, setS] = useState<{ pr: SyncInfo } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch("/api/apptasks-sync").then((r) => (r.ok ? r.json() : null)).then(setS).catch(() => {});
  }, []);
  if (!s?.pr.enabled || s.pr.ok !== false) return null;
  const run = async () => {
    setBusy(true);
    try {
      await fetch("/api/apptasks-sync", { method: "POST" });
      setS(await (await fetch("/api/apptasks-sync")).json());
      onSynced();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg bg-chip/60 px-3 py-1.5 text-[11.5px] text-mute">
      <span className="min-w-0 flex-1 truncate">
        <span className="text-orange-ink">PR の確認に失敗</span>
      </span>
      <button onClick={() => void run()} disabled={busy} className="flex-none rounded-full border border-line-2 px-2 py-0.5 text-[11px] text-ink-2 disabled:opacity-40">{busy ? "取り込み中…" : "今すぐ"}</button>
    </div>
  );
}

type Scope = "open" | "inbox" | "todo" | "doing" | "done";

/** Undone の中の状態。一覧の絞り込みでは Undone の枠の中に並べて、関係が見えるようにする */
const UNDONE_SCOPES = OPEN as ("inbox" | "todo" | "doing")[];

function ChipToggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button aria-pressed={on} onClick={onClick} className={`flex h-9 flex-none items-center whitespace-nowrap rounded-lg border px-2.5 text-[12px] ${on ? "border-ink font-semibold text-ink" : "border-line text-mute"}`}>
      {children}
    </button>
  );
}

function ScopeTab({ label, n, on, onPick }: { label: string; n: number; on: boolean; onPick: () => void }) {
  return (
    <button role="tab" aria-selected={on} onClick={onPick} className={`flex flex-none items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-1.5 text-[12px] min-[390px]:px-2 ${on ? "bg-ink font-semibold text-paper" : "text-ink-2 hover:bg-chip"}`}>
      {label}
      {n > 0 && <span className={`text-[10.5px] tabular-nums ${on ? "opacity-70 max-[359px]:hidden" : "text-mute max-[412px]:hidden"}`}>{n}</span>}
    </button>
  );
}

export function TasksScreen({ snap, id }: { snap: Snapshot | null; id: number | null }) {
  const params = hashParams();
  const raw = params.get("s");
  const scope: Scope = raw === "inbox" || raw === "todo" || raw === "doing" || raw === "done" ? raw : "open";
  const project = params.get("project");
  const showApprovals = params.get("approvals") === "1";
  const tag = params.get("tag");
  const byDue = params.get("sort") === "due";
  const [q, setQ] = useState("");
  const [list, setList] = useState<AppTaskList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const addRef = useRef<HTMLInputElement>(null);
  const [bump, setBump] = useState(0);
  const reload = useCallback(() => setBump((x) => x + 1), []);

  useEffect(() => {
    const p = new URLSearchParams();
    p.set("status", scope === "open" ? OPEN.join(",") : scope);
    if (project !== null) p.set("project", project);
    if (tag) p.set("tag", tag);
    if (showApprovals) p.set("approvals", "1");
    if (q.trim()) p.set("q", q.trim());
    const t = setTimeout(
      () =>
        fetchTaskList(p)
          .then((l) => {
            setList(l);
            setError(null);
          })
          .catch((e) => setError(String(e instanceof Error ? e.message : e))),
      q ? 200 : 0,
    );
    return () => clearTimeout(t);
  }, [scope, project, tag, q, bump, snap, showApprovals]);
  useEffect(() => taskSync.onEvent((e) => e.type === "synced" && reload()), [reload]);

  const go = (k: string, v: string | null, keepId = true) => {
    const p = hashParams();
    if (v === null) p.delete(k);
    else p.set(k, v);
    location.hash = listHref(p, keepId ? id : null);
  };

  const toggle = async (t: AppTask) => {
    const done = t.status === "done";
    await patchTask(t.id, { status: done ? "todo" : "done" }).catch((e) => setError(String(e instanceof Error ? e.message : e)));
    reload();
  };

  const add = async () => {
    const title = adding.trim();
    if (!title) return;
    try {
      const t = await createTask({ title, project: project || null });
      setAdding("");
      reload();
      // 広い画面では足したものを右に開く
      if (matchMedia("(min-width: 1024px)").matches) location.hash = listHref(hashParams(), t.id);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  // 期限順なら期限で区切る。そうでなければ Undone は状態ごとに区切る（BackLog → Todo → AI-Driven）
  const all = list?.tasks ?? [];
  const groups: { key: string; label?: string; cls?: string; dot?: string; tasks: AppTask[] }[] = byDue
    ? BUCKETS.map((b) => ({ key: b, label: b, cls: BUCKET_CLS[b], tasks: all.filter((t) => dueBucket(t.due) === b) })).filter((g) => g.tasks.length)
    : scope === "open"
      ? (["inbox", "todo", "doing"] as AppTaskStatus[]).map((s) => ({ key: s, label: STATUS_LABEL[s], dot: STATUS_DOT[s], tasks: all.filter((t) => t.status === s) })).filter((g) => g.tasks.length)
      : [{ key: scope, tasks: all }];
  const lp = hashParams();

  const listPane = (
    <div className={`flex min-h-0 min-w-0 flex-col ${id ? "hidden lg:flex" : "flex"} lg:w-[440px] lg:flex-none lg:border-r lg:border-line 2xl:w-[520px]`}>
      <PjTabs current="tasks" onPlus={() => addRef.current?.focus()} plusLabel="タスクを追加" />
      <div className="flex justify-end px-4 empty:hidden"><TaskSyncBadge /></div>
      {project !== null && <div className="truncate px-5 pb-1 text-[12.5px] font-semibold text-ink-2">{project === "" ? "プロジェクトなし" : project}</div>}
      <div className="flex flex-col gap-2 px-4 pb-2">
        <AddField
          inputRef={addRef}
          value={adding}
          onChange={setAdding}
          onAdd={() => void add()}
          placeholder={project ? `${project} にタスクを追加` : "タスクを追加"}
          className="relative flex h-10 items-center gap-2 rounded-lg border border-line-2 bg-panel px-3"
          inputClassName="w-full min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-mute"
        />
        <div className="flex items-center gap-1.5">
          <label className="relative flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-chip px-3 text-mute">
            <Icon name="search" size={14} />
            <span className="sr-only">タスクを探す</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="探す" className="w-full min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-mute" />
          </label>
          {scope === "done" && <ChipToggle on={showApprovals} onClick={() => go("approvals", showApprovals ? null : "1", false)}>承認も表示</ChipToggle>}
          <ChipToggle on={byDue} onClick={() => go("sort", byDue ? null : "due", false)}>期限順</ChipToggle>
        </div>
      </div>
      {/* 必ず1行。横にスクロールさせない。幅が足りないときは件数を落とす */}
      <div className="flex max-w-[440px] items-center gap-1 px-4 pb-1" role="tablist" aria-label="状態">
        {/* Undone は枠。枠の頭を押すと全部、中の状態を押すとそれだけ */}
        <div className={`flex min-w-0 flex-1 items-center justify-between rounded-full border p-0.5 ${scope === "done" ? "border-line" : "border-line-2"}`}>
          <ScopeTab label={UNDONE_LABEL} n={OPEN.reduce((a, k) => a + (list?.counts[k] ?? 0), 0)} on={scope === "open"} onPick={() => go("s", null, false)} />
          <span className="h-4 w-px flex-none bg-line" aria-hidden="true" />
          {UNDONE_SCOPES.map((s) => (
            <ScopeTab key={s} label={STATUS_LABEL[s]} n={list?.counts[s] ?? 0} on={scope === s} onPick={() => go("s", s, false)} />
          ))}
        </div>
        <ScopeTab label={STATUS_LABEL.done} n={0} on={scope === "done"} onPick={() => go("s", "done", false)} />
      </div>
      {tag && (
        <div className="flex px-4 pb-1">
          <button onClick={() => go("tag", null, false)} className="flex items-center gap-1 rounded-full border border-blue px-2.5 py-1 text-[12px] text-blue">#{tag} ×</button>
        </div>
      )}
      {list && list.projects.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto px-4 pb-1 pt-1 [scrollbar-width:none]" role="group" aria-label="プロジェクト">
          <button onClick={() => go("project", null, false)} className={`flex flex-none items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] ${project === null ? "border-ink text-ink" : "border-line text-mute"}`}>すべて</button>
          {list.projects.map((p) => (
            <button key={p.name} onClick={() => go("project", project === p.name ? null : p.name, false)} className={`flex flex-none items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] ${project === p.name ? "border-ink text-ink" : "border-line text-mute"}`}>
              <FolderIcon size={11} />{p.name}<span className="opacity-60">{p.count}</span>
            </button>
          ))}
          <button onClick={() => go("project", project === "" ? null : "", false)} className={`flex flex-none items-center rounded-full border px-2.5 py-1 text-[12px] ${project === "" ? "border-ink text-ink" : "border-line text-mute"}`}>なし</button>
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-6">
        {error && <div className="mx-4 mt-2 rounded-lg bg-orange-soft px-3 py-2 text-xs text-orange-ink" role="alert">{error}</div>}
        {!list && !error && <Skeleton />}
        {list && list.tasks.length === 0 && <div className="px-6 pt-12 text-center text-sm text-mute">{q || project !== null ? "当てはまるタスクはありません" : `${scope === "open" ? UNDONE_LABEL : STATUS_LABEL[scope]} のタスクはありません`}</div>}
        <SyncLine onSynced={reload} />
        {groups.map((g) => (
          <section key={g.key} className="pt-3">
            {g.label && (
              <div className={`flex items-center gap-1.5 px-5 pb-1 text-[11px] font-semibold tracking-wide ${g.cls ?? "text-mute"}`}>
                {g.dot && <span className="size-2 rounded-full" style={{ background: g.dot }} />}
                {g.label}<span className="tabular-nums">{g.tasks.length}</span>
              </div>
            )}
            <ul className="m-0 list-none p-0">
              {/* 探しているときは、当たったサブタスクを親に隠さない */}
              {(q.trim() ? g.tasks : topLevel(g.tasks, list?.tasks)).map((t) => (
                <TaskNode key={t.id} t={t} selectedId={id} href={(x) => listHref(lp, x.id)} onToggle={toggle} onChanged={reload} snap={snap} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );

  return (
    <div className={`h-full ${RAIL}`}>
      <div className="mx-auto flex h-full w-full max-w-[520px] flex-col md:max-w-none 2xl:max-w-[1760px]">
        <div className="flex min-h-0 flex-1">
          {listPane}
          {id ? (
            <TaskDetail key={id} id={id} snap={snap} onChanged={reload} onBack={() => (location.hash = listHref(hashParams(), null))} />
          ) : (
            <div className="hidden flex-1 items-center justify-center text-sm text-mute lg:flex">タスクを選ぶと、ここに中身が出ます</div>
          )}
        </div>
        <div className={id ? "hidden lg:block" : ""}><Nav current="#/pj" /></div>
      </div>
    </div>
  );
}
