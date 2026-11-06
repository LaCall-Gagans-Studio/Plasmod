// 速さの記録（v2.0 の基準値）: 起動から操作できるまで・話しかけてから最初の返事が見えるまで。画面が測って送る。
import type { Database } from "bun:sqlite";
import type { PerfName, PerfRow } from "../shared/types";

const NAMES: PerfName[] = ["startup", "startup_entry", "startup_doc", "startup_script", "startup_data", "session_new", "session_reply"];
const VIAS = ["apk", "browser"] as const;
const MAX_MS = 3600_000;
const KEEP = 5000;

const pick = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

export class PerfLog {
  constructor(private db: Database) {
    db.exec("CREATE TABLE IF NOT EXISTS perf (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, name TEXT NOT NULL, via TEXT NOT NULL, ms INTEGER NOT NULL)");
  }

  /** おかしな値は黙って捨てる（記録のためだけなので、画面に失敗を返さない） */
  add(name: unknown, via: unknown, ms: unknown, now = Date.now()) {
    if (!NAMES.includes(name as PerfName) || !VIAS.includes(via as (typeof VIAS)[number])) return;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > MAX_MS) return;
    this.db.query("INSERT INTO perf (at, name, via, ms) VALUES (?, ?, ?, ?)").run(now, name as string, via as string, Math.round(ms));
    this.db.query("DELETE FROM perf WHERE id <= (SELECT MAX(id) FROM perf) - ?").run(KEEP);
  }

  /** 種類・端末ごとの中央値と遅い方（90%）。直近の days 日 */
  summary(days = 30, now = Date.now()): PerfRow[] {
    const rows = this.db.query("SELECT name, via, ms FROM perf WHERE at >= ? ORDER BY ms").all(now - days * 86_400_000) as { name: PerfName; via: PerfRow["via"]; ms: number }[];
    const groups = new Map<string, number[]>();
    for (const r of rows) {
      const k = `${r.name} ${r.via}`;
      groups.set(k, [...(groups.get(k) ?? []), r.ms]);
    }
    return [...groups].map(([k, ms]) => {
      const [name, via] = k.split(" ") as [PerfName, PerfRow["via"]];
      return { name, via, n: ms.length, p50: pick(ms, 0.5), p90: pick(ms, 0.9) };
    });
  }
}
