// プロジェクト: 各プロジェクトのタスク（期日順の先頭）と最近のメモを、上に詰めたカードで見る画面。
// 期限順の一覧はタスクの画面にある（#/todos?sort=due）。
// プロジェクトを開くと、説明（Markdown）・状態・絵文字・名前と、そのプロジェクトのタスクとメモ。
import type { EditorView } from "@codemirror/view";
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { AppTask, Project, ProjectDetail, ProjectOverview, ProjectStatus, Snapshot } from "../shared/types";
import { TasksScreen } from "./AppTasks";
import { TaskNode, topLevel } from "./TaskRow";
import { BodyEditor, FolderIcon, json } from "./memo-fields";
import { MemoListPage } from "./Memos";
import { PjTabs } from "./pjtabs";
import { Icon, Nav, RAIL, ago } from "./ui";
import { Skeleton } from "./loading";

const STATUS: Record<ProjectStatus, { label: string; cls: string }> = {
  active: { label: "進行中", cls: "bg-lime-soft text-lime-ink" },
  paused: { label: "保留", cls: "bg-yellow-soft text-yellow-ink" },
  done: { label: "完了", cls: "bg-chip text-mute" },
};

function hashView(): "projects" | "due" {
  return new URLSearchParams(location.hash.split("?")[1] ?? "").get("v") === "due" ? "due" : "projects";
}

const toggleDone = async (t: AppTask) => {
  const done = t.status === "done" || t.status === "dismissed";
  await fetch(`/api/apptasks/${t.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: done ? "todo" : "done" }) });
};

/** タスクをすぐ足す欄（プロジェクトを付ける） */
function QuickAdd({ project, onAdded, placeholder }: { project: string | null; onAdded: () => void; placeholder: string }) {
  const [v, setV] = useState("");
  const add = async () => {
    const title = v.trim();
    if (!title) return;
    await fetch("/api/apptasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, project }) });
    setV("");
    onAdded();
  };
  return (
    <label className="relative mx-2 flex h-9 items-center gap-2 rounded-lg px-3 text-mute hover:bg-chip/60">
      <span aria-hidden="true">＋</span>
      <span className="sr-only">{placeholder}</span>
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void add()}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-mute"
      />
    </label>
  );
}

/** 開いたプロジェクトは端末に覚える（既定は畳む） */
const OPEN_KEY = "gh-pj-open";
function readOpen(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function useOpen(key: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => readOpen().includes(key));
  return [
    open,
    () => {
      const next = !open;
      setOpen(next);
      try {
        const rest = readOpen().filter((x) => x !== key);
        localStorage.setItem(OPEN_KEY, JSON.stringify(next ? [...rest, key] : rest));
      } catch {
        /* 覚えられないだけ */
      }
    },
  ];
}

function Fold({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-expanded={open} aria-label={`${label}を${open ? "畳む" : "開く"}`} className="flex size-9 flex-none items-center justify-center rounded-full text-mute hover:bg-chip">
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true" className={`transition-transform duration-200 ${open ? "rotate-90" : ""}`}><path d="M9 6l6 6-6 6" /></svg>
    </button>
  );
}

/** 畳んでいるときに見せる分: 期限切れと、期限が近いもの（親も出ているサブタスクは親の下に任せる） */
function Urgent({ tasks, ...rest }: { tasks: AppTask[]; snap: Snapshot | null; hideProject?: boolean; onToggle: (t: AppTask) => void; onChanged: () => void }) {
  if (!tasks.length) return null;
  return <ul className="m-0 list-none p-0">{topLevel(tasks).map((t) => <TaskNode key={t.id} t={t} {...rest} />)}</ul>;
}

function ProjectCard({ p, snap, reload }: { p: ProjectOverview["projects"][number]; snap: Snapshot | null; reload: () => void }) {
  const [open, toggle] = useOpen(String(p.id));
  const onToggle = (x: AppTask) => void toggleDone(x).then(reload);
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-line bg-panel pb-1" aria-label={p.name}>
      <div className="flex min-w-0 items-center gap-1 py-1 pl-3.5 pr-1.5">
        <a href={`#/pj/${p.id}`} className="flex min-w-0 flex-1 flex-col text-ink no-underline">
          <span className="flex min-w-0 items-center gap-2">
            <span className="text-[15px] leading-none">{p.emoji ?? "📁"}</span>
            <span className="min-w-0 truncate text-[14px] font-bold">{p.name}</span>
            {p.status !== "active" && <span className={`flex-none rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS[p.status].cls}`}>{STATUS[p.status].label}</span>}
          </span>
          <span className="flex gap-3 text-[11px] text-mute">
            <span>タスク {p.openTasks}</span>
            {p.lateTasks > 0 && <span className="font-semibold text-red-ink">期限切れ {p.lateTasks}</span>}
            <span>メモ {p.memos}</span>
          </span>
        </a>
        <Fold open={open} onClick={toggle} label={p.name} />
      </div>
      {open ? (
        <>
          {p.tasks.length > 0 && (
            <ul className="m-0 list-none p-0">
              {topLevel(p.tasks).map((t) => <TaskNode key={t.id} t={t} hideProject snap={snap} onToggle={onToggle} onChanged={reload} />)}
            </ul>
          )}
          <QuickAdd project={p.name} onAdded={reload} placeholder="タスクを追加" />
          {p.recentMemos.length > 0 && (
            <div className="mx-3.5 mt-1 flex min-w-0 flex-col gap-0.5 border-t border-line pt-1.5">
              {p.recentMemos.map((m) => (
                <a key={m.id} href={`#/memo/${m.id}`} className="flex min-w-0 items-center gap-2 py-1 text-[12.5px] text-ink-2 no-underline hover:text-ink">
                  <Icon name="memo" size={13} />
                  <span className="min-w-0 flex-1 truncate">{m.title}</span>
                  <span className="flex-none text-[11px] text-mute">{ago(m.updatedAt)}</span>
                </a>
              ))}
            </div>
          )}
        </>
      ) : (
        <Urgent tasks={p.urgent} hideProject snap={snap} onToggle={onToggle} onChanged={reload} />
      )}
    </section>
  );
}

