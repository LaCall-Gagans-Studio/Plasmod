// 設定の VPS: タスクマネージャーのように、上で項目を選んで大きなグラフを1つ見る。
import { useEffect, useRef, useState } from "react";
import type { VpsSample, VpsStatus } from "../shared/types";

type Key = "cpu" | "mem" | "disk" | "net";
const ITEMS: { key: Key; label: string }[] = [
  { key: "cpu", label: "CPU" },
  { key: "mem", label: "メモリ" },
  { key: "disk", label: "ディスク" },
  { key: "net", label: "ネット" },
];
const WINDOW_MS = 10 * 60_000;
const HEIGHT = 200;
const PAD = { top: 8, right: 8, bottom: 22, left: 40 };

const bytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)}GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)}MB` : `${Math.round(n / 1024)}KB`);
export const rate = (n: number) => (n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)}MB/s` : n >= 1024 ? `${Math.round(n / 1024)}KB/s` : `${Math.round(n)}B/s`);
const show = (key: Key, v: number | null) => (v === null ? "—" : key === "net" ? rate(v) : `${Math.round(v)}%`);
const clock = (at: number) => new Date(at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** ネットの縦軸の上限: 1・2・5 の切りのいい値に */
export function niceMax(max: number): number {
  if (max <= 1024) return 1024;
  const base = 1024 ** Math.floor(Math.log(max) / Math.log(1024));
  const x = max / base;
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1024].find((s) => s >= x) ?? 1024;
  return step * base;
}

