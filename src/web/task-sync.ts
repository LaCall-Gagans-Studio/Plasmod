// タスクのオフライン。未完了のタスクだけを端末に写し、オフラインで作る・変えると、つながったときに送る。
// 完了は端末に置かない。変更の衝突は、題などの項目はこちらを優先し、本文は両方残す。
import type { AppTask, AppTaskDoneReason, AppTaskLinks, AppTaskList, AppTaskStatus } from "../shared/types";

export const OPEN_STATUSES: AppTaskStatus[] = ["inbox", "todo", "doing"];
const ALL_STATUSES: AppTaskStatus[] = ["inbox", "todo", "doing", "done"];
export const isOpenTask = (t: Pick<AppTask, "status">) => OPEN_STATUSES.includes(t.status);

export interface TaskFields {
  title?: string;
  body?: string;
  project?: string | null;
  due?: string | null;
  status?: AppTaskStatus;
  doneReason?: AppTaskDoneReason | null;
  tags?: string[];
}

export interface TaskNew extends TaskFields {
  title: string;
  parentId?: number | null;
}

/** 送っていない変更。1タスク1件で、同じ項目は新しい値に置き換える */
export interface TaskPending {
  id: number;
  /** サーバーで最後に見た更新時刻と本文。新しいタスクは null */
  base: number | null;
  baseBody: string | null;
  fields: TaskFields;
}

export interface TaskDb {
  allTasks(): Promise<AppTask[]>;
  getTask(id: number): Promise<AppTask | undefined>;
  putTask(t: AppTask): Promise<void>;
  deleteTask(id: number): Promise<void>;
  allPending(): Promise<TaskPending[]>;
  putPending(p: TaskPending): Promise<void>;
  deletePending(id: number): Promise<void>;
}

export interface TaskApi {
  create(t: TaskNew): Promise<AppTask>;
  patch(id: number, f: TaskFields & { baseUpdatedAt?: number }): Promise<AppTask>;
  get(id: number): Promise<AppTask>;
  /** 未完了のタスクすべて */
  open(): Promise<AppTask[]>;
}

export type TaskSyncEvent =
  | { type: "remap"; from: number; to: number }
  /** 両方で本文を変えていたので、本文を両方残した */
  | { type: "merged"; id: number }
  /** サーバーが受け付けなかったので、この変更は取り消した */
  | { type: "rejected"; id: number; error: string }
  /** 送り終えた・取り直した（画面を読み直す合図） */
  | { type: "synced" };

export interface TaskSyncStatus {
  pending: number;
  syncing: boolean;
  offline: boolean;
  error: string | null;
}

const statusOf = (e: unknown) => (e as { status?: number }).status;
export const isNetworkError = (e: unknown) => statusOf(e) === undefined;

export const MERGE_MARK = "--- オフラインで書いた内容 ---";

/** 両方で本文を変えていたら、サーバーの本文の下にこちらの本文を足す。どちらも消さない */
export function mergeBody(server: string, local: string, base: string | null): string {
  if (server === local || server === base) return local;
  if (local === base) return server;
  return `${server.trimEnd()}\n\n${MERGE_MARK}\n${local}`;
}

export const emptyLinks = (): AppTaskLinks => ({ parent: null, children: [], blocks: [], blockedBy: [], related: [] });

export class TaskSync {
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(e: TaskSyncEvent) => void>();
  private running: Promise<void> | null = null;
  private again = false;
  private seq = 0;
  /** 同期で本当の番号に変わったタスク。開いたままの画面の保存を、新しい番号へ流す */
  private moved = new Map<number, number>();
  status: TaskSyncStatus = { pending: 0, syncing: false, offline: false, error: null };

  constructor(
    private db: TaskDb,
    private api: TaskApi,
    private now: () => number = Date.now,
  ) {}

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  onEvent(fn: (e: TaskSyncEvent) => void) {
    this.eventListeners.add(fn);
    return () => void this.eventListeners.delete(fn);
  }

  private set(patch: Partial<TaskSyncStatus>) {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn();
  }

  private emit(e: TaskSyncEvent) {
    for (const fn of this.eventListeners) fn(e);
  }

  private async countPending() {
    this.set({ pending: (await this.db.allPending()).length });
  }

  resolve(id: number) {
    return this.moved.get(id) ?? id;
  }