/** プロジェクトの付いていないもの。畳み方は同じ */
function NoneCard({ none, snap, reload }: { none: ProjectOverview["none"]; snap: Snapshot | null; reload: () => void }) {
  const [open, toggle] = useOpen("none");
  const onToggle = (x: AppTask) => void toggleDone(x).then(reload);
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-dashed border-line-2 pb-1" aria-label="プロジェクトなし">
      <div className="flex min-w-0 items-center gap-1 py-1 pl-3.5 pr-1.5">
        <a href="#/todos?project=" className="flex min-w-0 flex-1 flex-col text-ink no-underline">
          <span className="flex min-w-0 items-center gap-2">
            <span className="text-[15px] leading-none">📂</span>
            <span className="min-w-0 truncate text-[14px] font-bold text-ink-2">プロジェクトなし</span>
          </span>
          <span className="text-[11px] text-mute">タスク {none.openTasks}・メモ {none.memos}</span>
        </a>
        <Fold open={open} onClick={toggle} label="プロジェクトなし" />
      </div>
      {open ? (
        <>
          <ul className="m-0 list-none p-0">
            {topLevel(none.tasks).map((t) => <TaskNode key={t.id} t={t} snap={snap} onToggle={onToggle} onChanged={reload} />)}
          </ul>
          <QuickAdd project={null} onAdded={reload} placeholder="タスクを追加" />
        </>
      ) : (
        <Urgent tasks={none.urgent} snap={snap} onToggle={onToggle} onChanged={reload} />
      )}
    </section>
  );
}

/** 画面の幅から列の数を決める（Tailwind の md・2xl と同じ） */
function useColumns(): number {
  const pick = () => (matchMedia("(min-width: 1536px)").matches ? 3 : matchMedia("(min-width: 768px)").matches ? 2 : 1);
  const [n, setN] = useState(pick);
  useEffect(() => {
    const on = () => setN(pick());
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);
  return n;
}

/** Pinterest のように上へ詰める。中身の量を見て、いま一番短い列に順に足す（開閉しても列をまたいで動かない） */
function Masonry({ items }: { items: { key: string | number; weight: number; node: ReactNode }[] }) {
  const n = useColumns();
  const cols: (typeof items)[] = Array.from({ length: n }, () => []);
  const heights = Array.from({ length: n }, () => 0);
  for (const it of items) {
    const i = heights.indexOf(Math.min(...heights));
    cols[i].push(it);
    heights[i] += it.weight;
  }
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      {cols.map((c, i) => (
        <div key={i} className="flex min-w-0 flex-1 flex-col gap-2.5">
          {c.map((it) => <Fragment key={it.key}>{it.node}</Fragment>)}
        </div>
      ))}
    </div>
  );
}

