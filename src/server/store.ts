// アプリ自身の記録（判断・スヌーズ・通知）。SQLite 1ファイル。
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface NotificationRow {
  key: string;
  token: string;
  first_sent: number;
  last_sent: number;
  attempts: number;
  escalated: number;
  seen_at: number | null;
  token_used_at: number | null;
}

export interface NoteRow {
  id: number;
  title: string;
  body: string;
  source: string | null;
  created_at: number;
  done_at: number | null;
}

/** セッション一覧のピン留め・削除（一覧から外す）。Hermes の記録はそのまま */
export interface SessionMark {
  id: string;
  title: string;
  pinned_at: number | null;
  /** オーナーが付けた題名（無ければ元の題名） */
  rename: string | null;
  hidden_at: number | null;
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        choice TEXT NOT NULL,
        text TEXT,
        card_created_at INTEGER NOT NULL,
        decided_at INTEGER NOT NULL,
        via TEXT NOT NULL,
        ok INTEGER NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS decisions_key ON decisions(key);
      CREATE TABLE IF NOT EXISTS snoozes (key TEXT PRIMARY KEY, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source TEXT,
        created_at INTEGER NOT NULL,
        done_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS notifications (
        key TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        first_sent INTEGER NOT NULL,
        last_sent INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        escalated INTEGER NOT NULL DEFAULT 0,
        seen_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS session_marks (
        agent TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        pinned_at INTEGER,
        hidden_at INTEGER,
        PRIMARY KEY (agent, id)
      );
    `);
    if (!(this.db.query("PRAGMA table_info(session_marks)").all() as { name: string }[]).some((c) => c.name === "rename")) this.db.exec("ALTER TABLE session_marks ADD COLUMN rename TEXT");
    const cols = (this.db.query("PRAGMA table_info(notifications)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("token_used_at")) this.db.exec("ALTER TABLE notifications ADD COLUMN token_used_at INTEGER");
  }

  recordDecision(d: { key: string; choice: string; text?: string; cardCreatedAt: number; via: string; ok: boolean; error?: string }) {
    this.db.query(
      "INSERT INTO decisions (key, choice, text, card_created_at, decided_at, via, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(d.key, d.choice, d.text ?? null, d.cardCreatedAt, Date.now(), d.via, d.ok ? 1 : 0, d.error ?? null);
  }

  /** key → 最後に成功した判断の対象カードの createdAt */
  decidedAt(): Map<string, number> {
    const rows = this.db.query(
      "SELECT key, MAX(card_created_at) AS at FROM decisions WHERE ok = 1 AND choice != 'later' GROUP BY key",
    ).all() as { key: string; at: number }[];
    return new Map(rows.map((r) => [r.key, r.at]));
  }

  addNote(title: string, body: string, source: string | null): NoteRow {
    const now = Date.now();
    const r = this.db.query("INSERT INTO notes (title, body, source, created_at) VALUES (?, ?, ?, ?)").run(title, body, source, now);
    return { id: Number(r.lastInsertRowid), title, body, source, created_at: now, done_at: null };
  }

  openNotes(): NoteRow[] {
    return this.db.query("SELECT * FROM notes WHERE done_at IS NULL ORDER BY created_at DESC").all() as NoteRow[];
  }

  finishNote(id: number) {
    this.db.query("UPDATE notes SET done_at = ? WHERE id = ?").run(Date.now(), id);
  }

  snooze(key: string, until: number) {
    this.db.query("INSERT INTO snoozes (key, until) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET until = excluded.until").run(key, until);
  }

  snoozedUntil(): Map<string, number> {
    const rows = this.db.query("SELECT key, until FROM snoozes WHERE until > ?").all(Date.now()) as { key: string; until: number }[];
    return new Map(rows.map((r) => [r.key, r.until]));
  }

  notification(key: string): NotificationRow | null {
    return this.db.query("SELECT * FROM notifications WHERE key = ?").get(key) as NotificationRow | null;
  }

  saveNotification(key: string) {
    const now = Date.now();
    // token の列は前の通知ボタンの名残（NOT NULL・UNIQUE）。もう使わない
    const token = crypto.randomUUID();
    this.db.query(
      `INSERT INTO notifications (key, token, first_sent, last_sent) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET last_sent = excluded.last_sent, attempts = attempts + 1`,
    ).run(key, token, now, now);
  }

  markSeen(key: string) {
    this.db.query("UPDATE notifications SET seen_at = ? WHERE key = ? AND seen_at IS NULL").run(Date.now(), key);
  }

  /** カードが消えた（判断済み・解消済み）通知を片付ける */
  /** 今出ていないカードの通知の記録を消す。消した key を返す */
  pruneNotifications(liveKeys: Set<string>): string[] {
    const rows = this.db.query("SELECT key FROM notifications").all() as { key: string }[];
    const del = this.db.query("DELETE FROM notifications WHERE key = ?");
    const gone = rows.map((r) => r.key).filter((k) => !liveKeys.has(k));
    for (const k of gone) del.run(k);
    return gone;
  }

  sessionMarks(agent: string): SessionMark[] {
    return this.db.query("SELECT id, title, pinned_at, hidden_at, rename FROM session_marks WHERE agent = ?").all(agent) as SessionMark[];
  }

  /**
   * pinned・hidden は true で付け、false で外す。title は元の題名（一覧の60件から落ちても出せるように覚えておく）。
   * rename は題名の付け替え（アプリの中だけ。Hermes の題名は変えない）。null で元に戻す
   */
  markSession(agent: string, id: string, m: { pinned?: boolean; hidden?: boolean; title?: string; rename?: string | null }) {
    const now = Date.now();
    this.db.query("INSERT INTO session_marks (agent, id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(agent, id);
    if (m.title) this.db.query("UPDATE session_marks SET title = ? WHERE agent = ? AND id = ?").run(m.title.slice(0, 200), agent, id);
    if (m.pinned !== undefined) this.db.query("UPDATE session_marks SET pinned_at = ? WHERE agent = ? AND id = ?").run(m.pinned ? now : null, agent, id);
    if (m.rename !== undefined) {
      const v = (m.rename ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      this.db.query("UPDATE session_marks SET rename = ? WHERE agent = ? AND id = ?").run(v || null, agent, id);
    }
    // 削除したらピンも外す
    if (m.hidden !== undefined) this.db.query("UPDATE session_marks SET hidden_at = ?, pinned_at = CASE WHEN ? THEN NULL ELSE pinned_at END WHERE agent = ? AND id = ?").run(m.hidden ? now : null, m.hidden ? 1 : 0, agent, id);
    this.db.query("DELETE FROM session_marks WHERE agent = ? AND id = ? AND pinned_at IS NULL AND hidden_at IS NULL AND rename IS NULL").run(agent, id);
  }
}