  get(id: number) {
    return this.db.getTask(this.resolve(id));
  }

  async isPending(id: number) {
    const real = this.resolve(id);
    return (await this.db.allPending()).some((p) => p.id === real);
  }

  /** サーバーから取ったタスクを写しにする。完了したものは置かない。送っていない変更があれば触らない */
  async adopt(t: AppTask): Promise<boolean> {
    if (await this.isPending(t.id)) return false;
    if (isOpenTask(t)) await this.db.putTask(t);
    else await this.db.deleteTask(t.id);
    return true;
  }

  /** 新しいタスクを端末に作る。同期するまで番号（id）は負 */
  async create(input: TaskNew): Promise<AppTask> {
    const at = this.now();
    const id = -(at * 1000 + this.seq++ % 1000);
    const task: AppTask = {
      id,
      ref: null,
      parentId: input.parentId ?? null,
      tags: input.tags ?? [],
      title: input.title,
      body: input.body ?? "",
      kind: "todo",
      status: input.status ?? "todo",
      doneReason: input.doneReason ?? null,
      source: "app",
      sourceKey: null,
      url: null,
      agent: null,
      propose: [],
      project: input.project ?? null,
      due: input.due ?? null,
      createdBy: "app",
      kanbanId: null,
      eventAt: null,
      decidedAt: null,
      inboxAt: at,
      createdAt: at,
      updatedAt: at,
    };
    await this.db.putTask(task);
    await this.db.putPending({ id, base: null, baseBody: null, fields: {} });
    await this.countPending();
    return task;
  }

  /** 変更を端末に残す。写しが無いタスク（完了したものなど）は、オフラインでは変えられない */
  async patch(rawId: number, f: TaskFields): Promise<AppTask> {
    const id = this.resolve(rawId);
    const cur = await this.db.getTask(id);
    if (!cur) throw new Error("このタスクはオフラインでは変えられない（未完了のタスクだけ端末にある）");
    const next: AppTask = { ...cur, ...f, updatedAt: this.now() } as AppTask;
    await this.db.putTask(next);
    const had = (await this.db.allPending()).find((p) => p.id === id);
    await this.db.putPending(had ? { ...had, fields: { ...had.fields, ...f } } : { id, base: cur.updatedAt, baseBody: cur.body, fields: f });
    await this.countPending();
    return next;
  }

