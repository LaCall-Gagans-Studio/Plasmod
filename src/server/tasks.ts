// タスク。メール・Beeper・ops から見回りが拾ったものは、まずここに「元の ID 付き」で登録する。
// ホームのカードは、BackLog（inbox）のタスクの見え方の1つ。判断はタスクに残るので、同じ元がまた来ても起こし直さない。
//
const KANBAN_ACTIVE = ["todo", "ready", "running", "scheduled"];
const KANBAN_GONE_GRACE_MS = 10 * 60_000;

// 状態（4つ）: inbox BackLog（＝カード）／todo やる（オーナー）／doing 任せ中（エージェントがカンバンで）／
//       done 完了（理由が不要なら done_reason = unneeded）。完了でも、同じ元に判断より新しい動きがあれば BackLog に戻る
//       （不要は、キーがぴったり同じときだけ。言い換え・似た題名では戻さない）
import type { Database } from "bun:sqlite";
import type { AppTaskLinks, AppTaskList, DevPr, TaskSummaryItem } from "../shared/types";
import { normalizeTags } from "./memos";
import { SearchIndex } from "./search";
import { type TaskStatus, type TaskDoneReason, TASK_STATUSES, LEGACY_DISMISSED, statusLabel, OPEN, type Task, type TaskEvent, TaskError, type TaskInput, type MirrorInput, GONE, type UpsertResult, NAME_RE, STATUS_LABEL, KINDS, clean, LOOSE_KEY_SOURCES, keyParts, sameLooseKey, titleScore, TITLE_WINDOW_MS, TAGS, OPEN_CHILDREN, type Row, toTask } from "./task-model";
import { config } from "./config";
import { localDay, tzOffsetMs } from "../shared/time";

export * from "./task-model";

export class TaskStore {
  /** アプリ全体の検索（/api/search）にも載せる。不要にしたものは外す */
  private search: SearchIndex;

