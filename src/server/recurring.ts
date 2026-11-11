// 繰り返しのルール。「毎週月曜」「毎月25日」「3日ごと」などを持ち、期日が近づいたら普通のタスク（Todo）を1件作る。
// 作ったタスクは今のタスクの画面にそのまま出る。元（source = recur, key = ルールID:期日）で、同じ回は二重に作らない。
// 前の回が終わっていない（Todo / AI-Driven / BackLog に残っている）間は、新しい回を重ねない。
import type { Database } from "bun:sqlite";
import { localDay } from "../shared/time";
import type { Task, TaskStore } from "./tasks";

export class RecurError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

/** 周期。days は曜日（0=日〜6=土）。monthly の day は 1〜31（その月に無い日は月末）。every は起点（anchor）から n 日ごと */
export type Cadence =
  | { type: "daily" }
  | { type: "weekdays" }
  | { type: "weekly"; days: number[] }
  | { type: "monthly"; day: number }
  | { type: "every"; n: number };

export interface RecurringRule {
  id: number;
  title: string;
  body: string;
  project: string | null;
  cadence: Cadence;
  /** 数え始める日（YYYY-MM-DD）。every はこの日が起点 */
  anchor: string;
  /** 期日の何日前に浮上させるか（0〜60） */
  leadDays: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

const DAY = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY);
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const lastDayOfMonth = (day: string) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate();

/** その日にルールの回が来るか（anchor より前は来ない） */
export function occursOn(rule: Pick<RecurringRule, "cadence" | "anchor">, day: string): boolean {
  if (day < rule.anchor) return false;
  const c = rule.cadence;
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  switch (c.type) {
    case "daily":
      return true;
    case "weekdays":
      return dow >= 1 && dow <= 5;
    case "weekly":
      return c.days.includes(dow);
    case "monthly":
      return Number(day.slice(8, 10)) === Math.min(c.day, lastDayOfMonth(day));
    case "every":
      return (num(day) - num(rule.anchor)) % c.n === 0;
  }
}

/** from〜to（両端を含む）に来る回の日付。カレンダー表示にも使う。長くても 400 日まで */
export function occurrences(rule: Pick<RecurringRule, "cadence" | "anchor">, from: string, to: string): string[] {
  const out: string[] = [];
  const end = Math.min(num(to), num(from) + 400);
  for (let d = num(from); d <= end; d++) {
    const day = shift("1970-01-01", d);
    if (occursOn(rule, day)) out.push(day);
  }
  return out;
}

/** 受け取った周期を検査して整える */
export function parseCadence(v: unknown): Cadence {
  const c = (v ?? {}) as Record<string, unknown>;
  switch (c.type) {
    case "daily":
    case "weekdays":
      return { type: c.type };
    case "weekly": {
      const days = [...new Set(Array.isArray(c.days) ? c.days.map(Number) : [])].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
      if (!days.length) throw new RecurError("曜日を1つ以上選んでください（0=日〜6=土）");
      return { type: "weekly", days };
    }
    case "monthly": {
      const day = Number(c.day);
      if (!Number.isInteger(day) || day < 1 || day > 31) throw new RecurError("日は 1〜31");
      return { type: "monthly", day };
    }
    case "every": {
      const n = Number(c.n);
      if (!Number.isInteger(n) || n < 1 || n > 365) throw new RecurError("間隔は 1〜365 日");
      return { type: "every", n };
    }
    default:
      throw new RecurError("周期は daily / weekdays / weekly / monthly / every のどれか");
  }
}

interface Row {
  id: number;
  title: string;
  body: string;
  project: string | null;
  cadence: string;
  anchor: string;
  lead_days: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

const toRule = (r: Row): RecurringRule => ({ id: r.id, title: r.title, body: r.body, project: r.project, cadence: JSON.parse(r.cadence) as Cadence, anchor: r.anchor, leadDays: r.lead_days, enabled: !!r.enabled, createdAt: r.created_at, updatedAt: r.updated_at });

export interface RuleInput {
  title?: unknown;
  body?: unknown;
  project?: unknown;
  cadence?: unknown;
  anchor?: unknown;
  leadDays?: unknown;
  enabled?: unknown;
}

export const SOURCE = "recur";
export const TICK_EVERY_MS = 30 * 60_000;

export class RecurringStore {
  constructor(
    private db: Database,
    private tasks: TaskStore,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS recurring_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      project TEXT,
      cadence TEXT NOT NULL,
      anchor TEXT NOT NULL,
      lead_days INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }

