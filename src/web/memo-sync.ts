// メモのオフライン（v2.0 A）。端末に写しと「まだ送っていない変更」を持つ。正本はサーバー。
// 同じメモを両方で変えていたら、片方を消さずに「衝突したコピー」として両方残す。
import type { Memo, MemoList, MemoSummary } from "../shared/types";

export interface MemoFields {
  title: string;
  body: string;
  project: string | null;
  tags: string[];
}

/** 送っていない変更。中身は memos の写しを送るので、1メモ1件 */
export interface PendingChange {
  id: number;
  /** サーバーで最後に見た更新時刻。新しいメモは null */
  base: number | null;
}

export interface MemoDb {
  allMemos(): Promise<Memo[]>;
  getMemo(id: number): Promise<Memo | undefined>;
  putMemo(m: Memo): Promise<void>;
  deleteMemo(id: number): Promise<void>;
  allPending(): Promise<PendingChange[]>;
  putPending(p: PendingChange): Promise<void>;
  deletePending(id: number): Promise<void>;
  getLastSync(): Promise<number>;
  setLastSync(at: number): Promise<void>;
}

export interface MemoApi {
  create(f: MemoFields): Promise<Memo>;
  update(id: number, f: MemoFields, baseUpdatedAt: number | null): Promise<Memo>;
  get(id: number): Promise<Memo>;
  changedSince(since: number): Promise<Memo[]>;
}

export type SyncEvent =
  | { type: "remap"; from: number; to: number }
  | { type: "conflict"; id: number; copyId: number };

export interface SyncStatus {
  pending: number;
  syncing: boolean;
  /** 最後の同期が通信で失敗した */
  offline: boolean;
  error: string | null;
}

export const CONFLICT_SUFFIX = "（衝突したコピー）";

const fieldsOf = (m: Memo): MemoFields => ({ title: m.title, body: m.body, project: m.project, tags: m.tags });
const statusOf = (e: unknown) => (e as { status?: number }).status;

export class MemoSync {
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(e: SyncEvent) => void>();
  private running: Promise<void> | null = null;
  private again = false;
  private localSeq = 0;
  status: SyncStatus = { pending: 0, syncing: false, offline: false, error: null };

  constructor(
    private db: MemoDb,
    private api: MemoApi,
    private now: () => number = Date.now,
  ) {}

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  onEvent(fn: (e: SyncEvent) => void) {
    this.eventListeners.add(fn);
    return () => void this.eventListeners.delete(fn);
  }

  private set(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn();
  }

  private emit(e: SyncEvent) {
    for (const fn of this.eventListeners) fn(e);
  }

  private async countPending() {
    this.set({ pending: (await this.db.allPending()).length });
  }

  get(id: number) {
    return this.db.getMemo(id);
  }

  async isPending(id: number) {
    return (await this.db.allPending()).some((p) => p.id === id);
  }

  /** 書いた内容を端末に残す。新しいメモ（id=null）は、同期するまで負の番号 */
  async save(id: number | null, f: MemoFields): Promise<Memo> {
    const at = this.now();
    const cur = id === null ? undefined : await this.db.getMemo(id);
    const memo: Memo = {
      id: id ?? -(at * 1000 + this.localSeq++ % 1000),
      ...f,
      author: cur?.author ?? "app",
      createdAt: cur?.createdAt ?? at,
      updatedAt: at,
      archivedAt: cur?.archivedAt ?? null,
    };
    const had = (await this.db.allPending()).some((p) => p.id === memo.id);
    if (!had) await this.db.putPending({ id: memo.id, base: memo.id < 0 ? null : (cur?.updatedAt ?? null) });
    await this.db.putMemo(memo);
    await this.countPending();
    return memo;
  }

  /** サーバーから取ったメモを写しにする（送っていない変更があれば触らない） */
  async adopt(m: Memo): Promise<boolean> {
    if (await this.isPending(m.id)) return false;
    await this.db.putMemo(m);
    return true;
  }

  async list(opts: LocalListOptions = {}): Promise<MemoList> {
    return localList(await this.db.allMemos(), opts);
  }

