// カレンダー: 月・週の表示。実際のタスク（期日つき）は濃く、繰り返しのルールから来る予定は薄く重ねる。
// ルールの追加・直し・停止・その回だけやめる、もここからできる。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppTask } from "../shared/types";
import { type Cadence, type RecurringRule, cadenceLabel, occurrences, shiftDay } from "../shared/recurrence";
import { localDay } from "../shared/time";
import { json } from "./memo-light";
import { Sheet, SheetCard } from "./sheet";
import { fetchTaskList } from "./task-db";
import { STATUS_LABEL, taskDot } from "./TaskRow";
import { Page } from "./ui";

const WD = ["日", "月", "火", "水", "木", "金", "土"];
const call = <T,>(path: string, method = "GET", body?: unknown) =>
  fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => json<T>(r));

const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
const addMonths = (day: string, n: number) => {
  const d = new Date(`${monthStart(day)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
/** 月曜始まりの週の頭 */
const weekStart = (day: string) => shiftDay(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}（${WD[new Date(`${day}T00:00:00Z`).getUTCDay()]}）`;

interface Item {
  kind: "task" | "plan";
  day: string;
  task?: AppTask;
  rule?: RecurringRule;
  skipped?: boolean;
}

type Agents = { id: string; name: string }[];
const nameOf = (agents: Agents, id: string | null | undefined) => (id ? agents.find((a) => a.id === id)?.name ?? id : null);

/** 日の中身（右の列・スマホの下）。タスクは濃く、予定は薄く（やめた回は打ち消し線）。長い題は折り返さず省略する */
function DayItems({ items, agents, onSkip }: { items: Item[]; agents: Agents; onSkip: (rule: RecurringRule, day: string, skip: boolean) => void }) {
  if (!items.length) return <div className="rounded-2xl border border-dashed border-line-2 px-3 py-4 text-center text-[12.5px] text-mute">この日の予定はありません</div>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {items.map((it, i) =>
        it.task ? (
          <li key={`t${it.task.id}`} className="min-w-0">
            <a href={`#/todo/${it.task.id}`} className="flex min-h-11 min-w-0 items-center gap-2.5 rounded-2xl bg-chip/70 px-3 py-1.5 text-ink no-underline transition-colors hover:bg-chip">
              <span className="size-2.5 flex-none rounded-full" style={{ background: taskDot(it.task) }} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-[13.5px] ${it.task.status === "done" ? "text-mute line-through" : ""}`}>{it.task.title}</span>
                <span className="block truncate text-[11px] text-mute">
                  {[it.task.ref, STATUS_LABEL[it.task.status], nameOf(agents, it.task.agent), it.task.project].filter(Boolean).join(" ・ ")}
                </span>
              </span>
              {it.task.source === "recur" && <span className="flex-none rounded-full bg-panel px-2 py-0.5 text-[10.5px] text-mute">繰り返し</span>}
            </a>
          </li>
        ) : (
          <li key={`p${it.rule!.id}-${i}`} className="flex min-h-11 min-w-0 items-center gap-2.5 rounded-2xl border border-dashed border-line-2 px-3 py-1.5">
            <span className="size-2.5 flex-none rounded-full border border-mute" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-[13.5px] text-ink-2 ${it.skipped ? "line-through" : ""}`}>{it.rule!.title}</span>
              <span className="block truncate text-[11px] text-mute">予定 ・ {cadenceLabel(it.rule!.cadence)} ・ {nameOf(agents, it.rule!.agent) ? `${nameOf(agents, it.rule!.agent)}が担当` : "自分"}</span>
            </span>
            <button onClick={() => onSkip(it.rule!, it.day, !it.skipped)} className="flex-none rounded-full border border-line-2 px-2.5 py-1 text-[11px] text-ink-2 hover:bg-chip">{it.skipped ? "戻す" : "この回をやめる"}</button>
          </li>
        ),
      )}
    </ul>
  );
}

