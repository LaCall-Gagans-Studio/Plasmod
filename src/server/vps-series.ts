// 設定の「VPS」のグラフ用。CPU・メモリ・ディスク・ネットを一定の間隔で測り、直近の分だけメモリに持つ（読むだけ・保存しない）。
import type { VpsSample } from "../shared/types";
import { type HostReader, parseMeminfo } from "./vps";

export const SERIES_EVERY_MS = 5000;
/** 5秒ごとに120個で10分 */
const KEEP = 120;

/** /proc/stat の1行目 → 全体と待ち（iowait を含む）の累計 */
export function parseCpu(text: string): { total: number; idle: number } | null {
  const m = text.match(/^cpu\s+(.+)$/m);
  if (!m) return null;
  const v = m[1].trim().split(/\s+/).map(Number);
  if (v.length < 4 || v.some((x) => !Number.isFinite(x))) return null;
  // guest は user に含まれているので足さない（8番目まで）
  return { total: v.slice(0, 8).reduce((a, b) => a + b, 0), idle: v[3] + (v[4] ?? 0) };
}

/** /proc/diskstats → 実ディスクごとの動いていた時間の累計（ms）。パーティションは数えない */
export function parseDiskTicks(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of text.split("\n")) {
    const f = l.trim().split(/\s+/);
    if (f.length >= 13 && /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+)$/.test(f[2])) out[f[2]] = Number(f[12]);
  }
  return out;
}

/** /proc/net/dev → 外とやりとりしたバイト数の累計。仮想の口は実の口と二重に数えるので除く */
export function parseNetBytes(text: string): number | null {
  let sum = 0;
  let seen = false;
  for (const l of text.split("\n")) {
    const m = l.match(/^\s*([^:\s]+):\s*(.+)$/);
    if (!m || /^(lo|tailscale|docker|br-|veth|virbr|tun|wg)/.test(m[1])) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (f.length >= 9 && Number.isFinite(f[0]) && Number.isFinite(f[8])) {
      sum += f[0] + f[8];
      seen = true;
    }
  }
  return seen ? sum : null;
}

const pct = (x: number) => Math.round(Math.min(100, Math.max(0, x)) * 10) / 10;

export class VpsSeries {
  private samples: VpsSample[] = [];
  private prev: { at: number; cpu: { total: number; idle: number } | null; disk: Record<string, number>; net: number | null } | null = null;

  constructor(
    private host: HostReader,
    private keep = KEEP,
  ) {}

  private tryRead<T>(path: string, parse: (text: string) => T, fallback: T): T {
    try {
      return parse(this.host.read(path));
    } catch {
      return fallback;
    }
  }

  /** 1回測る。CPU・ディスク・ネットは累計の差で出すので、最初の1回は無い */
  sample(at = Date.now()): VpsSample {
    const cpu = this.tryRead("/proc/stat", parseCpu, null);
    const disk = this.tryRead("/proc/diskstats", parseDiskTicks, {});
    const net = this.tryRead("/proc/net/dev", parseNetBytes, null);
    const meminfo = this.tryRead("/proc/meminfo", parseMeminfo, {} as Record<string, number>);
    const p = this.prev;
    const ms = p ? at - p.at : 0;
    const s: VpsSample = {
      at,
      cpu: p?.cpu && cpu && cpu.total > p.cpu.total ? pct((1 - (cpu.idle - p.cpu.idle) / (cpu.total - p.cpu.total)) * 100) : null,
      mem: meminfo.MemTotal && meminfo.MemAvailable !== undefined ? pct(((meminfo.MemTotal - meminfo.MemAvailable) / meminfo.MemTotal) * 100) : null,
      disk: null,
      net: p && p.net !== null && net !== null && ms > 0 && net >= p.net ? Math.round(((net - p.net) * 1000) / ms) : null,
    };
    if (p && ms > 0) {
      // 一番忙しいディスク
      const busy = Object.entries(disk).filter(([k, v]) => p.disk[k] !== undefined && v >= p.disk[k]).map(([k, v]) => ((v - p.disk[k]) / ms) * 100);
      if (busy.length) s.disk = pct(Math.max(...busy));
    }
    this.prev = { at, cpu, disk, net };
    this.samples.push(s);
    if (this.samples.length > this.keep) this.samples.splice(0, this.samples.length - this.keep);
    return s;
  }

  all(): VpsSample[] {
    return this.samples;
  }
}
