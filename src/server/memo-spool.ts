// AI（開発エージェント・ハブたち）からメモを読み書きする窓口。鍵を増やさないために、受け渡しはファイルで行い、
// 「誰が書いたか」は依頼ファイルの持ち主（OS のユーザー）で決める。持ち主はカーネルが付けるので偽れない。
//
//   <dir>/in/<id>.json   依頼。エージェントが書く（in は 1733: 誰でも置けるが一覧は見られない。知らないユーザーの依頼は捨てる）
//   <dir>/out/<id>.json  返事。アプリが書く（out は 0711: 一覧は見られず、名前＝依頼のランダムな id を知っている人だけ読める）。2分で消す
//
// できるのは 読む・探す・作る・書き換える・追記する まで。アーカイブ（消す）は画面から、オーナーだけ。
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HabitStore } from "./habits";
import { MergeError, type MergeDesk } from "./merge";
import { MemoError, type MemoStore } from "./memos";
import { TASK_STATUSES, TaskError, type TaskStatus, type TaskStore } from "./tasks";

const ID_RE = /^[0-9a-f-]{8,64}$/;
const AS_RE = /^[a-z0-9_-]{1,32}$/;
const MAX_REQUEST = 512 * 1024;
const OUT_TTL_MS = 120_000;

/** /etc/passwd の中身と「user=名前,…」から、uid → エージェント名 */
export function agentUids(spec: string, passwd: string): Map<number, string> {
  const uids = new Map<string, number>();
  for (const line of passwd.split("\n")) {
    const f = line.split(":");
    if (f.length >= 3 && /^\d+$/.test(f[2])) uids.set(f[0], Number(f[2]));
  }
  const out = new Map<number, string>();
  for (const pair of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [user, name] = pair.split("=").map((s) => s.trim());
    const uid = uids.get(user);
    if (uid !== undefined && uid !== 0 && name && AS_RE.test(name)) out.set(uid, name);
  }
  return out;
}

type Req = { op?: unknown; args?: Record<string, unknown>; as?: unknown };

export class MemoSpool {
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly inDir: string;
  readonly outDir: string;

  constructor(
    private memos: MemoStore,
    dir: string,
    private agents: Map<number, string>,
    private tasks: TaskStore | null = null,
    /** タスクが変わったら（カードを出し直す） */
    private onTasks: () => void = () => {},
    private habits: HabitStore | null = null,
    private merge: MergeDesk | null = null,
  ) {
    this.inDir = join(dir, "in");
    this.outDir = join(dir, "out");
  }

