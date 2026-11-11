// task-sync.ts の端末側（IndexedDB）とサーバー側（API）。画面はここを通してタスクを読み書きする。
// つながっていれば今までどおりサーバーへ。通信で失敗したときだけ、端末に残して後で送る。
import { ing } from "./dots";
import { useSyncExternalStore } from "react";
import type { AppTask, AppTaskEvent, AppTaskLinks, AppTaskList, AppTaskStatus, MemoSummary } from "../shared/types";
import { emptyLinks, isNetworkError, OPEN_STATUSES, type TaskApi, type TaskDb, type TaskFields, type TaskNew, type TaskPending, TaskSync, type TaskSyncStatus } from "./task-sync";
import { toast } from "./touch";

const DB_NAME = "plasmod-tasks";
const TIMEOUT_MS = 8000;

let opened: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  return (opened ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("tasks", { keyPath: "id" });
      r.result.createObjectStore("pending", { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req.result as T);
    t.onerror = t.onabort = () => reject(t.error);
  });
}

const idb: TaskDb = {
  allTasks: () => tx<AppTask[]>("tasks", "readonly", (s) => s.getAll()),
  getTask: (id) => tx<AppTask | undefined>("tasks", "readonly", (s) => s.get(id)),
  putTask: (t) => tx("tasks", "readwrite", (s) => s.put(t)),
  deleteTask: (id) => tx("tasks", "readwrite", (s) => s.delete(id)),
  allPending: () => tx<TaskPending[]>("pending", "readonly", (s) => s.getAll()),
  putPending: (p) => tx("pending", "readwrite", (s) => s.put(p)),
  deletePending: (id) => tx("pending", "readwrite", (s) => s.delete(id)),
};

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), headers: init.body ? { "Content-Type": "application/json" } : undefined });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  return body as T;
}

const api: TaskApi = {
  create: (t) => call<AppTask>("/api/apptasks", { method: "POST", body: JSON.stringify(t) }),
  patch: (id, f) => call<AppTask>(`/api/apptasks/${id}`, { method: "PATCH", body: JSON.stringify(f) }),
  get: async (id) => (await call<{ task: AppTask }>(`/api/apptasks/${id}`)).task,
  open: async () => (await call<AppTaskList>(`/api/apptasks?status=${OPEN_STATUSES.join(",")}`)).tasks,
};

export const taskSync = new TaskSync(idb, api);

let started = false;
/** 開いたとき・つながったとき・戻ったときに同期する（未完了のタスクは毎回取り直すので、定期には回さない） */
export function startTaskSync() {
  if (started || typeof indexedDB === "undefined") return;
  started = true;
  const run = () => void taskSync.run();
  run();
  addEventListener("online", run);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && run());
  taskSync.onEvent((e) => {
    if (e.type === "remap") {
      // 開いている画面の番号を、本当の番号へ
      const from = `#/todo/${e.from}`;
      if (location.hash === from || location.hash.startsWith(`${from}?`)) location.replace(location.hash.replace(from, `#/todo/${e.to}`));
    } else if (e.type === "merged") toast("ほかでも本文が変わっていたので、両方残した");
    else if (e.type === "rejected") toast(`送れなかった変更を取り消した: ${e.error}`, "error");
  });
}

const statusesOf = (p: URLSearchParams) => (p.get("status") ?? "").split(",").filter(Boolean) as AppTaskStatus[];

/** 一覧。届かなければ端末の写しから。届いても、送っていない変更は端末の版を見せる */
export async function fetchTaskList(p: URLSearchParams): Promise<AppTaskList> {
  try {
    const l = await call<AppTaskList>(`/api/apptasks?${p}`);
    const local = await taskSync.list({ status: statusesOf(p), q: p.get("q") ?? "", project: p.get("project"), tag: p.get("tag") }).catch(() => null);
    const pending = new Set((await idb.allPending().catch(() => [])).map((x) => x.id));
    if (!local || !pending.size) return l;
    const mine = local.tasks.filter((t) => pending.has(t.id));
    const statuses = statusesOf(p);
    return { ...l, tasks: [...mine, ...l.tasks.filter((t) => !pending.has(t.id) && (!statuses.length || statuses.includes(t.status)))] };
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    return taskSync.list({ status: statusesOf(p), q: p.get("q") ?? "", project: p.get("project"), tag: p.get("tag") });
  }
}

export interface TaskDetailData {
  task: AppTask;
  events: AppTaskEvent[];
  links: AppTaskLinks;
  memos?: MemoSummary[];
  card: string | null;
  /** 端末の写しから作った（記録やつながりの一部は無い） */
  local?: boolean;
}

async function localDetail(id: number): Promise<TaskDetailData> {
  const task = await taskSync.get(id);
  if (!task) throw new Error("このタスクはオフラインでは開けない（未完了のタスクだけ端末にある）");
  return { task, events: [], links: await taskSync.links(id).catch(() => emptyLinks()), memos: [], card: null, local: true };
}

export async function fetchTask(rawId: number): Promise<TaskDetailData> {
  const id = taskSync.resolve(rawId);
  if (id < 0) return localDetail(id);
  try {
    const d = await call<TaskDetailData>(`/api/apptasks/${id}`);
    if (!(await taskSync.adopt(d.task))) {
      const mine = await taskSync.get(id);
      if (mine) return { ...d, task: mine };
    }
    return d;
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    return localDetail(id);
  }
}

/** 変更を送る。送っていない変更があるタスクと、通信で失敗したときは、端末に残す */
export async function patchTask(rawId: number, f: TaskFields & { baseUpdatedAt?: number }): Promise<AppTask> {
  const id = taskSync.resolve(rawId);
  const { baseUpdatedAt, ...fields } = f;
  if (id < 0 || (await taskSync.isPending(id).catch(() => false))) {
    const t = await taskSync.patch(id, fields);
    void taskSync.run();
    return t;
  }
  try {
    const t = await api.patch(id, f);
    await taskSync.adopt(t).catch(() => {});
    return t;
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    return taskSync.patch(id, fields);
  }
}

export async function createTask(input: TaskNew): Promise<AppTask> {
  const parent = input.parentId ? taskSync.resolve(input.parentId) : input.parentId;
  try {
    if (parent && parent < 0) throw new TypeError("親がまだ同期していない");
    const t = await api.create({ ...input, parentId: parent });
    await taskSync.adopt(t).catch(() => {});
    return t;
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    return taskSync.create({ ...input, parentId: parent });
  }
}

export function useTaskSyncStatus(): TaskSyncStatus {
  return useSyncExternalStore((fn) => taskSync.subscribe(fn), () => taskSync.status);
}

/** 同期の様子。問題がなければ何も出さない */
export function TaskSyncBadge() {
  const s = useTaskSyncStatus();
  const text = s.offline ? (s.pending ? `オフライン · 未同期 ${s.pending} 件` : "オフライン") : s.error ? `同期できない · 未同期 ${s.pending} 件` : s.pending ? `未同期 ${s.pending} 件` : null;
  if (!text) return null;
  return (
    <button onClick={() => void taskSync.run()} aria-label={`${text}。押して同期する`} className={`min-h-7 rounded-full px-2.5 text-[11.5px] font-semibold ${s.error ? "bg-orange-soft text-orange-ink" : "bg-chip text-ink-2"}`}>
      {s.syncing ? ing("同期中…") : text}
    </button>
  );
}
