import { useCallback, useEffect, useState } from "react";
import type { TaskSummaryItem, Report as ReportT, ReportSlide, Snapshot } from "../shared/types";
import { MicButton } from "./speech";
import { Avatar, Icon, ago, profileOf } from "./ui";
import { plainSummary } from "./WatchPage";
import { HabitRow } from "./Habits";
import { Skeleton } from "./loading";
import { ownerName } from "./identity";
import { useHoldSwipe } from "./touch";

/** 1枚を見せる時間。上のバーがこの時間で 100% になったら次へ。中身が多いタスクの枚は長め */
const slideMs = (s: ReportSlide) => (s.kind === "digest" || s.kind === "watch" || s.kind === "routine" ? 9000 : 5000);
/** 中身を押して使う枚。自動で進めず、左右の押す場所も置かない（下の ‹ › で動く） */
const isHands = (s: ReportSlide | undefined) => s?.kind === "tasks" || s?.kind === "memos" || s?.kind === "habits";
const BG = ["#C8F25A", "#FF8A3D", "#8FB8FF", "#F3F1EC"];

/** スライドの頭のアイコン（角丸の四角に線画。Material の tonal なチップに寄せる） */
function Badge({ name }: { name: Parameters<typeof Icon>[0]["name"] }) {
  return (
    <div className="gh-pop flex size-14 items-center justify-center rounded-2xl bg-[#17171a] text-white shadow-[0_6px_18px_rgba(0,0,0,0.18)]">
      <Icon name={name} size={30} />
    </div>
  );
}

