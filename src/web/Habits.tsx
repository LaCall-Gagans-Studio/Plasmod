// 統計（下のメニューの「統計」。前のルーティーンの画面）: 上に期間の数字と1枚のグラフ、下にルーティーン・この半年の草・よく使ったタグ。
// ルーティーンのチェックはここと、レポートからできる。
import { type PointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { Habit, HabitOverview, StatsRange, StatsReport } from "../shared/types";
import { StatsChart, cumulative } from "./stats-chart";
import { Skeleton } from "./loading";
import { json } from "./memo-light";
import { Page } from "./ui";

/** チェックを付ける・外す。結果のルーティーンが返る */
export const checkHabit = (id: number, done: boolean) =>
  fetch(`/api/habits/${id}/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done }) }).then((r) => json<Habit>(r));

const LEVEL = ["bg-chip", "bg-ring-lime/30", "bg-ring-lime/55", "bg-ring-lime/80", "bg-ring-lime"];

/** その日のチェックの数を、ルーティーンの数に対する割合で5段階に */
function levelOf(count: number, habits: number) {
  if (count <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((count / Math.max(1, habits)) * 4)));
}

/** 草グラフ: 1列が1週間（月曜が上）。新しい週が右。右端を最初に見せる */
function Grass({ days, habits }: { days: HabitOverview["days"]; habits: number }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollLeft = box.current.scrollWidth;
  }, [days.length]);
  const first = days[0]?.day;
  // 最初の週の、月曜までの空き
  const pad = first ? (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7 : 0;
  const cells: (HabitOverview["days"][number] | null)[] = [...Array.from({ length: pad }, () => null), ...days];
  const weeks: (typeof cells)[] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const active = days.filter((d) => d.count > 0).length;
  return (
    <Card title="この半年" right={<span className="font-mono tabular-nums">{active} 日</span>} label="これまでの記録">
      <div className="px-3.5 py-3">
        <div ref={box} className="flex gap-[3px] overflow-x-auto [scrollbar-width:none]" data-noswipe>
          <span className="flex-1" />
          {weeks.map((w, i) => (
            <div key={i} className="flex flex-none flex-col gap-[3px]">
              {w.map((d, k) =>
                d ? (
                  <span key={d.day} title={`${d.day}: ${d.count} 件`} className={`size-[11px] rounded-[3px] ${LEVEL[levelOf(d.count, habits)]}`} />
                ) : (
                  <span key={`pad${k}`} className="size-[11px]" />
                ),
              )}
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-end gap-1 text-[10.5px] text-mute">
          少{LEVEL.map((c) => <i key={c} className={`size-[9px] rounded-[2px] ${c}`} />)}多
        </div>
      </div>
    </Card>
  );
}

/** 統計の箱（見出しの行＋中身）。角は 12px、影なしで細い線 */
function Card({ title, right, label, children, className = "" }: { title: string; right?: ReactNode; label?: string; children: ReactNode; className?: string }) {
  return (
    <section aria-label={label ?? title} className={`min-w-0 overflow-hidden rounded-xl border border-line bg-panel ${className}`}>
      <div className="flex min-h-10 items-center gap-2 border-b border-line px-3.5 text-[12.5px] font-medium text-ink-2">
        {title}
        <span className="ml-auto flex items-center gap-2 text-[12px] font-normal text-mute">{right}</span>
      </div>
      {children}
    </section>
  );
}

/** 統計のルーティーンの1行: 四角のチェック・名前・直近7日のマス・連続日数 */
function StatHabitRow({ h, onChange }: { h: Habit; onChange: (next: Habit) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const toggle = async () => {
    setBusy(true);
    setError(false);
    try {
      onChange(await checkHabit(h.id, !h.doneToday));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button role="checkbox" aria-checked={h.doneToday} disabled={busy} onClick={() => void toggle()} className="flex min-h-11 w-full items-center gap-2.5 border-t border-line px-3.5 text-left first:border-t-0 hover:bg-chip/40 disabled:opacity-60">
      <span className={`flex size-[17px] flex-none items-center justify-center rounded-[5px] border-[1.5px] ${h.doneToday ? "border-ring-lime bg-ring-lime text-[#17171a]" : "border-line-2"}`}>
        {h.doneToday && <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.5} aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}
      </span>
      {h.emoji && <span className="flex-none text-[15px] leading-none">{h.emoji}</span>}
      <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{h.name}</span>
      <span className="flex flex-none gap-[2px]" aria-hidden="true">
        {(h.week ?? []).map((on, i) => <i key={i} className={`size-[9px] rounded-[3px] ${on ? "bg-ring-lime" : "bg-chip"}`} />)}
      </span>
      <span className="w-[60px] flex-none text-right font-mono text-[11px] tabular-nums text-mute">{error ? <span className="font-sans font-semibold text-red-ink">送れません</span> : h.streak > 0 ? `${h.streak}日連続` : "—"}</span>
    </button>
  );
}

export function HabitRow({ h, onChange, light }: { h: Habit; onChange: (next: Habit) => void; light?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const toggle = async () => {
    setBusy(true);
    setError(false);
    try {
      onChange(await checkHabit(h.id, !h.doneToday));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      role="checkbox"
      aria-checked={h.doneToday}
      disabled={busy}
      onClick={() => void toggle()}
      className={`flex min-h-[52px] w-full items-center gap-3 rounded-2xl px-3.5 py-2 text-left disabled:opacity-60 ${light ? "bg-on/10 text-on" : "border border-line bg-panel text-ink"}`}
    >
      <span className={`flex size-7 flex-none items-center justify-center rounded-full border-2 ${h.doneToday ? (light ? "border-[#17171a] bg-[#17171a] text-white" : "border-lime bg-lime text-on") : light ? "border-on/40" : "border-line-2"}`}>
        {h.doneToday && (
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        )}
      </span>
      {h.emoji && <span className="flex-none text-[18px] leading-none">{h.emoji}</span>}
      <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold">{h.name}</span>
      {error ? <span className="flex-none text-[11px] font-semibold text-red-ink">送れませんでした</span> : h.streak > 0 && <span className="flex-none text-[11.5px] tabular-nums opacity-70">{h.streak} 日連続</span>}
    </button>
  );
}

/** 編集の1行: 線をつまんで並べ替え、文字を押すとそのまま書ける、× で消す */
function EditRow({ h, dragging, offset, onHandle, onRename, onRemove, rowRef }: { h: Habit; dragging: boolean; offset: number; onHandle: (e: PointerEvent<HTMLButtonElement>) => void; onRename: (name: string) => void; onRemove: () => void; rowRef: (el: HTMLDivElement | null) => void }) {
  return (
    <div
      ref={rowRef}
      style={{ transform: offset ? `translateY(${offset}px)` : undefined }}
      className={`relative flex min-h-[52px] items-center gap-1 rounded-2xl border bg-panel pl-1 pr-1 ${dragging ? "z-10 border-line-2 shadow-[0_8px_24px_rgba(0,0,0,0.16)]" : "border-line transition-transform duration-150"}`}
    >
      <button aria-label={`${h.name}を並べ替える`} onPointerDown={onHandle} data-noswipe className="flex size-11 flex-none cursor-grab touch-none items-center justify-center text-mute active:cursor-grabbing">
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><path d="M5 8h14M5 12h14M5 16h14" /></svg>
      </button>
      {h.emoji && <span className="flex-none text-[18px] leading-none">{h.emoji}</span>}
      <input
        defaultValue={h.name}
        key={h.name}
        maxLength={60}
        aria-label={`${h.name}の名前`}
        onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && e.currentTarget.blur()}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && v !== h.name) onRename(v);
          else e.target.value = h.name;
        }}
        className="min-h-11 min-w-0 flex-1 bg-transparent px-1 text-[14.5px] font-semibold text-ink outline-none"
      />
      <button onClick={onRemove} aria-label={`${h.name}を消す`} className="flex size-11 flex-none items-center justify-center rounded-full text-mute hover:text-red-ink">
        <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  );
}

export function Habits() {
  const [ov, setOv] = useState<HabitOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(false);
  const load = useCallback(
    () =>
      fetch("/api/habits")
        .then((r) => json<HabitOverview>(r))
        .then((x) => {
          setOv(x);
          setError(null);
        })
        .catch((e) => setError(String(e instanceof Error ? e.message : e))),
    [],
  );
  useEffect(() => void load(), [load]);

  // 統計（期間は端末に覚える）
  const [range, setRangeState] = useState<StatsRange>(() => {
    try {
      const v = localStorage.getItem(RANGE_KEY);
      return v === "month" || v === "30d" ? v : "week";
    } catch {
      return "week";
    }
  });
  const setRange = (r: StatsRange) => {
    setRangeState(r);
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {
      /* 覚えられないだけ */
    }
  };
  const [stats, setStats] = useState<StatsReport | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/stats?range=${range}`)
      .then((r) => json<StatsReport>(r))
      .then((x) => live && setStats(x))
      .catch((e) => live && setError(String(e instanceof Error ? e.message : e)));
    return () => {
      live = false;
    };
  }, [range, ov]);

  const add = async () => {
    const v = name.trim();
    if (!v) return;
    try {
      await json<Habit>(await fetch("/api/habits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: v }) }));
      setName("");
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };
  const remove = async (h: Habit) => {
    if (!confirm(`「${h.name}」を消しますか？（これまでの記録は草に残ります）`)) return;
    const r = await fetch(`/api/habits/${h.id}`, { method: "DELETE" });
    if (!r.ok) setError(`消せませんでした: HTTP ${r.status}`);
    await load();
  };
  const rename = async (h: Habit, next: string) => {
    try {
      await json<Habit>(await fetch(`/api/habits/${h.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: next }) }));
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  // 並べ替え: 線をつまんで動かす間は見た目だけずらし、離したら確定する（途中で行を動かすと指の追跡が切れるため）
  const rowEls = useRef(new Map<number, HTMLDivElement>());
  const [drag, setDrag] = useState<{ id: number; dy: number; from: number; to: number; step: number } | null>(null);
  const startDrag = (id: number, e: PointerEvent<HTMLButtonElement>) => {
    const list = ov?.habits ?? [];
    const from = list.findIndex((h) => h.id === id);
    if (from < 0 || list.length < 2) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const a = rowEls.current.get(list[0].id)?.getBoundingClientRect();
    const b = rowEls.current.get(list[1].id)?.getBoundingClientRect();
    const step = a && b ? b.top - a.top : 60;
    const y0 = e.clientY;
    let to = from;
    setDrag({ id, dy: 0, from, to, step });
    const move = (ev: globalThis.PointerEvent) => {
      const dy = ev.clientY - y0;
      to = Math.min(list.length - 1, Math.max(0, from + Math.round(dy / step)));
      setDrag({ id, dy, from, to, step });
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", stop);
      setDrag(null);
    };
    const up = () => {
      stop();
      if (to === from) return;
      const next = list.slice();
      next.splice(to, 0, next.splice(from, 1)[0]);
      setOv((x) => (x ? { ...x, habits: next } : x));
      void saveOrder(next.map((h) => h.id));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", stop);
  };
  /** つまんでいる間の、行ごとのずれ */
  const offsetOf = (i: number, id: number) => {
    if (!drag) return 0;
    if (id === drag.id) return drag.dy;
    if (i > drag.from && i <= drag.to) return -drag.step;
    if (i < drag.from && i >= drag.to) return drag.step;
    return 0;
  };
  const saveOrder = async (ids: number[]) => {
    try {
      await json<HabitOverview>(await fetch("/api/habits/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) }));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      await load();
    }
  };

  const done = ov?.habits.filter((h) => h.doneToday).length ?? 0;
  return (
    <Page title="統計" current="#/habits" right={<RangeTabs range={range} onChange={setRange} />}>
      <div className="mx-auto flex max-w-[1120px] flex-col gap-3 px-4 pb-8 pt-2">
        {error && <div className="rounded-lg bg-orange-soft px-3 py-2 text-xs text-orange-ink" role="alert">{error}</div>}
        {!ov && !error && <Skeleton />}
        {stats && <Overview r={stats} habits={ov?.habits ?? []} />}
        {ov && (
          <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
            <Card
              title="ルーティーン"
              right={
                <>
                  <span className="font-mono tabular-nums">今日 {done}/{ov.habits.length}</span>
                  {ov.habits.length > 0 && <button onClick={() => setEditing((x) => !x)} className="min-h-8 rounded-md px-1.5 text-[12px] text-ink-2 hover:bg-chip">{editing ? "完了" : "編集"}</button>}
                </>
              }
            >
              {ov.habits.length === 0 && <div className="px-3.5 py-3 text-[13px] text-mute">まだありません。下の欄から足せます</div>}
              <div className={editing ? "flex flex-col gap-2 p-2" : ""}>
                {ov.habits.map((h, i) =>
                  editing ? (
                    <EditRow
                      key={h.id}
                      h={h}
                      dragging={drag?.id === h.id}
                      offset={offsetOf(i, h.id)}
                      rowRef={(el) => void (el ? rowEls.current.set(h.id, el) : rowEls.current.delete(h.id))}
                      onHandle={(e) => startDrag(h.id, e)}
                      onRename={(next) => void rename(h, next)}
                      onRemove={() => void remove(h)}
                    />
                  ) : (
                    <StatHabitRow key={h.id} h={h} onChange={(next) => { setOv((x) => (x ? { ...x, habits: x.habits.map((y) => (y.id === next.id ? next : y)) } : x)); void load(); }} />
                  ),
                )}
              </div>
              <label className="flex min-h-11 items-center gap-2 border-t border-line px-3.5 text-mute">
                <span aria-hidden="true" className="text-[15px]">＋</span>
                <span className="sr-only">ルーティーンを足す</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void add()}
                  placeholder="ルーティーンを足す（Enter）"
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-mute"
                />
              </label>
            </Card>
            <Grass days={ov.days} habits={Math.max(1, ov.habits.length)} />
          </div>
        )}
        {stats && stats.tags.length > 0 && (
          <Card title="よく使ったタグ" right="この期間">
            <div className="flex flex-wrap gap-1.5 px-3.5 py-3">
              {stats.tags.map((t) => (
                <a key={t.name} href={`#/memos?tag=${encodeURIComponent(t.name)}`} className="rounded-[7px] border border-line px-2 py-0.5 text-[12px] text-ink-2 no-underline hover:border-line-2 hover:text-ink">
                  <span className="text-mute">#</span>{t.name}<span className="ml-1.5 font-mono text-[10.5px] text-mute">{t.count}</span>
                </a>
              ))}
            </div>
          </Card>
        )}
      </div>
    </Page>
  );
}

