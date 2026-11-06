import { describe, expect, test } from "bun:test";
import { CONFLICT_SUFFIX, localList, type MemoApi, type MemoDb, type MemoFields, MemoSync, type PendingChange, type SyncEvent } from "../src/web/memo-sync";
import type { Memo } from "../src/shared/types";

function fakeDb(): MemoDb {
  const memos = new Map<number, Memo>();
  const pending = new Map<number, PendingChange>();
  let last = 0;
  return {
    allMemos: async () => [...memos.values()],
    getMemo: async (id) => memos.get(id),
    putMemo: async (m) => void memos.set(m.id, m),
    deleteMemo: async (id) => void memos.delete(id),
    allPending: async () => [...pending.values()],
    putPending: async (p) => void pending.set(p.id, p),
    deletePending: async (id) => void pending.delete(id),
    getLastSync: async () => last,
    setLastSync: async (at) => void (last = at),
  };
}

/** 偽のサーバー。本物と同じく baseUpdatedAt が古ければ 409 */
function fakeServer() {
  const memos = new Map<number, Memo>();
  let clock = 1000;
  let nextId = 1;
  const state = { online: true, calls: [] as string[] };
  const gate = () => {
    if (!state.online) throw new TypeError("fetch failed");
  };
  const fail = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
  const write = (id: number, f: MemoFields, createdAt: number): Memo => {
    const m: Memo = { id, ...f, parentId: f.parentId ?? null, author: "app", createdAt, updatedAt: ++clock, archivedAt: null };
    memos.set(id, m);
    return m;
  };
  const api: MemoApi = {
    create: async (f) => (gate(), state.calls.push(`create ${f.title}`), write(nextId++, f, clock)),
    update: async (id, f, base) => {
      gate();
      state.calls.push(`update ${id}`);
      const cur = memos.get(id);
      if (!cur) throw fail(404);
      if (base !== null && base !== cur.updatedAt) throw fail(409);
      return write(id, f, cur.createdAt);
    },
    get: async (id) => (gate(), memos.get(id)!),
    changedSince: async (since) => (gate(), [...memos.values()].filter((m) => m.updatedAt >= since)),
  };
  return { api, memos, state, write };
}

const F = (title: string, body = "本文"): MemoFields => ({ title, body, project: null, tags: [] });

function setup() {
  const s = fakeServer();
  const db = fakeDb();
  let t = 5000;
  const sync = new MemoSync(db, s.api, () => ++t);
  const events: SyncEvent[] = [];
  sync.onEvent((e) => events.push(e));
  return { ...s, db, sync, events };
}

describe("メモのオフライン", () => {
  test("圏外で書いたメモは端末に残り、つながると送られて番号が付く", async () => {
    const { sync, state, memos, events, db } = setup();
    state.online = false;
    const m = await sync.save(null, F("圏外のメモ"));
    expect(m.id).toBeLessThan(0);
    await sync.run();
    expect(sync.status).toMatchObject({ offline: true, pending: 1 });
    expect((await sync.list()).memos.map((x) => x.title)).toEqual(["圏外のメモ"]);
    expect(memos.size).toBe(0);

    state.online = true;
    await sync.run();
    expect(sync.status).toMatchObject({ offline: false, pending: 0 });
    expect(memos.get(1)!.title).toBe("圏外のメモ");
    expect(events).toEqual([{ type: "remap", from: m.id, to: 1 }]);
    expect(await db.getMemo(m.id)).toBeUndefined();
    expect((await sync.list()).memos.map((x) => x.id)).toEqual([1]);
  });

  test("他の端末の変更を取ってくる。送っていない変更は上書きしない", async () => {
    const { sync, write, state } = setup();
    write(7, F("別の端末"), 1);
    await sync.run();
    expect((await sync.get(7))!.title).toBe("別の端末");
    write(7, F("別の端末2"), 1);
    state.online = false;
    await sync.save(7, F("こちらの書きかけ"));
    await sync.run();
    expect((await sync.get(7))!.title).toBe("こちらの書きかけ");
  });

  test("両方で変えていたら、どちらも消さない（サーバーの版＋衝突したコピー）", async () => {
    const { sync, write, state, memos, events } = setup();
    write(7, F("元", "元の本文"), 1);
    await sync.run();
    state.online = false;
    await sync.save(7, F("元", "端末で書いた"));
    state.online = true;
    write(7, F("元", "別の端末で書いた"), 1);
    await sync.run();
    expect(memos.get(7)!.body).toBe("別の端末で書いた");
    const copy = [...memos.values()].find((m) => m.title === `元${CONFLICT_SUFFIX}`)!;
    expect(copy.body).toBe("端末で書いた");
    expect(events).toEqual([{ type: "conflict", id: 7, copyId: copy.id }]);
    expect((await sync.get(7))!.body).toBe("別の端末で書いた");
    expect((await sync.get(copy.id))!.body).toBe("端末で書いた");
    expect(sync.status.pending).toBe(0);
    await sync.run(); // 2周目でコピーが増えない
    expect([...memos.values()].filter((m) => m.title.endsWith(CONFLICT_SUFFIX))).toHaveLength(1);
  });

  test("コピーを作る途中で切れても失わない（次に作り直す）", async () => {
    const { sync, write, api, memos } = setup();
    write(7, F("元"), 1);
    await sync.run();
    await sync.save(7, F("元", "端末で書いた"));
    write(7, F("元", "別で書いた"), 1);
    const create = api.create;
    api.create = async () => {
      throw new TypeError("切れた");
    };
    await sync.run();
    expect(sync.status).toMatchObject({ offline: true, pending: 1 });
    expect((await sync.get(7))!.body).toBe("端末で書いた");
    api.create = create;
    await sync.run();
    expect(sync.status.pending).toBe(0);
    expect([...memos.values()].some((m) => m.body === "端末で書いた")).toBe(true);
  });

  test("送っている間に書き足した分は失わず、次に送る", async () => {
    const { sync, api, memos } = setup();
    const m = await sync.save(null, F("題", "一文目"));
    const create = api.create;
    api.create = async (f) => {
      const r = await create(f);
      await sync.save(m.id, F("題", "一文目と二文目"));
      return r;
    };
    await sync.run();
    await sync.run();
    expect(memos.get(1)!.body).toBe("一文目と二文目");
    expect(sync.status.pending).toBe(0);
  });

  test("サーバーから消えていたら、書いた分を新しいメモとして残す", async () => {
    const { sync, write, memos } = setup();
    write(7, F("元"), 1);
    await sync.run();
    await sync.save(7, F("元", "書いた"));
    memos.delete(7);
    await sync.run();
    expect([...memos.values()].map((m) => m.body)).toEqual(["書いた"]);
    expect(sync.status.pending).toBe(0);
  });

  test("サーバーのエラー（500）は圏外扱いにせず、変更を残す", async () => {
    const { sync, write, api } = setup();
    write(7, F("元"), 1);
    await sync.run();
    await sync.save(7, F("元", "書いた"));
    api.update = async () => {
      throw Object.assign(new Error("HTTP 500"), { status: 500 });
    };
    await sync.run();
    expect(sync.status).toMatchObject({ offline: false, error: "HTTP 500", pending: 1 });
  });
});