  start(ms = 250) {
    mkdirSync(this.inDir, { recursive: true });
    mkdirSync(this.outDir, { recursive: true });
    this.timer = setInterval(() => this.tick(), ms);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** 来ている依頼を全部片付け、古い返事を消す */
  tick(now = Date.now()) {
    let names: string[] = [];
    try {
      names = readdirSync(this.inDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue; // 書きかけ（.tmp）は待つ
      this.handle(name);
    }
    try {
      for (const name of readdirSync(this.outDir)) {
        const p = join(this.outDir, name);
        if (now - lstatSync(p).mtimeMs > OUT_TTL_MS) unlinkSync(p);
      }
    } catch {
      /* 次の回に */
    }
  }

  private handle(name: string) {
    const path = join(this.inDir, name);
    const id = name.slice(0, -".json".length);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return;
    }
    const drop = () => {
      try {
        unlinkSync(path);
      } catch {
        /* もう無い */
      }
    };
    // シンボリックリンク・知らないユーザー・名前の形が違うものは、返事をせずに捨てる
    const agent = this.agents.get(st.uid);
    if (!st.isFile() || !agent || !ID_RE.test(id)) return drop();
    let reply: unknown;
    try {
      if (st.size > MAX_REQUEST) throw new MemoError("依頼が大きすぎる", 400);
      const req = JSON.parse(readFileSync(path, "utf8")) as Req;
      // hermes は1つのユーザーで何人も動くので、名乗り（as）を添えてよい。記録は「hermes/default」のようになる
      const as = typeof req.as === "string" && AS_RE.test(req.as) ? req.as : null;
      reply = { ok: true, result: this.run(String(req.op ?? ""), req.args ?? {}, as ? `${agent}/${as}` : agent) };
    } catch (e) {
      reply = { ok: false, error: e instanceof Error ? e.message : String(e), status: e instanceof MemoError || e instanceof TaskError || e instanceof MergeError ? e.status : 500 };
    }
    drop();
    const tmp = join(this.outDir, `${id}.tmp`);
    writeFileSync(tmp, JSON.stringify(reply));
    chmodSync(tmp, 0o644);
    renameSync(tmp, join(this.outDir, `${id}.json`));
  }

  run(op: string, a: Record<string, unknown>, author: string): unknown {
    if (op.startsWith("task.")) return this.runTask(op.slice("task.".length), a, author);
    // マージの承認を頼む（マージそのものは、オーナーが画面で承認したときにアプリがする）
    if (op === "merge.request" || op === "merge.status") {
      if (!this.merge) throw new MergeError("マージの承認は使えない", 404);
      const pr = typeof a.pr === "string" ? a.pr : "";
      if (op === "merge.status") {
        const m = pr.match(/^(.+)#(\d+)$/);
        if (!m) throw new MergeError("PR は owner/repo#番号 の形で");
        return { enabled: this.merge.enabled, request: this.merge.latest(m[1], Number(m[2])) };
      }
      const r = this.merge.request({ pr, sha: typeof a.sha === "string" ? a.sha : undefined, note: typeof a.note === "string" ? a.note : undefined }, author);
      this.onTasks();
      return { enabled: this.merge.enabled, request: r };
    }
    // ルーティーンは読むだけ（チェックはオーナーが画面で付ける）
    if (op === "habit.list") {
      if (!this.habits) throw new MemoError("ルーティーンは使えない", 404);
      return this.habits.overview();
    }
    const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
    const id = () => {
      const n = Number(a.id);
      if (!Number.isSafeInteger(n) || n <= 0) throw new MemoError("id が要る", 400);
      return n;
    };
    const tags = Array.isArray(a.tags) ? (a.tags as string[]) : undefined;
    const project = typeof a.project === "string" || a.project === null ? (a.project as string | null) : undefined;
    switch (op) {
      case "list":
        return this.memos.list({ q: str("q"), project: project === undefined ? null : (project ?? ""), tag: str("tag") ?? null, archived: a.archived === true, limit: Number(a.limit) || 50 });
      case "get": {
        const m = this.memos.get(id());
        if (!m) throw new MemoError("このメモは無い", 404);
        return m;
      }
      case "history":
        return this.memos.history(id());
      case "create":
        return this.memos.create({ title: str("title"), body: str("body"), project, tags, parentId: typeof a.parentId === "number" && a.parentId > 0 ? a.parentId : null }, author);
      case "update": {
        const updated = this.memos.update(
          id(),
          { title: str("title"), body: str("body"), project, tags, baseUpdatedAt: typeof a.baseUpdatedAt === "number" ? a.baseUpdatedAt : undefined },
          author,
        );
        if (a.parentId === null || typeof a.parentId === "number") return this.memos.setParent(updated.id, a.parentId === null ? null : a.parentId);
        return updated;
      }
      case "append":
        return this.memos.append(id(), str("text") ?? "", author);
      default:
        throw new MemoError(`知らない操作: ${op}`, 400);
    }
  }

  /** タスク（TASK-173）。見回りは upsert で登録する（同じ元は1件にまとまる）。判断（済み・不要など）はアプリから、オーナーだけ */
  private runTask(op: string, a: Record<string, unknown>, author: string): unknown {
    const tasks = this.tasks;
    if (!tasks) throw new TaskError("タスクは使えない", 404);
    const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
    const id = () => {
      const n = Number(a.id);
      if (!Number.isSafeInteger(n) || n <= 0) throw new TaskError("id が要る", 400);
      return n;
    };
    // 番号（TASK-123）か数字の id から、タスクの id を引く
    const ref = (k: string) => {
      const v = a[k];
      if (typeof v === "string" && /^[A-Za-z]+-\d+$/.test(v)) {
        const t = tasks.byRef(v);
        if (!t) throw new TaskError(`このタスクは無い: ${v}`, 404);
        return t.id;
      }
      const n = Number(v);
      if (!Number.isSafeInteger(n) || n <= 0) throw new TaskError(`${k} が要る`, 400);
      return n;
    };
    switch (op) {
      case "upsert": {
        const eventAt = typeof a.eventAt === "number" ? a.eventAt : typeof a.eventAt === "string" ? Date.parse(a.eventAt) : null;
        const r = tasks.upsert(
          {
            source: str("source") ?? "",
            key: str("key") ?? "",
            title: str("title") ?? "",
            body: str("body"),
            kind: str("kind"),
            url: str("url") ?? null,
            agent: str("agent") ?? null,
            propose: Array.isArray(a.propose) ? (a.propose as string[]).filter((x) => typeof x === "string") : [],
            project: str("project") ?? null,
            due: str("due") ?? null,
            eventAt: eventAt !== null && Number.isFinite(eventAt) ? eventAt : null,
            status: a.status === "todo" || a.status === "doing" ? a.status : undefined,
          },
          author,
        );
        // 親を一緒に付ける（登録しなかったときは付けない）
        if (a.parent !== undefined && a.parent !== null && r.action !== "ignored") {
          const before = r.task.parentId;
          r.task = tasks.setParent(r.task.id, ref("parent"), author);
          if (r.action === "unchanged" && r.task.parentId !== before) r.action = "updated";
        }
        if (r.action !== "unchanged" && r.action !== "ignored") this.onTasks();
        return r;
      }
      case "parent": {
        // 親を付ける・外す（parent: null で外す）
        const t = tasks.setParent(ref("id"), a.parent === null ? null : ref("parent"), author);
        this.onTasks();
        return t;
      }
      case "link": {
        const kind = a.kind === "blocks" ? "blocks" : a.kind === "related" ? "related" : null;
        if (!kind) throw new TaskError("kind は blocks か related", 400);
        tasks.link(ref("a"), ref("b"), kind, a.on !== false, author);
        this.onTasks();
        return tasks.links(ref("a"));
      }
      case "links":
        return tasks.links(ref("id"));
      case "get": {
        // id は数字か番号（TASK-123）
        const t = typeof a.id === "string" && /^[A-Za-z]+-\d+$/.test(a.id) ? tasks.byRef(a.id) : tasks.get(id());
        if (!t) throw new TaskError("このタスクは無い", 404);
        return { ...t, events: tasks.events(t.id) };
      }
      case "find": {
        const src = String(str("source") ?? "").toLowerCase();
        const t = tasks.bySource(src, str("key") ?? "") ?? tasks.byLooseKey(src, str("key") ?? "");
        return t ? { ...t, events: tasks.events(t.id) } : null;
      }
      case "list": {
        const status = Array.isArray(a.status) ? (a.status as string[]).filter((s): s is TaskStatus | "dismissed" => (TASK_STATUSES as string[]).includes(s) || s === "dismissed") : undefined;
        return tasks.list({ status: status?.length ? status : undefined, source: str("source"), q: str("q"), limit: Number(a.limit) || 50 });
      }
      case "comment":
        return tasks.comment(id(), str("text") ?? "", author);
      case "status": {
        const t = tasks.setStatusBy(ref("id"), str("status") ?? "", str("note") ?? "", author);
        this.onTasks();
        return t;
      }
      default:
        throw new TaskError(`知らない操作: task.${op}`, 400);
    }
  }
}