const RANGES: { id: StatsRange; label: string }[] = [
  { id: "week", label: "今週" },
  { id: "month", label: "今月" },
  { id: "30d", label: "30日" },
];
const RANGE_KEY = "gh-stats-range";

function RangeTabs({ range, onChange }: { range: StatsRange; onChange: (r: StatsRange) => void }) {
  return (
    <div role="tablist" aria-label="期間" className="flex overflow-hidden rounded-lg border border-line text-[12px]">
      {RANGES.map((r) => (
        <button key={r.id} role="tab" aria-selected={range === r.id} onClick={() => onChange(r.id)} className={`min-h-8 border-l border-line px-2.5 first:border-l-0 ${range === r.id ? "bg-panel font-medium text-ink" : "text-mute hover:text-ink-2"}`}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);

/** 上の数字（5つ）とグラフ */
function Overview({ r, habits }: { r: StatsReport; habits: Habit[] }) {
  const cum = cumulative(r);
  const last = cum[cum.length - 1] ?? { scope: r.openAtStart, done: 0 };
  const upto = r.days.filter((d) => d.day <= r.today);
  const sum = (k: "onTime" | "late" | "noDue" | "created" | "habits" | "memos") => upto.reduce((a, d) => a + d[k], 0);
  const onTime = sum("onTime");
  const late = sum("late");
  const remaining = last.scope - last.done;
  const habitRate = pct(sum("habits"), r.habitCount * upto.length);
  const longest = Math.max(0, ...habits.map((h) => h.streak));
  const rate = pct(last.done, last.scope);
  const onTimeRate = pct(onTime, onTime + late);
  const delta = remaining - r.openAtStart;
  return (
    <section aria-label="この期間" className="min-w-0 overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center border-b border-line px-3.5 py-2 text-[12px] text-mute">
        <span className="font-mono tabular-nums">{r.from.slice(5).replace("-", "/")} – {r.to.slice(5).replace("-", "/")}</span>
      </div>
      <div className="grid grid-cols-2 border-b border-line md:grid-cols-5 [&>*]:border-line">
        <Kpi label="達成" value={<>{last.done}<small>/{last.scope}</small></>} bar={[[rate ?? 0, "bg-ink"]]} sub={`${rate ?? 0}%・作成 ${sum("created")}`} className="border-r border-b md:border-b-0" />
        <Kpi label="期限内" mark="bg-ring-lime" value={onTimeRate === null ? "—" : <>{onTimeRate}<small>%</small></>} bar={onTimeRate === null ? [] : [[onTimeRate, "bg-ring-lime"], [100 - onTimeRate, "bg-orange"]]} sub={`遅れ ${late}・期限切れ ${r.overdue}`} className="border-b md:border-b-0 md:border-r" />
        <Kpi label="残り" mark="dash" value={<>{remaining}<small className="ml-1.5">{delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "±0"}</small></>} sub={`期間の始め ${r.openAtStart}`} className="border-r border-b md:border-b-0" />
        <Kpi label="ルーティーン" mark="bg-ring-lime/60" value={habitRate === null ? "—" : <>{habitRate}<small>%</small></>} bar={habitRate === null ? [] : [[habitRate, "bg-ring-lime/60"]]} sub={longest ? `最長 ${longest}日連続` : "まだ連続なし"} className="border-b md:border-b-0 md:border-r" />
        <Kpi label="メモ" mark="bg-line-2" value={sum("memos")} sub={r.tags[0] ? `多いタグ #${r.tags[0].name}` : "—"} className="col-span-2 md:col-span-1" />
      </div>
      <div className="flex flex-wrap gap-x-3.5 gap-y-1 px-3.5 pt-2.5 text-[11px] text-mute">
        <Legend mark={<span className="inline-block w-3 border-t-2 border-ink" />}>完了（累計）</Legend>
        <Legend mark={<span className="inline-block w-3 border-t-[1.5px] border-dashed border-mute" />}>全体（累計）</Legend>
        <Legend mark={<span className="inline-block w-3 border-t-2 border-dotted border-mute" />}>目安</Legend>
        <Legend mark={<i className="size-2 rounded-sm bg-ring-lime" />}>期限内</Legend>
        <Legend mark={<i className="size-2 rounded-sm bg-orange" />}>遅れ</Legend>
        <Legend mark={<i className="size-2 rounded-sm bg-line-2" />}>期限なし</Legend>
      </div>
      <div className="px-1.5 pb-2 pt-1">
        <StatsChart r={r} />
      </div>
    </section>
  );
}

function Legend({ mark, children }: { mark: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {mark}
      {children}
    </span>
  );
}

function Kpi({ label, mark, value, bar = [], sub, className = "" }: { label: string; mark?: string; value: ReactNode; bar?: [number, string][]; sub: string; className?: string }) {
  return (
    <div className={`min-w-0 px-3.5 py-3 ${className}`}>
      <div className="flex items-center gap-1.5 text-[11.5px] text-mute">
        {mark === "dash" ? <span className="inline-block w-3 border-t-[1.5px] border-dashed border-mute" /> : mark && <i className={`size-2 rounded-sm ${mark}`} />}
        {label}
      </div>
      <div className="mt-1 font-mono text-[21px] font-medium tracking-tight tabular-nums text-ink [&_small]:text-[12.5px] [&_small]:font-normal [&_small]:text-mute">{value}</div>
      <div className={`mt-2 flex h-1 overflow-hidden rounded-full ${bar.length ? "bg-chip" : ""}`}>{bar.map(([w, c], i) => <i key={i} className={`block h-full ${c}`} style={{ width: `${Math.max(0, Math.min(100, w))}%` }} />)}</div>
      <div className="mt-1.5 truncate text-[11px] text-mute">{sub}</div>
    </div>
  );
}
