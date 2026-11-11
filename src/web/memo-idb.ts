// メモの端末側の保存（IndexedDB）。画面に依存しないので、テストと測定からも使う。
// memos = 本文つきの写し / summaries = 一覧に要る軽い行（本文なし）。一覧と数え上げは summaries だけを読む。
// 一覧は更新日の索引を新しい方から数えて LIST_LIMIT 件で止める（件数が増えても、読むのは出す分だけ）。
import type { Memo, MemoList, MemoSummary } from "../shared/types";
import { memoIdOf } from "../shared/memo-ref";
import type { LocalListOptions, MemoDb, PendingChange } from "./memo-sync";

export const LIST_LIMIT = 200;
const DB_NAME = "plasmod-memos";
const VERSION = 3;

/** summaries の行。a は索引用（IndexedDB は真偽値を鍵にできない） */
type Row = MemoSummary & { a: 0 | 1; p: 0 | 1 };

export const excerptOf = (body: string) => body.replace(/^\s*```html\s*$[\s\S]*?^\s*```\s*$/gm, "").replace(/\s+/g, " ").trim().slice(0, 120);

export const summaryOf = (m: Memo): MemoSummary => ({ id: m.id, title: m.title, excerpt: excerptOf(m.body), project: m.project, tags: m.tags, parentId: m.parentId ?? null, updatedAt: m.updatedAt, archived: !!m.archivedAt, pinned: !!m.pinnedAt, headerImage: m.headerImage ?? null });

export const rowOf = (m: Memo): Row => ({ ...summaryOf(m), a: m.archivedAt ? 1 : 0, p: m.pinnedAt ? 1 : 0 });
const plain = ({ a: _a, p: _p, ...s }: Row): MemoSummary => s;

/** 絞り込み。本文を見ない部分（一覧の行だけで決まる） */
export function matchesFilter(m: { project: string | null; tags: string[]; parentId?: number | null; archived: boolean }, o: LocalListOptions): boolean {
  return m.archived === !!o.archived && (o.project === "" ? !m.project : o.project ? m.project === o.project : true) && (!o.tag || m.tags.includes(o.tag)) && (!o.parent || m.parentId === o.parent);
}

