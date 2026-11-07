import { useState } from "react";
import type { KanbanTask, Snapshot, TaskStatus } from "../shared/types";
import { TaskBadges, refsIn } from "./badges";
import { Avatar, Page, ago, profileOf } from "./ui";

const COLUMNS: { name: string; dot: string; statuses: TaskStatus[] }[] = [
  { name: "RUNNING", dot: "#C8F25A", statuses: ["running"] },
  { name: "BLOCKED", dot: "#FF8A3D", statuses: ["blocked"] },
  { name: "REVIEW", dot: "#F2C98A", statuses: ["review"] },
  { name: "READY", dot: "#8FB8FF", statuses: ["ready", "todo", "triage", "scheduled"] },
  { name: "DONE", dot: "var(--color-dot-done)", statuses: ["done"] },
];

function TaskCard({ t, snap }: { t: KanbanTask; snap: Snapshot }) {
  const p = profileOf(snap.agents, t.assignee ?? "unassigned");
  const when = (t.last_heartbeat_at ?? t.completed_at ?? t.started_at ?? t.created_at) * 1000;
  const inner = (
    <>
      <div className="text-[13px] font-medium leading-snug">{t.title}</div>
      {refsIn(t.title).length > 0 && <div className="flex flex-wrap gap-1"><TaskBadges ids={refsIn(t.title)} small /></div>}
      <div className="flex items-center gap-1.5 text-[11px] text-mute">
        <Avatar p={p} size={18} />
        <span className="truncate">{ago(when)} · {t.id}</span>
      </div>
    </>
  );
  return (
    <a href={`#/task/${encodeURIComponent(t.id)}`} className="flex flex-col gap-1.5 rounded-[10px] border border-line bg-panel p-2.5 text-ink no-underline">
      {inner}
    </a>
  );
}

/** これ以上積まれた列は、上の SHOW 件だけ出して残りを重ねる（押すと広がる） */
const STACK_AT = 5;
const SHOW = 3;

function Pile({ n, onOpen }: { n: number; onOpen: () => void }) {
  return (
    <button onClick={onOpen} aria-label={`残り ${n} 件を広げる`} className="relative mb-3 h-11 text-left">
      <span className="absolute inset-x-3 top-3 h-11 rounded-[10px] border border-line bg-panel-2" />
      <span className="absolute inset-x-1.5 top-1.5 h-11 rounded-[10px] border border-line bg-panel-2" />
      <span className="relative flex h-11 items-center justify-between rounded-[10px] border border-line bg-panel px-2.5 text-[12px]">
        <span className="font-semibold">ほか {n} 件</span>
        <span className="text-[11px] text-mute">広げる ▾</span>
      </span>
    </button>
  );
}

export function Watching({ snap }: { snap: Snapshot | null }) {
  const tasks = snap?.board?.tasks ?? [];
  const [open, setOpen] = useState<string[]>([]);
  return (
    <Page
      title="カンバン"
      current="#/watching"
      right={<span className="font-mono text-[11px] text-mute">{snap?.board ? `更新 ${ago(snap.board.fetched_at)}` : "…"}</span>}
    >
      {snap?.boardError && <div className="mx-4 mt-2 rounded-xl bg-orange/10 px-3 py-2 text-xs text-orange-ink">{snap.boardError}</div>}
      <div className="flex gap-2.5 overflow-x-auto px-4 pb-4 pt-3">
        {COLUMNS.map((col) => {
          const items = tasks
            .filter((t) => col.statuses.includes(t.status))
            .sort((a, b) => (b.completed_at ?? b.created_at) - (a.completed_at ?? a.created_at));
          return (
            <section key={col.name} className="flex w-[168px] flex-none flex-col gap-2 md:w-auto md:min-w-[170px] md:flex-1" aria-label={col.name}>
              <div className="flex items-center gap-1.5 font-mono text-[11px] text-mute">
                <span className="size-2 rounded-sm" style={{ background: col.dot }} />
                {col.name}
                <span className="ml-auto">{items.length}</span>
              </div>
              {snap && (items.length >= STACK_AT && !open.includes(col.name) ? items.slice(0, SHOW) : items).map((t) => <TaskCard key={t.id} t={t} snap={snap} />)}
              {items.length >= STACK_AT &&
                (open.includes(col.name) ? (
                  <button onClick={() => setOpen((x) => x.filter((c) => c !== col.name))} className="min-h-9 rounded-[10px] border border-dashed border-line-2 text-[11px] text-mute">重ねる ▴</button>
                ) : (
                  <Pile n={items.length - SHOW} onOpen={() => setOpen((x) => [...x, col.name])} />
                ))}
            </section>
          );
        })}
      </div>
    </Page>
  );
}