/** カードの高さのおおよそ。畳んだ姿（見出し＋期限が近いもの）で決める。開いても列をまたがない */
const weightOf = (urgent: number) => 60 + urgent * 44;

export function PjScreen({ snap }: { snap: Snapshot | null }) {
  // 前の「期日順」のリンクは、タスクの期限順へ
  useEffect(() => {
    if (hashView() === "due") location.replace("#/todos?sort=due");
  }, []);
  const [ov, setOv] = useState<ProjectOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const reload = useCallback(() => setBump((x) => x + 1), []);
  const [newName, setNewName] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => json<ProjectOverview>(r))
      .then((x) => {
        setOv(x);
        setError(null);
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, [bump, snap]);

  const create = async () => {
    const name = (newName ?? "").trim();
    if (!name) return setNewName(null);
    try {
      const p = await json<Project>(await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }));
      location.hash = `#/pj/${p.id}`;
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const cards = ov
    ? [
        ...ov.projects.map((p) => ({ key: p.id, weight: weightOf(topLevel(p.urgent).length), node: <ProjectCard p={p} snap={snap} reload={reload} /> })),
        ...(ov.none.openTasks > 0 || ov.none.memos > 0 ? [{ key: "none", weight: weightOf(topLevel(ov.none.urgent).length), node: <NoneCard none={ov.none} snap={snap} reload={reload} /> }] : []),
      ]
    : [];

  return (
    <div className={`h-full ${RAIL}`}>
      <div className="mx-auto flex h-full w-full max-w-[520px] flex-col md:max-w-none 2xl:max-w-[1760px]">
        <PjTabs current="pj" onPlus={() => setNewName("")} plusLabel="新しいプロジェクト" />
        {newName !== null && (
          <div className="mx-4 mb-2 flex items-center gap-2 rounded-xl border border-line-2 bg-panel px-3">
            <FolderIcon />
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void create()}
              placeholder="新しいプロジェクトの名前（Enter）"
              aria-label="新しいプロジェクトの名前"
              className="min-h-10 min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none"
            />
            <button onClick={() => setNewName(null)} className="text-[12px] text-mute">やめる</button>
          </div>
        )}

        <main className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-6">
          {error && <div className="mb-2 rounded-lg bg-orange-soft px-3 py-2 text-xs text-orange-ink" role="alert">{error}</div>}
          {!ov && !error && <Skeleton />}
          {ov && <Masonry items={cards} />}
        </main>
        <Nav current="#/pj" />
      </div>
    </div>
  );
}

