// アプリ自身の通知の流れ（TASK-250 段4）。APK が Tailscale 越しにつなぎっぱなしで受け取る（/api/notify/stream）。
// 記録は SQLite に7日分（つながっていなかった間の分を後から受け取れる）
import type { Database } from "bun:sqlite";
import type { AppNotice, NoticeEvent } from "../shared/types";

const KEEP_MS = 7 * 86_400_000;

export class NotifyFeed {
  private listeners = new Set<(e: NoticeEvent) => void>();

  constructor(private db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notify_feed (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `);
  }

  private push(type: NoticeEvent["type"], data: object, now: number): NoticeEvent {
    const r = this.db.query("INSERT INTO notify_feed (at, type, data) VALUES (?, ?, ?)").run(now, type, JSON.stringify(data));
    const e = { id: Number(r.lastInsertRowid), at: now, type, ...data } as NoticeEvent;
    this.db.query("DELETE FROM notify_feed WHERE at < ?").run(now - KEEP_MS);
    for (const fn of this.listeners) fn(e);
    return e;
  }

  /** 通知を1件出す */
  add(n: Omit<AppNotice, "id" | "at" | "type">, now = Date.now()): NoticeEvent {
    return this.push("notice", n, now);
  }

  /** そのカードの通知を消す（判断された・無くなった） */
  clear(key: string, now = Date.now()): NoticeEvent {
    return this.push("clear", { key }, now);
  }

  /** id より後の出来事（古い順、最大 limit 件） */
  since(id: number, limit = 100): NoticeEvent[] {
    const rows = this.db.query("SELECT id, at, type, data FROM notify_feed WHERE id > ? ORDER BY id LIMIT ?").all(id, limit) as { id: number; at: number; type: NoticeEvent["type"]; data: string }[];
    return rows.map((r) => ({ id: r.id, at: r.at, type: r.type, ...JSON.parse(r.data) }) as NoticeEvent);
  }

  /** いちばん新しい id（初めてつないだ端末は、ここから先だけ受け取る） */
  last(): number {
    return (this.db.query("SELECT MAX(id) AS m FROM notify_feed").get() as { m: number | null }).m ?? 0;
  }

  subscribe(fn: (e: NoticeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}
