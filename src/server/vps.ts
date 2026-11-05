// 設定の「VPS」: 負荷・メモリ・ディスク・主なサービスの状態・失敗しているユニット。どれも読むだけ（/proc・statfs・systemctl）。
import { readFileSync, statfsSync } from "node:fs";
import { hostname } from "node:os";
import type { VpsService, VpsStatus } from "../shared/types";
import type { SystemctlCall } from "./system";
import { config } from "./config";

/** 画面に出すサービス（systemctl のパターン）。OS の細かいものは出さず、失敗したら「失敗しているユニット」に出る */
export const VPS_UNITS = ["plasmod*.service", "hermes-*.service", ...config.extraUnits, "tailscaled.service", "docker.service", "fail2ban.service"];

/** 見るディスク。同じファイルシステムなら1つにまとめる */
const DISKS = ["/", "/var/lib/plasmod", "/home"];

export interface HostReader {
  read(path: string): string;
  statfs(path: string): { blocks: number; bavail: number; bfree: number; bsize: number };
  hostname(): string;
}

export const realHost: HostReader = {
  read: (p) => readFileSync(p, "utf8"),
  statfs: (p) => statfsSync(p),
  hostname,
};

/** /proc/meminfo（kB）→ バイト */
export function parseMeminfo(text: string): Record<string, number> {
  const o: Record<string, number> = {};
  for (const l of text.split("\n")) {
    const m = l.match(/^(\w+):\s+(\d+)(?:\s+kB)?/);
    if (m) o[m[1]] = Number(m[2]) * (l.includes("kB") ? 1024 : 1);
  }
  return o;
}

/** systemctl show の塊（空行区切りの Key=Value） */
function blocks(text: string): Record<string, string>[] {
  return text
    .split(/\n\s*\n/)
    .map((b) => Object.fromEntries(b.split("\n").filter((l) => l.indexOf("=") > 0).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])))
    .filter((o) => o.Id);
}

const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : null);

export function toService(o: Record<string, string>, description: string): VpsService {
  const since = (o.ActiveEnterTimestamp ?? "").match(/^@(\d+)/);
  const mem = num(o.MemoryCurrent);
  return {
    unit: o.Id,
    description: o.Description || description,
    active: o.ActiveState ?? "",
    sub: o.SubState ?? "",
    // oneshot（タイマーで動くもの）は止まっているのが普通。最後の結果で見る
    oneshot: o.Type === "oneshot",
    result: o.Result || null,
    since: since ? Number(since[1]) * 1000 : null,
    restarts: num(o.NRestarts),
    // 上限なしのときは 2^64-1 が出る
    memory: mem !== null && mem < 2 ** 60 ? mem : null,
  };
}

export async function readVps(host: HostReader, systemctl: SystemctlCall | null): Promise<VpsStatus> {
  const errors: VpsStatus["errors"] = [];
  const tryRead = <T>(source: string, fn: () => T): T | null => {
    try {
      return fn();
    } catch (e) {
      errors.push({ source, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };

  const load = tryRead("負荷", () => host.read("/proc/loadavg").trim().split(/\s+/).slice(0, 3).map(Number) as [number, number, number]);
  const cpus = tryRead("CPU", () => (host.read("/proc/cpuinfo").match(/^processor\s*:/gm) ?? []).length) || 1;
  const uptime = tryRead("起動時間", () => Math.round(Number(host.read("/proc/uptime").split(/\s+/)[0]) * 1000));
  const mi = tryRead("メモリ", () => parseMeminfo(host.read("/proc/meminfo")));
  const mem = mi?.MemTotal ? { total: mi.MemTotal, used: mi.MemTotal - (mi.MemAvailable ?? mi.MemFree ?? 0) } : null;
  const swap = mi?.SwapTotal ? { total: mi.SwapTotal, used: mi.SwapTotal - (mi.SwapFree ?? 0) } : null;

  const disks: VpsStatus["disks"] = [];
  const seen = new Set<string>();
  for (const path of DISKS) {
    const s = tryRead(`ディスク ${path}`, () => host.statfs(path));
    if (!s) continue;
    // 同じファイルシステム（大きさと空きが同じ）は1つに
    const id = `${s.blocks}:${s.bfree}`;
    if (seen.has(id)) continue;
    seen.add(id);
    disks.push({ path, total: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize, avail: s.bavail * s.bsize });
  }

  const deployed = (() => {
    try {
      return host.read("/var/lib/plasmod-deploy/deployed").trim().slice(0, 40) || null;
    } catch {
      return null;
    }
  })();

  let services: VpsService[] = [];
  let failed: string[] = [];
  if (systemctl) {
    try {
      const list = JSON.parse(await systemctl("list-units", "--all", "--type=service", "--output=json", "--", ...VPS_UNITS)) as { unit: string; description?: string }[];
      const desc = new Map(list.map((u) => [u.unit, u.description ?? ""]));
      if (list.length) {
        const shown = await systemctl("show", "--timestamp=unix", "-p", "Id,Description,Type,ActiveState,SubState,Result,ActiveEnterTimestamp,NRestarts,MemoryCurrent,UnitFileState", "--", ...list.map((u) => u.unit));
        // 無効にして止めたものは出さない（「停止」で赤く出続けないように）
        services = blocks(shown)
          .filter((o) => !(o.UnitFileState === "disabled" && o.ActiveState !== "active"))
          .map((o) => toService(o, desc.get(o.Id) ?? ""));
        // 常駐するものを先に、それぞれ名前順
        services.sort((a, b) => Number(a.oneshot) - Number(b.oneshot) || a.unit.localeCompare(b.unit));
      }
    } catch (e) {
      errors.push({ source: "サービス", error: e instanceof Error ? e.message : String(e) });
    }
    try {
      failed = (JSON.parse(await systemctl("list-units", "--all", "--state=failed", "--output=json")) as { unit: string }[]).map((u) => u.unit);
    } catch (e) {
      errors.push({ source: "失敗しているユニット", error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { at: Date.now(), hostname: tryRead("ホスト名", () => host.hostname()) ?? "", uptime, load, cpus, mem, swap, disks, services, failed, deployed, errors };
}
