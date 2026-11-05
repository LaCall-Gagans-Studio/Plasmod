// システム → 定期実行: Hermes の cron と VPS の systemd タイマー。読むだけ
import { useEffect, useState } from "react";
import type { CronJob, Schedules as SchedulesData, Snapshot, TimerInfo } from "../shared/types";
import { Avatar, ago, profileOf } from "./ui";
import { Skeleton } from "./loading";

const DOW = ["日", "月", "火", "水", "木", "金", "土"];
const pad = (n: number) => String(n).padStart(2, "0");

/** cron の5項目のうち、よくある形（分・時が数字、日・月が *）だけ日本語にする。ほかはそのまま */
export function cronText(expr: string | null): string {
  if (!expr) return "?";
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = f;
  if (dom !== "*" || mon !== "*" || !/^\d{1,2}$/.test(min)) return expr;
  let days = "毎日";
  if (dow !== "*") {
    if (dow === "1-5") days = "平日";
    else if (/^[0-7](,[0-7])*$/.test(dow)) days = `毎週${dow.split(",").map((d) => DOW[Number(d) % 7]).join("・")}`;
    else return expr;
  }
  if (/^\d{1,2}(,\d{1,2})*$/.test(hour)) {
    const hs = hour.split(",");
    return min === "0" ? `${days} ${hs.join("・")}時` : `${days} ${hs.map((h) => `${h}:${pad(Number(min))}`).join("・")}`;
  }
  if (hour === "*") return `${days} 毎時${min}分`;
  return expr;
}

/** systemd の OnCalendar= / OnUnitInactiveSec= などを短く */
export function timerText(schedule: string): string {
  if (!schedule) return "?";
  return schedule
    .split(" / ")
    .map((part) => {
      const [k, v = ""] = [part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1)];
      if (k === "OnCalendar") {
        // タイムゾーンが無いものは VPS の時刻（JST）
        const m = v.match(/^(?:([A-Z][a-z]{2}) )?\*-\*-\* (\d{2}):(\d{2}):\d{2}(?: Asia\/Tokyo)?$/);
        if (m && /^\d+$/.test(m[2])) {
          const days = m[1] ? `毎週${DOW[["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(m[1])] ?? m[1]}` : "毎日";
          return `${days} ${m[2]}:${m[3]}`;
        }
        return v;
      }
      if (k === "OnUnitInactiveSec") return `前回が終わって ${v} ごと`;
      if (k === "OnUnitActiveSec") return `${v} ごと`;
      if (k === "OnBootSec" || k === "OnStartupSec") return `起動の ${v} 後`;
      return part;
    })
    .join(" · ");
}