  constructor(
    private db: Database,
    /** 番号の頭（TASK-123 の TASK） */
    private refPrefix = config.taskRefPrefix,
  ) {
    this.search = new SearchIndex(db);
    // プロジェクトはメモと共通（memo_projects）。メモより先に作られても困らないよう、ここでも用意する
    db.exec(`
      CREATE TABLE IF NOT EXISTS memo_projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        source_key TEXT,
        url TEXT,
        agent TEXT,
        propose TEXT NOT NULL DEFAULT '[]',
        project_id INTEGER REFERENCES memo_projects(id),
        due TEXT,
        created_by TEXT NOT NULL,
        kanban_id TEXT,
        event_at INTEGER,
        decided_at INTEGER,
        inbox_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_source ON tasks(source, source_key) WHERE source_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS tasks_kanban ON tasks(kanban_id);
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        at INTEGER NOT NULL,
        author TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id);
    `);
    // 前の取り込みの列。もう使わない
    const cols = (db.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("ext_updated_at")) db.exec("ALTER TABLE tasks ADD COLUMN ext_updated_at INTEGER");
    if (!cols.includes("ext_synced_at")) db.exec("ALTER TABLE tasks ADD COLUMN ext_synced_at INTEGER");
    // 切り替え: どのタスクにも番号（TASK-123）を付ける。
    if (!cols.includes("ref")) db.exec("ALTER TABLE tasks ADD COLUMN ref TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tasks_ref ON tasks(ref) WHERE ref IS NOT NULL");
    // 親子とつながり
    if (!cols.includes("parent_id")) db.exec("ALTER TABLE tasks ADD COLUMN parent_id INTEGER REFERENCES tasks(id)");
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_tags (
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        tag TEXT NOT NULL,
        PRIMARY KEY (task_id, tag)
      );
      CREATE INDEX IF NOT EXISTS task_tags_tag ON task_tags(tag);
      CREATE TABLE IF NOT EXISTS task_links (
        a INTEGER NOT NULL REFERENCES tasks(id),
        b INTEGER NOT NULL REFERENCES tasks(id),
        kind TEXT NOT NULL,
        PRIMARY KEY (a, b, kind)
      );
      -- 消したタスクの控え: 見回りが同じ元（source・key）をまた入れない／番号を使い回さない
      CREATE TABLE IF NOT EXISTS task_deleted (
        id INTEGER NOT NULL,
        ref TEXT,
        source TEXT NOT NULL,
        source_key TEXT,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_deleted_source ON task_deleted(source, source_key);
    `);
    // 2026-10-29: 返事待ちをやめた → 完了へ（元に新しい動きがあれば、これまでどおり BackLog に戻る）
    const waiting = db.query("SELECT id FROM tasks WHERE status = 'waiting'").all() as { id: number }[];
    for (const w of waiting) {
      const now = Date.now();
      db.query("UPDATE tasks SET status = 'done', decided_at = COALESCE(decided_at, ?), updated_at = ? WHERE id = ?").run(now, now, w.id);
      this.event(w.id, "decide", "app", "返事待ちから完了へ（状態を4つにしたため）", now);
    }
    // 2026-11-08: 「不要」を状態から Done の理由へ。#92 のころのカードの不要（状態は done、記録に「不要」）も合わせる
    if (!cols.includes("done_reason")) {
      db.exec("ALTER TABLE tasks ADD COLUMN done_reason TEXT");
      db.exec(`UPDATE tasks SET done_reason = 'unneeded' WHERE status = 'done' AND (
        (SELECT text FROM task_events e WHERE e.task_id = tasks.id AND e.kind = 'decide' ORDER BY e.at DESC, e.id DESC LIMIT 1) GLOB '不要*'
        OR (SELECT text FROM task_events e WHERE e.task_id = tasks.id AND e.kind = 'decide' ORDER BY e.at DESC, e.id DESC LIMIT 1) GLOB '返信不要*')`);
    }
    db.exec("UPDATE tasks SET status = 'done', done_reason = 'unneeded' WHERE status = 'dismissed'");
    // Done から出たら理由は消える（戻す処理が何か所もあるので、DB で揃える）
    db.exec(`CREATE TRIGGER IF NOT EXISTS tasks_done_reason AFTER UPDATE OF status ON tasks WHEN NEW.status != 'done' AND NEW.done_reason IS NOT NULL
      BEGIN UPDATE tasks SET done_reason = NULL WHERE id = NEW.id; END`);
    for (const t of this.list({ status: TASK_STATUSES, limit: 500 })) this.index(t);
  }

  private index(t: Task) {
    if (t.doneReason === "unneeded") return this.search.remove("apptask", String(t.id));
    const meta = [t.ref, t.project, t.due ? `期日 ${t.due}` : "", t.sourceKey ? `${t.source} ${t.sourceKey}` : t.source].filter(Boolean).join(" ");
    this.search.upsert("apptask", String(t.id), t.title, `${meta}\n${t.body}`, t.updatedAt);
  }

  /** 変えたあとに読み直して、索引も合わせる */
  private fresh(id: number): Task {
    const t = this.must(id);
    this.index(t);
    return t;
  }

  private row(where: string, ...args: (string | number)[]): Task | null {
    const r = this.db
      .query(`SELECT t.*, p.name AS project, ${TAGS}, ${OPEN_CHILDREN} FROM tasks t LEFT JOIN memo_projects p ON p.id = t.project_id WHERE ${where}`)
      .get(...args) as Row | null;
    return r ? toTask(r) : null;
  }

  get(id: number): Task | null {
    return this.row("t.id = ?", id);
  }

  byRef(ref: string): Task | null {
    return this.row("t.ref = ?", ref.toUpperCase());
  }

  /** 次の番号（今ある番号の最大＋1） */
  private nextRef(): string {
    const p = this.refPrefix;
    const r = this.db
      .query(`SELECT MAX(CAST(SUBSTR(ref, ?1) AS INTEGER)) AS m FROM (SELECT ref FROM tasks UNION ALL SELECT ref FROM task_deleted) WHERE ref LIKE ?2`)
      .get(p.length + 2, `${p}-%`) as { m: number | null };
    return `${p}-${(r.m ?? 0) + 1}`;
  }

  /** 元の ID がこちらの番号の形（TASK-123）ならそれ、そうでなければ続きの番号 */
  private refFor(source: string, key: string | null): string {
    return this.nextRef();
  }

  /** 番号の無いタスクに番号を付ける（切り替えの前に作られたもの）。付けた件数 */
  assignRefs(): number {
    const rows = this.db.query("SELECT id, source, source_key FROM tasks WHERE ref IS NULL ORDER BY id").all() as { id: number; source: string; source_key: string | null }[];
    for (const r of rows) {
      this.db.query("UPDATE tasks SET ref = ? WHERE id = ?").run(this.refFor(r.source, r.source_key), r.id);
      this.fresh(r.id);
    }
    return rows.length;
  }

  private must(id: number): Task {
    const t = this.get(id);
    if (!t) throw new TaskError("このタスクは無い", 404);
    return t;
  }

  bySource(source: string, key: string): Task | null {
    return this.row("t.source = ? AND t.source_key = ?", source, key);
  }

  /**
   * 見回りがキーを自分で考える元（ops）は、同じ件でも回ごとに揺れる（domain:x.com:icann-verification → domain:x.com:icann-verify → domain:x.com）。
   * ぴったりが無ければ、同じ元・同じ先頭の部分で、残りの単語がほぼ重なるもの（いちばん新しいもの）を同じ件とみなす
   */
  byLooseKey(source: string, key: string): Task | null {
    if (!LOOSE_KEY_SOURCES.has(source)) return null;
    const [head] = keyParts(key);
    const rows = this.db
      .query("SELECT id, source_key FROM tasks WHERE source = ? AND source_key LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 200")
      .all(source, `${head.replace(/[\\%_]/g, "\\$&")}:%`) as { id: number; source_key: string }[];
    const hit = rows.find((r) => sameLooseKey(r.source_key, key));
    return hit ? this.get(hit.id) : null;
  }

  /** キーで見つからないとき、題名がほぼ同じもの（直近 30 日・いちばん近いもの）を同じ件とみなす */
  byTitle(title: string, now = Date.now()): Task | null {
    const rows = this.db
      .query("SELECT id, title FROM tasks WHERE created_at >= ? ORDER BY updated_at DESC LIMIT 300")
      .all(now - TITLE_WINDOW_MS) as { id: number; title: string }[];
    let best: { id: number; score: number } | null = null;
    for (const r of rows) {
      const score = titleScore(title, r.title);
      if (score && (!best || score > best.score)) best = { id: r.id, score };
    }
    return best ? this.get(best.id) : null;
  }

  private projectId(name: string | null | undefined, now: number): number | null {
    const v = clean(name ?? "").slice(0, 60);
    if (!v) return null;
    this.db.query("INSERT INTO memo_projects (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING").run(v, now);
    return (this.db.query("SELECT id FROM memo_projects WHERE name = ?").get(v) as { id: number }).id;
  }

  private event(id: number, kind: TaskEvent["kind"], author: string, text: string, at: number) {
    this.db.query("INSERT INTO task_events (task_id, at, author, kind, text) VALUES (?, ?, ?, ?, ?)").run(id, at, author, kind, text.slice(0, 8000));
  }

  /** 入力を確かめて揃える */
  private normalize(i: TaskInput) {
    const source = clean(i.source ?? "").toLowerCase();
    if (!NAME_RE.test(source)) throw new TaskError("source は英小文字・数字・-_（例: mail, beeper, ops）", 400);
    const key = clean(i.key ?? "").slice(0, 300);
    if (!key) throw new TaskError("key（元の ID: メールのスレッド ID など）が要る", 400);
    const title = clean(i.title ?? "").slice(0, 200);
    if (!title) throw new TaskError("title が要る", 400);
    const agent = i.agent ? clean(i.agent).toLowerCase() : null;
    const due = i.due ? clean(i.due) : null;
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new TaskError("due は YYYY-MM-DD", 400);
    const url = i.url && /^https?:\/\/\S+$/.test(i.url.trim()) ? i.url.trim().slice(0, 1000) : null;
    return {
      source,
      key,
      title,
      body: (i.body ?? "").trim().slice(0, 20_000),
      kind: KINDS[clean(i.kind ?? "todo").toLowerCase()] ?? "todo",
      url,
      agent: agent && NAME_RE.test(agent) ? agent : null,
      propose: [...new Set((i.propose ?? []).map((p) => p.toLowerCase().trim()).filter((p): p is "kanban" | "task" => p === "kanban" || p === "task"))],
      project: i.project,
      due,
      eventAt: typeof i.eventAt === "number" && Number.isFinite(i.eventAt) ? Math.round(i.eventAt) : null,
      status: i.status === "todo" || i.status === "doing" ? i.status : ("inbox" as const),
    };
  }

  /**
   * 見回りからの登録。同じ元（source + key）は1件にまとめる:
   *   無い → 作る（inbox＝カードになる）
   *   開いている → 中身が変わっていれば書き換える（状態はそのまま）
   *   完了 → 元に判断より新しい動き（eventAt）があれば inbox に戻す。無ければ何もしない
   * キーで無ければ、ops の揺れたキー → 題名がほぼ同じもの、の順に同じ件を探す。
   * そうして見つけたものがカードで「不要」にした件なら、新しい動きがあっても開き直さない
   */
  upsert(input: TaskInput, author: string, now = Date.now()): UpsertResult {
    const v = this.normalize(input);
    return this.db.transaction((): UpsertResult => {
      const exact = this.bySource(v.source, v.key);
      // 消したタスクは返すものが無い（呼び出し側は ignored なら task を見ない。plasmod-task には null で返る）
      if (!exact && this.wasDeleted(v.source, v.key)) return { action: "ignored", reason: "オーナーが削除済み", task: null as unknown as Task };
      const cur = exact ?? this.byLooseKey(v.source, v.key) ?? this.byTitle(v.title, now);
      if (cur && !exact) {
        // 別のキーで来た同じ件。「不要」にしたものは、催促メールや言い換えでは開き直さない
        if (cur.doneReason === "unneeded")
          return { action: "ignored", reason: `「不要」にした ${cur.ref ?? `#${cur.id}`} と同じ件`, task: cur };
        const note = `同じ件が別の元からも来た（${v.source}: ${v.key}）`;
        if (!this.db.query("SELECT 1 FROM task_events WHERE task_id = ? AND text = ?").get(cur.id, note)) this.event(cur.id, "update", author, note, now);
      }
      if (!cur) {
        const r = this.db
          .query(
            `INSERT INTO tasks (ref, title, body, kind, status, source, source_key, url, agent, propose, project_id, due, created_by, event_at, inbox_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(this.refFor(v.source, v.key), v.title, v.body, v.kind, v.status, v.source, v.key, v.url, v.agent, JSON.stringify(v.propose), this.projectId(v.project, now), v.due, author, v.eventAt, now, now, now);
        const id = Number(r.lastInsertRowid);
        this.event(id, "create", author, `${v.source}: ${v.key}${v.status === "inbox" ? "" : `（${STATUS_LABEL[v.status]}で登録）`}`, now);
        return { action: "created", task: this.fresh(id) };
      }
      const newer = v.eventAt !== null && v.eventAt > (cur.decidedAt ?? cur.createdAt) && v.eventAt > (cur.eventAt ?? 0);
      if (cur.status === "done" && !newer) return { action: "ignored", reason: "完了（判断のあとに元の新しい動きが無い）", task: cur };
      const changed = v.title !== cur.title || v.body !== cur.body || v.url !== cur.url || v.due !== cur.due;
      // 完了したものは、元に新しい動きがあれば BackLog に戻す（返事が来た・催促が来た。オーナーの手が要るかもしれない）
      const reopen = cur.status === "done" && newer;
      if (!changed && !reopen && !(v.eventAt && v.eventAt > (cur.eventAt ?? 0))) return { action: "unchanged", task: cur };
      const at = Math.max(now, cur.updatedAt + 1);
      this.db
        .query(
          `UPDATE tasks SET title = ?, body = ?, url = ?, due = COALESCE(?, due), kind = ?, agent = COALESCE(?, agent), propose = ?,
             event_at = MAX(COALESCE(event_at, 0), COALESCE(?, 0)), status = ?, inbox_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(v.title, v.body, v.url, v.due, v.kind, v.agent, JSON.stringify(v.propose), v.eventAt, reopen ? "inbox" : cur.status, reopen ? at : cur.inboxAt, at, cur.id);
      this.event(cur.id, reopen ? "reopen" : "update", author, reopen ? "元に新しい動きがあったので、BackLog に戻した" : "見回りが中身を更新した", at);
      return { action: reopen ? "reopened" : "updated", task: this.fresh(cur.id) };
    })();
  }

  /**
   * カード（カンバン・承認依頼・メモ）を BackLog のタスクに写す。何度呼んでも同じ（変わったときだけ書く）。
   *   無い → BackLog で作る
   *   BackLog → 中身を合わせる（アプリのタスクから任せたものは、題・本文はアプリの方を残す）
   *   閉じている（不要も） → カードが判断より新しい（また止まった）か、元が消えて自動で閉じていたなら、BackLog に戻す
   *   削除済み → 戻さない（カードも出ない）
   * healthy の元（取得できている元）で、もうカードの無い BackLog のタスクは閉じる:
   *   カンバンにつながっているもの → 任せた（カンバンが進んだ）、ほか → 済み
   * 返すのはカードの key → タスク
   */
  mirror(items: MirrorInput[], healthy: Set<string>, now = Date.now()): Map<string, Task> {
    return this.db.transaction(() => {
      const out = new Map<string, Task>();
      const seen = new Set<number>();
      for (const i of items) {
        const linked = i.kanbanId ? this.row("t.kanban_id = ? AND t.done_reason IS NULL ORDER BY t.updated_at DESC", i.kanbanId) : null;
        let t = linked ?? this.bySource(i.source, i.key);
        if (!t && this.wasDeleted(i.source, i.key)) continue;
        const title = clean(i.title).slice(0, 200) || i.key;
        const body = i.body.trim().slice(0, 20_000);
        if (!t) {
          const r = this.db
            .query(
              `INSERT INTO tasks (ref, title, body, kind, status, source, source_key, url, agent, created_by, kanban_id, event_at, inbox_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'inbox', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
            )
            .run(this.nextRef(), title, body, i.kind, i.source, i.key, i.url ?? null, i.agent, i.kanbanId ?? null, i.createdAt, now, now, now);
          const id = Number(r.lastInsertRowid);
          this.event(id, "create", i.agent, i.reopenText, now);
          t = this.fresh(id);
        } else if (t.status === "inbox") {
          if (t.source === i.source && (t.title !== title || t.body !== body)) {
            this.db.query("UPDATE tasks SET title = ?, body = ?, updated_at = ? WHERE id = ?").run(title, body, Math.max(now, t.updatedAt + 1), t.id);
            t = this.fresh(t.id);
          }
        } else if (i.createdAt > (t.decidedAt ?? 0) || this.closedByGone(t.id)) {
          const at = Math.max(now, t.updatedAt + 1);
          const own = t.source === i.source;
          this.db
            .query(`UPDATE tasks SET status = 'inbox', inbox_at = ?, updated_at = ?${own ? ", title = ?, body = ?" : ""} WHERE id = ?`)
            .run(...((own ? [at, at, title, body, t.id] : [at, at, t.id]) as [number, number, ...(string | number)[]]));
          this.event(t.id, "reopen", i.agent, i.reopenText, at);
          t = this.fresh(t.id);
        }
        if (t.status !== "inbox") continue;
        seen.add(t.id);
        out.set(i.cardKey, t);
      }
      // もうカードの無い BackLog（元で片付いた）
      const rows = this.db.query("SELECT id, source, kanban_id FROM tasks WHERE status = 'inbox' AND (source IN ('kanban', 'perm', 'note') OR kanban_id IS NOT NULL)").all() as { id: number; source: string; kanban_id: string | null }[];
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        const from = r.kanban_id ? "kanban" : r.source;
        if (!healthy.has(from)) continue;
        const status: TaskStatus = r.kanban_id ? "doing" : "done";
        const at = now;
        this.db.query("UPDATE tasks SET status = ?, decided_at = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?").run(status, at, at, r.id);
        const text = r.kanban_id ? `カンバン ${r.kanban_id} が先に進んだ（カードは閉じた）` : r.source === "perm" ? "承認依頼が無くなった（開発エージェント側で片付いた・期限切れ）" : "元で片付いた";
        this.event(r.id, "decide", GONE, text, at);
        this.fresh(r.id);
      }
      return out;
    })();
  }

  /** 最後の判断が「元が消えて自動で閉じた」もの */
  private closedByGone(id: number): boolean {
    const e = this.db.query("SELECT author FROM task_events WHERE task_id = ? AND kind = 'decide' ORDER BY at DESC, id DESC LIMIT 1").get(id) as { author: string } | null;
    return e?.author === GONE;
  }

  /**
   * エージェント（plasmod-task）が状態を動かす。誰が登録したタスクでも動かせる。誰が動かしたかは記録に残る。
   * 計画の子を BackLog から外す・作業が終わったら完了・実態に合わせて直す、のため
   */
  setStatusBy(id: number, input: string, note: string, author: string, now = Date.now()): Task {
    const t = this.must(id);
    const reason: TaskDoneReason | null = input === LEGACY_DISMISSED ? "unneeded" : null;
    const status = (reason ? "done" : input) as TaskStatus;
    if (!TASK_STATUSES.includes(status)) throw new TaskError("状態は inbox・todo・doing・done", 400);
    if (t.status === status && t.doneReason === reason) return t;
    return this.decide(id, status, note, author, now, statusLabel(status, reason), reason);
  }

  /** オーナーの判断。note はタスクの記録に残す */
  decide(id: number, status: TaskStatus, note: string, author: string, now = Date.now(), label = "", doneReason: TaskDoneReason | null = null): Task {
    return this.db.transaction(() => {
      const cur = this.must(id);
      const at = Math.max(now, cur.updatedAt + 1);
      this.db.query("UPDATE tasks SET status = ?, done_reason = ?, decided_at = ?, updated_at = ? WHERE id = ?").run(status, status === "done" ? doneReason : null, at, at, id);
      this.event(id, "decide", author, [label || status, note.trim()].filter(Boolean).join(": "), at);
      return this.fresh(id);
    })();
  }

  /** エージェントに任せた（カンバンのカードにつないだ） */
  linkKanban(id: number, kanbanId: string, to: string, note: string, author: string, now = Date.now()): Task {
    return this.db.transaction(() => {
      const cur = this.must(id);
      const at = Math.max(now, cur.updatedAt + 1);
      this.db.query("UPDATE tasks SET status = 'doing', kanban_id = ?, decided_at = ?, updated_at = ? WHERE id = ?").run(kanbanId, at, at, id);
      this.event(id, "kanban", author, [`${to} に任せた（カンバン ${kanbanId}）`, note.trim()].filter(Boolean).join(": "), at);
      return this.fresh(id);
    })();
  }

  /** PR のマージなどで済みにする（開いているときだけ）。済みにしたら true */
  closeByRef(ref: string, text: string, author: string, now = Date.now()): boolean {
    const t = this.byRef(ref);
    if (!t || !OPEN.includes(t.status)) return false;
    this.decide(t.id, "done", text, author, now, "済み");
    return true;
  }

  /**
   * 繰り返しのルールが作る回。元（source + key）がぴったり同じものは1度しか作らない（消した回も作り直さない）。
   * upsert と違い、題名が近い別のタスクとは混ぜない（毎週同じ題名で来るため）。作ったら Todo（オーナーがやる）
   */
  spawn(input: { source: string; key: string; title: string; body: string; project: string | null; due: string; agent?: string | null }, author: string, now = Date.now()): Task | null {
    return this.db.transaction(() => {
      if (this.bySource(input.source, input.key) || this.wasDeleted(input.source, input.key)) return null;
      const r = this.db
        .query(
          `INSERT INTO tasks (ref, title, body, kind, status, source, source_key, project_id, due, agent, created_by, inbox_at, created_at, updated_at)
           VALUES (?, ?, ?, 'todo', 'todo', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(this.nextRef(), clean(input.title).slice(0, 200), input.body.slice(0, 20_000), input.source, input.key, this.projectId(input.project, now), input.due, input.agent ?? null, author, now, now, now);
      const id = Number(r.lastInsertRowid);
      this.event(id, "create", author, `繰り返しのルールから（期日 ${input.due}）`, now);
      return this.fresh(id);
    })();
  }

  /** 画面で足したタスク（元は app、key は無し）。既定は「オーナーがやる」 */
  create(input: { title: string; body?: string; project?: string | null; due?: string | null; status?: TaskStatus; parentId?: number | null; tags?: string[] }, author: string, now = Date.now()): Task {
    const title = clean(input.title ?? "").slice(0, 200);
    if (!title) throw new TaskError("題が要る", 400);
    const due = input.due ? clean(input.due) : null;
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new TaskError("期日は YYYY-MM-DD", 400);
    const status = input.status && TASK_STATUSES.includes(input.status) ? input.status : "todo";
    return this.db.transaction(() => {
      const r = this.db
        .query(
          `INSERT INTO tasks (ref, title, body, kind, status, source, source_key, project_id, due, created_by, inbox_at, created_at, updated_at)
           VALUES (?, ?, ?, 'todo', ?, 'app', NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .run(this.nextRef(), title, (input.body ?? "").slice(0, 20_000), status, this.projectId(input.project, now), due, author, now, now, now);
      const id = Number(r.lastInsertRowid);
      this.event(id, "create", author, "画面で追加", now);
      if (input.tags?.length) this.setTags(id, normalizeTags(input.tags));
      if (input.parentId) {
        const parent = this.must(input.parentId);
        this.db.query("UPDATE tasks SET parent_id = ? WHERE id = ?").run(parent.id, id);
        // 親のプロジェクトを引き継ぐ（指定が無ければ）
        if (!input.project && parent.project) this.db.query("UPDATE tasks SET project_id = (SELECT id FROM memo_projects WHERE name = ?) WHERE id = ?").run(parent.project, id);
      }
      return this.fresh(id);
    })();
  }

  /**
   * 画面からの書き換え（題・本文・プロジェクト・期日・状態）。渡したものだけ変わる。
   * baseUpdatedAt を渡すと、その後にほか（見回り・別の端末）が変えていたら 409
   */
  update(
    id: number,
    patch: { title?: string; body?: string; project?: string | null; due?: string | null; status?: TaskStatus; doneReason?: TaskDoneReason | null; tags?: string[]; note?: string; baseUpdatedAt?: number },
    author: string,
    now = Date.now(),
  ): Task {
    return this.db.transaction(() => {
      const cur = this.must(id);
      if (patch.baseUpdatedAt !== undefined && patch.baseUpdatedAt !== cur.updatedAt) throw new TaskError("ほかで書き換えられています。開き直してください", 409);
      const title = patch.title !== undefined ? clean(patch.title).slice(0, 200) : cur.title;
      if (!title) throw new TaskError("題が要る", 400);
      const due = patch.due !== undefined ? (patch.due ? clean(patch.due) : null) : cur.due;
      if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new TaskError("期日は YYYY-MM-DD", 400);
      const body = patch.body !== undefined ? patch.body.slice(0, 20_000) : cur.body;
      const project = patch.project !== undefined ? clean(patch.project ?? "") || null : cur.project;
      const status = patch.status && TASK_STATUSES.includes(patch.status) ? patch.status : cur.status;
      // 理由は Done のときだけ。指定が無ければ、Done のままなら今の理由を残す
      const doneReason = status !== "done" ? null : patch.doneReason !== undefined ? patch.doneReason : cur.status === "done" ? cur.doneReason : null;
      const changed: string[] = [];
      if (title !== cur.title) changed.push("題");
      if (body !== cur.body) changed.push("本文");
      if (project !== cur.project) changed.push(`プロジェクト → ${project ?? "なし"}`);
      if (due !== cur.due) changed.push(`期日 → ${due ?? "なし"}`);
      const tags = patch.tags !== undefined ? normalizeTags(patch.tags) : cur.tags;
      if (tags.join("\n") !== cur.tags.join("\n")) changed.push(`タグ → ${tags.length ? tags.map((t) => `#${t}`).join(" ") : "なし"}`);
      const statusChanged = status !== cur.status || doneReason !== cur.doneReason;
      if (!changed.length && !statusChanged && !patch.note?.trim()) return cur;
      const at = Math.max(now, cur.updatedAt + 1);
      this.db
        .query(
          `UPDATE tasks SET title = ?, body = ?, project_id = ?, due = ?, status = ?, done_reason = ?, updated_at = ?,
             decided_at = CASE WHEN ? THEN ? ELSE decided_at END, inbox_at = CASE WHEN ? = 'inbox' AND status != 'inbox' THEN ? ELSE inbox_at END WHERE id = ?`,
        )
        .run(title, body, this.projectId(project, at), due, status, doneReason, at, statusChanged ? 1 : 0, at, status, at, id);
      if (patch.tags !== undefined) this.setTags(id, tags);
      if (changed.length) this.event(id, "update", author, changed.join("・"), at);
      if (statusChanged || patch.note?.trim()) this.event(id, "decide", author, [statusChanged ? statusLabel(status, doneReason) : "", patch.note?.trim() ?? ""].filter(Boolean).join(": "), at);
      return this.fresh(id);
    })();
  }

  private setTags(id: number, tags: string[]) {
    this.db.query("DELETE FROM task_tags WHERE task_id = ?").run(id);
    const ins = this.db.query("INSERT OR IGNORE INTO task_tags (task_id, tag) VALUES (?, ?)");
    for (const t of tags) ins.run(id, t);
  }

  comment(id: number, text: string, author: string, now = Date.now()): Task {
    const t = text.trim();
    if (!t) throw new TaskError("コメントが空", 400);
    this.must(id);
    this.event(id, "comment", author, t, now);
    return this.must(id);
  }

  /**
   * タスクを正本にして、カンバンの動きを写す（読めたカンバンの一覧を渡す）:
   *   進行中でタスクの無いカード → AI-Driven のタスクを作る（止まったカードは mirror が BackLog で作る）
   *   カードが完了 → つないだタスクも Done
   *   カードが一覧から消えた（アーカイブ・古い完了） → つないだタスクも Done
   */
  syncKanban(board: { id: string; title?: string; body?: string | null; status: string; assignee?: string | null; created_by?: string | null; result?: string | null }[], now = Date.now(), ownerAssignees: string[] = []): number {
    return this.db.transaction(() => {
      let n = 0;
      const known = new Set((this.db.query("SELECT kanban_id FROM tasks WHERE kanban_id IS NOT NULL").all() as { kanban_id: string }[]).map((r) => r.kanban_id));
      for (const b of board) {
        if (known.has(b.id) || !KANBAN_ACTIVE.includes(b.status) || !b.title) continue;
        if ((b.assignee && ownerAssignees.includes(b.assignee.toLowerCase())) || this.wasDeleted("kanban", b.id) || this.bySource("kanban", b.id)) continue;
        const r = this.db
          .query(
            `INSERT INTO tasks (ref, title, body, kind, status, source, source_key, agent, created_by, kanban_id, inbox_at, created_at, updated_at)
             VALUES (?, ?, ?, 'todo', 'doing', 'kanban', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(this.nextRef(), clean(b.title).slice(0, 200) || b.id, (b.body ?? "").trim().slice(0, 20_000), b.id, b.assignee ?? null, b.created_by || "kanban", b.id, now, now, now);
        const id = Number(r.lastInsertRowid);
        this.event(id, "create", "kanban", `カンバン ${b.id} の作業を写した`, now);
        this.fresh(id);
        n++;
      }
      const onBoard = new Map(board.map((b) => [b.id, b]));
      const rows = this.db.query("SELECT id, kanban_id, updated_at FROM tasks WHERE status = 'doing' AND kanban_id IS NOT NULL").all() as { id: number; kanban_id: string; updated_at: number }[];
      for (const r of rows) {
        const card = onBoard.get(r.kanban_id);
        // 任せた直後は、読み始めが作成より前の一覧に載っていないことがある
        const gone = !card && now - r.updated_at > KANBAN_GONE_GRACE_MS;
        if (card?.status !== "done" && card?.status !== "archived" && !gone) continue;
        const text = card?.status === "done" ? `カンバン ${r.kanban_id} が完了${card.result ? `: ${card.result.slice(0, 2000)}` : ""}` : `カンバン ${r.kanban_id} が片付いた（アーカイブなど）`;
        this.db.query("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?").run(now, r.id);
        this.event(r.id, "done", "kanban", text, now);
        this.fresh(r.id);
        n++;
      }
      return n;
    })();
  }

  /** カンバンのカードにつながるタスク（カード画面からタスクへ戻るため） */
  byKanban(kanbanId: string): Task | null {
    return this.row("t.kanban_id = ? ORDER BY t.updated_at DESC", kanbanId);
  }

  events(id: number): TaskEvent[] {
    this.must(id);
    return this.db.query("SELECT id, at, author, kind, text FROM task_events WHERE task_id = ? ORDER BY at DESC, id DESC").all(id) as TaskEvent[];
  }

  /**
   * レポート用: 今日（期限が今日まで・期限切れ）、今週（明日〜日曜）、進行中（任せた・期限なし）、今週終えた（月曜から）、
   * 自分のタスク（Todo 全件。期限のあるものを期限順に、続けて期限なしを長く動いていない順に）。
   * 日付はアプリのタイムゾーン（id は番号、url はタスクの画面）
   */
  summary(now = Date.now()): { today: TaskSummaryItem[]; week: TaskSummaryItem[]; doing: TaskSummaryItem[]; done: TaskSummaryItem[]; mine: TaskSummaryItem[] } {
    const off = tzOffsetMs(now);
    const j = new Date(now + off);
    const today = j.toISOString().slice(0, 10);
    const dow = (j.getUTCDay() + 6) % 7;
    const monday = Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate() - dow);
    const weekEnd = new Date(monday + 6 * 86_400_000).toISOString().slice(0, 10);
    const weekStartMs = monday - off;
    const row = (t: Task, due: string | null): TaskSummaryItem => ({
      id: t.ref ?? `#${t.id}`,
      title: t.title,
      url: `#/todo/${t.id}`,
      state: STATUS_LABEL[t.status],
      due,
      ...(due && t.status !== "done" && due < today ? { overdue: true } : {}),
    });
    const open = this.list({ status: ["inbox", "todo", "doing"], limit: 500 });
    const byDue = (a: TaskSummaryItem, b: TaskSummaryItem) => (a.due ?? "9").localeCompare(b.due ?? "9");
    const done = (
      this.db
        .query(`SELECT t.*, p.name AS project, ${TAGS} FROM tasks t LEFT JOIN memo_projects p ON p.id = t.project_id WHERE t.status = 'done' AND t.decided_at >= ? ORDER BY t.decided_at DESC`)
        .all(weekStartMs) as Row[]
    ).map(toTask);
    return {
      today: open.filter((t) => t.due && t.due <= today).map((t) => row(t, t.due)).sort(byDue),
      week: open.filter((t) => t.due && t.due > today && t.due <= weekEnd).map((t) => row(t, t.due)).sort(byDue),
      doing: open.filter((t) => !t.due && t.status === "doing").map((t) => row(t, null)),
      done: done.map((t) => row(t, localDay(t.decidedAt ?? t.updatedAt))),
      mine: open
        .filter((t) => t.status === "todo")
        .sort((a, b) => (a.due ?? "9").localeCompare(b.due ?? "9") || a.updatedAt - b.updatedAt)
        .map((t) => ({ ...row(t, t.due), project: t.project, idleDays: Math.max(0, Math.floor((now - t.updatedAt) / 86_400_000)) })),
    };
  }

  /**
   * 開いている PR を Todo のタスクに写す（下書きはレビューできるようになるまで作らない）。変わったら true。
   *   無い → Todo で作る／開いている → 題名だけ合わせる（本文はオーナーが書き足すので触らない）
   *   オーナーが閉じた・消したもの → 戻さない
   * complete のときだけ、開いている一覧に無くなった PR のタスクを完了にする（マージ・クローズ）
   */
  syncPrs(prs: DevPr[], complete: boolean, now = Date.now()): boolean {
    return this.db.transaction(() => {
      let changed = false;
      const open = new Set<string>();
      for (const p of prs) {
        const key = `${p.repo}#${p.number}`;
        open.add(key);
        const title = `${p.repo.split("/")[1]} #${p.number} ${p.title}`.slice(0, 300);
        const cur = this.bySource("github", key);
        if (!cur) {
          if (p.draft || this.wasDeleted("github", key)) continue;
          const r = this.db
            .query(
              `INSERT INTO tasks (ref, title, body, kind, status, source, source_key, url, created_by, inbox_at, created_at, updated_at)
               VALUES (?, ?, ?, 'todo', 'todo', 'github', ?, ?, 'github', ?, ?, ?)`,
            )
            .run(this.refFor("github", key), title, p.summary, key, p.url, now, now, now);
          const id = Number(r.lastInsertRowid);
          this.event(id, "create", "github", `PR ${key}`, now);
          this.fresh(id);
          changed = true;
        } else if (cur.title !== title && cur.status !== "done") {
          this.db.query("UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?").run(title, Math.max(now, cur.updatedAt + 1), cur.id);
          this.fresh(cur.id);
          changed = true;
        }
      }
      if (!complete) return changed;
      const rows = this.db.query("SELECT id, source_key AS k, updated_at AS u FROM tasks WHERE source = 'github' AND status IN ('inbox','todo','doing')").all() as { id: number; k: string; u: number }[];
      for (const r of rows) {
        if (open.has(r.k)) continue;
        const at = Math.max(now, r.u + 1);
        this.db.query("UPDATE tasks SET status = 'done', decided_at = ?, updated_at = ? WHERE id = ?").run(at, at, r.id);
        this.event(r.id, "done", "github", "PR が閉じた（マージまたはクローズ）", at);
        this.fresh(r.id);
        changed = true;
      }
      return changed;
    })();
  }

  /** 親を付ける・外す（自分や自分の子孫は親にできない） */
  setParent(id: number, parentId: number | null, author: string, now = Date.now()): Task {
    const cur = this.must(id);
    if (parentId !== null) {
      const parent = this.must(parentId);
      for (let p: Task | null = parent; p; p = p.parentId ? this.get(p.parentId) : null)
        if (p.id === id) throw new TaskError("自分の子孫を親にはできない", 400);
      if (cur.parentId === parentId) return cur;
    } else if (cur.parentId === null) return cur;
    const at = Math.max(now, cur.updatedAt + 1);
    this.db.query("UPDATE tasks SET parent_id = ?, updated_at = ? WHERE id = ?").run(parentId, at, id);
    const p = parentId ? this.get(parentId) : null;
    this.event(id, "update", author, p ? `親を ${p.ref ?? `#${p.id}`} にした` : "親を外した", at);
    return this.fresh(id);
  }

  /** つながりを足す・外す。kind: blocks（a が b を止めている）／related（向きなし） */
  link(a: number, b: number, kind: "blocks" | "related", on: boolean, author: string, now = Date.now()) {
    if (a === b) throw new TaskError("同じタスクはつなげない", 400);
    const ta = this.must(a);
    const tb = this.must(b);
    const [x, y] = kind === "related" && a > b ? [b, a] : [a, b];
    if (on) this.db.query("INSERT OR IGNORE INTO task_links (a, b, kind) VALUES (?, ?, ?)").run(x, y, kind);
    else this.db.query("DELETE FROM task_links WHERE a = ? AND b = ? AND kind = ?").run(x, y, kind);
    const label = kind === "blocks" ? "止めている" : "関連";
    this.event(a, "update", author, `${tb.ref ?? `#${b}`} を${label}${on ? "に足した" : "から外した"}`, now);
    this.event(b, "update", author, `${ta.ref ?? `#${a}`} と${on ? "つながった" : "のつながりを外した"}（${label}）`, now);
  }

  private wasDeleted(source: string, key: string | null): boolean {
    return !!key && !!this.db.query("SELECT 1 FROM task_deleted WHERE source = ? AND source_key = ?").get(source, key);
  }

  /**
   * タスクを消す（長押しのメニューから）。記録・タグ・つながりも消し、サブタスクは1つ上の親に付け替える。
   * 控え（task_deleted）を残すので、見回りが同じ元から入れ直したり、番号が使い回されたりはしない
   */
  remove(id: number, author: string, now = Date.now()): void {
    const t = this.must(id);
    this.db.transaction(() => {
      this.db.query("UPDATE tasks SET parent_id = ? WHERE parent_id = ?").run(t.parentId, id);
      this.db.query("DELETE FROM task_tags WHERE task_id = ?").run(id);
      this.db.query("DELETE FROM task_links WHERE a = ?1 OR b = ?1").run(id);
      this.db.query("DELETE FROM task_events WHERE task_id = ?").run(id);
      this.db.query("DELETE FROM tasks WHERE id = ?").run(id);
      this.db.query("INSERT INTO task_deleted (id, ref, source, source_key, title, author, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, t.ref, t.source, t.sourceKey, t.title, author, now);
    })();
    this.search.remove("apptask", String(id));
  }

  links(id: number): AppTaskLinks {
    const t = this.must(id);
    const q = (sql: string) => (this.db.query(`SELECT t.*, p.name AS project, ${TAGS}, ${OPEN_CHILDREN} FROM tasks t LEFT JOIN memo_projects p ON p.id = t.project_id WHERE ${sql}`).all(id) as Row[]).map(toTask);
    return {
      parent: t.parentId ? this.get(t.parentId) : null,
      // 子は一覧の中でも開くので、孫の数（openChildren）も付く
      children: q("t.parent_id = ? ORDER BY CASE WHEN t.status = 'done' THEN 1 ELSE 0 END, t.due IS NULL, t.due, t.id"),
      blocks: q("t.id IN (SELECT b FROM task_links WHERE a = ? AND kind = 'blocks')"),
      blockedBy: q("t.id IN (SELECT a FROM task_links WHERE b = ? AND kind = 'blocks')"),
      related: (this.db
        .query(
          `SELECT t.*, p.name AS project, ${TAGS} FROM tasks t LEFT JOIN memo_projects p ON p.id = t.project_id
           WHERE t.id IN (SELECT b FROM task_links WHERE a = ?1 AND kind = 'related' UNION SELECT a FROM task_links WHERE b = ?1 AND kind = 'related')`,
        )
        .all(id) as Row[]).map(toTask),
    };
  }

  /** 開いている子の数（一覧で「サブ n」と出す） */
  openChildCounts(): Map<number, number> {
    const rows = this.db.query("SELECT parent_id AS p, COUNT(*) AS n FROM tasks WHERE parent_id IS NOT NULL AND status IN ('inbox','todo','doing') GROUP BY parent_id").all() as { p: number; n: number }[];
    return new Map(rows.map((r) => [r.p, r.n]));
  }

  /** BackLog（カードにするもの） */
  inbox(): Task[] {
    return (this.db.query(`SELECT t.*, p.name AS project, ${TAGS} FROM tasks t LEFT JOIN memo_projects p ON p.id = t.project_id WHERE t.status = 'inbox' ORDER BY t.inbox_at`).all() as Row[]).map(toTask);
  }

  /** 状態の絞り込み以外（プロジェクト・元・語）の条件 */
  private filters(opts: { source?: string; q?: string; project?: string | null; tag?: string | null; hideDoneApprovals?: boolean; dueFrom?: string; dueTo?: string }) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    // 片付いた承認依頼は記録なので、Done の一覧では既定で見せない（まだカードの承認依頼は残す）
    if (opts.hideDoneApprovals) where.push("NOT (t.source = 'perm' AND t.status = 'done')");
    if (opts.tag) {
      where.push("EXISTS (SELECT 1 FROM task_tags x WHERE x.task_id = t.id AND x.tag = ?)");
      args.push(opts.tag);
    }
    if (opts.project === "") where.push("t.project_id IS NULL");
    else if (opts.project) {
      where.push("p.name = ?");
      args.push(opts.project);
    }
    // 期日の範囲（カレンダー用。YYYY-MM-DD の両端を含む）
    if (opts.dueFrom) {
      where.push("t.due >= ?");
      args.push(opts.dueFrom);
    }
    if (opts.dueTo) {
      where.push("t.due <= ?");
      args.push(opts.dueTo);
    }
    if (opts.source) {
      where.push("t.source = ?");
      args.push(opts.source);
    }
    for (const w of clean(opts.q ?? "").split(" ").filter(Boolean).slice(0, 8)) {
      const like = `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(t.title LIKE ? ESCAPE '\\' OR t.body LIKE ? ESCAPE '\\' OR t.source_key LIKE ? ESCAPE '\\')");
      args.push(like, like, like);
    }
    return { where, args };
  }

  list(opts: { status?: (TaskStatus | typeof LEGACY_DISMISSED)[]; source?: string; q?: string; project?: string | null; tag?: string | null; hideDoneApprovals?: boolean; dueFrom?: string; dueTo?: string; limit?: number } = {}): Task[] {
    const { where, args } = this.filters(opts);
    const wanted = opts.status ?? OPEN;
    const statuses = wanted.filter((s): s is TaskStatus => (TASK_STATUSES as string[]).includes(s));
    // dismissed だけ指定されたら、Done のうち理由が不要のもの（plasmod-task の --status dismissed）
    const unneeded = wanted.includes(LEGACY_DISMISSED) ? " OR (t.status = 'done' AND t.done_reason = 'unneeded')" : "";
    where.unshift(`(t.status IN (${statuses.map(() => "?").join(",") || "''"})${unneeded})`);
    args.unshift(...statuses);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    return (
      this.db
        .query(
          `SELECT t.*, p.name AS project, ${TAGS}, ${OPEN_CHILDREN} FROM tasks t LEFT JOIN memo_projects p ON p.id = t.project_id WHERE ${where.join(" AND ")}
           ORDER BY CASE WHEN t.due IS NULL THEN 1 ELSE 0 END, t.due, t.updated_at DESC LIMIT ${limit}`,
        )
        .all(...args) as Row[]
    ).map(toTask);
  }

  /** 画面の一覧: タスクと、状態ごとの件数・プロジェクトごとの件数（開いているもの） */
  view(opts: { status?: TaskStatus[]; q?: string; project?: string | null; tag?: string | null; hideDoneApprovals?: boolean; dueFrom?: string; dueTo?: string }): AppTaskList {
    // 期日の範囲を指定したとき（カレンダー）は、その範囲のものを多めに返す。件数の集計は範囲に関係なく出す
    const tasks = this.list({ ...opts, limit: opts.dueFrom || opts.dueTo ? 500 : 300 });
    const { where, args } = this.filters({ q: opts.q, project: opts.project, tag: opts.tag, hideDoneApprovals: opts.hideDoneApprovals });
    const rows = this.db
      .query(`SELECT t.status AS status, COUNT(*) AS n FROM tasks t LEFT JOIN memo_projects p ON p.id = t.project_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} GROUP BY t.status`)
      .all(...args) as { status: TaskStatus; n: number }[];
    const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
    for (const r of rows) counts[r.status] = r.n;
    const projects = this.db
      .query(
        `SELECT p.name AS name, COUNT(*) AS count FROM tasks t JOIN memo_projects p ON p.id = t.project_id
         WHERE t.status IN ('inbox','todo','doing') GROUP BY p.id ORDER BY count DESC, name`,
      )
      .all() as { name: string; count: number }[];
    return { tasks, counts, projects };
  }
}
