// 統計: 期間（今週・今月・30日）のタスクの達成・期限の守り具合・積み上がり、ルーティーン、メモ、よく使ったタグ。
// 新しく記録するものはなく、tasks・habit_checks・memos・タグを日ごとに数えるだけ。
// 「不要」で閉じたタスク（done_reason = unneeded）は、作った数にも完了にも数えない（見回りが拾って捨てたものが混ざらないように）
import type { Database } from "bun:sqlite";
import type { StatsDay, StatsRange, StatsReport } from "../shared/types";
import { localDay } from "../shared/time";

const DAY = 86_400_000;
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // 月曜 0

export const STATS_RANGES: StatsRange[] = ["week", "month", "30d"];

/** 期間の最初と最後の日（どちらも含む） */
export function rangeOf(range: StatsRange, today: string): { from: string; to: string } {
  if (range === "week") {
    const from = shift(today, -weekday(today));
    return { from, to: shift(from, 6) };
  }
  if (range === "month") {
    const from = `${today.slice(0, 8)}01`;
    const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from, to: `${today.slice(0, 8)}${String(last).padStart(2, "0")}` };
  }
  return { from: shift(today, -29), to: today };
}

interface TaskRow {
  status: string;
  due: string | null;
  created_at: number;
  decided_at: number | null;
  done_reason: string | null;
}

export class StatsStore {
  constructor(private db: Database) {}

  report(range: StatsRange, now = Date.now()): StatsReport {
    const today = localDay(now);
    const { from, to } = rangeOf(range, today);
    const n = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
    const days: StatsDay[] = Array.from({ length: n }, (_, i) => ({ day: shift(from, i), created: 0, onTime: 0, late: 0, noDue: 0, habits: 0, memos: 0 }));
    const at = new Map(days.map((d, i) => [d.day, i]));

    // タスク
    const tasks = (this.db.query("SELECT status, due, created_at, decided_at, done_reason FROM tasks").all() as TaskRow[]).filter((t) => t.done_reason !== "unneeded");
    let openAtStart = 0;
    for (const t of tasks) {
      const made = localDay(t.created_at);
      const doneDay = t.status === "done" && t.decided_at ? localDay(t.decided_at) : null;
      if (made < from && (!doneDay || doneDay >= from)) openAtStart++;
      const ci = at.get(made);
      if (ci !== undefined) days[ci].created++;
      const di = doneDay ? at.get(doneDay) : undefined;
      if (di !== undefined && doneDay) {
        if (!t.due) days[di].noDue++;
        else if (doneDay <= t.due) days[di].onTime++;
        else days[di].late++;
      }
    }
    const overdue = tasks.filter((t) => t.status !== "done" && t.due && t.due < today).length;

    // ルーティーン（やめたものの記録も数える。割合は今あるルーティーンの数で割る）
    for (const r of this.db.query("SELECT day, COUNT(*) AS n FROM habit_checks WHERE day >= ? AND day <= ? GROUP BY day").all(from, to) as { day: string; n: number }[]) {
      const i = at.get(r.day);
      if (i !== undefined) days[i].habits = r.n;
    }
    const habitCount = (this.db.query("SELECT COUNT(*) AS n FROM habits WHERE archived_at IS NULL").get() as { n: number }).n;

    // メモ（作った日）
    const start = Date.parse(`${shift(from, -1)}T00:00:00Z`);
    const end = Date.parse(`${shift(to, 2)}T00:00:00Z`);
    for (const r of this.db.query("SELECT created_at FROM memos WHERE created_at >= ? AND created_at < ?").all(start, end) as { created_at: number }[]) {
      const i = at.get(localDay(r.created_at));
      if (i !== undefined) days[i].memos++;
    }

    // よく使ったタグ: 期間に書いたメモと、期間に作った・完了したタスク
    const tagCount = new Map<string, number>();
    const add = (tag: string) => tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
    const inRange = (ms: number | null) => ms !== null && at.has(localDay(ms));
    for (const r of this.db.query("SELECT m.updated_at, m.created_at, t.tag FROM memo_tags t JOIN memos m ON m.id = t.memo_id WHERE m.archived_at IS NULL AND m.updated_at >= ?").all(start) as { updated_at: number; created_at: number; tag: string }[])
      if (inRange(r.updated_at) || inRange(r.created_at)) add(r.tag);
    for (const r of this.db.query("SELECT k.created_at, k.decided_at, k.status, k.done_reason, t.tag FROM task_tags t JOIN tasks k ON k.id = t.task_id WHERE k.created_at >= ? OR k.decided_at >= ?").all(start, start) as { created_at: number; decided_at: number | null; status: string; done_reason: string | null; tag: string }[])
      if (r.done_reason !== "unneeded" && (inRange(r.created_at) || (r.status === "done" && inRange(r.decided_at)))) add(r.tag);
    const tags = [...tagCount].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 12);

    return { range, from, to, today, openAtStart, overdue, habitCount, days, tags };
  }
}
