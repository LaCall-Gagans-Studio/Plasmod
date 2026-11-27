// 統計のグラフ: 1枚に、完了の累計（実線）・全体の累計（破線）・目安（点線）、その日の完了の柱（期限内・遅れ・期限なし）、
// 日付の下にルーティーンの達成とメモの数。日付を押す（なぞる）と、その日の内訳が出る。
import { useEffect, useRef, useState } from "react";
import type { StatsReport } from "../shared/types";

const C = {
  ink: "var(--color-ink)",
  mute: "var(--color-mute)",
  line: "var(--color-line)",
  chip: "var(--color-chip)",
  panel: "var(--color-panel)",
  acc: "var(--color-ring-lime)",
  late: "var(--color-orange)",
  none: "var(--color-line-2)",
};
const WEEK = ["月", "火", "水", "木", "金", "土", "日"];
const wd = (day: string) => WEEK[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7];

/** 単調な3次曲線（点を行き過ぎない）。pts は x の小さい順 */
export function smoothPath(pts: [number, number][]): string {
  const n = pts.length;
  if (!n) return "";
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`;
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0]));
  const m = pts.map((_, i) => (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2));
  let p = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = (pts[i + 1][0] - pts[i][0]) / 3;
    p += ` C${pts[i][0] + h},${pts[i][1] + m[i] * h} ${pts[i + 1][0] - h},${pts[i + 1][1] - m[i + 1] * h} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return p;
}

