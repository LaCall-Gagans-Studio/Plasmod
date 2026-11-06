// 検索・履歴。カード・カンバン・判断・レポート・メモを1つの全文検索の索引に入れる。
// 日本語は単語の区切りが無いので trigram（3文字単位）で引く。2文字以下は LIKE で探す。
import type { Database } from "bun:sqlite";
import type { SearchHit } from "../shared/types";

export class SearchIndex {
  constructor(private db: Database) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
        kind UNINDEXED, ref UNINDEXED, title, body, at UNINDEXED, tokenize = "trigram"
      );
    `);
  }

  /** kind+ref ごとに1件。中身が変わったら置き換える */
  upsert(kind: SearchHit["kind"], ref: string, title: string, body: string, at: number) {
    const cur = this.db.query("SELECT rowid, title, body FROM search_fts WHERE kind = ? AND ref = ?").get(kind, ref) as
      | { rowid: number; title: string; body: string }
      | null;
    if (cur && cur.title === title && cur.body === body) return;
    if (cur) this.db.query("DELETE FROM search_fts WHERE rowid = ?").run(cur.rowid);
    this.db.query("INSERT INTO search_fts (kind, ref, title, body, at) VALUES (?, ?, ?, ?, ?)").run(kind, ref, title, body, at);
  }

  remove(kind: SearchHit["kind"], ref: string) {
    this.db.query("DELETE FROM search_fts WHERE kind = ? AND ref = ?").run(kind, ref);
  }

  search(q: string, limit = 50): SearchHit[] {
    const words = q.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const short = words.some((w) => [...w].length < 3);
    let rows: { kind: SearchHit["kind"]; ref: string; title: string; body: string; at: number }[];
    if (short) {
      const where = words.map(() => "(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')").join(" AND ");
      const args = words.flatMap((w) => {
        const like = `%${w.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        return [like, like];
      });
      rows = this.db.query(`SELECT kind, ref, title, body, at FROM search_fts WHERE ${where} ORDER BY at DESC LIMIT ${limit}`).all(...args) as typeof rows;
    } else {
      const match = words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" AND ");
      rows = this.db.query(`SELECT kind, ref, title, body, at FROM search_fts WHERE search_fts MATCH ? ORDER BY at DESC LIMIT ${limit}`).all(match) as typeof rows;
    }
    return rows.map((r) => ({ kind: r.kind, ref: r.ref, title: r.title, snippet: snippet(r.body, words[0]), at: Number(r.at) }));
  }
}

/**
 * 検索結果の絞り込み。エージェント・プロジェクトは、分かるものだけが残る
 * （エージェント: 会話とタスク。プロジェクト: タスクとメモ）
 */
export function filterHits(
  hits: SearchHit[],
  f: { since: number; agent: string; project: string },
  look: { taskOf: (id: number) => { agent?: string | null; project?: string | null } | null; memoOf: (id: number) => { project?: string | null } | null },
): SearchHit[] {
  return hits.filter((h) => {
    if (f.since && h.at < f.since) return false;
    if (f.agent) {
      const who = h.kind === "session" ? h.ref.split("/")[0] : h.kind === "apptask" ? look.taskOf(Number(h.ref))?.agent : null;
      if (who !== f.agent) return false;
    }
    if (f.project) {
      const pj = h.kind === "apptask" ? look.taskOf(Number(h.ref))?.project : h.kind === "memo" ? look.memoOf(Number(h.ref))?.project : null;
      if (pj !== f.project) return false;
    }
    return true;
  });
}

function snippet(body: string, word: string, width = 60): string {
  const i = body.toLowerCase().indexOf(word.toLowerCase());
  if (i < 0) return body.slice(0, width * 2);
  const start = Math.max(0, i - width);
  return `${start > 0 ? "…" : ""}${body.slice(start, i + word.length + width)}${i + word.length + width < body.length ? "…" : ""}`;
}
