// メモ（TASK-174）: Markdown の本文に、プロジェクト（1つ）とタグ（いくつでも）を付ける。
// 消さずにアーカイブする。保存のたびに版を memo_events に残す（後で AI が書いても誰が何を変えたか追える）。
import type { Database } from "bun:sqlite";
import type { Memo, MemoEvent, MemoList, MemoSummary } from "../shared/types";
import { SearchIndex } from "./search";
import { memoIdOf } from "../shared/memo-ref";

export const MEMO_LIMITS = { title: 200, body: 100_000, project: 60, tag: 40, tags: 20, image: 2000 } as const;

/** ヘッダー画像のリンク。http(s) だけ（javascript: などは受けない）。空・不正は null */
export function normalizeImageUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().slice(0, MEMO_LIMITS.image);
  if (!t) return null;
  try {
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

export class MemoError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export interface MemoInput {
  title?: string;
  body?: string;
  project?: string | null;
  tags?: string[];
  /** ヘッダー画像のリンク。null・空で外す */
  headerImage?: string | null;
  /** 作るときの親。変えるのは setParent */
  parentId?: number | null;
}

interface MemoRow {
  id: number;
  title: string;
  body: string;
  project: string | null;
  parent_id: number | null;
  author: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  pinned_at: number | null;
  header_image: string | null;
}

/** 空白をまとめ、前後を落とす */
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** タグ: 先頭の # を外し、重複を除いて、決まった数まで */
export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const v = clean(t.replace(/^#+/, "")).slice(0, MEMO_LIMITS.tag);
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(0, MEMO_LIMITS.tags);
}

/** 一覧に出す本文の頭。見出し・箇条書き・表の記号は落とす */
export function excerptOf(body: string): string {
  return clean(
    body
      // html の箱の中身は一覧に出さない
      .replace(/^\s*```html\s*$[\s\S]*?^\s*```\s*$/gm, "")
      .replace(/^\s*```.*$/gm, "")
      .replace(/^\s*(#+|[-*+>]|\d+\.)\s+/gm, "")
      .replace(/^\s*\[[ xX]\]\s+/gm, "")
      .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, "")
      .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1")
      .replace(/(\*\*|__|~~|`)/g, "")
      .replace(/\|/g, " "),
  ).slice(0, 140);
}

/** 題が空なら、本文の最初の行（見出しの # は外す） */
export function memoTitle(title: string, body: string): string {
  const t = clean(title);
  if (t) return t.slice(0, MEMO_LIMITS.title);
  const first = body.split("\n").map((l) => clean(l.replace(/^#+\s*/, ""))).find(Boolean) ?? "";
  return first.slice(0, 60) || "無題のメモ";
}

export class MemoStore {
  /** アプリ全体の検索（/api/search）にも載せる。アーカイブしたものは外す */
  private search: SearchIndex;

  constructor(private db: Database) {
    this.search = new SearchIndex(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memo_projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        project_id INTEGER REFERENCES memo_projects(id),
        author TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS memos_updated ON memos(updated_at);
      CREATE TABLE IF NOT EXISTS memo_tags (
        memo_id INTEGER NOT NULL REFERENCES memos(id),
        tag TEXT NOT NULL,
        PRIMARY KEY (memo_id, tag)
      );
      CREATE INDEX IF NOT EXISTS memo_tags_tag ON memo_tags(tag);
      CREATE TABLE IF NOT EXISTS memo_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memo_id INTEGER NOT NULL REFERENCES memos(id),
        at INTEGER NOT NULL,
        author TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        project TEXT,
        tags TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memo_events_memo ON memo_events(memo_id);
      -- 消したメモの印。ほかの端末が写しを消せるように、いつ消したかを残す
      CREATE TABLE IF NOT EXISTS memo_deleted (
        memo_id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL
      );
    `);
    // ネスト（親のメモ）。前の版の DB には列が無い
    const cols = (db.query("PRAGMA table_info(memos)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("parent_id")) db.exec("ALTER TABLE memos ADD COLUMN parent_id INTEGER REFERENCES memos(id)");
    db.exec("CREATE INDEX IF NOT EXISTS memos_parent ON memos(parent_id)");
    // ピン留め（一覧の一番上に固定）
    if (!cols.includes("pinned_at")) db.exec("ALTER TABLE memos ADD COLUMN pinned_at INTEGER");
    if (!cols.includes("header_image")) db.exec("ALTER TABLE memos ADD COLUMN header_image TEXT");
    // 起動時に索引を合わせる（中身が同じなら upsert は何もしない）
    const ids = this.db.query("SELECT id FROM memos WHERE archived_at IS NULL").all() as { id: number }[];
    for (const { id } of ids) this.index(this.get(id)!);
  }

  private index(m: Memo) {
    if (m.archivedAt) return this.search.remove("memo", String(m.id));
    const meta = [m.project, ...m.tags.map((t) => `#${t}`)].filter(Boolean).join(" ");
    this.search.upsert("memo", String(m.id), m.title, meta ? `${meta}\n${m.body}` : m.body, m.updatedAt);
  }

  private row(id: number): MemoRow | null {
    return this.db
      .query("SELECT m.*, p.name AS project FROM memos m LEFT JOIN memo_projects p ON p.id = m.project_id WHERE m.id = ?")
      .get(id) as MemoRow | null;
  }

  private tagsOf(id: number): string[] {
    return (this.db.query("SELECT tag FROM memo_tags WHERE memo_id = ? ORDER BY rowid").all(id) as { tag: string }[]).map((r) => r.tag);
  }

  private projectId(name: string | null | undefined, now: number): number | null {
    const v = clean(name ?? "").slice(0, MEMO_LIMITS.project);
    if (!v) return null;
    this.db.query("INSERT INTO memo_projects (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING").run(v, now);
    return (this.db.query("SELECT id FROM memo_projects WHERE name = ?").get(v) as { id: number }).id;
  }

  private setTags(id: number, tags: string[]) {
    this.db.query("DELETE FROM memo_tags WHERE memo_id = ?").run(id);
    const ins = this.db.query("INSERT INTO memo_tags (memo_id, tag) VALUES (?, ?)");
    for (const t of tags) ins.run(id, t);
  }

  private event(m: Memo, kind: MemoEvent["kind"], author: string, at: number) {
    this.db
      .query("INSERT INTO memo_events (memo_id, at, author, kind, title, body, project, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(m.id, at, author, kind, m.title, m.body, m.project, JSON.stringify(m.tags));
  }

  /** 同期用: この時刻以降に変わったメモ（アーカイブも含む、全文） */
  changedSince(since: number): Memo[] {
    const rows = this.db.query("SELECT id FROM memos WHERE updated_at >= ? ORDER BY updated_at").all(since) as { id: number }[];
    return rows.map((r) => this.get(r.id)!);
  }

  get(id: number): Memo | null {
    const r = this.row(id);
    if (!r) return null;
    return {
      id: r.id,
      title: r.title,
      body: r.body,
      project: r.project,
      tags: this.tagsOf(r.id),
      parentId: r.parent_id,
      author: r.author,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      archivedAt: r.archived_at,
      pinnedAt: r.pinned_at,
      headerImage: r.header_image,
    };
  }

  private must(id: number): Memo {
    const m = this.get(id);
    if (!m) throw new MemoError("このメモは無い", 404);
    return m;
  }

  create(input: MemoInput, author: string, now = Date.now()): Memo {
    const body = (input.body ?? "").slice(0, MEMO_LIMITS.body);
    if (!clean(input.title ?? "") && !body.trim()) throw new MemoError("題か本文が要る", 400);
    return this.db.transaction(() => {
      const r = this.db
        .query("INSERT INTO memos (title, body, project_id, author, created_at, updated_at, header_image) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(memoTitle(input.title ?? "", body), body, this.projectId(input.project, now), author, now, now, normalizeImageUrl(input.headerImage));
      const id = Number(r.lastInsertRowid);
      this.setTags(id, normalizeTags(input.tags));
      // 親が消えていても書いた分は失わない（オフラインで作ったメモが同期で止まらないように）
      if (input.parentId && this.get(input.parentId)) this.db.query("UPDATE memos SET parent_id = ? WHERE id = ?").run(input.parentId, id);
      const m = this.must(id);
      this.event(m, "create", author, now);
      this.index(m);
      return m;
    })();
  }

  /** 親を変える。null で一番上へ。自分や自分の子孫は親にできない */
  setParent(id: number, parentId: number | null, now = Date.now()): Memo {
    return this.db.transaction(() => {
      const cur = this.must(id);
      if (parentId !== null) {
        for (let p: Memo | null = this.must(parentId); p; p = p.parentId ? this.get(p.parentId) : null)
          if (p.id === id) throw new MemoError("自分や自分の子のメモは親にできない", 400);
      }
      if (cur.parentId === parentId) return cur;
      const at = Math.max(now, cur.updatedAt + 1);
      this.db.query("UPDATE memos SET parent_id = ?, updated_at = ? WHERE id = ?").run(parentId, at, id);
      return this.must(id);
    })();
  }

  /**
   * 書き換える。baseUpdatedAt を渡すと、その後に誰か（別の端末・AI）が変えていたら 409 にする。
   * 渡さなかった項目はそのまま
   */
  update(id: number, input: MemoInput & { baseUpdatedAt?: number }, author: string, now = Date.now()): Memo {
    return this.db.transaction(() => {
      const cur = this.must(id);
      if (input.baseUpdatedAt !== undefined && input.baseUpdatedAt !== cur.updatedAt)
        throw new MemoError("ほかで書き換えられています。開き直してください", 409);
      const body = input.body !== undefined ? input.body.slice(0, MEMO_LIMITS.body) : cur.body;
      const title = input.title !== undefined ? memoTitle(input.title, body) : cur.title;
      const projectId = input.project !== undefined ? this.projectId(input.project, now) : this.projectId(cur.project, now);
      const tags = input.tags !== undefined ? normalizeTags(input.tags) : cur.tags;
      const headerImage = input.headerImage !== undefined ? normalizeImageUrl(input.headerImage) : cur.headerImage ?? null;
      const same = headerImage === (cur.headerImage ?? null) && title === cur.title && body === cur.body && (input.project === undefined || clean(input.project ?? "") === (cur.project ?? "")) && tags.join("\n") === cur.tags.join("\n");
      if (same) return cur;
      // 同じ時刻に2回保存しても baseUpdatedAt が区別できるように進める
      const at = Math.max(now, cur.updatedAt + 1);
      this.db.query("UPDATE memos SET title = ?, body = ?, project_id = ?, header_image = ?, updated_at = ? WHERE id = ?").run(title, body, projectId, headerImage, at, id);
      this.setTags(id, tags);
      const m = this.must(id);
      this.event(m, "edit", author, at);
      this.index(m);
      return m;
    })();
  }

  /** 本文の最後に足す（AI の追記用）。空行で区切る */
  append(id: number, text: string, author: string, now = Date.now()): Memo {
    const add = text.trim();
    if (!add) throw new MemoError("足す文が空", 400);
    return this.db.transaction(() => {
      const cur = this.must(id);
      if (cur.archivedAt) throw new MemoError("アーカイブしたメモには足せない", 409);
      return this.update(id, { body: cur.body.trimEnd() ? `${cur.body.trimEnd()}\n\n${add}` : add }, author, now);
    })();
  }

  setArchived(id: number, archived: boolean, author: string, now = Date.now()): Memo {
    return this.db.transaction(() => {
      const cur = this.must(id);
      if (!!cur.archivedAt === archived) return cur;
      const at = Math.max(now, cur.updatedAt + 1);
      // アーカイブするとピン留めは外れる
      this.db.query("UPDATE memos SET archived_at = ?, pinned_at = NULL, updated_at = ? WHERE id = ?").run(archived ? at : null, at, id);
      const m = this.must(id);
      this.event(m, archived ? "archive" : "restore", author, at);
      this.index(m);
      return m;
    })();
  }

  /** ピン留め・外す。同期で他の端末に届くよう更新時刻を進める。アーカイブしたメモは留められない */
  setPinned(id: number, pinned: boolean, now = Date.now()): Memo {
    return this.db.transaction(() => {
      const cur = this.must(id);
      if (!!cur.pinnedAt === pinned) return cur;
      if (pinned && cur.archivedAt) throw new MemoError("アーカイブしたメモは留められない", 409);
      const at = Math.max(now, cur.updatedAt + 1);
      this.db.query("UPDATE memos SET pinned_at = ?, updated_at = ? WHERE id = ?").run(pinned ? at : null, at, id);
      return this.must(id);
    })();
  }

  /**
   * 完全に消す（履歴・タグも）。子のメモは消さずに、このメモの親へ繋ぎ直す。
   * ほかの端末が写しを消せるよう memo_deleted に残す
   */
  delete(id: number, now = Date.now()): void {
    this.db.transaction(() => {
      const cur = this.must(id);
      const at = Math.max(now, cur.updatedAt + 1);
      // 子の親を付け替えるので、子の更新時刻も進めて同期に載せる
      this.db.query("UPDATE memos SET parent_id = ?, updated_at = ? WHERE parent_id = ?").run(cur.parentId, at, id);
      this.db.query("DELETE FROM memo_tags WHERE memo_id = ?").run(id);
      this.db.query("DELETE FROM memo_events WHERE memo_id = ?").run(id);
      this.db.query("DELETE FROM memos WHERE id = ?").run(id);
      this.db.query("INSERT INTO memo_deleted (memo_id, at) VALUES (?, ?) ON CONFLICT(memo_id) DO UPDATE SET at = excluded.at").run(id, at);
      this.search.remove("memo", String(id));
    })();
  }

  /** 同期用: この時刻以降に消えたメモの id */
  deletedSince(since: number): number[] {
    return (this.db.query("SELECT memo_id FROM memo_deleted WHERE at >= ? ORDER BY at").all(since) as { memo_id: number }[]).map((r) => r.memo_id);
  }

  history(id: number): MemoEvent[] {
    this.must(id);
    const rows = this.db.query("SELECT * FROM memo_events WHERE memo_id = ? ORDER BY id DESC").all(id) as {
      id: number;
      at: number;
      author: string;
      kind: MemoEvent["kind"];
      title: string;
      body: string;
      project: string | null;
      tags: string;
    }[];
    return rows.map((r) => ({ id: r.id, at: r.at, author: r.author, kind: r.kind, title: r.title, body: r.body, project: r.project, tags: JSON.parse(r.tags) as string[] }));
  }

  /**
   * 一覧。q は空白区切りの語を AND で、題・本文・タグ・プロジェクトから探す（MEMO-9 はそのメモにも当たり、一番上に出る）。
   * project="" は「プロジェクトなし」。projects・tags は絞り込み用に、アーカイブ以外の件数を返す
   */
  list(opts: { q?: string; project?: string | null; tag?: string | null; archived?: boolean; limit?: number; parent?: number | null } = {}): MemoList {
    const where = [opts.archived ? "m.archived_at IS NOT NULL" : "m.archived_at IS NULL"];
    const args: (string | number)[] = [];
    if (opts.project === "") where.push("m.project_id IS NULL");
    else if (opts.project) {
      where.push("p.name = ?");
      args.push(opts.project);
    }
    if (opts.parent) {
      where.push("m.parent_id = ?");
      args.push(opts.parent);
    }
    if (opts.tag) {
      where.push("EXISTS (SELECT 1 FROM memo_tags t WHERE t.memo_id = m.id AND t.tag = ?)");
      args.push(opts.tag);
    }
    let exact = 0;
    for (const w of clean(opts.q ?? "").split(" ").filter(Boolean).slice(0, 8)) {
      const byNumber = memoIdOf(w);
      if (byNumber !== null) exact = byNumber;
      const like = `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(
        `(m.title LIKE ? ESCAPE '\\' OR m.body LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM memo_tags t WHERE t.memo_id = m.id AND t.tag LIKE ? ESCAPE '\\')${byNumber !== null ? " OR m.id = ?" : ""})`,
      );
      args.push(like, like, like, like);
      if (byNumber !== null) args.push(byNumber);
    }
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const rows = this.db
      .query(
        `SELECT m.id, m.title, m.body, p.name AS project, m.parent_id, m.updated_at, m.archived_at, m.pinned_at, m.header_image FROM memos m
         LEFT JOIN memo_projects p ON p.id = m.project_id
         WHERE ${where.join(" AND ")} ORDER BY m.id = ${exact} DESC, m.pinned_at IS NOT NULL DESC, m.updated_at DESC LIMIT ${limit}`,
      )
      .all(...args) as { id: number; title: string; body: string; project: string | null; parent_id: number | null; updated_at: number; archived_at: number | null; pinned_at: number | null; header_image: string | null }[];
    const tagRows = rows.length
      ? (this.db.query(`SELECT memo_id, tag FROM memo_tags WHERE memo_id IN (${rows.map(() => "?").join(",")}) ORDER BY rowid`).all(...rows.map((r) => r.id)) as {
          memo_id: number;
          tag: string;
        }[])
      : [];
    const memos: MemoSummary[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      excerpt: excerptOf(r.body),
      project: r.project,
      tags: tagRows.filter((t) => t.memo_id === r.id).map((t) => t.tag),
      parentId: r.parent_id,
      updatedAt: r.updated_at,
      archived: r.archived_at !== null,
      pinned: r.pinned_at !== null,
      headerImage: r.header_image,
    }));
    const projects = this.db
      .query(
        `SELECT p.name AS name, COUNT(m.id) AS count FROM memo_projects p
         LEFT JOIN memos m ON m.project_id = p.id AND m.archived_at IS NULL
         GROUP BY p.id HAVING count > 0 ORDER BY MAX(m.updated_at) DESC`,
      )
      .all() as { name: string; count: number }[];
    const tags = this.db
      .query(
        `SELECT t.tag AS name, COUNT(*) AS count FROM memo_tags t JOIN memos m ON m.id = t.memo_id
         WHERE m.archived_at IS NULL GROUP BY t.tag ORDER BY count DESC, name LIMIT 100`,
      )
      .all() as { name: string; count: number }[];
    return { memos, projects, tags };
  }
}