/** カレンダーの升目の中の1行（題を省略して出す） */
function Chip({ it, tall }: { it: Item; tall?: boolean }) {
  const title = it.task?.title ?? it.rule!.title;
  const dot = it.task ? taskDot(it.task) : undefined;
  const done = it.task?.status === "done";
  return (
    <span
      title={title}
      className={`flex min-w-0 items-center gap-1 rounded-md px-1.5 text-[11px] leading-[1.5] ${tall ? "py-0.5" : ""} ${it.task ? "bg-chip text-ink" : "border border-dashed border-line-2 text-mute"} ${done || it.skipped ? "opacity-50" : ""}`}
    >
      <span className="size-1.5 flex-none rounded-full" style={it.task ? { background: dot } : { border: "1px solid var(--color-mute)" }} aria-hidden="true" />
      <span className={`min-w-0 flex-1 truncate ${done || it.skipped ? "line-through" : ""}`}>{title}</span>
    </span>
  );
}

interface Draft {
  id: number | null;
  title: string;
  type: Cadence["type"];
  days: number[];
  monthDay: number;
  every: number;
  anchor: string;
  lead: number;
  project: string;
  agent: string;
}

const draftOf = (r: RecurringRule | null, today: string): Draft => ({
  id: r?.id ?? null,
  title: r?.title ?? "",
  type: r?.cadence.type ?? "weekly",
  days: r?.cadence.type === "weekly" ? r.cadence.days : [1],
  monthDay: r?.cadence.type === "monthly" ? r.cadence.day : 1,
  every: r?.cadence.type === "every" ? r.cadence.n : 3,
  anchor: r?.anchor ?? today,
  lead: r?.leadDays ?? 1,
  project: r?.project ?? "",
  agent: r?.agent ?? "",
});

const cadenceOf = (d: Draft): Cadence =>
  d.type === "weekly" ? { type: "weekly", days: d.days } : d.type === "monthly" ? { type: "monthly", day: d.monthDay } : d.type === "every" ? { type: "every", n: d.every } : { type: d.type };

function RuleSheet({ draft, agents, onClose, onSaved }: { draft: Draft; agents: Agents; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState(draft);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { title: d.title, cadence: cadenceOf(d), anchor: d.anchor, leadDays: d.lead, project: d.project, agent: d.agent };
      await call(d.id ? `/api/recurring/${d.id}` : "/api/recurring", d.id ? "PATCH" : "POST", body);
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };
  const field = "min-h-10 min-w-0 flex-1 rounded-xl bg-chip/70 px-3 text-[14px] text-ink outline-none focus:bg-chip";
  const chip = (on: boolean) => `min-h-9 flex-1 rounded-full px-2 text-[12.5px] ${on ? "bg-ink text-paper" : "bg-chip/70 text-ink-2"}`;
  return (
    <Sheet label="繰り返しのルール" onClose={onClose}>
      <SheetCard>
        <div className="flex flex-col gap-2.5 p-3.5">
          <label className="flex items-center gap-3 text-[12.5px] text-mute">
            <span className="w-14 flex-none">題</span>
            <input value={d.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} placeholder="週報を書く" className={field} />
          </label>
          <div role="radiogroup" aria-label="周期" className="flex flex-wrap gap-1">
            {(["daily", "weekdays", "weekly", "monthly", "every"] as const).map((t) => (
              <button key={t} role="radio" aria-checked={d.type === t} onClick={() => set({ type: t })} className={chip(d.type === t)}>
                {t === "daily" ? "毎日" : t === "weekdays" ? "平日" : t === "weekly" ? "毎週" : t === "monthly" ? "毎月" : "N日ごと"}
              </button>
            ))}
          </div>
          {d.type === "weekly" && (
            <div className="flex gap-1" role="group" aria-label="曜日">
              {[1, 2, 3, 4, 5, 6, 0].map((w) => (
                <button key={w} aria-pressed={d.days.includes(w)} onClick={() => set({ days: d.days.includes(w) ? d.days.filter((x) => x !== w) : [...d.days, w] })} className={chip(d.days.includes(w))}>{WD[w]}</button>
              ))}
            </div>
          )}
          {d.type === "monthly" && (
            <label className="flex items-center gap-3 text-[12.5px] text-mute">
              <span className="w-14 flex-none">日</span>
              <input type="number" min={1} max={31} value={d.monthDay} onChange={(e) => set({ monthDay: Number(e.target.value) })} className={field} />
              <span className="text-[11px]">無い月は月末</span>
            </label>
          )}
          {d.type === "every" && (
            <label className="flex items-center gap-3 text-[12.5px] text-mute">
              <span className="w-14 flex-none">間隔</span>
              <input type="number" min={1} max={365} value={d.every} onChange={(e) => set({ every: Number(e.target.value) })} className={field} />
              <span className="text-[11px]">日ごと</span>
            </label>
          )}
          <label className="flex items-center gap-3 text-[12.5px] text-mute">
            <span className="w-14 flex-none">{d.type === "every" ? "起点" : "開始"}</span>
            <input type="date" value={d.anchor} onChange={(e) => set({ anchor: e.target.value })} className={field} />
          </label>
          <label className="flex items-center gap-3 text-[12.5px] text-mute">
            <span className="w-14 flex-none">浮上</span>
            <input type="number" min={0} max={60} value={d.lead} onChange={(e) => set({ lead: Number(e.target.value) })} className={field} />
            <span className="text-[11px]">日前から</span>
          </label>
          <label className="flex items-center gap-3 text-[12.5px] text-mute">
            <span className="w-14 flex-none">担当</span>
            <select value={d.agent} onChange={(e) => set({ agent: e.target.value })} className={field} aria-label="担当">
              <option value="">自分（Todo）</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}（AI-Driven）</option>)}
            </select>
          </label>
          {d.agent && <p className="m-0 px-1 text-[11.5px] leading-snug text-mute">期日が近づくと、自動でカンバンにカードを作って {nameOf(agents, d.agent)} に任せます。</p>}
          <label className="flex items-center gap-3 text-[12.5px] text-mute">
            <span className="w-14 flex-none">PJ</span>
            <input value={d.project} onChange={(e) => set({ project: e.target.value })} maxLength={60} placeholder="（なし）" className={field} />
          </label>
          {error && <div className="rounded-xl bg-orange-soft px-3 py-2 text-xs text-orange-ink" role="alert">{error}</div>}
          <button onClick={() => void save()} disabled={busy || !d.title.trim()} className="min-h-11 rounded-full bg-ink text-[14px] font-semibold text-paper disabled:opacity-40">{d.id ? "保存" : "ルールを足す"}</button>
        </div>
      </SheetCard>
    </Sheet>
  );
}