describe("端末の一覧", () => {
  const memo = (p: Partial<Memo> & { id: number }): Memo => ({ title: "t", body: "b", project: null, tags: [], parentId: null, author: "app", createdAt: 1, updatedAt: 1, archivedAt: null, ...p });
  const all = [
    memo({ id: 1, title: "古い", project: "A", tags: ["x"], updatedAt: 1 }),
    memo({ id: 2, title: "新しい", body: "東京の話", updatedAt: 9 }),
    memo({ id: 3, title: "アーカイブ", archivedAt: 5, project: "B" }),
  ];
  test("新しい順。語・プロジェクト・タグ・アーカイブで絞る。数はアーカイブを除く", () => {
    expect(localList(all).memos.map((m) => m.id)).toEqual([2, 1]);
    expect(localList(all, { q: "東京" }).memos.map((m) => m.id)).toEqual([2]);
    expect(localList(all, { project: "A" }).memos.map((m) => m.id)).toEqual([1]);
    expect(localList(all, { project: "" }).memos.map((m) => m.id)).toEqual([2]);
    expect(localList(all, { tag: "x" }).memos.map((m) => m.id)).toEqual([1]);
    expect(localList(all, { archived: true }).memos.map((m) => m.id)).toEqual([3]);
    expect(localList(all).projects).toEqual([{ name: "A", count: 1 }]);
  });
});

describe("アーカイブは端末に置かない", () => {
  const memo = (id: number, archivedAt: number | null): Memo => ({ id, title: "t", body: "b", project: null, tags: [], parentId: null, author: "app", createdAt: 1, updatedAt: 1, archivedAt });
  const fakeDb = (seed: Memo[], pendingIds: number[] = []) => {
    const m = new Map(seed.map((x) => [x.id, x]));
    const p = new Map(pendingIds.map((id) => [id, { id, base: 1 } as PendingChange]));
    const db: MemoDb = {
      allMemos: async () => [...m.values()],
      getMemo: async (id) => m.get(id),
      putMemo: async (x) => void m.set(x.id, x),
      deleteMemo: async (id) => void m.delete(id),
      allPending: async () => [...p.values()],
      putPending: async (x) => void p.set(x.id, x),
      deletePending: async (id) => void p.delete(id),
      getLastSync: async () => 0,
      setLastSync: async () => {},
    };
    return { db, m };
  };
  const noApi = {} as MemoApi;

  test("取ってきたアーカイブは写さない。写しがあれば消す。戻したら入る", async () => {
    const { db, m } = fakeDb([memo(1, null)]);
    const s = new MemoSync(db, noApi);
    expect(await s.adopt(memo(1, 5))).toBe(true);
    expect(m.has(1)).toBe(false);
    await s.adopt(memo(2, 5));
    expect(m.has(2)).toBe(false);
    await s.adopt(memo(1, null));
    expect(m.has(1)).toBe(true);
  });

  test("前の版で入れたアーカイブを片付ける。送っていない変更があるものは残す", async () => {
    const { db, m } = fakeDb([memo(1, 5), memo(2, 5), memo(3, null)], [2]);
    await new MemoSync(db, noApi).purgeArchived();
    expect([...m.keys()]).toEqual([2, 3]);
  });
});
