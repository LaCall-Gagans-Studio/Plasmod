// Hermes のカンバンへの窓口。本番は hermes ユーザーの仲介（broker）を sudo で呼ぶ。
import { readFile } from "node:fs/promises";
import type { Board, KanbanComment, TaskDetail } from "../shared/types";

export interface KanbanSource {
  board(): Promise<Board>;
  /** since より新しいイベントがあるか（最新のイベント ID を返す） */
  latestEventId(): Promise<number>;
  comment(taskId: string, body: string): Promise<void>;
  unblock(taskId: string): Promise<void>;
  complete(taskId: string, result: string): Promise<void>;
  /** アーカイブ（triage・todo など、完了にできない状態のカードを片付ける） */
  archive(taskId: string): Promise<void>;
  /** triage（仕分け待ち）のカードの担当を決めて todo に戻す */
  specify(taskId: string, assignee: string): Promise<void>;
  requestChanges(taskId: string, reason: string): Promise<void>;
  /** カードを作って ID を返す */
  create(title: string, body: string, assignee: string): Promise<string>;
  attach(taskId: string, name: string, data: Uint8Array): Promise<void>;
  /** カードの詳細（コメント・イベント・実行・親子・添付の一覧） */
  task(taskId: string): Promise<TaskDetail>;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function checkTaskId(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`不正なカードID: ${id}`);
  return id;
}

export class BrokerSource implements KanbanSource {
  constructor(private cmd: string[]) {}

  private async run(...args: string[]): Promise<string> {
    return this.runWith(null, ...args);
  }

  /** ファイルをそのまま受ける（media-read） */
  async readFile(path: string): Promise<Uint8Array> {
    const p = Bun.spawn([...this.cmd, "media-read", path], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(err.trim().slice(-300) || `broker media-read failed (${code})`);
    return new Uint8Array(out);
  }

  private async runWith(stdin: Uint8Array | null, ...args: string[]): Promise<string> {
    const p = Bun.spawn([...this.cmd, ...args], { stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
    // 仲介が終わらないと画面が「読み込み中」のまま残るので、90 秒で止めてエラーにする
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      p.kill();
    }, 90_000);
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]).finally(() => clearTimeout(timer));
    if (late) throw new Error(`仲介（${args[0]}）が 90 秒で終わらなかった`);
    if (code !== 0) throw new Error((err || out).trim().slice(-500) || `broker ${args[0]} failed (${code})`);
    return out;
  }

  /** システム画面（usage / models / set-model / fs-list / fs-read）用 */
  call = (...args: string[]) => this.run(...args);

  async board(): Promise<Board> {
    return { ...(JSON.parse(await this.run("board")) as Omit<Board, "fetched_at">), fetched_at: Date.now() };
  }

  async latestEventId(): Promise<number> {
    return Number((await this.run("latest-event")).trim());
  }

  async comment(taskId: string, body: string) {
    await this.run("comment", checkTaskId(taskId), body.slice(0, 8000));
  }

  async unblock(taskId: string) {
    await this.run("unblock", checkTaskId(taskId));
  }

  async complete(taskId: string, result: string) {
    await this.run("complete", checkTaskId(taskId), result.slice(0, 8000));
  }

  async requestChanges(taskId: string, reason: string) {
    await this.run("request-changes", checkTaskId(taskId), reason.slice(0, 4000));
  }

  async archive(taskId: string) {
    await this.run("archive", checkTaskId(taskId));
  }

  async specify(taskId: string, assignee: string) {
    await this.run("specify", checkTaskId(taskId), assignee);
  }

  async create(title: string, body: string, assignee: string): Promise<string> {
    return checkTaskId((await this.run("create", title.slice(0, 200), body.slice(0, 8000), assignee)).trim());
  }

  async attach(taskId: string, name: string, data: Uint8Array) {
    await this.runWith(data, "attach", checkTaskId(taskId), name);
  }

  async task(taskId: string): Promise<TaskDetail> {
    return JSON.parse(await this.run("task", checkTaskId(taskId))) as TaskDetail;
  }

  /** Hermes のエージェントに渡すファイルを仲介が置き、置いたパスを返す（1ファイルずつ） */
  async putFiles(files: { name: string; data: Uint8Array }[]): Promise<string[]> {
    const out: string[] = [];
    for (const f of files) out.push((await this.runWith(f.data, "put-file", f.name)).trim());
    return out;
  }
}