  /** 送って、取る。同時には1つだけ（走っている間に呼ばれたら、終わったあともう1回） */
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
      for (const p of await this.db.allPending()) await this.push(p);
      await this.pull();
      this.set({ offline: false, error: null });
    } catch (e) {
      if (statusOf(e) === undefined) this.set({ offline: true });
      else this.set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      await this.countPending();
      this.set({ syncing: false });
    }
  }

  /** 送ったあと写しを置き換える。送っている間に書き足されていたら、それは次に送る */
  private async settle(sent: Memo, server: Memo) {
    const cur = await this.db.getMemo(sent.id);
    const edited = cur && cur.updatedAt !== sent.updatedAt;
    if (sent.id !== server.id) {
      await this.db.deleteMemo(sent.id);
      await this.db.deletePending(sent.id);
    }
    if (edited) {
      await this.db.putMemo({ ...cur, id: server.id, createdAt: server.createdAt });
      await this.db.putPending({ id: server.id, base: server.updatedAt });
    } else {
      await this.db.putMemo(server);
      await this.db.deletePending(server.id);
    }
    if (sent.id !== server.id) this.emit({ type: "remap", from: sent.id, to: server.id });
  }

  private async push(p: PendingChange) {
    const memo = await this.db.getMemo(p.id);
    if (!memo) return this.db.deletePending(p.id);
    if (p.id < 0) return this.settle(memo, await this.api.create(fieldsOf(memo)));
    try {
      await this.settle(memo, await this.api.update(p.id, fieldsOf(memo), p.base));
    } catch (e) {
      if (statusOf(e) === 404) {
        // サーバーから消えていた: 書いた分を新しいメモとして残す
        await this.settle(memo, await this.api.create(fieldsOf(memo)));
      } else if (statusOf(e) === 409) {
        await this.keepBoth(memo);
      } else throw e;
    }
  }

  /** 両方で変えていた: サーバーの版を写しにし、こちらの版はコピーとして残す。どちらも消さない */
  private async keepBoth(memo: Memo) {
    const server = await this.api.get(memo.id);
    const latest = (await this.db.getMemo(memo.id)) ?? memo;
    const copy = await this.api.create({ ...fieldsOf(latest), title: `${latest.title || "無題"}${CONFLICT_SUFFIX}` });
    await this.db.putMemo(copy);
    await this.db.putMemo(server);
    await this.db.deletePending(memo.id);
    this.emit({ type: "conflict", id: memo.id, copyId: copy.id });
  }

  private async pull() {
    const since = await this.db.getLastSync();
    let newest = since;
    for (const m of await this.api.changedSince(since)) {
      await this.adopt(m);
      newest = Math.max(newest, m.updatedAt);
    }
    if (newest !== since) await this.db.setLastSync(newest);
  }
}

export interface LocalListOptions {
  q?: string;
  /** "" はプロジェクトなし。null・省略はすべて */
  project?: string | null;
  tag?: string | null;
  archived?: boolean;
}

/** サーバーに届かないときの一覧。形は /api/memos と同じ */
export function localList(all: Memo[], o: LocalListOptions = {}): MemoList {
  const live = all.filter((m) => !m.archivedAt);
  const count = (names: string[]) => {
    const c = new Map<string, number>();
    for (const n of names) c.set(n, (c.get(n) ?? 0) + 1);
    return [...c].map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  };
  const word = o.q?.trim().toLowerCase();
  const memos: MemoSummary[] = all
    .filter((m) => !!m.archivedAt === !!o.archived)
    .filter((m) => (o.project === "" ? !m.project : o.project ? m.project === o.project : true))
    .filter((m) => !o.tag || m.tags.includes(o.tag))
    .filter((m) => !word || `${m.title}\n${m.body}`.toLowerCase().includes(word))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((m) => ({ id: m.id, title: m.title, excerpt: m.body.replace(/\s+/g, " ").slice(0, 120), project: m.project, tags: m.tags, updatedAt: m.updatedAt, archived: !!m.archivedAt }));
  return { memos, projects: count(live.flatMap((m) => (m.project ? [m.project] : []))), tags: count(live.flatMap((m) => m.tags)) };
}
