// カレンダー: 月・週の表示。実際のタスク（期日つき）は濃く、繰り返しのルールから来る予定は薄く重ねる。
// ルールの追加・直し・停止・その回だけやめる、もここからできる。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AppTask } from "../shared/types";
import { type Cadence, type RecurringRule, cadenceLabel, occurrences, shiftDay } from "../shared/recurrence";
import { localDay } from "../shared/time";
import { json } from "./memo-light";
import { IconButton, Sheet, SheetCard, useConfirm } from "./sheet";
import { fetchTaskList } from "./task-db";
import { STATUS_LABEL, taskDot } from "./TaskRow";
import { Page } from "./ui";

const WD = ["日", "月", "火", "水", "木", "金", "土"];
const call = <T,>(path: string, method = "GET", body?: unknown) =>
  fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => json<T>(r));

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
            <IconButton name={it.skipped ? "undo" : "skip"} label={it.skipped ? "やめた回を戻す" : "この回をやめる"} onClick={() => onSkip(it.rule!, it.day, !it.skipped)} tone="chip" size={16} className="!size-8" />
          </li>
        ),
      )}
    </ul>
  );
}

/** カレンダーの升目の中の1行（題を省略して出す） */
function Chip({ it, tall, wrap }: { it: Item; tall?: boolean; wrap?: boolean }) {
  const title = it.task?.title ?? it.rule!.title;
  const dot = it.task ? taskDot(it.task) : undefined;
  const done = it.task?.status === "done";
  return (
    <span
      title={title}
      className={`flex min-w-0 items-center gap-1 rounded-md px-1.5 text-[11px] leading-[1.5] ${tall ? "py-0.5" : ""} ${it.task ? "bg-chip text-ink" : "border border-dashed border-line-2 text-mute"} ${done || it.skipped ? "opacity-50" : ""}`}
    >
      <span className="size-1.5 flex-none rounded-full" style={it.task ? { background: dot } : { border: "1px solid var(--color-mute)" }} aria-hidden="true" />
      <span className={`min-w-0 flex-1 ${wrap ? "line-clamp-2 break-words" : "truncate"} ${done || it.skipped ? "line-through" : ""}`}>{title}</span>
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
            <input value={d.project} onChange={(e) => set({ project: e.target.value })} maxLength={60} placeholder="未仕訳" className={field} />
          </label>
          {error && <div className="rounded-xl bg-orange-soft px-3 py-2 text-xs text-orange-ink" role="alert">{error}</div>}
          <button onClick={() => void save()} disabled={busy || !d.title.trim()} className="min-h-11 rounded-full bg-ink text-[14px] font-semibold text-paper disabled:opacity-40">{d.id ? "保存" : "ルールを足す"}</button>
        </div>
      </SheetCard>
    </Sheet>
  );
}

interface Api {
  goto: (day: string, smooth?: boolean) => void;
  shift: (n: number) => void;
}
interface ScrollerProps {
  anchor: string;
  today: string;
  sel: string;
  byDay: Map<string, Item[]>;
  onSel: (d: string) => void;
  onRange: (first: string, last: string) => void;
  onTitle: (day: string) => void;
  api: React.MutableRefObject<Api | null>;
}

