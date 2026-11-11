// memo-sync.ts の端末側（IndexedDB）とサーバー側（API）。アプリに1つの memoSync を置く。
import { ing } from "./dots";
import { useSyncExternalStore } from "react";
import type { Memo, MemoList } from "../shared/types";
import { createIdb } from "./memo-idb";
import { type LocalListOptions, type MemoApi, type MemoDb, type MemoFields, MemoSync, type PendingChange, type SyncStatus } from "./memo-sync";

const TIMEOUT_MS = 8000;
const EVERY_MS = 30_000;

const idb = createIdb(globalThis.indexedDB);

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), headers: init.body ? { "Content-Type": "application/json" } : undefined });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return (await res.json()) as T;
}

const api: MemoApi = {
  create: (f) => call<Memo>("/api/memos", { method: "POST", body: JSON.stringify(f) }),
  update: (id, f: MemoFields, base) => call<Memo>(`/api/memos/${id}`, { method: "PUT", body: JSON.stringify({ ...f, ...(base === null ? {} : { baseUpdatedAt: base }) }) }),
  get: (id) => call<Memo>(`/api/memos/${id}`),
  changedSince: (since) => call<Memo[]>(`/api/memos-sync?since=${since}`),
};

export const memoSync = new MemoSync(idb, api);

let started = false;
/** 開いたとき・つながったとき・戻ったとき・30秒ごとに同期する */
export function startMemoSync() {
  if (started || typeof indexedDB === "undefined") return;
  started = true;
  const run = () => void memoSync.run();
  run();
  addEventListener("online", run);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && run());
  setInterval(() => document.visibilityState === "visible" && run(), EVERY_MS);
}

export function useMemoSyncStatus(): SyncStatus {
  return useSyncExternalStore((fn) => memoSync.subscribe(fn), () => memoSync.status);
}

/** サーバーの一覧。届かなければ端末の写しから作る */
export async function memoList(p: URLSearchParams): Promise<MemoList> {
  try {
    return await call<MemoList>(`/api/memos?${p}`);
  } catch (e) {
    if ((e as { status?: number }).status !== undefined) throw e;
    return localMemoList(p);
  }
}

export function localMemoList(p: URLSearchParams): Promise<MemoList> {
  const o: LocalListOptions = { q: p.get("q") ?? "", project: p.get("project"), tag: p.get("tag"), archived: p.get("archived") === "1", parent: Number(p.get("parent")) || null };
  return memoSync.list(o);
}

/** 同期の様子。問題がなければ何も出さない */
export function SyncBadge() {
  const s = useMemoSyncStatus();
  const text = s.offline ? (s.pending ? `オフライン · 未同期 ${s.pending} 件` : "オフライン") : s.error ? `同期できない · 未同期 ${s.pending} 件` : s.pending ? `未同期 ${s.pending} 件` : null;
  if (!text) return null;
  return (
    <button onClick={() => void memoSync.run()} aria-label={`${text}。押して同期する`} className={`min-h-7 rounded-full px-2.5 text-[11.5px] font-semibold ${s.error ? "bg-orange-soft text-orange-ink" : "bg-chip text-ink-2"}`}>
      {s.syncing ? ing("同期中…") : text}
    </button>
  );
}
