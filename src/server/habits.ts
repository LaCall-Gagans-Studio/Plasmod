// ルーティーン: 繰り返すことと、日ごとのチェック。画面とレポートでチェックでき、AI は plasmod-task habits で読める。
import type { Database } from "bun:sqlite";
import type { Habit, HabitOverview } from "../shared/types";
import { localDay } from "../shared/time";

export class HabitError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

const DAY = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 草グラフに出す長さ（週の頭まで広げるので、少し長くなる） */
export const GRAPH_DAYS = 182;

/** その時刻の日付（タスクの期日と同じ考え方） */
export const dayOf = (ms: number) => localDay(ms);
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

interface Row {
  id: number;
  name: string;
  emoji: string | null;
}

export class HabitStore {
  constructor(private db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS habits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        emoji TEXT,
        created_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS habit_checks (
        habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (habit_id, day)
      );
    `);
    const cols = (db.query("PRAGMA table_info(habits)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("position")) db.exec("ALTER TABLE habits ADD COLUMN position INTEGER");
  }

  private row(id: number): Row {
    const r = this.db.query("SELECT id, name, emoji FROM habits WHERE id = ? AND archived_at IS NULL").get(id) as Row | null;
    if (!r) throw new HabitError("そのルーティーンはありません", 404);
    return r;
  }

  private cleanName(name: unknown): string {
    const v = typeof name === "string" ? name.trim() : "";
    if (!v) throw new HabitError("名前を入れてください");
    if (v.length > 60) throw new HabitError("名前は60文字まで");
    return v;
  }

  private cleanEmoji(emoji: unknown): string | null {
    const v = typeof emoji === "string" ? emoji.trim() : "";
    return v ? [...v].slice(0, 4).join("") : null;
  }

  private days(id: number): string[] {
    return (this.db.query("SELECT day FROM habit_checks WHERE habit_id = ? ORDER BY day DESC").all(id) as { day: string }[]).map((x) => x.day);
  }

  private toHabit(r: Row, today: string): Habit {
    const days = this.days(r.id);
    const set = new Set(days);
    // 続いている日数: 今日がまだでも、昨日まで続いていれば途切れていない
    let streak = 0;
    let d = set.has(today) ? today : shift(today, -1);
    while (set.has(d)) {
      streak++;
      d = shift(d, -1);
    }
    return { id: r.id, name: r.name, emoji: r.emoji, doneToday: set.has(today), streak, total: days.length };
  }

  overview(now = Date.now()): HabitOverview {
    const today = dayOf(now);
    const rows = this.db.query("SELECT id, name, emoji FROM habits WHERE archived_at IS NULL ORDER BY COALESCE(position, id), id").all() as Row[];
    const from = shift(today, -(GRAPH_DAYS - 1));
    // やめたルーティーンの記録も、草には残す
    const counts = this.db.query("SELECT day, COUNT(*) AS n FROM habit_checks WHERE day >= ? AND day <= ? GROUP BY day").all(from, today) as { day: string; n: number }[];
    const byDay = new Map(counts.map((c) => [c.day, c.n]));
    return {
      today,
      habits: rows.map((r) => this.toHabit(r, today)),
      days: Array.from({ length: GRAPH_DAYS }, (_, i) => {
        const day = shift(from, i);
        return { day, count: byDay.get(day) ?? 0 };
      }),
    };
  }

  create(input: { name?: unknown; emoji?: unknown }, now = Date.now()): Habit {
    // 新しいものは一番下へ
    const last = this.db.query("SELECT MAX(COALESCE(position, id)) AS p FROM habits").get() as { p: number | null };
    const r = this.db.query("INSERT INTO habits (name, emoji, created_at, position) VALUES (?, ?, ?, ?) RETURNING id").get(this.cleanName(input.name), this.cleanEmoji(input.emoji), now, (last.p ?? 0) + 1) as { id: number };
    return this.toHabit(this.row(r.id), dayOf(now));
  }

  update(id: number, input: { name?: unknown; emoji?: unknown }, now = Date.now()): Habit {
    const cur = this.row(id);
    const name = input.name === undefined ? cur.name : this.cleanName(input.name);
    const emoji = input.emoji === undefined ? cur.emoji : this.cleanEmoji(input.emoji);
    this.db.query("UPDATE habits SET name = ?, emoji = ? WHERE id = ?").run(name, emoji, id);
    return this.toHabit(this.row(id), dayOf(now));
  }

  /** 並べ替える。ids は今あるルーティーンすべて */
  reorder(ids: unknown) {
    const cur = (this.db.query("SELECT id FROM habits WHERE archived_at IS NULL").all() as { id: number }[]).map((x) => x.id);
    if (!Array.isArray(ids) || ids.length !== cur.length || new Set(ids).size !== ids.length || !ids.every((x) => cur.includes(x))) throw new HabitError("並びが今のルーティーンと合いません");
    this.db.transaction(() => {
      ids.forEach((id, i) => this.db.query("UPDATE habits SET position = ? WHERE id = ?").run(i + 1, id));
    })();
  }

  /** 消す（記録は草に残す） */
  archive(id: number, now = Date.now()) {
    this.row(id);
    this.db.query("UPDATE habits SET archived_at = ? WHERE id = ?").run(now, id);
  }

  /** チェックを付ける・外す。day を省くと今日。先の日は付けられない */
  check(id: number, done: boolean, day?: unknown, now = Date.now()): Habit {
    const r = this.row(id);
    const today = dayOf(now);
    const d = day === undefined || day === null ? today : String(day);
    if (!DAY_RE.test(d) || d > today || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) throw new HabitError("日付が正しくありません");
    if (done) this.db.query("INSERT OR IGNORE INTO habit_checks (habit_id, day, at) VALUES (?, ?, ?)").run(id, d, now);
    else this.db.query("DELETE FROM habit_checks WHERE habit_id = ? AND day = ?").run(id, d);
    return this.toHabit(r, today);
  }
}