  list(): RecurringRule[] {
    return (this.db.query("SELECT * FROM recurring_rules ORDER BY id").all() as Row[]).map(toRule);
  }

  get(id: number): RecurringRule {
    const r = this.db.query("SELECT * FROM recurring_rules WHERE id = ?").get(id) as Row | null;
    if (!r) throw new RecurError("ルールが見つからない", 404);
    return toRule(r);
  }

  private fields(i: RuleInput, cur?: RecurringRule, now = Date.now()) {
    const title = i.title !== undefined ? String(i.title).replace(/\s+/g, " ").trim().slice(0, 200) : cur?.title ?? "";
    if (!title) throw new RecurError("題が要る");
    const cadence = i.cadence !== undefined ? parseCadence(i.cadence) : cur?.cadence;
    if (!cadence) throw new RecurError("周期が要る");
    const anchor = i.anchor !== undefined ? String(i.anchor) : cur?.anchor ?? localDay(now);
    if (!DAY_RE.test(anchor) || Number.isNaN(Date.parse(anchor))) throw new RecurError("起点は YYYY-MM-DD");
    const lead = i.leadDays !== undefined ? Number(i.leadDays) : cur?.leadDays ?? 0;
    if (!Number.isInteger(lead) || lead < 0 || lead > 60) throw new RecurError("何日前からは 0〜60");
    const project = i.project !== undefined ? (String(i.project ?? "").trim().slice(0, 60) || null) : cur?.project ?? null;
    const body = i.body !== undefined ? String(i.body).slice(0, 20_000) : cur?.body ?? "";
    const enabled = i.enabled !== undefined ? !!i.enabled : cur?.enabled ?? true;
    return { title, cadence, anchor, lead, project, body, enabled };
  }

  create(i: RuleInput, now = Date.now()): RecurringRule {
    const f = this.fields(i, undefined, now);
    const r = this.db
      .query("INSERT INTO recurring_rules (title, body, project, cadence, anchor, lead_days, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(f.title, f.body, f.project, JSON.stringify(f.cadence), f.anchor, f.lead, f.enabled ? 1 : 0, now, now);
    return this.get(Number(r.lastInsertRowid));
  }

  update(id: number, i: RuleInput, now = Date.now()): RecurringRule {
    const cur = this.get(id);
    const f = this.fields(i, cur, now);
    this.db
      .query("UPDATE recurring_rules SET title = ?, body = ?, project = ?, cadence = ?, anchor = ?, lead_days = ?, enabled = ?, updated_at = ? WHERE id = ?")
      .run(f.title, f.body, f.project, JSON.stringify(f.cadence), f.anchor, f.lead, f.enabled ? 1 : 0, now, id);
    return this.get(id);
  }

  /** ルールを消す。作ったタスクはそのまま残る */
  remove(id: number) {
    this.get(id);
    this.db.query("DELETE FROM recurring_rules WHERE id = ?").run(id);
  }

  /** 前の回が終わっていないか（終わっていないなら、新しい回は重ねない） */
  private hasOpen(ruleId: number): boolean {
    return !!this.db.query("SELECT 1 FROM tasks WHERE source = ? AND source_key LIKE ? AND status != 'done' LIMIT 1").get(SOURCE, `${ruleId}:%`);
  }

  /**
   * 今日から「何日前に浮上するか」の先までに期日が来る回を、タスクにする。何度呼んでも同じ（同じ回は1度だけ）。
   * サーバーが止まっていた間の過ぎた回は作らない。作ったタスクを返す
   */
  tick(now = Date.now()): Task[] {
    const today = localDay(now);
    const made: Task[] = [];
    for (const rule of this.list()) {
      if (!rule.enabled || this.hasOpen(rule.id)) continue;
      const due = occurrences(rule, today, shift(today, rule.leadDays))[0];
      if (!due) continue;
      const t = this.tasks.spawn({ source: SOURCE, key: `${rule.id}:${due}`, title: rule.title, body: rule.body, project: rule.project, due }, "recur", now);
      if (t) made.push(t);
    }
    return made;
  }

  start(onMade: () => void) {
    const run = () => {
      try {
        if (this.tick().length) onMade();
      } catch (e) {
        console.error("recurring", e instanceof Error ? e.message : e);
      }
    };
    run();
    setInterval(run, TICK_EVERY_MS).unref?.();
  }
}
