// ルーティーン: 上に草グラフ、下に今日のルーティーン。チェックはここと、レポートからできる。
import { type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import type { Habit, HabitOverview } from "../shared/types";
import { Skeleton } from "./loading";
import { json } from "./memo-fields";
import { Page } from "./ui";

/** チェックを付ける・外す。結果のルーティーンが返る */
export const checkHabit = (id: number, done: boolean) =>
  fetch(`/api/habits/${id}/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done }) }).then((r) => json<Habit>(r));

const LEVEL = ["bg-chip", "bg-lime/35", "bg-lime/60", "bg-lime/80", "bg-lime"];

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
    <section aria-label="これまでの記録" className="mx-4 rounded-2xl border border-line bg-panel p-3.5">
      <div className="mb-2.5 flex items-baseline text-[12px] text-mute">
        <span className="font-semibold text-ink-2">この半年</span>
        <span className="ml-auto tabular-nums">{active} 日</span>
      </div>
      <div ref={box} className="flex gap-[3px] overflow-x-auto [scrollbar-width:none]" data-noswipe>
        {weeks.map((w, i) => (
          <div key={i} className="flex flex-none flex-col gap-[3px]">
            {w.map((d, k) =>
              d ? (
                <span key={d.day} title={`${d.day}: ${d.count} 件`} className={`size-[13px] rounded-[3px] ${LEVEL[levelOf(d.count, habits)]}`} />
              ) : (
                <span key={`pad${k}`} className="size-[13px]" />
              ),
            )}
          </div>
        ))}
      </div>
    </section>
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
    <Page
      title="ルーティーン"
      current="#/habits"
      right={ov && ov.habits.length > 0 ? <button onClick={() => setEditing((x) => !x)} className="min-h-9 px-1 text-[13px] text-mute">{editing ? "完了" : "編集"}</button> : undefined}
    >
      <div className="mx-auto flex max-w-[720px] flex-col gap-3 pb-6 pt-2.5">
        {error && <div className="mx-4 rounded-lg bg-orange-soft px-3 py-2 text-xs text-orange-ink" role="alert">{error}</div>}
        {!ov && !error && <Skeleton />}
        {ov && (
          <>
            <Grass days={ov.days} habits={Math.max(1, ov.habits.length)} />
            <div className="flex items-baseline px-5 pt-1 text-[12px] font-semibold text-mute">
              今日<span className="ml-auto tabular-nums">{done} / {ov.habits.length}</span>
            </div>
            <div className="flex flex-col gap-2 px-4">
              {ov.habits.length === 0 && <div className="py-3 text-center text-sm text-mute">まだありません。下の欄から足せます</div>}
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
                  <HabitRow key={h.id} h={h} onChange={(next) => { setOv((x) => (x ? { ...x, habits: x.habits.map((y) => (y.id === next.id ? next : y)) } : x)); void load(); }} />
                ),
              )}
              <label className="flex h-11 items-center gap-2 rounded-2xl border border-dashed border-line-2 px-3.5 text-mute">
                <span aria-hidden="true">＋</span>
                <span className="sr-only">ルーティーンを足す</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void add()}
                  placeholder="ルーティーンを足す（Enter）"
                  className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-mute"
                />
              </label>
            </div>
          </>
        )}
      </div>
    </Page>
  );
}