export function count(names: string[]) {
  const c = new Map<string, number>();
  for (const n of names) c.set(n, (c.get(n) ?? 0) + 1);
  return [...c].map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** プロジェクト・タグごとの件数（アーカイブを除く）。一覧のたびに数え直さないよう meta に持ち、写しを書く取引の中で足し引きする */
type Facets = { projects: Record<string, number>; tags: Record<string, number> };
const bump = (f: Facets, r: Row | undefined, d: 1 | -1) => {
  if (!r || r.a) return;
  if (r.project) f.projects[r.project] = (f.projects[r.project] ?? 0) + d;
  for (const t of r.tags) f.tags[t] = (f.tags[t] ?? 0) + d;
  for (const k of [f.projects, f.tags]) for (const n in k) if (k[n] <= 0) delete k[n];
};
const facetList = (r: Record<string, number>) => Object.entries(r).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

const done = <T>(r: IDBRequest<T>) => new Promise<T>((ok, ng) => ((r.onsuccess = () => ok(r.result)), (r.onerror = () => ng(r.error))));

function open(f: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = f.open(DB_NAME, VERSION);
    r.onupgradeneeded = (ev) => {
      const db = r.result;
      const t = r.transaction!;
      if (ev.oldVersion < 1) {
        db.createObjectStore("memos", { keyPath: "id" });
        db.createObjectStore("pending", { keyPath: "id" });
        db.createObjectStore("meta");
      }
      if (ev.oldVersion < 2) {
        // 更新日の索引を足し、いまある写しから軽い行を作る
        t.objectStore("memos").createIndex("updatedAt", "updatedAt");
        const s = db.createObjectStore("summaries", { keyPath: "id" });
        s.createIndex("updatedAt", "updatedAt");
        s.createIndex("a", "a");
        const f: Facets = { projects: {}, tags: {} };
        const cur = t.objectStore("memos").openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return void t.objectStore("meta").put(f, "facets");
          const row = rowOf(c.value as Memo);
          s.put(row);
          bump(f, row, 1);
          c.continue();
        };
      }
      if (ev.oldVersion < 3) {
        // ピン留めの索引。v2 までの行には p が無い（留めたメモはまだ無いので 0 を入れる。v2 未満は上で作る行がもう持っている）
        const s = t.objectStore("summaries");
        s.createIndex("p", "p");
        if (ev.oldVersion === 2) {
          const cur = s.openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return;
            c.update({ ...(c.value as Row), p: 0, pinned: false });
            c.continue();
          };
        }
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function createIdb(factory: IDBFactory): MemoDb {
  let opened: Promise<IDBDatabase> | null = null;
  const db = () => (opened ??= open(factory));

  /** 1つの取引の中で fn を動かし、終わったら結果を返す */
  async function run<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(stores, mode);
      let out: T;
      t.oncomplete = () => resolve(out);
      t.onerror = t.onabort = () => reject(t.error);
      Promise.resolve(fn(t)).then((v) => (out = v), reject);
    });
  }
  const one = <T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest) => run<T>([store], mode, (t) => done(fn(t.objectStore(store))) as Promise<T>);

  /** 索引を新しい方から読み、keep が true のものを limit 件まで集める */
  function newest<V>(index: IDBIndex, keep: (v: V) => boolean, limit: number): Promise<V[]> {
    return new Promise((resolve, reject) => {
      const out: V[] = [];
      const r = index.openCursor(null, "prev");
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const c = r.result;
        if (!c || out.length >= limit) return resolve(out);
        if (keep(c.value as V)) out.push(c.value as V);
        c.continue();
      };
    });
  }

  /** 写しと軽い行と件数を、1つの取引で書き換える */
  const change = (id: number, row: Row | undefined, memo: Memo | undefined) =>
    run(["memos", "summaries", "meta"], "readwrite", async (t) => {
      const sums = t.objectStore("summaries");
      const meta = t.objectStore("meta");
      const [old, f] = (await Promise.all([done(sums.get(id)), done(meta.get("facets"))])) as [Row | undefined, Facets | undefined];
      const facets = f ?? { projects: {}, tags: {} };
      bump(facets, old, -1);
      bump(facets, row, 1);
      if (memo && row) await Promise.all([done(t.objectStore("memos").put(memo)), done(sums.put(row)), done(meta.put(facets, "facets"))]);
      else await Promise.all([done(t.objectStore("memos").delete(id)), done(sums.delete(id)), done(meta.put(facets, "facets"))]);
    });

  return {
    getMemo: (id) => one<Memo | undefined>("memos", "readonly", (s) => s.get(id)),
    putMemo: (m) => change(m.id, rowOf(m), m),
    deleteMemo: (id) => change(id, undefined, undefined),
    archivedIds: () => one<number[]>("summaries", "readonly", (s) => s.index("a").getAllKeys(1)),
    allPending: () => one<PendingChange[]>("pending", "readonly", (s) => s.getAll()),
    putPending: (p) => one("pending", "readwrite", (s) => s.put(p)),
    deletePending: (id) => one("pending", "readwrite", (s) => s.delete(id)),
    getLastSync: async () => (await one<number | undefined>("meta", "readonly", (s) => s.get("lastSync"))) ?? 0,
    setLastSync: (at) => one("meta", "readwrite", (s) => s.put(at, "lastSync")),

    listLocal: (o) =>
      run(["memos", "summaries", "meta"], "readonly", async (t): Promise<MemoList> => {
        const sums = t.objectStore("summaries");
        const facets = ((await done(t.objectStore("meta").get("facets"))) as Facets | undefined) ?? { projects: {}, tags: {} };
        const word = o.q?.trim().toLowerCase();
        const exact = word ? memoIdOf(word) : null;
        let memos: MemoSummary[];
        if (!word) {
          // 留めたメモは新しさに関わらず先頭に。残りを新しい順に
          const pinned = ((await done(sums.index("p").getAll(1))) as Row[]).filter((r) => matchesFilter(r, o)).sort((a, b) => b.updatedAt - a.updatedAt);
          const rest = await newest<Row>(sums.index("updatedAt"), (r) => !r.p && matchesFilter(r, o), LIST_LIMIT);
          memos = [...pinned, ...rest].slice(0, LIST_LIMIT).map(plain);
        } else {
          // 語を探すときだけ本文を読む。新しい順に、LIST_LIMIT 件見つかったところで止める
          const hits = await newest<Memo>(t.objectStore("memos").index("updatedAt"), (m) => matchesFilter({ ...m, archived: !!m.archivedAt }, o) && `${m.title}\n${m.body}`.toLowerCase().includes(word), LIST_LIMIT);
          memos = hits.map(summaryOf).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
          if (exact !== null && !memos.some((m) => m.id === exact)) {
            const r = (await done(sums.get(exact))) as Row | undefined;
            if (r && matchesFilter(r, o)) memos.unshift(plain(r));
          } else if (exact !== null) memos.sort((a, b) => Number(b.id === exact) - Number(a.id === exact));
          memos = memos.slice(0, LIST_LIMIT);
        }
        return { memos, projects: facetList(facets.projects), tags: facetList(facets.tags) };
      }),
  };
}