export function ProjectPage({ snap, id }: { snap: Snapshot | null; id: number }) {
  const [d, setD] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<"" | "保存中…" | "保存済み" | "保存できませんでした">("");
  const [showDone, setShowDone] = useState(false);
  const [bump, setBump] = useState(0);
  const reload = useCallback(() => setBump((x) => x + 1), []);
  const viewRef = useRef<EditorView | null>(null);
  const base = useRef<number | undefined>(undefined);
  const pending = useRef<Partial<Project>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch(`/api/projects/${id}`)
      .then((r) => json<ProjectDetail>(r))
      .then((x) => {
        setD(x);
        base.current = x.project.updatedAt;
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, [id, bump, snap]);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    pending.current = {};
    if (!Object.keys(p).length) return;
    setSave("保存中…");
    try {
      const np = await json<Project>(await fetch(`/api/projects/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...p, baseUpdatedAt: base.current }) }));
      base.current = np.updatedAt;
      setD((x) => (x ? { ...x, project: np } : x));
      setSave("保存済み");
      setError(null);
    } catch (e) {
      setSave("保存できませんでした");
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [id]);
  const edit = (p: Partial<Project>, now = false) => {
    pending.current = { ...pending.current, ...p };
    setD((x) => (x ? { ...x, project: { ...x.project, ...p } } : x));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), now ? 0 : 800);
  };
  useEffect(() => () => void flush(), [flush]);

  const p = d?.project;
  return (
    <div className="flex h-full flex-col bg-ground">
      <div className="flex items-center gap-1 px-2 pb-1 pt-[max(env(safe-area-inset-top),10px)]">
        <a href="#/pj" aria-label="プロジェクトへ" className="flex size-11 items-center justify-center text-ink-2">
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </a>
        <span className="flex-1 text-[12.5px] text-mute">プロジェクト</span>
        <span className="px-2 text-[11.5px] text-mute" role="status">{save}</span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-10 md:px-10">
        <div className="mx-auto w-full min-w-0 max-w-[1280px]">
          {error && <div className="mb-3 rounded-lg bg-orange-soft px-3 py-2 text-xs text-orange-ink" role="alert">{error}</div>}
          {!d && !error && <Skeleton />}
          {p && d && (
            <>
              <div className="flex items-center gap-2 pt-2">
                <input
                  value={p.emoji ?? ""}
                  onChange={(e) => edit({ emoji: e.target.value || null })}
                  placeholder="📁"
                  aria-label="絵文字"
                  className="w-10 flex-none rounded-lg bg-transparent text-center text-[22px] outline-none placeholder:opacity-60 hover:bg-chip"
                />
                <input
                  value={p.name}
                  onChange={(e) => edit({ name: e.target.value })}
                  aria-label="プロジェクトの名前"
                  className="min-w-0 flex-1 bg-transparent text-[22px] font-bold tracking-tight text-ink outline-none"
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="状態">
                {(Object.keys(STATUS) as ProjectStatus[]).map((s) => (
                  <button key={s} role="radio" aria-checked={p.status === s} onClick={() => edit({ status: s }, true)} className={`rounded-full px-3 py-1 text-[12.5px] ${p.status === s ? `${STATUS[s].cls} font-semibold` : "text-ink-2 hover:bg-chip"}`}>
                    {STATUS[s].label}
                  </button>
                ))}
                <span className="ml-2 text-[12px] text-mute">タスク {p.openTasks}{p.lateTasks ? `（期限切れ ${p.lateTasks}）` : ""}・メモ {p.memos}</span>
              </div>

              <div className="mt-5 grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-8">
                {/* 説明 */}
                <section aria-label="説明" className="min-w-0 lg:row-span-2">
                  <div className="pb-1 text-[12px] font-semibold text-mute">説明</div>
                  <div className="min-w-0 overflow-x-auto rounded-xl border border-line bg-panel px-3.5 py-2">
                    <BodyEditor
                      key={`${p.id}`}
                      initial={p.description}
                      onChange={(description) => edit({ description })}
                      viewRef={viewRef}
                      autoFocus={false}
                      readOnly={false}
                      minClass="min-h-[120px] [&_.cm-content]:!pb-6"
                      hint="このプロジェクトの目的・計画・メモ（Markdown）"
                    />
                  </div>
                </section>

                {/* タスク */}
                <section aria-label="タスク" className="min-w-0">
                  <div className="flex items-baseline pb-1 text-[12px] font-semibold text-mute">
                    タスク<a href={`#/todos?project=${encodeURIComponent(p.name)}`} className="ml-auto font-normal text-mute">一覧で ›</a>
                  </div>
                  <div className="rounded-xl border border-line bg-panel py-1">
                    <ul className="m-0 list-none p-0">
                      {topLevel(d.tasks).map((t) => <TaskNode key={t.id} t={t} hideProject snap={snap} onToggle={(x) => toggleDone(x).then(reload)} onChanged={reload} />)}
                    </ul>
                    <QuickAdd project={p.name} onAdded={reload} placeholder="タスクを追加（Enter）" />
                    {d.doneTasks.length > 0 && (
                      <button onClick={() => setShowDone((x) => !x)} className="mx-5 my-1 text-[12px] text-mute">{showDone ? "完了を隠す" : `完了 ${d.doneTasks.length} 件を見る`}</button>
                    )}
                    {showDone && (
                      <ul className="m-0 list-none p-0">
                        {topLevel(d.doneTasks).map((t) => <TaskNode key={t.id} t={t} hideProject snap={snap} onToggle={(x) => toggleDone(x).then(reload)} onChanged={reload} />)}
                      </ul>
                    )}
                  </div>
                </section>

                {/* メモ */}
                <section aria-label="メモ" className="min-w-0">
                  <div className="flex items-baseline pb-1 text-[12px] font-semibold text-mute">
                    メモ<a href={`#/memo/new?project=${encodeURIComponent(p.name)}`} className="ml-auto font-normal text-ink-2">＋ 書く</a>
                  </div>
                  <div className="rounded-xl border border-line bg-panel py-1">
                    {d.memos.length === 0 && <div className="px-4 py-3 text-[13px] text-mute">まだありません</div>}
                    {d.memos.map((m) => (
                      <a key={m.id} href={`#/memo/${m.id}`} className="mx-2 flex flex-col rounded-lg px-3 py-2 text-ink no-underline hover:bg-chip/60">
                        <span className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{m.title}</span>
                          <span className="flex-none text-[11px] text-mute">{ago(m.updatedAt)}</span>
                        </span>
                        {m.excerpt && m.excerpt !== m.title && <span className="truncate text-[12px] text-mute">{m.excerpt}</span>}
                      </a>
                    ))}
                  </div>
                </section>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 設定: プロジェクト（名前・絵文字・状態・まとめる・消す）とタグ（名前の変更・まとめる・外す） */
export function PjSettings() {
  const [data, setData] = useState<{ projects: Project[]; tags: { name: string; memos: number; tasks: number }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    fetch("/api/projects-settings")
      .then((r) => json<{ projects: Project[]; tags: { name: string; memos: number; tasks: number }[] }>(r))
      .then(setData)
      .catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, []);
  useEffect(load, [load]);

  const run = async (label: string, f: () => Promise<Response>) => {
    try {
      await json(await f());
      setMsg(label);
      setError(null);
      load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };
  const patchProject = (p: Project, body: Record<string, unknown>, label: string) =>
    run(label, () => fetch(`/api/projects/${p.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

  return (
    <div className="flex h-full flex-col bg-ground">
      <div className="flex items-center gap-1 px-2 pb-1 pt-[max(env(safe-area-inset-top),10px)]">
        <a href="#/pj" aria-label="プロジェクトへ" className="flex size-11 items-center justify-center text-ink-2">
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </a>
        <h1 className="m-0 min-w-0 flex-1 truncate text-[16px] font-bold">プロジェクトとタグの設定</h1>
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-10">
        <div className="mx-auto grid w-full min-w-0 max-w-[1100px] grid-cols-1 items-start gap-6 lg:grid-cols-2">
          {(error || msg) && (
            <div className={`rounded-lg px-3 py-2 text-xs lg:col-span-2 ${error ? "bg-orange-soft text-orange-ink" : "bg-lime-soft text-lime-ink"}`} role="status">{error ?? msg}</div>
          )}
          <section aria-label="プロジェクト" className="min-w-0">
            <div className="pb-2 text-[12px] font-semibold text-mute">プロジェクト</div>
            <div className="flex flex-col gap-2">
              {data?.projects.map((p) => {
                const empty = p.openTasks === 0 && p.memos === 0;
                const others = data.projects.filter((x) => x.id !== p.id);
                return (
                  <div key={p.id} className="flex min-w-0 flex-col gap-1.5 rounded-2xl border border-line bg-panel px-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <input defaultValue={p.emoji ?? ""} onBlur={(e) => e.target.value !== (p.emoji ?? "") && void patchProject(p, { emoji: e.target.value || null }, "絵文字を変えた")} placeholder="📁" aria-label={`${p.name} の絵文字`} className="size-9 flex-none rounded-lg bg-chip/60 text-center text-[18px] outline-none focus:bg-chip" />
                      <input defaultValue={p.name} onBlur={(e) => e.target.value.trim() && e.target.value !== p.name && void patchProject(p, { name: e.target.value }, `「${e.target.value}」に変えた`)} aria-label={`${p.name} の名前`} className="min-h-9 min-w-0 flex-1 rounded-lg bg-transparent px-1.5 text-[15px] font-bold text-ink outline-none hover:bg-chip focus:bg-chip" />
                      <span className="flex-none text-[11.5px] tabular-nums text-mute">タスク {p.openTasks}・メモ {p.memos}</span>
                    </div>
                    {/* 状態・まとめる・消す・開くを1列に */}
                    <div className="flex min-w-0 items-center gap-1 text-[12px]">
                      <div role="group" aria-label={`${p.name} の状態`} className="flex flex-none rounded-full bg-chip p-0.5">
                        {(Object.keys(STATUS) as ProjectStatus[]).map((s) => (
                          <button key={s} aria-pressed={p.status === s} onClick={() => p.status !== s && void patchProject(p, { status: s }, `${p.name} を${STATUS[s].label}にした`)} className={`min-h-7 rounded-full px-2.5 ${p.status === s ? "bg-panel font-semibold text-ink shadow-sm" : "text-mute"}`}>
                            {STATUS[s].label}
                          </button>
                        ))}
                      </div>
                      <span className="ml-auto" />
                      {others.length > 0 && (
                        <label className="relative flex min-h-8 flex-none cursor-pointer items-center rounded-full px-2 text-ink-2 hover:bg-chip">
                          まとめる
                          <select
                            value=""
                            onChange={(e) => {
                              const into = Number(e.target.value);
                              const target = data.projects.find((x) => x.id === into);
                              if (target && confirm(`「${p.name}」のメモ・タスクを「${target.name}」にまとめて、「${p.name}」を消します。よいですか？`))
                                void run(`「${target.name}」にまとめた`, () => fetch(`/api/projects/${p.id}/merge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ into }) }));
                            }}
                            aria-label={`${p.name} をまとめる先`}
                            className="absolute inset-0 cursor-pointer opacity-0"
                          >
                            <option value="">まとめる先を選ぶ…</option>
                            {others.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                          </select>
                        </label>
                      )}
                      <button
                        disabled={!empty}
                        title={empty ? undefined : "タスクとメモが無いときだけ消せます（先にまとめる）"}
                        onClick={() => confirm(`「${p.name}」を消しますか？`) && void run(`「${p.name}」を消した`, () => fetch(`/api/projects/${p.id}`, { method: "DELETE" }))}
                        className="min-h-8 flex-none rounded-full px-2 text-red-ink hover:bg-chip disabled:text-mute disabled:opacity-40"
                      >
                        消す
                      </button>
                      <a href={`#/pj/${p.id}`} className="flex min-h-8 flex-none items-center rounded-full px-2 text-ink-2 no-underline hover:bg-chip">開く ›</a>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
          <section aria-label="タグ" className="min-w-0">
            <div className="pb-2 text-[12px] font-semibold text-mute">タグ（メモとタスクで共通）</div>
            <div className="flex flex-col rounded-xl border border-line bg-panel py-1">
              {data?.tags.length === 0 && <div className="px-3 py-2 text-[13px] text-mute">まだありません</div>}
              {data?.tags.map((t) => (
                <div key={t.name} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="text-blue">#</span>
                  <input
                    defaultValue={t.name}
                    onBlur={(e) => {
                      const to = e.target.value.trim();
                      if (!to || to === t.name) return;
                      const exists = data.tags.some((x) => x.name === to);
                      if (exists && !confirm(`「#${to}」はもうあります。「#${t.name}」をまとめますか？`)) return void (e.target.value = t.name);
                      void run(exists ? `#${to} にまとめた` : `#${to} に変えた`, () => fetch("/api/tags", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: t.name, to }) }));
                    }}
                    aria-label={`タグ ${t.name} の名前`}
                    className="min-w-0 flex-1 rounded-md bg-transparent px-1 text-[14px] text-ink outline-none hover:bg-chip focus:bg-chip"
                  />
                  <a href={`#/memos?tag=${encodeURIComponent(t.name)}`} className="text-[11.5px] text-mute">メモ {t.memos}</a>
                  <a href={`#/todos?tag=${encodeURIComponent(t.name)}`} className="text-[11.5px] text-mute">タスク {t.tasks}</a>
                  <button onClick={() => confirm(`「#${t.name}」をメモ・タスクから外しますか？`) && void run(`#${t.name} を外した`, () => fetch(`/api/tags?name=${encodeURIComponent(t.name)}`, { method: "DELETE" }))} aria-label={`タグ ${t.name} を外す`} className="flex size-7 items-center justify-center rounded text-mute hover:text-red-ink">
                    ×
                  </button>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11.5px] text-mute">名前を、すでにあるタグと同じにすると、まとめられます。</p>
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * PJ・メモ・タスクの4つの見方を1つの入れ物から出す。App からは同じ部品に見えるので、
 * 切り替えても読み込み待ち（Suspense）にならず、上の列の白い背景がすぐに動く
 */
export function PjShell({ snap, view, taskId }: { snap: Snapshot | null; view: "pj" | "memos" | "tasks"; taskId?: number | null }) {
  if (view === "memos") return <MemoListPage />;
  if (view === "tasks") return <TasksScreen snap={snap} id={taskId ?? null} />;
  return <PjScreen snap={snap} />;
}