export function Calendar() {
  const today = localDay();
  const [rules, setRules] = useState<RecurringRule[]>([]);
  const [agents, setAgents] = useState<Agents>([]);
  const [tasks, setTasks] = useState<AppTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"month" | "week">("month");
  const [sel, setSel] = useState(today);
  const [edit, setEdit] = useState<Draft | null>(null);

  // 見えている範囲（月なら前後の週まで）
  const first = mode === "month" ? weekStart(monthStart(sel)) : weekStart(sel);
  const last = mode === "month" ? shiftDay(weekStart(shiftDay(addMonths(sel, 1), -1)), 6) : shiftDay(first, 6);

  const load = useCallback(async () => {
    try {
      // 期日がこの範囲のタスクだけ読む（動かすたびに読み直す）
      const [r, l] = await Promise.all([call<{ rules: RecurringRule[]; agents: Agents }>("/api/recurring"), fetchTaskList(new URLSearchParams({ status: "inbox,todo,doing,done", dueFrom: first, dueTo: last }))]);
      setRules(r.rules);
      setAgents(r.agents ?? []);
      setTasks(l.tasks);
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [first, last]);
  useEffect(() => void load(), [load]);

  const days = useMemo(() => {
    const out: string[] = [];
    for (let d = first; d <= last; d = shiftDay(d, 1)) out.push(d);
    return out;
  }, [first, last]);

  const byDay = useMemo(() => {
    const m = new Map<string, Item[]>();
    const add = (it: Item) => m.set(it.day, [...(m.get(it.day) ?? []), it]);
    const made = new Set(tasks.filter((t) => t.source === "recur").map((t) => t.sourceKey));
    for (const t of tasks) if (t.due && t.due >= first && t.due <= last && t.doneReason !== "unneeded") add({ kind: "task", day: t.due, task: t });
    for (const r of rules) {
      if (!r.enabled) continue;
      for (const d of occurrences(r, first > today ? first : today, last)) if (!made.has(`${r.id}:${d}`)) add({ kind: "plan", day: d, rule: r, skipped: r.skips.includes(d) });
    }
    return m;
  }, [tasks, rules, first, last, today]);

  const move = (n: number) => setSel(mode === "month" ? addMonths(sel, n) : shiftDay(sel, 7 * n));
  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };
  const skip = (rule: RecurringRule, day: string, v: boolean) => act(() => call(`/api/recurring/${rule.id}/skip`, "POST", { day, skip: v }));
  const toggle = (r: RecurringRule) => act(() => call(`/api/recurring/${r.id}`, "PATCH", { enabled: !r.enabled }));
  const remove = (r: RecurringRule) => {
    if (confirm(`「${r.title}」のルールを消しますか？（作ったタスクは残ります）`)) void act(() => call(`/api/recurring/${r.id}`, "DELETE"));
  };

  const title = mode === "month" ? `${sel.slice(0, 4)}年${Number(sel.slice(5, 7))}月` : `${md(first)} 〜 ${md(last)}`;
  const seg = (on: boolean) => `min-h-8 rounded-full px-3.5 text-[12.5px] transition-colors ${on ? "bg-panel font-semibold text-ink shadow-sm" : "text-ink-2"}`;
  const navBtn = "flex size-9 flex-none items-center justify-center rounded-full bg-chip text-[18px] leading-none text-ink-2 transition-colors hover:bg-line/60";
  const selItems = byDay.get(sel) ?? [];

  return (
    <Page title="カレンダー" current="#/pj" right={<a href="#/todos" className="text-[13px] text-mute no-underline">タスク一覧 ›</a>}>
      <div className="mx-auto grid w-full max-w-[1280px] grid-cols-1 gap-x-6 gap-y-4 px-4 pb-10 pt-2 md:px-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        {error && <div className="rounded-lg bg-orange-soft px-3 py-2 text-xs text-orange-ink lg:col-span-2" role="alert">{error}</div>}

        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 mr-auto min-w-0 truncate text-[20px] font-bold tracking-tight md:text-[24px]">{title}</h2>
            <div role="tablist" aria-label="表示" className="flex rounded-full bg-chip p-0.5">
              <button role="tab" aria-selected={mode === "month"} onClick={() => setMode("month")} className={seg(mode === "month")}>月</button>
              <button role="tab" aria-selected={mode === "week"} onClick={() => setMode("week")} className={seg(mode === "week")}>週</button>
            </div>
            <button onClick={() => setSel(today)} className="min-h-9 rounded-full bg-chip px-3.5 text-[12.5px] text-ink-2 transition-colors hover:bg-line/60">今日</button>
            <button onClick={() => move(-1)} aria-label="前へ" className={navBtn}>‹</button>
            <button onClick={() => move(1)} aria-label="次へ" className={navBtn}>›</button>
          </div>

          {mode === "month" ? (
            <div className="overflow-hidden rounded-2xl border border-line bg-panel" role="grid" aria-label={title}>
              <div className="grid grid-cols-7 border-b border-line bg-chip/50" role="row">
                {[1, 2, 3, 4, 5, 6, 0].map((w) => <div key={w} role="columnheader" className={`py-1.5 text-center text-[11px] font-medium ${w === 0 ? "text-red-ink" : w === 6 ? "text-ink-2" : "text-mute"}`}>{WD[w]}</div>)}
              </div>
              <div className="grid grid-cols-7">
                {days.map((d, i) => {
                  const items = byDay.get(d) ?? [];
                  const out = d.slice(0, 7) !== sel.slice(0, 7);
                  const dow = i % 7; // 月曜始まり: 5=土 6=日
                  return (
                    <button
                      key={d}
                      role="gridcell"
                      aria-selected={d === sel}
                      aria-label={`${md(d)} ${items.length}件`}
                      onClick={() => setSel(d)}
                      className={`flex min-h-[62px] min-w-0 flex-col items-stretch gap-1 overflow-hidden border-b border-r border-line/70 p-1 text-left transition-colors sm:min-h-[96px] lg:min-h-[118px] ${d === sel ? "bg-lime-soft/40 ring-2 ring-inset ring-ink" : "hover:bg-chip/50"} ${out ? "opacity-45" : ""} ${(i + 1) % 7 === 0 ? "border-r-0" : ""}`}
                    >
                      <span className={`flex size-6 flex-none items-center justify-center self-start rounded-full text-[12px] tabular-nums ${d === today ? "bg-ink font-bold text-paper" : dow === 6 ? "text-red-ink" : dow === 5 ? "text-ink-2" : "text-ink"}`}>{Number(d.slice(8, 10))}</span>
                      {/* スマホは点だけ。広いところは題を出す（長いものは省略） */}
                      <span className="flex flex-wrap justify-center gap-[3px] sm:hidden" aria-hidden="true">
                        {items.slice(0, 5).map((it, k) => <span key={k} className="size-[7px] rounded-full" style={it.task ? { background: taskDot(it.task), opacity: it.task.status === "done" ? 0.35 : 1 } : { border: "1px solid var(--color-mute)", opacity: it.skipped ? 0.3 : 1 }} />)}
                      </span>
                      <span className="hidden min-w-0 flex-col gap-[3px] sm:flex">
                        {items.slice(0, 3).map((it, k) => <Chip key={k} it={it} />)}
                        {items.length > 3 && <span className="px-1.5 text-[10.5px] text-mute">ほか {items.length - 3} 件</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-7 md:gap-0 md:overflow-hidden md:rounded-2xl md:border md:border-line md:bg-panel">
              {days.map((d, i) => {
                const items = byDay.get(d) ?? [];
                return (
                  <section key={d} aria-label={md(d)} className={`min-w-0 md:min-h-[320px] md:border-r md:border-line/70 md:p-1.5 ${i === 6 ? "md:border-r-0" : ""} ${d === sel ? "md:bg-lime-soft/30" : ""}`}>
                    <button onClick={() => setSel(d)} className={`mb-1 flex w-full items-center gap-1.5 px-1 text-left text-[12.5px] font-semibold ${d === today ? "text-ink" : "text-mute"}`}>
                      <span className={d === today ? "flex size-6 items-center justify-center rounded-full bg-ink text-[12px] text-paper" : ""}>{Number(d.slice(8, 10))}</span>
                      <span>{WD[new Date(`${d}T00:00:00Z`).getUTCDay()]}</span>
                    </button>
                    <div className="hidden min-w-0 flex-col gap-1 md:flex">{items.map((it, k) => <Chip key={k} it={it} tall />)}</div>
                    <div className="md:hidden"><DayItems items={items} agents={agents} onSkip={skip} /></div>
                  </section>
                );
              })}
            </div>
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-2">
          <section aria-label={md(sel)}>
            <h2 className="m-0 mb-2 px-1 text-[13px] font-semibold">{md(sel)}{sel === today ? " · 今日" : ""}<span className="ml-2 font-normal text-mute">{selItems.length}件</span></h2>
            <DayItems items={selItems} agents={agents} onSkip={skip} />
          </section>

          <section aria-label="繰り返しのルール">
            <div className="mb-2 flex items-center px-1">
              <h2 className="m-0 text-[13px] font-semibold">繰り返しのルール</h2>
              <button onClick={() => setEdit(draftOf(null, today))} className="ml-auto min-h-8 rounded-full bg-ink px-3.5 text-[12.5px] font-semibold text-paper">＋ 足す</button>
            </div>
            {rules.length === 0 && <div className="rounded-2xl border border-dashed border-line-2 px-3 py-4 text-center text-[12.5px] text-mute">まだありません。「週報を毎週月曜」のように足せます</div>}
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {rules.map((r) => (
                <li key={r.id} className={`flex min-w-0 items-center gap-2 rounded-2xl bg-chip/70 px-3 py-2 ${r.enabled ? "" : "opacity-60"}`}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] text-ink">{r.title}</div>
                    <div className="truncate text-[11px] text-mute">{cadenceLabel(r.cadence)} ・ {r.leadDays}日前から ・ {r.agent ? `${nameOf(agents, r.agent)}が担当` : "自分"}{r.project ? ` ・ ${r.project}` : ""}{r.enabled ? "" : " ・ 停止中"}</div>
                  </div>
                  <button onClick={() => void toggle(r)} className="flex-none rounded-full border border-line-2 px-2.5 py-1 text-[11px] text-ink-2 hover:bg-chip">{r.enabled ? "止める" : "再開"}</button>
                  <button onClick={() => setEdit(draftOf(r, today))} className="flex-none rounded-full border border-line-2 px-2.5 py-1 text-[11px] text-ink-2 hover:bg-chip">直す</button>
                  <button onClick={() => remove(r)} aria-label={`${r.title}を消す`} className="flex-none px-1 text-[16px] text-mute hover:text-ink">×</button>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
      {edit && <RuleSheet draft={edit} agents={agents} onClose={() => setEdit(null)} onSaved={() => void load()} />}
    </Page>
  );
}