/** 開発用。fixtures/board.json を読み、書き込みはメモリ上で反映する。 */
export class FixtureSource implements KanbanSource {
  private cache: Board | null = null;
  private eventId = 0;
  private comments = new Map<string, KanbanComment[]>();
  readonly log: string[] = [];

  constructor(private path: string) {}

  private async load(): Promise<Board> {
    if (!this.cache) {
      this.cache = JSON.parse(await readFile(this.path, "utf8")) as Board;
      this.eventId = this.cache.latest_event_id;
    }
    return this.cache;
  }

  async board() {
    const b = await this.load();
    return { ...b, latest_event_id: this.eventId, fetched_at: Date.now() };
  }

  async latestEventId() {
    await this.load();
    return this.eventId;
  }

  private async touch(taskId: string, fn: (t: Board["tasks"][number]) => void) {
    const b = await this.load();
    const t = b.tasks.find((x) => x.id === checkTaskId(taskId));
    if (!t) throw new Error(`${taskId} が無い`);
    fn(t);
    this.eventId += 1;
  }

  async comment(taskId: string, body: string) {
    this.log.push(`comment ${taskId} ${body}`);
    await this.touch(taskId, (t) => {
      const c = { author: "owner", body, created_at: Math.floor(Date.now() / 1000) };
      this.comments.set(t.id, [...(this.comments.get(t.id) ?? (t.latest_comment ? [t.latest_comment] : [])), c]);
      t.latest_comment = c;
    });
  }

  async unblock(taskId: string) {
    this.log.push(`unblock ${taskId}`);
    await this.touch(taskId, (t) => {
      t.status = "ready";
      t.block_kind = null;
    });
  }

  async requestChanges(taskId: string, reason: string) {
    this.log.push(`request-changes ${taskId} ${reason}`);
    await this.touch(taskId, (t) => {
      t.status = "ready";
    });
  }

  async create(title: string, body: string, assignee: string): Promise<string> {
    const b = await this.load();
    const id = `t_fx${b.tasks.length + 1}`;
    const now = Math.floor(Date.now() / 1000);
    b.tasks.push({
      id, title, body, assignee, status: "ready", priority: 0, created_by: "owner", created_at: now, started_at: null,
      completed_at: null, last_heartbeat_at: null, block_kind: null, result: null, latest_comment: null,
    });
    this.eventId += 1;
    this.log.push(`create ${id} ${assignee} ${title}`);
    return id;
  }

  async attach(taskId: string, name: string, data: Uint8Array) {
    this.log.push(`attach ${taskId} ${name} ${data.length}`);
  }

  async task(taskId: string): Promise<TaskDetail> {
    const b = await this.load();
    const t = b.tasks.find((x) => x.id === checkTaskId(taskId));
    if (!t) throw new Error(`${taskId} が無い`);
    const ref = (id: string) => {
      const x = b.tasks.find((y) => y.id === id);
      return { id, title: x?.title ?? id, status: x?.status ?? null, assignee: x?.assignee ?? null };
    };
    const { latest_comment, last_heartbeat_at: _h, block_kind: _b, ...task } = t;
    return {
      task,
      latest_summary: t.result,
      comments: this.comments.get(t.id) ?? (latest_comment ? [latest_comment] : []),
      events: [{ kind: "created", created_at: t.created_at, run_id: null, detail: null }],
      runs: b.active_runs.filter((r) => r.task_id === t.id).map((r, i) => ({ id: i + 1, profile: r.profile, status: "running", outcome: null, summary: null, error: null, started_at: r.started_at, ended_at: null })),
      parents: b.links.filter((l) => l.child_id === t.id).map((l) => ref(l.parent_id)),
      children: b.links.filter((l) => l.parent_id === t.id).map((l) => ref(l.child_id)),
      attachments: [],
    };
  }

  async archive(taskId: string) {
    this.log.push(`archive ${taskId}`);
    await this.touch(taskId, (t) => {
      t.status = "archived";
    });
  }

  async specify(taskId: string, assignee: string) {
    this.log.push(`specify ${taskId} ${assignee}`);
    await this.touch(taskId, (t) => {
      if (t.status !== "triage") throw new Error("仕分けられなかった（もう仕分け待ちではないかもしれない）");
      t.status = "todo";
      t.assignee = assignee;
    });
  }

  async complete(taskId: string, result: string) {
    this.log.push(`complete ${taskId} ${result}`);
    await this.touch(taskId, (t) => {
      t.status = "done";
      t.result = result;
      t.completed_at = Math.floor(Date.now() / 1000);
    });
  }
}
