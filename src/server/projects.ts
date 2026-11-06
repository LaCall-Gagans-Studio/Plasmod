// プロジェクト（PJ）。メモとタスクで共通の memo_projects に、説明（Markdown）・状態・絵文字を足す。
// PJ の画面は、プロジェクトごとにタスクとメモを並べる見方と、全部のタスクを期日順に並べる見方を切り替える。
import type { Database } from "bun:sqlite";
import type { AppTask, MemoSummary, Project, ProjectDetail, ProjectOverview, ProjectStatus } from "../shared/types";
import { MemoStore } from "./memos";
import { TaskStore } from "./tasks";
import { localDay } from "../shared/time";

export const PROJECT_STATUSES: ProjectStatus[] = ["active", "paused", "done"];

export class ProjectError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

interface Row {
  id: number;
  name: string;
  description: string | null;
  status: string | null;
  emoji: string | null;
  created_at: number;
  updated_at: number | null;
}

/** 「期限が近い」の日数 */
const NEAR_DAYS = 3;

export class ProjectStore {
  constructor(
    private db: Database,
    private memos: MemoStore,
    private tasks: TaskStore,
  ) {
    const cols = (db.query("PRAGMA table_info(memo_projects)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("description")) db.exec("ALTER TABLE memo_projects ADD COLUMN description TEXT");
    if (!cols.includes("status")) db.exec("ALTER TABLE memo_projects ADD COLUMN status TEXT");
    if (!cols.includes("emoji")) db.exec("ALTER TABLE memo_projects ADD COLUMN emoji TEXT");
    if (!cols.includes("updated_at")) db.exec("ALTER TABLE memo_projects ADD COLUMN updated_at INTEGER");
    db.exec("CREATE TABLE IF NOT EXISTS app_flags (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  flag(key: string): string | null {
    return (this.db.query("SELECT value FROM app_flags WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
  }

  setFlag(key: string, value: string) {
    this.db.query("INSERT INTO app_flags (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  private toProject(r: Row): Project {
    const c = this.db
      .query(
        `SELECT
           (SELECT COUNT(*) FROM tasks WHERE project_id = ? AND status IN ('inbox','todo','doing')) AS open,
           (SELECT COUNT(*) FROM tasks WHERE project_id = ? AND status IN ('inbox','todo','doing') AND due IS NOT NULL AND due < ?) AS late,
           (SELECT MIN(due) FROM tasks WHERE project_id = ? AND status IN ('inbox','todo','doing') AND due IS NOT NULL) AS next_due,
           (SELECT COUNT(*) FROM memos WHERE project_id = ? AND archived_at IS NULL) AS memos`,
      )
      .get(r.id, r.id, today(), r.id, r.id) as { open: number; late: number; next_due: string | null; memos: number };
    return {
      id: r.id,
      name: r.name,
      description: r.description ?? "",
      status: (PROJECT_STATUSES as string[]).includes(r.status ?? "") ? (r.status as ProjectStatus) : "active",
      emoji: r.emoji ?? null,
      openTasks: c.open,
      lateTasks: c.late,
      nextDue: c.next_due,
      memos: c.memos,
      createdAt: r.created_at,
      updatedAt: r.updated_at ?? r.created_at,
    };
  }

  get(id: number): Project | null {
    const r = this.db.query("SELECT * FROM memo_projects WHERE id = ?").get(id) as Row | null;
    return r ? this.toProject(r) : null;
  }

  byName(name: string): Project | null {
    const r = this.db.query("SELECT * FROM memo_projects WHERE name = ?").get(clean(name)) as Row | null;
    return r ? this.toProject(r) : null;
  }

  /** すべて。進行中 → 保留 → 完了、その中は期限の近いタスク・更新の新しい順 */
  list(): Project[] {
    const rows = this.db.query("SELECT * FROM memo_projects").all() as Row[];
    const order = { active: 0, paused: 1, done: 2 };
    return rows
      .map((r) => this.toProject(r))
      .filter((p) => p.openTasks + p.memos > 0 || p.description || p.status !== "done")
      .sort((a, b) => order[a.status] - order[b.status] || (a.nextDue ?? "9").localeCompare(b.nextDue ?? "9") || b.updatedAt - a.updatedAt);
  }

  create(input: { name: string; description?: string; emoji?: string | null }, now = Date.now()): Project {
    const name = clean(input.name ?? "").slice(0, 60);
    if (!name) throw new ProjectError("名前が要る", 400);
    if (this.byName(name)) throw new ProjectError("同じ名前のプロジェクトがある", 409);
    const r = this.db
      .query("INSERT INTO memo_projects (name, created_at, description, status, emoji, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
      .run(name, now, (input.description ?? "").slice(0, 100_000), input.emoji ?? null, now);
    return this.get(Number(r.lastInsertRowid))!;
  }

  /** 名前（変えるとメモ・タスクにもそのまま効く）・説明・状態・絵文字。baseUpdatedAt で書き違いを 409 */
  update(id: number, patch: { name?: string; description?: string; status?: ProjectStatus; emoji?: string | null; baseUpdatedAt?: number }, now = Date.now()): Project {
    const cur = this.get(id);
    if (!cur) throw new ProjectError("このプロジェクトは無い", 404);
    if (patch.baseUpdatedAt !== undefined && patch.baseUpdatedAt !== cur.updatedAt) throw new ProjectError("ほかで書き換えられています。開き直してください", 409);
    const name = patch.name !== undefined ? clean(patch.name).slice(0, 60) : cur.name;
    if (!name) throw new ProjectError("名前が要る", 400);
    if (name !== cur.name && this.byName(name)) throw new ProjectError("同じ名前のプロジェクトがある", 409);
    const status = patch.status && PROJECT_STATUSES.includes(patch.status) ? patch.status : cur.status;
    const emoji = patch.emoji !== undefined ? (patch.emoji ? [...patch.emoji.trim()].slice(0, 2).join("") || null : null) : cur.emoji;
    const description = patch.description !== undefined ? patch.description.slice(0, 100_000) : cur.description;
    const at = Math.max(now, cur.updatedAt + 1);
    this.db.query("UPDATE memo_projects SET name = ?, description = ?, status = ?, emoji = ?, updated_at = ? WHERE id = ?").run(name, description, status, emoji, at, id);
    return this.get(id)!;
  }

  /** 1つのプロジェクトの中身: タスク（開いているもの＋最近の済み）とメモ */
  detail(id: number): ProjectDetail {
    const p = this.get(id);
    if (!p) throw new ProjectError("このプロジェクトは無い", 404);
    const open: AppTask[] = this.tasks.list({ status: ["inbox", "todo", "doing"], project: p.name, limit: 500 });
    const done: AppTask[] = this.tasks.list({ status: ["done"], project: p.name, limit: 20 });
    const memos: MemoSummary[] = this.memos.list({ project: p.name, limit: 200 }).memos;
    return { project: p, tasks: open, doneTasks: done, memos };
  }

  /**
   * PJ の「プロジェクトごと」の見方: プロジェクトごとに、開いているタスク（期日順の先頭）と最近のメモ。
   * 「プロジェクトなし」も最後に1つ
   */
  overview(perProject = Infinity, now = Date.now()): ProjectOverview {
    // 期限切れと、3日以内
    const limit = today(now + NEAR_DAYS * 86_400_000);
    const near = (ts: AppTask[]) => ts.filter((t) => t.due && t.due <= limit);
    // サブタスクは画面で親の下に畳むので、親も開いているものは先頭の枠に数えない
    const top = (ts: AppTask[]) => {
      const ids = new Set(ts.map((t) => t.id));
      return ts.filter((t) => !t.parentId || !ids.has(t.parentId));
    };
    const projects = this.list().map((p) => {
      const all = this.tasks.list({ status: ["inbox", "todo", "doing"], project: p.name, limit: 500 });
      return { ...p, tasks: top(all).slice(0, perProject), urgent: near(all), recentMemos: this.memos.list({ project: p.name, limit: 3 }).memos };
    });
    const noneTasks = this.tasks.list({ status: ["inbox", "todo", "doing"], project: "", limit: 500 });
    const noneMemos = this.memos.list({ project: "", limit: 200 }).memos;
    return { projects, none: { tasks: top(noneTasks).slice(0, perProject), urgent: near(noneTasks), recentMemos: noneMemos.slice(0, 3), openTasks: noneTasks.length, memos: noneMemos.length } };
  }

  /** プロジェクトをまとめる: from のメモ・タスクを into に移し、from を消す（説明は into が空なら引き継ぐ） */
  merge(fromId: number, intoId: number, now = Date.now()): Project {
    if (fromId === intoId) throw new ProjectError("同じプロジェクトにはまとめられない", 400);
    const from = this.get(fromId);
    const into = this.get(intoId);
    if (!from || !into) throw new ProjectError("このプロジェクトは無い", 404);
    this.db.transaction(() => {
      this.db.query("UPDATE memos SET project_id = ? WHERE project_id = ?").run(intoId, fromId);
      this.db.query("UPDATE tasks SET project_id = ? WHERE project_id = ?").run(intoId, fromId);
      if (!into.description && from.description) this.db.query("UPDATE memo_projects SET description = ? WHERE id = ?").run(from.description, intoId);
      this.db.query("UPDATE memo_projects SET updated_at = ? WHERE id = ?").run(Math.max(now, into.updatedAt + 1), intoId);
      this.db.query("DELETE FROM memo_projects WHERE id = ?").run(fromId);
    })();
    return this.get(intoId)!;
  }

  /** 消す（メモ・タスクが残っていたら断る。先にまとめるか移す） */
  remove(id: number) {
    const p = this.get(id);
    if (!p) throw new ProjectError("このプロジェクトは無い", 404);
    const left = this.db.query("SELECT (SELECT COUNT(*) FROM memos WHERE project_id = ?1) + (SELECT COUNT(*) FROM tasks WHERE project_id = ?1) AS n").get(id) as { n: number };
    if (left.n > 0) throw new ProjectError(`メモ・タスクが ${left.n} 件残っている。先にほかのプロジェクトにまとめる`, 409);
    this.db.query("DELETE FROM memo_projects WHERE id = ?").run(id);
  }

  /** 設定の画面用: すべてのプロジェクト（完了・空のものも） */
  all(): Project[] {
    return (this.db.query("SELECT * FROM memo_projects ORDER BY name").all() as Row[]).map((r) => this.toProject(r));
  }

  /** タグ（メモとタスクで共通の名前）と、それぞれの件数 */
  tags(): { name: string; memos: number; tasks: number }[] {
    return this.db
      .query(
        `SELECT name, SUM(m) AS memos, SUM(t) AS tasks FROM (
           SELECT tag AS name, COUNT(*) AS m, 0 AS t FROM memo_tags GROUP BY tag
           UNION ALL SELECT tag AS name, 0 AS m, COUNT(*) AS t FROM task_tags GROUP BY tag
         ) GROUP BY name ORDER BY (SUM(m) + SUM(t)) DESC, name`,
      )
      .all() as { name: string; memos: number; tasks: number }[];
  }

  /** タグの名前を変える。to がもうあれば、まとめる */
  renameTag(from: string, to: string) {
    const a = clean(from.replace(/^#+/, ""));
    const b = clean(to.replace(/^#+/, "")).slice(0, 40);
    if (!a || !b) throw new ProjectError("タグの名前が要る", 400);
    if (a === b) return;
    this.db.transaction(() => {
      this.db.query("INSERT OR IGNORE INTO memo_tags (memo_id, tag) SELECT memo_id, ? FROM memo_tags WHERE tag = ?").run(b, a);
      this.db.query("DELETE FROM memo_tags WHERE tag = ?").run(a);
      this.db.query("INSERT OR IGNORE INTO task_tags (task_id, tag) SELECT task_id, ? FROM task_tags WHERE tag = ?").run(b, a);
      this.db.query("DELETE FROM task_tags WHERE tag = ?").run(a);
    })();
  }

  /** タグを外す（メモ・タスクのどちらからも） */
  removeTag(name: string) {
    const a = clean(name.replace(/^#+/, ""));
    this.db.query("DELETE FROM memo_tags WHERE tag = ?").run(a);
    this.db.query("DELETE FROM task_tags WHERE tag = ?").run(a);
  }
}

function today(now = Date.now()): string {
  return localDay(now);
}