/** 値の列を線に。測れなかったところで切る */
export function linePath(points: { x: number; y: number | null }[]): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of points) {
    if (p.y === null) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += `${cur ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }
  if (cur) out.push(cur);
  return out;
}

function Spark({ samples, k, top }: { samples: VpsSample[]; k: Key; top: number }) {
  const W = 64;
  const H = 20;
  if (samples.length < 2) return <svg width={W} height={H} aria-hidden="true" />;
  const t1 = samples[samples.length - 1].at;
  const pts = samples.map((s) => ({ x: W - ((t1 - s.at) / WINDOW_MS) * W, y: s[k] === null ? null : H - 1 - ((s[k] as number) / top) * (H - 2) }));
  return (
    <svg width={W} height={H} aria-hidden="true" className="block">
      {linePath(pts).map((d, i) => <path key={i} d={d} fill="none" stroke="var(--color-blue)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />)}
    </svg>
  );
}

function BigChart({ samples, k, label, top }: { samples: VpsSample[]; k: Key; label: string; top: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(340);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 340));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const plotW = Math.max(40, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const t1 = samples.length ? samples[samples.length - 1].at : Date.now();
  const X = (at: number) => PAD.left + plotW - ((t1 - at) / WINDOW_MS) * plotW;
  const Y = (v: number) => PAD.top + plotH - (Math.min(v, top) / top) * plotH;
  const lines = linePath(samples.map((s) => ({ x: X(s.at), y: s[k] === null ? null : Y(s[k] as number) })));
  const base = PAD.top + plotH;
  const hit = hover !== null ? samples[hover] : null;
  const pick = (e: React.PointerEvent) => {
    if (!samples.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const at = t1 - ((PAD.left + plotW - (e.clientX - r.left)) / plotW) * WINDOW_MS;
    let best = 0;
    samples.forEach((s, i) => {
      if (Math.abs(s.at - at) < Math.abs(samples[best].at - at)) best = i;
    });
    setHover(best);
  };
  const last = samples.length ? samples[samples.length - 1][k] : null;
  return (
    <div ref={box} className="relative" data-noswipe="1">
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`${label}の直近10分のグラフ。今は ${show(k, last)}`}
        className="block touch-pan-y select-none"
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={() => setHover(null)}
      >
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={PAD.top + plotH * (1 - f)} y2={PAD.top + plotH * (1 - f)} stroke="var(--color-line)" strokeWidth={1} />
            <text x={PAD.left - 6} y={PAD.top + plotH * (1 - f) + 3.5} textAnchor="end" fontSize={10.5} fill="var(--color-mute)">{k === "net" ? rate(top * f) : `${Math.round(top * f)}%`}</text>
          </g>
        ))}
        {[0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => (
          <line key={f} x1={PAD.left + plotW * f} x2={PAD.left + plotW * f} y1={PAD.top} y2={base} stroke="var(--color-line)" strokeWidth={1} opacity={0.6} />
        ))}
        <text x={PAD.left} y={HEIGHT - 6} fontSize={10.5} fill="var(--color-mute)">10分前</text>
        <text x={PAD.left + plotW} y={HEIGHT - 6} textAnchor="end" fontSize={10.5} fill="var(--color-mute)">今</text>
        {lines.map((d, i) => {
          const m = d.match(/^M([\d.]+),/);
          const end = d.match(/([\d.]+),[\d.]+$/);
          return <path key={`a${i}`} d={`${d}L${end?.[1]},${base}L${m?.[1]},${base}Z`} fill="var(--color-blue)" fillOpacity={0.1} />;
        })}
        {lines.map((d, i) => <path key={`l${i}`} d={d} fill="none" stroke="var(--color-blue)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
        {hit && (
          <>
            <line x1={X(hit.at)} x2={X(hit.at)} y1={PAD.top} y2={base} stroke="var(--color-ink-2)" strokeWidth={1} />
            {hit[k] !== null && <circle cx={X(hit.at)} cy={Y(hit[k] as number)} r={4} fill="var(--color-blue)" stroke="var(--color-panel)" strokeWidth={2} />}
          </>
        )}
      </svg>
      {hit && (
        <div
          className="pointer-events-none absolute top-1 rounded-md border border-line bg-panel px-2 py-1 text-[11px] shadow-sm"
          style={X(hit.at) > width / 2 ? { right: width - X(hit.at) + 8 } : { left: X(hit.at) + 8 }}
        >
          <div className="font-mono font-semibold text-ink">{show(k, hit[k])}</div>
          <div className="font-mono text-mute">{clock(hit.at)}</div>
        </div>
      )}
      {samples.length < 2 && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-mute">記録を始めたところです</div>}
    </div>
  );
}

function Detail({ k, v }: { k: Key; v: VpsStatus }) {
  const cell = (label: string, value: string) => (
    <div key={label} className="flex min-w-0 flex-col">
      <span className="text-[11px] text-mute">{label}</span>
      <span className="truncate font-mono text-[12.5px] text-ink">{value}</span>
    </div>
  );
  const grid = "grid grid-cols-2 gap-x-4 gap-y-2 px-3 pb-3 pt-1 sm:grid-cols-3";
  if (k === "cpu")
    return (
      <div className={grid}>
        {cell("コア", String(v.cpus))}
        {cell("負荷（1 / 5 / 15分）", v.load ? v.load.map((x) => x.toFixed(2)).join(" / ") : "?")}
      </div>
    );
  if (k === "mem")
    return (
      <div className={grid}>
        {cell("使用中（キャッシュ除く）", v.mem ? `${bytes(v.mem.used)} / ${bytes(v.mem.total)}` : "?")}
        {cell("スワップ", v.swap ? `${bytes(v.swap.used)} / ${bytes(v.swap.total)}` : "なし")}
      </div>
    );
  if (k === "disk")
    return <div className={grid}>{v.disks.map((d) => cell(`容量 ${d.path}`, `${bytes(d.used)} / ${bytes(d.total)}（空き ${bytes(d.avail)}）`))}</div>;
  return <div className={grid}>{cell("数えているもの", "受信＋送信（実の口のみ）")}</div>;
}

const NOTE: Record<Key, string> = {
  cpu: "CPU の使用率",
  mem: "メモリの使用率",
  disk: "一番忙しいディスクの動いている時間の割合",
  net: "受信と送信の合計",
};

export function VpsChart({ v }: { v: VpsStatus }) {
  const [samples, setSamples] = useState<VpsSample[]>([]);
  const [k, setK] = useState<Key>("cpu");
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/system/vps-series")
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { samples?: VpsSample[] } | null) => alive && b?.samples && setSamples(b.samples))
        .catch(() => {});
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const topOf = (key: Key) => (key === "net" ? niceMax(Math.max(0, ...samples.map((s) => s.net ?? 0))) : 100);
  const lastOf = (key: Key) => {
    for (let i = samples.length - 1; i >= 0; i--) if (samples[i][key] !== null) return samples[i][key];
    return null;
  };
  const item = ITEMS.find((x) => x.key === k)!;
  const recent = samples.slice(-12).reverse();
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="grid grid-cols-2 border-b border-line sm:grid-cols-4" role="tablist" aria-label="グラフの項目">
        {ITEMS.map((x) => {
          const val = lastOf(x.key);
          const high = x.key !== "net" && val !== null && val >= 80;
          return (
            <button key={x.key} role="tab" aria-selected={k === x.key} onClick={() => setK(x.key)} className={`flex min-h-[60px] items-center gap-2 border-line px-3 py-2 text-left ${k === x.key ? "bg-chip" : ""}`}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[11.5px] text-ink-2">{x.label}</span>
                <span className="truncate font-mono text-[14px] font-semibold text-ink">{show(x.key, val)}</span>
                {high && <span className="text-[10.5px] font-semibold text-orange-ink">⚠ 高い</span>}
              </span>
              <Spark samples={samples} k={x.key} top={topOf(x.key)} />
            </button>
          );
        })}
      </div>
      <div className="flex items-baseline gap-2 px-3 pt-2.5">
        <span className="text-[13px] font-bold text-ink">{item.label}</span>
        <span className="min-w-0 truncate text-[11px] text-mute">{NOTE[k]}・直近10分</span>
      </div>
      <div className="px-1 pt-1">
        <BigChart samples={samples} k={k} label={item.label} top={topOf(k)} />
      </div>
      <Detail k={k} v={v} />
      {recent.length > 0 && (
        <details className="border-t border-line px-3 py-2 text-[12px]">
          <summary className="cursor-pointer text-mute">数字で見る</summary>
          <table className="mt-1.5 w-full border-collapse font-mono text-[11.5px]">
            <tbody>
              {recent.map((s) => (
                <tr key={s.at} className="border-t border-line first:border-t-0">
                  <td className="py-1 text-mute">{clock(s.at)}</td>
                  <td className="py-1 text-right text-ink">{show(k, s[k])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