/** 月: 縦に無限スクロール（週が1行）。上下の端に近づくと、その先の週を足す */
export function MonthScroller({ anchor, today, sel, byDay, onSel, onRange, onTitle, api }: ScrollerProps) {
  const box = useRef<HTMLDivElement>(null);
  const [from, setFrom] = useState(() => shiftDay(weekStart(anchor), -7 * 10));
  const [weeks, setWeeks] = useState(28);
  const fix = useRef<number | null>(null);
  const raf = useRef(0);
  const rowH = () => box.current?.querySelector<HTMLElement>("[data-week]")?.offsetHeight || 96;

  useLayoutEffect(() => onRange(from, shiftDay(from, weeks * 7 - 1)), [from, weeks]); // eslint-disable-line react-hooks/exhaustive-deps
  // 頭に足したぶん、見ている位置がずれないように送る
  useLayoutEffect(() => {
    if (fix.current !== null && box.current) {
      box.current.scrollTop += fix.current;
      fix.current = null;
    }
  }, [from]);
  const goto = useCallback((day: string, smooth = false) => {
    const el = box.current?.querySelector<HTMLElement>(`[data-week="${weekStart(day)}"]`);
    if (el && box.current) box.current.scrollTo({ top: Math.max(0, el.offsetTop - rowH()), behavior: smooth ? "smooth" : "auto" });
  }, []);
  useLayoutEffect(() => {
    goto(anchor);
    api.current = { goto, shift: (n) => box.current?.scrollBy({ top: n * 4 * rowH(), behavior: "smooth" }) };
    onScroll();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      const h = rowH();
      const idx = Math.max(0, Math.min(weeks - 1, Math.floor((el.scrollTop + h * 1.2) / h)));
      onTitle(shiftDay(from, idx * 7 + 3));
      if (el.scrollTop < h * 3 && fix.current === null) {
        fix.current = 8 * h;
        setFrom((f) => shiftDay(f, -56));
        setWeeks((w) => w + 8);
      } else if (el.scrollHeight - el.scrollTop - el.clientHeight < h * 3) setWeeks((w) => w + 8);
    });
  };

  const starts = useMemo(() => Array.from({ length: weeks }, (_, k) => shiftDay(from, k * 7)), [from, weeks]);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="grid flex-none grid-cols-7 border-b border-line bg-chip/50" role="row">
        {[1, 2, 3, 4, 5, 6, 0].map((w) => <div key={w} role="columnheader" className={`py-1.5 text-center text-[11px] font-medium ${w === 0 ? "text-red-ink" : w === 6 ? "text-ink-2" : "text-mute"}`}>{WD[w]}</div>)}
      </div>
      <div ref={box} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain" style={{ overflowAnchor: "none" }} role="grid" aria-label="タスクカレンダー（月）">
        {starts.map((w0) => (
          <div key={w0} data-week={w0} role="row" className="grid h-[64px] grid-cols-7 sm:h-[96px] lg:h-[118px]">
            {Array.from({ length: 7 }, (_, k) => {
              const d = shiftDay(w0, k);
              const items = byDay.get(d) ?? [];
              const odd = Number(d.slice(5, 7)) % 2 === 1;
              const first = d.slice(8, 10) === "01";
              return (
                <button
                  key={d}
                  role="gridcell"
                  aria-selected={d === sel}
                  aria-label={`${md(d)} ${items.length}件`}
                  onClick={() => onSel(d)}
                  className={`flex min-w-0 flex-col items-stretch gap-1 overflow-hidden border-b border-r border-line/70 p-1 text-left transition-colors ${k === 6 ? "border-r-0" : ""} ${d === sel ? "bg-lime-soft/40 ring-2 ring-inset ring-ink" : odd ? "bg-chip/30 hover:bg-chip/60" : "hover:bg-chip/50"}`}
                >
                  <span className={`flex h-6 flex-none items-center gap-1 self-start rounded-full text-[12px] tabular-nums ${d === today ? "bg-ink px-2 font-bold text-paper" : k === 6 ? "text-red-ink" : k === 5 ? "text-ink-2" : "text-ink"} ${first && d !== today ? "font-bold" : ""}`}>
                    {first ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : Number(d.slice(8, 10))}
                  </span>
                  <span className="flex flex-wrap justify-center gap-[3px] sm:hidden" aria-hidden="true">
                    {items.slice(0, 5).map((it, i) => <span key={i} className="size-[7px] rounded-full" style={it.task ? { background: taskDot(it.task), opacity: it.task.status === "done" ? 0.35 : 1 } : { border: "1px solid var(--color-mute)", opacity: it.skipped ? 0.3 : 1 }} />)}
                  </span>
                  <span className="hidden min-w-0 flex-col gap-[3px] sm:flex">
                    {items.slice(0, 3).map((it, i) => <Chip key={i} it={it} />)}
                    {items.length > 3 && <span className="px-1.5 text-[10.5px] text-mute">ほか {items.length - 3} 件</span>}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 週: 横に無限スクロール（日が1列）。左右の端に近づくと、その先の日を足す */
export function WeekScroller({ anchor, today, sel, byDay, onSel, onRange, onTitle, api }: ScrollerProps) {
  const box = useRef<HTMLDivElement>(null);
  const [from, setFrom] = useState(() => shiftDay(weekStart(anchor), -14));
  const [count, setCount] = useState(56);
  const fix = useRef<number | null>(null);
  const raf = useRef(0);
  const colW = () => box.current?.querySelector<HTMLElement>("[data-day]")?.offsetWidth || 120;

  useLayoutEffect(() => onRange(from, shiftDay(from, count - 1)), [from, count]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (fix.current !== null && box.current) {
      box.current.scrollLeft += fix.current;
      fix.current = null;
    }
  }, [from]);
  const goto = useCallback((day: string, smooth = false) => {
    const el = box.current?.querySelector<HTMLElement>(`[data-day="${weekStart(day)}"]`);
    if (el && box.current) box.current.scrollTo({ left: el.offsetLeft, behavior: smooth ? "smooth" : "auto" });
  }, []);
  useLayoutEffect(() => {
    goto(anchor);
    api.current = { goto, shift: (n) => box.current?.scrollBy({ left: n * 7 * colW(), behavior: "smooth" }) };
    onScroll();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      const w = colW();
      onTitle(shiftDay(from, Math.max(0, Math.min(count - 1, Math.floor(el.scrollLeft / w) + 2))));
      if (el.scrollLeft < w * 7 && fix.current === null) {
        fix.current = 14 * w;
        setFrom((f) => shiftDay(f, -14));
        setCount((c) => c + 14);
      } else if (el.scrollWidth - el.scrollLeft - el.clientWidth < w * 7) setCount((c) => c + 14);
    });
  };

  const days = useMemo(() => Array.from({ length: count }, (_, k) => shiftDay(from, k)), [from, count]);
  return (
    <div ref={box} onScroll={onScroll} style={{ overflowAnchor: "none" }} className="flex min-h-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-contain rounded-2xl border border-line bg-panel" role="grid" aria-label="タスクカレンダー（週）">
      {days.map((d) => {
        const items = byDay.get(d) ?? [];
        const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
        const first = d.slice(8, 10) === "01";
        return (
          <section key={d} data-day={d} role="gridcell" aria-label={md(d)} className={`flex w-1/3 flex-none flex-col border-r border-line/70 md:w-1/5 xl:w-1/7 ${Number(d.slice(5, 7)) % 2 === 1 ? "bg-chip/30" : ""} ${d === sel ? "bg-lime-soft/40" : ""}`}>
            <button onClick={() => onSel(d)} aria-label={`${md(d)} ${items.length}件`} className="flex flex-none flex-col items-start gap-0.5 border-b border-line/70 px-2 py-1.5 text-left hover:bg-chip/50">
              <span className={`text-[11px] ${dow === 0 ? "text-red-ink" : "text-mute"}`}>{first ? `${Number(d.slice(5, 7))}月` : ""} {WD[dow]}</span>
              <span className={`flex h-7 min-w-7 items-center justify-center rounded-full text-[15px] font-semibold tabular-nums ${d === today ? "bg-ink px-2 text-paper" : "text-ink"}`}>{Number(d.slice(8, 10))}</span>
            </button>
            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1">{items.map((it, i) => <Chip key={i} it={it} tall wrap />)}</div>
          </section>
        );
      })}
    </div>
  );
}

const SPAN = 56; // 1回に読む日数（一覧の上限に当たらないように区切る）

export function Calendar() {
  const today = localDay();
  const [rules, setRules] = useState<RecurringRule[]>([]);
  const [agents, setAgents] = useState<Agents>([]);
  const [tasks, setTasks] = useState<Map<number, AppTask>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"month" | "week">("month");
  const [sel, setSel] = useState(today);
  const [anchor, setAnchor] = useState(today);
  const [titleDay, setTitleDay] = useState(today);
  const [range, setRange] = useState({ first: today, last: today });
  const [edit, setEdit] = useState<Draft | null>(null);
  const api = useRef<Api | null>(null);
  const covered = useRef<{ a: string; b: string } | null>(null);

  const span = async (a: string, b: string): Promise<AppTask[]> => {
    const out: AppTask[] = [];
    const jobs: Promise<void>[] = [];
    for (let d = a; d <= b; d = shiftDay(d, SPAN)) {
      const e = shiftDay(d, SPAN - 1) < b ? shiftDay(d, SPAN - 1) : b;
      jobs.push(fetchTaskList(new URLSearchParams({ status: "inbox,todo,doing,done", dueFrom: d, dueTo: e })).then((l) => void out.push(...l.tasks)));
    }
    await Promise.all(jobs);
    return out;
  };
  const merge = (list: AppTask[], replace: boolean) => setTasks((m) => {
    const n = replace ? new Map<number, AppTask>() : new Map(m);
    for (const t of list) n.set(t.id, t);
    return n;
  });
  const loadRules = async () => {
    const r = await call<{ rules: RecurringRule[]; agents: Agents }>("/api/recurring");
    setRules(r.rules);
    setAgents(r.agents ?? []);
  };
  // 範囲が広がったら、足りない分だけ読む
  useEffect(() => {
    const c = covered.current;
    const run = async () => {
      try {
        if (!c) {
          merge(await span(range.first, range.last), true);
          await loadRules();
        } else {
          const jobs: Promise<AppTask[]>[] = [];
          if (range.first < c.a) jobs.push(span(range.first, shiftDay(c.a, -1)));
          if (range.last > c.b) jobs.push(span(shiftDay(c.b, 1), range.last));
          if (jobs.length) merge((await Promise.all(jobs)).flat(), false);
        }
        covered.current = { a: c && c.a < range.first ? c.a : range.first, b: c && c.b > range.last ? c.b : range.last };
        setError(null);
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      }
    };
    void run();
  }, [range]); // eslint-disable-line react-hooks/exhaustive-deps
  /** 変えたあとは、見えている範囲を全部読み直す */
  const load = useCallback(async () => {
    try {
      merge(await span(range.first, range.last), true);
      await loadRules();
      covered.current = { a: range.first, b: range.last };
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [range]); // eslint-disable-line react-hooks/exhaustive-deps

  const byDay = useMemo(() => {
    const m = new Map<string, Item[]>();
    const add = (it: Item) => m.set(it.day, [...(m.get(it.day) ?? []), it]);
    const list = [...tasks.values()];
    const made = new Set(list.filter((t) => t.source === "recur").map((t) => t.sourceKey));
    for (const t of list) if (t.due && t.due >= range.first && t.due <= range.last && t.doneReason !== "unneeded") add({ kind: "task", day: t.due, task: t });
    for (const r of rules) {
      if (!r.enabled) continue;
      for (const d of occurrences(r, range.first > today ? range.first : today, range.last)) if (!made.has(`${r.id}:${d}`)) add({ kind: "plan", day: d, rule: r, skipped: r.skips.includes(d) });
    }
    return m;
  }, [tasks, rules, range, today]);

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
  const { ask, node: confirmNode } = useConfirm();
  const remove = (r: RecurringRule) => ask(`「${r.title}」のルールを消します。作ったタスクは残ります。`, () => void act(() => call(`/api/recurring/${r.id}`, "DELETE")));

  const onRange = useCallback((first: string, last: string) => setRange((r) => (r.first === first && r.last === last ? r : { first, last })), []);
  const switchMode = (m: "month" | "week") => {
    if (m === mode) return;
    covered.current = null;
    setAnchor(titleDay);
    setMode(m);
  };
  const title = `${titleDay.slice(0, 4)}年${Number(titleDay.slice(5, 7))}月`;
  const seg = (on: boolean) => `min-h-8 rounded-full px-3.5 text-[12.5px] transition-colors ${on ? "bg-panel font-semibold text-ink shadow-sm" : "text-ink-2"}`;
  const navBtn = "flex size-9 flex-none items-center justify-center rounded-full bg-chip text-[18px] leading-none text-ink-2 transition-colors hover:bg-line/60";
  const selItems = byDay.get(sel) ?? [];
  const props = { anchor, today, sel, byDay, onSel: setSel, onRange, onTitle: setTitleDay, api };

  return (
    <Page title="タスクカレンダー" current="#/pj" right={<IconButton name="list" label="タスク一覧" href="#/todos" />}>
      <div className="mx-auto grid w-full max-w-[1280px] grid-cols-1 gap-x-6 gap-y-4 px-4 pb-10 pt-2 md:px-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        {error && <div className="rounded-lg bg-orange-soft px-3 py-2 text-xs text-orange-ink lg:col-span-2" role="alert">{error}</div>}

        <div className="flex h-[70dvh] min-w-0 flex-col gap-3 lg:h-[calc(100dvh-132px)]">
          <div className="flex flex-none flex-wrap items-center gap-2">
            <h2 className="m-0 mr-auto min-w-0 truncate text-[20px] font-bold tracking-tight md:text-[24px]">{title}</h2>
            <div role="tablist" aria-label="表示" className="flex rounded-full bg-chip p-0.5">
              <button role="tab" aria-selected={mode === "month"} onClick={() => switchMode("month")} className={seg(mode === "month")}>月</button>
              <button role="tab" aria-selected={mode === "week"} onClick={() => switchMode("week")} className={seg(mode === "week")}>週</button>
            </div>
            <button onClick={() => { setSel(today); api.current?.goto(today, true); }} className="min-h-9 rounded-full bg-chip px-3.5 text-[12.5px] text-ink-2 transition-colors hover:bg-line/60">今日</button>
            <button onClick={() => api.current?.shift(-1)} aria-label="前へ" className={navBtn}>‹</button>
            <button onClick={() => api.current?.shift(1)} aria-label="次へ" className={navBtn}>›</button>
          </div>
          {mode === "month" ? <MonthScroller key="m" {...props} /> : <WeekScroller key="w" {...props} />}
        </div>

        <aside className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-2">
          <section aria-label={md(sel)}>
            <h2 className="m-0 mb-2 px-1 text-[13px] font-semibold">{md(sel)}{sel === today ? " · 今日" : ""}<span className="ml-2 font-normal text-mute">{selItems.length}件</span></h2>
            <DayItems items={selItems} agents={agents} onSkip={skip} />
          </section>

          <section aria-label="繰り返しのルール">
            <div className="mb-2 flex items-center px-1">
              <h2 className="m-0 text-[13px] font-semibold">繰り返しのルール</h2>
              <IconButton name="plus" label="ルールを足す" onClick={() => setEdit(draftOf(null, today))} tone="solid" className="ml-auto !size-8" />
            </div>
            {rules.length === 0 && <div className="rounded-2xl border border-dashed border-line-2 px-3 py-4 text-center text-[12.5px] text-mute">まだありません。「週報を毎週月曜」のように足せます</div>}
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {rules.map((r) => (
                <li key={r.id} className={`flex min-w-0 items-center gap-2 rounded-2xl bg-chip/70 px-3 py-2 ${r.enabled ? "" : "opacity-60"}`}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] text-ink">{r.title}</div>
                    <div className="truncate text-[11px] text-mute">{cadenceLabel(r.cadence)} ・ {r.leadDays}日前から ・ {r.agent ? `${nameOf(agents, r.agent)}が担当` : "自分"}{r.project ? ` ・ ${r.project}` : ""}{r.enabled ? "" : " ・ 停止中"}</div>
                  </div>
                  <IconButton name={r.enabled ? "pause" : "play"} label={r.enabled ? "止める" : "再開する"} onClick={() => void toggle(r)} size={16} className="!size-8" />
                  <IconButton name="rename" label="直す" onClick={() => setEdit(draftOf(r, today))} size={16} className="!size-8" />
                  <IconButton name="trash" label={`${r.title}を消す`} onClick={() => remove(r)} tone="danger" size={16} className="!size-8" />
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
      {confirmNode}
      {edit && <RuleSheet draft={edit} agents={agents} onClose={() => setEdit(null)} onSaved={() => void load()} />}
    </Page>
  );
}