/** これからの時刻を「今日 21:00」「明日 8:00」「10/24 3:10」で */
export function when(ms: number | null, now = Date.now()): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const t = `${d.getHours()}:${pad(d.getMinutes())}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date(now))) / 86400_000);
  if (diff === 0) return `今日 ${t}`;
  if (diff === 1) return `明日 ${t}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${t}`;
}

const parseTime = (s: string | null) => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : null;
};

const STATE: Record<string, { label: string; cls: string }> = {
  scheduled: { label: "有効", cls: "bg-lime-soft text-lime-ink" },
  running: { label: "実行中", cls: "bg-blue/15 text-blue" },
  paused: { label: "停止中", cls: "bg-line text-mute" },
  completed: { label: "終了", cls: "bg-line text-mute" },
  error: { label: "エラー", cls: "bg-orange/10 text-orange-ink" },
};

function Badge({ state }: { state: string }) {
  const s = STATE[state] ?? { label: state, cls: "bg-line text-mute" };
  return <span className={`flex-none rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${s.cls}`}>{s.label}</span>;
}

function CronRow({ j, snap }: { j: CronJob; snap: Snapshot | null }) {
  const [open, setOpen] = useState(false);
  const p = snap ? profileOf(snap.agents, j.profile) : null;
  const failed = j.last_status && j.last_status !== "ok" && j.last_status !== "success";
  const last = parseTime(j.last_run_at);
  return (
    <div className={`overflow-hidden rounded-xl border bg-panel ${open ? "border-lime-line" : "border-line"}`}>
      <button onClick={() => setOpen(!open)} className="flex min-h-[60px] w-full items-center gap-2.5 px-3 py-2 text-left">
        {p && <Avatar p={p} size={30} />}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13.5px] font-bold">{j.name}</span>
          <span className="truncate text-[11.5px] text-ink-2">
            {j.kind === "cron" ? cronText(j.schedule) : j.schedule ?? "?"}
            {j.state === "scheduled" && j.next_run_at ? <span className="text-mute"> · 次 {when(parseTime(j.next_run_at))}</span> : null}
          </span>
        </span>
        <Badge state={failed && j.state === "scheduled" ? "error" : j.state} />
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-line p-3 text-[12px]">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-mute">担当</dt>
            <dd className="m-0">{p?.name ?? j.profile} <span className="font-mono text-[10.5px] text-mute">{j.profile} · {j.id}</span></dd>
            <dt className="text-mute">スケジュール</dt>
            <dd className="m-0 font-mono text-[11.5px]">{j.schedule ?? "?"}</dd>
            <dt className="text-mute">前回</dt>
            <dd className="m-0">{last ? `${when(last)}（${ago(last)}）` : "まだ"}{j.last_status ? ` · ${j.last_status}` : ""}{j.failure_streak > 1 ? ` · ${j.failure_streak} 回続けて失敗` : ""}</dd>
            {j.repeat.times !== null && (
              <>
                <dt className="text-mute">回数</dt>
                <dd className="m-0">{j.repeat.completed} / {j.repeat.times}</dd>
              </>
            )}
            {j.skills.length > 0 && (
              <>
                <dt className="text-mute">スキル</dt>
                <dd className="m-0 font-mono text-[11.5px]">{j.skills.join(", ")}</dd>
              </>
            )}
            {j.model && (
              <>
                <dt className="text-mute">モデル</dt>
                <dd className="m-0 font-mono text-[11.5px]">{j.model}</dd>
              </>
            )}
            {j.deliver.length > 0 && (
              <>
                <dt className="text-mute">送り先</dt>
                <dd className="m-0">{j.deliver.join(", ")}</dd>
              </>
            )}
          </dl>
          {j.paused_reason && <div className="text-mute">止めた理由: {j.paused_reason}</div>}
          {j.last_error && <div className="rounded-lg bg-orange/10 px-2.5 py-1.5 text-orange-ink">{j.last_error}</div>}
          {j.last_delivery_error && <div className="rounded-lg bg-orange/10 px-2.5 py-1.5 text-orange-ink">送れなかった: {j.last_delivery_error}</div>}
          {j.prompt && <pre className="m-0 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-panel-2 p-2.5 font-mono text-[11.5px] leading-relaxed text-ink-2">{j.prompt}</pre>}
          {(j.script || j.no_agent) && <div className="text-mute">{j.no_agent ? "スクリプトだけ（エージェントは動かない）" : "前処理のスクリプトあり"}</div>}
        </div>
      )}
    </div>
  );
}

function TimerRow({ t }: { t: TimerInfo }) {
  const bad = t.result && t.result !== "success";
  return (
    <div className="flex min-h-[52px] flex-col justify-center gap-0.5 border-b border-line px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold">{t.unit.replace(/\.timer$/, "")}</span>
        <span className="flex-none text-[11px] text-mute">次 {when(t.next)}</span>
      </div>
      {t.description && <div className="truncate text-[11.5px] text-ink-2">{t.description}</div>}
      <div className="text-[11px] text-mute">
        {timerText(t.schedule)} · 前回 {t.last ? ago(t.last) : "まだ"}
        {bad && <span className="text-orange-ink"> · ✕ {t.result}</span>}
      </div>
    </div>
  );
}

export function Schedules({ snap }: { snap: Snapshot | null }) {
  const [data, setData] = useState<SchedulesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOs, setShowOs] = useState(false);
  useEffect(() => {
    fetch("/api/system/schedules")
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
        setData(b);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);
  // 並びは次に動く順（止まっているものは後ろ）
  const jobs = (data?.hermes ?? []).slice().sort((a, b) => (parseTime(a.next_run_at) ?? Infinity) - (parseTime(b.next_run_at) ?? Infinity));
  const mine = (data?.timers ?? []).filter((t) => !t.os);
  const os = (data?.timers ?? []).filter((t) => t.os);
  return (
    <div className="flex flex-col gap-4 px-4 pb-4 pt-2.5 lg:grid lg:grid-cols-2 lg:items-start">
      {error && <div className="rounded-xl bg-orange/10 px-3 py-2 text-xs text-orange-ink">{error}</div>}
      {!data && !error && <Skeleton />}
      {data?.errors.map((e, i) => (
        <div key={i} className="rounded-xl bg-orange/10 px-3 py-2 text-xs text-orange-ink">{e.source}: {e.error}</div>
      ))}
      {data && (
        <>
          <div className="flex flex-col gap-2">
            <div className="text-xs text-mute">Hermes の cron（{jobs.length}）</div>
            {jobs.length === 0 && <div className="text-[12px] text-mute">登録されていない</div>}
            {jobs.map((j) => <CronRow key={`${j.profile}:${j.id}`} j={j} snap={snap} />)}
          </div>
          <div className="flex flex-col gap-2">
            <div className="text-xs text-mute">VPS のタイマー（{mine.length}）</div>
            <div className="overflow-hidden rounded-xl border border-line bg-panel">
              {mine.length === 0 && <div className="p-3 text-[12px] text-mute">無い</div>}
              {mine.map((t) => <TimerRow key={t.unit} t={t} />)}
            </div>
            {os.length > 0 && (
              <>
                <button onClick={() => setShowOs(!showOs)} className="self-start text-[11px] text-blue">OS 標準のタイマー {os.length} 件を{showOs ? "たたむ" : "見る"}</button>
                {showOs && <div className="overflow-hidden rounded-xl border border-line bg-panel">{os.map((t) => <TimerRow key={t.unit} t={t} />)}</div>}
              </>
            )}
          </div>
        </>
      )}
      <p className="text-[11px] text-mute">読み取りだけ。cron を足す・止めるときはエージェントに頼む。Claude のクラウドの定期実行（routines）はここには出ない。</p>
    </div>
  );
}