/** 0 から数え上げる（動きを減らす設定ならすぐ出す） */
function useCountUp(target: number, ms = 900) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setV(target);
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      setV(Math.round(target * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

const delay = (k: number) => ({ animationDelay: `${120 + k * 90}ms` });

const md = (d: string | null) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : "");

/** タスクの1行（押すとタスクを開く） */
function TaskRow({ t, k, done }: { t: TaskSummaryItem; k: number; done?: boolean }) {
  return (
    <a href={t.url} {...(t.url.startsWith("#") ? {} : { target: "_blank", rel: "noopener noreferrer" })} className="gh-rise flex items-center gap-2.5 py-1.5 text-on no-underline" style={delay(k)}>
      <span className={`flex size-7 flex-none items-center justify-center rounded-lg ${done ? "bg-[#17171a] text-white" : "bg-on/10"}`}>
        <Icon name={done ? "taskDone" : "calendar"} size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-bold">{t.title}</span>
        <span className="block text-[11.5px] opacity-70">{t.id} · {t.state}</span>
      </span>
      {t.due && <span className={`flex-none rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${t.overdue ? "bg-[#17171a] text-[#FFB27A]" : "bg-on/10"}`}>{t.overdue ? "期限切れ " : ""}{md(t.due)}</span>}
    </a>
  );
}

function Group({ title, items, k0, empty }: { title: string; items: TaskSummaryItem[]; k0: number; empty: string }) {
  return (
    <div className="flex flex-col">
      <div className="gh-rise flex items-baseline gap-2 text-[13px] font-bold opacity-80" style={delay(k0)}>
        {title}<span className="text-[22px] tabular-nums">{items.length}</span>
      </div>
      {items.length === 0 && <div className="gh-rise py-1 text-[13px] opacity-60" style={delay(k0 + 1)}>{empty}</div>}
      {items.slice(0, 5).map((t, k) => <TaskRow key={t.id} t={t} k={k0 + 1 + k} />)}
      {items.length > 5 && <div className="text-[12px] opacity-60">ほか {items.length - 5} 件</div>}
    </div>
  );
}

function Slide({ s, snap }: { s: ReportSlide; snap: Snapshot | null }) {
  const done = useCountUp(s.kind === "digest" ? s.done : 0);
  const [habits, setHabits] = useState(s.kind === "habits" ? s.items : []);
  switch (s.kind) {
    case "tasks":
      return (
        <div className="mt-3 flex flex-col gap-4">
          <Badge name="calendar" />
          <div className="gh-rise text-[26px] font-bold leading-tight" style={delay(0)}>今日と今週の<br />タスク</div>
          {s.error && <div className="rounded-xl bg-on/10 p-3 text-[13px]">タスクを読めなかった: {s.error}</div>}
          {!s.error && (
            <>
              <Group title="今日まで" items={s.today} k0={1} empty="今日が期限のものは無い" />
              <Group title="今週" items={s.week} k0={4} empty="今週が期限のものは無い" />
              {s.doing.length > 0 && <Group title="進行中（期限なし）" items={s.doing} k0={7} empty="" />}
            </>
          )}
        </div>
      );
    case "memos":
      return (
        <div className="mt-3 flex flex-col gap-3">
          <Badge name="memo" />
          <div className="gh-rise mt-2 text-[26px] font-bold leading-tight" style={delay(0)}>最近のメモ</div>
          {s.items.map((m, k) => (
            <a key={m.id} href={`#/memo/${m.id}`} className="gh-rise flex flex-col gap-0.5 rounded-2xl bg-on/10 px-3.5 py-2.5 text-on no-underline" style={delay(k + 1)}>
              <span className="truncate text-[14.5px] font-bold">{m.title}</span>
              <span className="truncate text-[12px] opacity-70">{[m.project, ago(m.at)].filter(Boolean).join(" · ")}{m.excerpt ? ` · ${m.excerpt}` : ""}</span>
            </a>
          ))}
          <a href="#/memos" className="gh-rise text-center text-[13px] font-bold text-on" style={delay(s.items.length + 1)}>メモをすべて見る ›</a>
        </div>
      );
    case "habits":
      return (
        <div className="mt-3 flex flex-col gap-3">
          <Badge name="habit" />
          <div className="gh-rise mt-2 text-[26px] font-bold leading-tight" style={delay(0)}>今日のルーティーン</div>
          {habits.map((h, k) => (
            <div key={h.id} className="gh-rise" style={delay(k + 1)}>
              <HabitRow h={h} light onChange={(next) => setHabits((x) => x.map((y) => (y.id === next.id ? next : y)))} />
            </div>
          ))}
          <a href="#/habits" className="gh-rise text-center text-[13px] font-bold text-on" style={delay(habits.length + 1)}>草グラフを見る ›</a>
        </div>
      );
    case "digest":
      return (
        <div className="mt-3 flex flex-col gap-3">
          <Badge name="taskDone" />
          <div className="gh-rise mt-2 text-[26px] font-bold leading-tight" style={delay(0)}>この24時間のまとめ</div>
          <div className="gh-rise flex gap-6" style={delay(1)}>
            <div><div className="text-[44px] font-bold leading-none tabular-nums">{done}</div><div className="mt-1 text-[12px] opacity-75">片付いたカード</div></div>
            <div><div className="text-[44px] font-bold leading-none tabular-nums">{s.running}</div><div className="mt-1 text-[12px] opacity-75">実行中</div></div>
            <div><div className="text-[44px] font-bold leading-none tabular-nums">{s.tasksDone.length}</div><div className="mt-1 text-[12px] opacity-75">今週終えたタスク</div></div>
          </div>
          {s.cards.length > 0 && (
            <div className="gh-rise flex flex-col gap-1" style={delay(2)}>
              {s.cards.map((c) => (
                <div key={c.name} className="flex items-center gap-2 text-[13px]">
                  <span className="size-2 flex-none rounded-full" style={{ background: c.color }} />
                  <span className="min-w-0 flex-1 truncate font-semibold">{c.name}</span>
                  <span className="flex-none text-[11.5px] opacity-70">{c.agent}</span>
                </div>
              ))}
            </div>
          )}
          {s.agents.length > 0 && (
            <div className="gh-rise flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]" style={delay(3)}>
              {s.agents.map((a) => <span key={a.id}><b>{a.name}</b> {a.done}件{a.running ? `・実行中 ${a.running}` : ""}</span>)}
            </div>
          )}
          {s.tasksDone.length > 0 && (
            <div className="flex flex-col">
              {s.tasksDone.slice(0, 3).map((t, k) => <TaskRow key={t.id} t={t} k={k + 4} done />)}
              {s.tasksDone.length > 3 && <div className="text-[12px] opacity-60">ほか {s.tasksDone.length - 3} 件</div>}
            </div>
          )}
        </div>
      );
    case "routine":
      return (
        <div className="mt-3 flex flex-col gap-3">
          <Badge name="insights" />
          <div className="gh-rise mb-1 mt-2 text-[26px] font-bold leading-tight" style={delay(0)}>今日の定期報告</div>
          {s.error && <div className="rounded-xl bg-on/10 p-3 text-[13px]">読めなかった: {s.error}</div>}
          {s.late.map((l) => (
            <div key={`${l.agent}:${l.name}`} className="gh-rise rounded-xl bg-[#17171a] px-3.5 py-2.5 text-[12.5px] text-[#FFB27A]" style={delay(1)}>
              ⚠ {snap ? profileOf(snap.agents, l.agent).name : l.agent}「{l.name}」: {l.reason}
            </div>
          ))}
          {s.items.length === 0 && s.late.length === 0 && !s.error && <div className="gh-rise text-base" style={delay(1)}>この1日はまだ報告がありません</div>}
          {s.items.map((r, k) => {
            const p = snap ? profileOf(snap.agents, r.agent) : null;
            return (
              <div key={`${r.agent}:${r.job}`} className="gh-rise flex flex-col gap-2 rounded-2xl bg-[#17171a] p-4 text-white shadow-[0_6px_18px_rgba(0,0,0,0.18)]" style={delay(k + 1)}>
                <div className="flex items-center gap-2">
                  {p && <Avatar p={p} size={26} />}
                  <span className="flex-none whitespace-nowrap text-sm font-bold">{p?.name ?? r.agent}</span>
                  <span className="truncate text-xs text-white/60">{r.name} · {ago(r.at)}</span>
                </div>
                <div className={`line-clamp-4 text-[13px] leading-relaxed ${r.ok ? "" : "text-[#FFB27A]"}`}>{r.ok ? plainSummary(r.text, 240) : "実行に失敗した"}</div>
              </div>
            );
          })}
        </div>
      );
    case "watch":
      return (
        <div className="mt-3 flex flex-col gap-3">
          <Badge name="watch" />
          <div className="gh-rise mb-1 mt-2 text-[26px] font-bold leading-tight" style={delay(0)}>{s.title ?? "今週の報告"}</div>
          {s.error && <div className="rounded-xl bg-on/10 p-3 text-[13px]">読めなかった: {s.error}</div>}
          {s.items.map((r, k) => {
            const p = snap ? profileOf(snap.agents, r.agent) : null;
            return (
              <div key={`${r.agent}:${r.at}`} className="gh-rise flex flex-col gap-2 rounded-2xl bg-[#17171a] p-4 text-white shadow-[0_6px_18px_rgba(0,0,0,0.18)]" style={delay(k + 1)}>
                <div className="flex items-center gap-2">
                  {p && <Avatar p={p} size={26} />}
                  <span className="flex-none whitespace-nowrap text-sm font-bold">{p?.name ?? r.agent}</span>
                  <span className="truncate text-xs text-white/60">{r.name} · {ago(r.at)}</span>
                </div>
                <div className={`line-clamp-4 text-[13px] leading-relaxed ${r.ok ? "" : "text-[#FFB27A]"}`}>{r.ok ? plainSummary(r.text, 240) : "実行に失敗した"}</div>
              </div>
            );
          })}
        </div>
      );
    case "waiting":
      return (
        <div className="mt-3 flex flex-col gap-3.5">
          <Badge name="hourglass" />
          <div className="gh-rise mb-1.5 mt-2 text-[26px] font-bold leading-tight" style={delay(0)}>{ownerName()}の<br />判断待ち</div>
          {s.items.length === 0 && <div className="gh-rise text-base" style={delay(1)}>いまは何もありません</div>}
          {s.items.map((i, k) => (
            <a key={i.key} href={`#/card/${encodeURIComponent(i.key)}`} className="gh-rise flex items-center gap-3 rounded-2xl bg-[#17171a] p-4 text-white shadow-[0_6px_18px_rgba(0,0,0,0.18)]" style={delay(k + 1)}>
              <span className="flex flex-1 flex-col gap-1.5">
                <span className="text-xs text-[#FFB27A]">{i.agent} · {i.label}</span>
                <span className="text-base font-bold">{i.title}</span>
              </span>
              <Icon name="send" size={18} />
            </a>
          ))}
        </div>
      );
  }
}

function slideTitle(s: ReportSlide): string {
  return { digest: "この24時間のまとめ", memos: "最近のメモ", habits: "今日のルーティーン", waiting: "判断待ち", tasks: "今日と今週のタスク", watch: "今週の報告", routine: "今日の定期報告" }[s.kind];
}

export function Report({ snap }: { snap: Snapshot | null }) {
  const [report, setReport] = useState<ReportT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/report")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setReport)
      .catch((e) => setError(String(e)));
  }, []);

  const n = report?.slides.length ?? 0;
  const go = useCallback((d: number) => setI((x) => Math.min(Math.max(x + d, 0), Math.max(n - 1, 0))), [n]);
  // 長押ししてから左右に引っ張ると、前後の枚へ（下の ‹ › を押さなくても動ける）
  const hold = useHoldSwipe(go);
  // 端の枚では、引っ張っても少ししか動かない
  const canMove = hold.dx > 0 ? i > 0 : i < n - 1;
  const holdDx = hold.held ? (canMove ? hold.dx : hold.dx * 0.2) : 0;

  const save = async () => {
    if (!report || !note.trim()) return;
    const s = report.slides[i];
    const res = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: note.trim().split("\n")[0].slice(0, 80), body: `${note.trim()}\n\n（レポート「${slideTitle(s)}」より）`, source: "report" }),
    });
    if (res.ok) {
      setSaved("カードにしました");
      setNote("");
      setNoting(false);
    } else setError(`保存できなかった: HTTP ${res.status}`);
  };

  const bg = BG[i % BG.length];
  return (
    <div className="mx-auto flex h-full max-w-[520px] flex-col text-on md:max-w-[640px] transition-colors duration-500" style={{ background: bg }}>
      <div className="flex gap-1 px-3.5 pt-[max(env(safe-area-inset-top),14px)]">
        {Array.from({ length: n }, (_, k) => (
          <div key={k} className="h-[3px] flex-1 overflow-hidden rounded bg-on/20">
            {k < i && <div className="h-full w-full bg-on" />}
            {k === i && report && (
              // 見ている枚のバーは左から伸び、100% になったら次へ（押さえている間・注釈を書いている間は止まる）
              <div
                key={`fill${i}`}
                className="gh-fill h-full bg-on"
                style={{ animationDuration: `${slideMs(report.slides[i])}ms`, animationPlayState: paused || hold.held || noting || isHands(report.slides[i]) ? "paused" : "running" }}
                onAnimationEnd={() => i < n - 1 && go(1)}
              />
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2.5 px-4 py-3">
        <div className="flex size-8 items-center justify-center rounded-full bg-[#17171a] text-white"><Icon name="insights" size={17} /></div>
        <div className="text-[13px] font-bold">レポート</div>
        {report && <div className="text-xs opacity-70">{new Date(report.at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>}
        <a href="#/" aria-label="閉じる" className="ml-auto flex size-11 items-center justify-center"><Icon name="close" /></a>
      </div>

      <div {...(noting ? {} : hold.bind)} data-noswipe="1" className={`gh-nocallout relative flex-1 select-none px-6 pt-2 ${isHands(report?.slides[i]) && !hold.held ? "overflow-y-auto" : "overflow-hidden"}`}>
        {error && <div className="rounded-xl bg-on/10 p-3 text-sm">{error}</div>}
        {!report && !error && <Skeleton />}
        {report && (
          <div style={hold.held ? { transform: `translateX(${holdDx}px) scale(0.97)`, transition: hold.dx === 0 ? "transform 160ms ease-out" : "none" } : { transition: "transform 160ms ease-out" }}>
            <Slide key={i} s={report.slides[i]} snap={snap} />
          </div>
        )}
        {!noting && report && !isHands(report.slides[i]) && (
          <div className="absolute inset-x-0 top-0 bottom-0 flex" aria-hidden="true">
            <button tabIndex={-1} className="flex-1 bg-transparent" onClick={() => go(-1)} onPointerDown={() => setPaused(true)} onPointerUp={() => setPaused(false)} />
            <button tabIndex={-1} className="flex-[2] bg-transparent" onClick={() => go(1)} onPointerDown={() => setPaused(true)} onPointerUp={() => setPaused(false)} />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2.5 p-4 pb-[max(env(safe-area-inset-bottom),24px)]">
        {saved && !noting && <div className="text-center text-sm font-bold">{saved}</div>}
        {!noting && (report?.slides[i]?.kind === "watch" || report?.slides[i]?.kind === "routine") && (
          <a href="#/watch" className="flex min-h-11 items-center justify-center rounded-full border border-on/40 text-sm font-bold text-on no-underline">
            {report.slides[i].kind === "watch" ? "報告を全文で読む" : "定期報告を全文で読む"}
          </a>
        )}
        {noting ? (
          <>
            <label className="flex items-start gap-2 rounded-2xl bg-[#17171a] p-3 text-white">
              <span className="sr-only">注釈</span>
              <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="このスライドについてのメモ…" className="flex-1 resize-none bg-transparent text-sm outline-none" />
              <MicButton onText={(t) => setNote((x) => x + t)} size={40} />
            </label>
            <div className="flex gap-2">
              <button onClick={save} className="min-h-12 flex-[2] rounded-full bg-[#17171a] text-sm font-bold text-white">カードにする</button>
              <button onClick={() => setNoting(false)} className="min-h-12 flex-1 rounded-full border border-on/40 text-sm font-bold">やめる</button>
            </div>
          </>
        ) : (
          <div className="flex gap-2">
            <button onClick={() => go(-1)} aria-label="前のスライド" className="min-h-12 w-12 rounded-full border border-on/30 text-lg font-bold">‹</button>
            <button disabled={!report} onClick={() => { setSaved(null); setNoting(true); }} className="min-h-12 flex-1 rounded-full bg-[#17171a] text-sm font-bold text-white disabled:opacity-50">＋ 注釈をつけてカードにする</button>
            <button onClick={() => go(1)} aria-label="次のスライド" className="min-h-12 w-12 rounded-full border border-on/30 text-lg font-bold">›</button>
          </div>
        )}
      </div>
    </div>
  );
}