  /** 端末の写しから、サーバーと同じ形の一覧を作る */
  async list(o: { status?: AppTaskStatus[]; q?: string; project?: string | null; tag?: string | null } = {}): Promise<AppTaskList> {
    const all = await this.db.allTasks();
    const word = o.q?.trim().toLowerCase();
    const filtered = all
      .filter((t) => (o.project === "" ? !t.project : o.project ? t.project === o.project : true))
      .filter((t) => !o.tag || t.tags.includes(o.tag))
      .filter((t) => !word || `${t.title}\n${t.body}\n${t.ref ?? ""}`.toLowerCase().includes(word));
    const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, filtered.filter((t) => t.status === s).length])) as Record<AppTaskStatus, number>;
    const openCount = (id: number) => all.filter((t) => t.parentId === id && isOpenTask(t)).length;
    const tasks = filtered
      .filter((t) => !o.status?.length || o.status.includes(t.status))
      .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || b.updatedAt - a.updatedAt)
      .map((t) => ({ ...t, openChildren: openCount(t.id) }));
    const names = new Map<string, number>();
    for (const t of all) if (t.project && isOpenTask(t)) names.set(t.project, (names.get(t.project) ?? 0) + 1);
    return { tasks, counts, projects: [...names].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) };
  }

  /** 端末の写しから作る、タスクの中身の画面用のつながり。親と子だけ分かる */
  async links(id: number): Promise<AppTaskLinks> {
    const t = await this.get(id);
    const all = await this.db.allTasks();
    return { ...emptyLinks(), parent: all.find((x) => x.id === t?.parentId) ?? null, children: all.filter((x) => x.parentId === t?.id) };
  }

  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.cycle().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.run();
      }
    });
    return this.running;
  }

  private async cycle() {
    this.set({ syncing: true });
    try {
      const pending = await this.db.allPending();
      // 新しいタスクを、作った順に先に送る（子より親が先になる）
      const order = [...pending].sort((a, b) => Number(b.id < 0) - Number(a.id < 0) || (a.id < 0 ? b.id - a.id : a.id - b.id));
      for (const p of order) await this.push(p);
      await this.pull();
      this.set({ offline: false, error: null });
      this.emit({ type: "synced" });
    } catch (e) {
      if (isNetworkError(e)) this.set({ offline: true });
      else this.set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      await this.countPending();
      this.set({ syncing: false });
    }
  }

  /** 送ったあと写しを置き換える。送っている間に足された変更は、次に送る */
  private async settle(sent: TaskPending, server: AppTask) {
    const latest = (await this.db.allPending()).find((p) => p.id === sent.id);
    const newer = latest && JSON.stringify(latest.fields) !== JSON.stringify(sent.fields);
    if (sent.id !== server.id) {
      this.moved.set(sent.id, server.id);
      await this.db.deleteTask(sent.id);
      await this.db.deletePending(sent.id);
      // この端末で作った子の親を、本当の番号に
      for (const c of await this.db.allTasks()) if (c.parentId === sent.id) await this.db.putTask({ ...c, parentId: server.id });
    }
    if (newer) {
      const extra: TaskFields = latest.fields;
      await this.db.putTask({ ...server, ...extra } as AppTask);
      await this.db.putPending({ id: server.id, base: server.updatedAt, baseBody: server.body, fields: extra });
    } else {
      await this.db.deletePending(server.id);
      if (isOpenTask(server)) await this.db.putTask(server);
      else await this.db.deleteTask(server.id);
    }
    if (sent.id !== server.id) this.emit({ type: "remap", from: sent.id, to: server.id });
  }

  private async push(p: TaskPending) {
    const local = await this.db.getTask(p.id);
    if (!local) return this.db.deletePending(p.id);
    try {
      if (p.id < 0) {
        // 作ってからの変更も、端末の写しに入っている
        const created = await this.api.create({
          title: local.title,
          body: local.body,
          project: local.project,
          due: local.due,
          status: local.status,
          tags: local.tags,
          parentId: local.parentId !== null && local.parentId > 0 ? local.parentId : null,
        });
        return await this.settle(p, created);
      }
      await this.settle(p, await this.api.patch(p.id, { ...p.fields, ...(p.base === null ? {} : { baseUpdatedAt: p.base }) }));
    } catch (e) {
      const code = statusOf(e);
      if (code === 409) return this.merge(p);
      if (code === 404 && p.id > 0) return this.gone(p, local);
      if (code !== undefined && code >= 400 && code < 500) {
        // 直しようがない変更で同期全体を止めない。写しはサーバーの版に戻る
        await this.db.deletePending(p.id);
        if (p.id < 0) await this.db.deleteTask(p.id);
        this.emit({ type: "rejected", id: p.id, error: e instanceof Error ? e.message : String(e) });
        return;
      }
      throw e;
    }
  }

  /** ほかでも変えられていた: 項目はこちらを優先し、本文は両方残す */
  private async merge(p: TaskPending) {
    const server = await this.api.get(p.id);
    const fields = { ...p.fields };
    if (fields.body !== undefined) {
      const body = mergeBody(server.body, fields.body, p.baseBody);
      if (body !== fields.body && body !== server.body) this.emit({ type: "merged", id: p.id });
      fields.body = body;
    }
    await this.settle(p, await this.api.patch(p.id, fields));
  }

  /** サーバーから消えていた: 題や本文を書いていたら新しいタスクとして残す。状態の変更だけなら捨てる */
  private async gone(p: TaskPending, local: AppTask) {
    if (p.fields.title === undefined && p.fields.body === undefined) {
      await this.db.deletePending(p.id);
      await this.db.deleteTask(p.id);
      return;
    }
    const created = await this.api.create({ title: local.title, body: local.body, project: local.project, due: local.due, status: local.status, tags: local.tags });
    await this.settle(p, created);
  }

  /** 未完了のタスクを取り直す。完了・削除で無くなったものは、端末からも消える */
  private async pull() {
    const open = await this.api.open();
    const pending = new Set((await this.db.allPending()).map((p) => p.id));
    const ids = new Set(open.map((t) => t.id));
    for (const t of open) if (!pending.has(t.id)) await this.db.putTask(t);
    for (const t of await this.db.allTasks()) if (!ids.has(t.id) && !pending.has(t.id)) await this.db.deleteTask(t.id);
  }
}