/** 日ごとの累計（今日まで） */
export function cumulative(r: StatsReport) {
  let scope = r.openAtStart;
  let done = 0;
  const upto = r.days.filter((d) => d.day <= r.today);
  return upto.map((d) => {
    scope += d.created;
    done += d.onTime + d.late + d.noDue;
    return { scope, done };
  });
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function StatsChart({ r }: { r: StatsReport }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [sel, setSel] = useState<number | null>(null);
  const W = Math.max(300, width);
  const narrow = W < 640;
  const H = narrow ? 250 : 300;
  const L = 30,
    R = 34,
    T = 18,
    B = 58;
  const ph = H - T - B;
  const n = r.days.length;
  const cw = (W - L - R) / n;
  const x = (i: number) => L + cw * i + cw / 2;
  const cum = cumulative(r);
  const ti = cum.length - 1; // 今日（期間が今日より前に終わることはない）
  const top = Math.max(5, ...cum.map((c) => c.scope));
  const step = top <= 10 ? 2 : top <= 25 ? 5 : top <= 60 ? 10 : 20;
  const max = Math.ceil((top + step * 0.5) / step) * step;
  const y = (v: number) => T + ph - (v / max) * ph;
  const bw = Math.max(3, Math.min(14, cw * 0.42));
  const dayDone = r.days.map((d) => d.onTime + d.late + d.noDue);
  const barMax = Math.max(4, ...dayDone);
  const bh = (v: number) => (v / barMax) * ph * 0.42;
  const memoMax = Math.max(1, ...r.days.map((d) => d.memos));
  const labelEvery = n <= 7 ? 1 : narrow ? 7 : 5;
  const showLabel = (i: number) => n <= 7 || i === ti || i === 0 || (i % labelEvery === 0 && Math.abs(i - ti) > 1);
  const lbl = (day: string) => (n <= 7 ? (narrow ? wd(day) : `${wd(day)} ${Number(day.slice(8))}`) : i0(day));
  const i0 = (day: string) => (day.slice(8) === "01" ? `${Number(day.slice(5, 7))}/1` : String(Number(day.slice(8))));
  const scopePts = cum.map((c, i) => [x(i), y(c.scope)] as [number, number]);
  const donePts = cum.map((c, i) => [x(i), y(c.done)] as [number, number]);
  const ticks = Array.from({ length: max / step + 1 }, (_, k) => k * step);

  // なぞる・押すで、近い日を選ぶ
  const pick = (clientX: number, el: SVGSVGElement) => {
    const rect = el.getBoundingClientRect();
    const i = Math.floor(((clientX - rect.left) * (W / rect.width) - L) / cw);
    setSel(i >= 0 && i < n ? i : null);
  };
  const s = sel !== null ? r.days[sel] : null;
  const sc = sel !== null && sel <= ti ? cum[sel] : null;

  return (
    <div ref={box} className="relative w-full select-none">
      {width > 0 && (
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          className="block touch-pan-y"
          role="img"
          aria-label={`完了 ${cum[ti]?.done ?? 0}、全体 ${cum[ti]?.scope ?? 0}`}
          onPointerMove={(e) => pick(e.clientX, e.currentTarget)}
          onPointerDown={(e) => pick(e.clientX, e.currentTarget)}
          onPointerLeave={(e) => e.pointerType === "mouse" && setSel(null)}
        >
          <defs>
            <linearGradient id="st-done" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={C.ink} stopOpacity={0.13} />
              <stop offset="1" stopColor={C.ink} stopOpacity={0} />
            </linearGradient>
          </defs>
          {ticks.map((g) => (
            <g key={g}>
              <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} stroke={C.line} />
              <text x={L - 7} y={y(g) + 3.5} textAnchor="end" fontSize={10} fill={C.mute} className="font-mono">{g}</text>
            </g>
          ))}
          {/* これから先の日は薄く */}
          {ti < n - 1 && <rect x={x(ti)} y={T} width={W - R - x(ti)} height={ph} fill={C.chip} opacity={0.45} />}
          {sel !== null && <rect x={L + cw * sel} y={T} width={cw} height={ph} fill={C.chip} opacity={0.7} />}
          {/* その日の完了: 1本の柱を、期限内・遅れ・期限なしで塗り分ける */}
          {r.days.map((d, i) => {
            const total = bh(dayDone[i]);
            if (!total) return null;
            let yy = T + ph;
            const parts = ([[d.onTime, C.acc, 0.95], [d.late, C.late, 0.95], [d.noDue, C.none, 1]] as const).map(([v, col, op], k) => {
              const hh = bh(v);
              if (!hh) return null;
              yy -= hh;
              return <rect key={k} x={x(i) - bw / 2} y={yy} width={bw} height={hh} fill={col} opacity={op} />;
            });
            return (
              <g key={d.day}>
                <clipPath id={`st-b${i}`}>
                  <rect x={x(i) - bw / 2} y={T + ph - total} width={bw} height={total + bw} rx={bw / 2} />
                </clipPath>
                <g clipPath={`url(#st-b${i})`}>{parts}</g>
              </g>
            );
          })}
          {/* 目安: 期間の始めの 0 から、終わりに今の全体まで */}
          {cum.length > 0 && <line x1={x(0)} y1={y(0)} x2={x(n - 1)} y2={y(cum[ti].scope)} stroke={C.mute} strokeDasharray="1 4" strokeLinecap="round" />}
          {cum.length > 0 && (
            <>
              <path d={`${smoothPath(donePts)} V${T + ph} H${x(0)} Z`} fill="url(#st-done)" />
              <path d={smoothPath(scopePts)} fill="none" stroke={C.mute} strokeWidth={1.5} strokeDasharray="4 3" strokeLinecap="round" />
              <path d={smoothPath(donePts)} fill="none" stroke={C.ink} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              <circle cx={x(ti)} cy={y(cum[ti].scope)} r={3.5} fill={C.panel} stroke={C.mute} strokeWidth={2} />
              <circle cx={x(ti)} cy={y(cum[ti].done)} r={3.5} fill={C.panel} stroke={C.ink} strokeWidth={2} />
              <text x={W - R + 6} y={y(cum[ti].scope) + (Math.abs(cum[ti].scope - cum[ti].done) / max < 0.06 ? -4 : 4)} fontSize={11} fill={C.mute} className="font-mono">{cum[ti].scope}</text>
              <text x={W - R + 6} y={y(cum[ti].done) + (Math.abs(cum[ti].scope - cum[ti].done) / max < 0.06 ? 11 : 4)} fontSize={11} fill={C.ink} className="font-mono">{cum[ti].done}</text>
              {/* 今日 */}
              <line x1={x(ti)} x2={x(ti)} y1={T - 4} y2={T + ph} stroke={C.ink} strokeOpacity={0.5} />
              <rect x={x(ti) - 17} y={T - 15} width={34} height={14} rx={7} fill={C.ink} />
              <text x={x(ti)} y={T - 5} textAnchor="middle" fontSize={9.5} fill={C.panel}>今日</text>
            </>
          )}
          {/* 日付・ルーティーン・メモの段 */}
          {r.days.map((d, i) => {
            const fut = i > ti;
            const w = Math.max(2, Math.min(cw * 0.66, 64));
            const hx = x(i) - w / 2;
            return (
              <g key={`f${d.day}`}>
                {showLabel(i) && (
                  <text x={x(i)} y={H - 40} textAnchor="middle" fontSize={10.5} fill={i === ti ? C.ink : C.mute} fontWeight={i === ti ? 600 : 400}>{lbl(d.day)}</text>
                )}
                <rect x={hx} y={H - 29} width={w} height={5} rx={2.5} fill={C.chip} />
                {!fut && r.habitCount > 0 && d.habits > 0 && <rect x={hx} y={H - 29} width={w * Math.min(1, d.habits / r.habitCount)} height={5} rx={2.5} fill={C.acc} opacity={0.6} />}
                {d.memos > 0 && <rect x={hx} y={H - 18} width={Math.max(3, w * (d.memos / memoMax))} height={5} rx={2.5} fill={C.none} />}
              </g>
            );
          })}
          <text x={L - 7} y={H - 24} textAnchor="end" fontSize={9.5} fill={C.mute}>習慣</text>
          <text x={L - 7} y={H - 13} textAnchor="end" fontSize={9.5} fill={C.mute}>メモ</text>
        </svg>
      )}
      {s && sel !== null && (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-[176px] rounded-xl border border-line-2 bg-panel px-3 py-2 text-[11.5px] leading-[1.75] shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
          style={x(sel) > W / 2 ? { right: W - x(sel) + 12 } : { left: x(sel) + 12 }}
        >
          <div className="text-[11px] text-mute">{Number(s.day.slice(5, 7))}/{Number(s.day.slice(8))}（{wd(s.day)}）</div>
          {sc && <TipRow mark={<span className="inline-block w-3 border-t-2 border-ink" />} label="完了（累計）" v={sc.done} />}
          {sc && <TipRow mark={<span className="inline-block w-3 border-t-[1.5px] border-dashed border-mute" />} label="全体（累計）" v={sc.scope} />}
          <TipRow mark={<i className="size-2 rounded-sm bg-ring-lime" />} label="期限内" v={s.onTime} />
          <TipRow mark={<i className="size-2 rounded-sm bg-orange" />} label="遅れ" v={s.late} />
          <TipRow mark={<i className="size-2 rounded-sm bg-line-2" />} label="期限なし" v={s.noDue} />
          <TipRow mark={<i className="size-2 rounded-sm bg-ring-lime/60" />} label="ルーティーン" v={`${s.habits}/${r.habitCount}`} />
          <TipRow mark={<i className="size-2 rounded-sm bg-line-2" />} label="メモ" v={s.memos} />
        </div>
      )}
    </div>
  );
}

function TipRow({ mark, label, v }: { mark: React.ReactNode; label: string; v: number | string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex w-3 items-center justify-center">{mark}</span>
      <span className="text-ink-2">{label}</span>
      <b className="ml-auto pl-3 font-mono font-medium tabular-nums">{v}</b>
    </div>
  );
}
