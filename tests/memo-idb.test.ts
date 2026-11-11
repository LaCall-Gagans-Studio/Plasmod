import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import type { Memo } from "../src/shared/types";
import { createIdb, LIST_LIMIT } from "../src/web/memo-idb";
import { localList } from "../src/web/memo-sync";

const memo = (id: number, p: Partial<Memo> = {}): Memo => ({ id, title: `題${id}`, body: `本文${id}`, project: null, tags: [], parentId: null, author: "app", createdAt: 1, updatedAt: id, archivedAt: null, ...p });

describe("端末の保存（IndexedDB）", () => {
  test("一覧は全件を読む基準の localList と同じ結果になる", async () => {
    const db = createIdb(new IDBFactory());
    const all = [
      memo(1, { project: "A", tags: ["x"] }),
      memo(2, { body: "東京の話", updatedAt: 9 }),
      memo(3, { archivedAt: 5, project: "B" }),
      memo(4, { project: "A", tags: ["x", "y"], parentId: 1, updatedAt: 7 }),
    ];
    for (const m of all) await db.putMemo(m);
    for (const o of [{}, { q: "東京" }, { project: "A" }, { project: "" }, { tag: "x" }, { archived: true }, { parent: 1 }, { q: "#4" }, { q: "なにもない" }]) {
      expect(await db.listLocal(o)).toEqual(localList(all, o, LIST_LIMIT));
    }
    expect(await db.archivedIds()).toEqual([3]);
    await db.putMemo(memo(3, { archivedAt: null }));
    expect(await db.archivedIds()).toEqual([]);
    await db.deleteMemo(2);
    expect((await db.listLocal({})).memos.map((m) => m.id)).toEqual([4, 3, 1]);
  });

  test("一覧は LIST_LIMIT 件で止まる（探すときも）。数え上げは全件", async () => {
    const db = createIdb(new IDBFactory());
    for (let i = 1; i <= LIST_LIMIT + 50; i++) await db.putMemo(memo(i, { project: "P", body: "共通の語" }));
    const l = await db.listLocal({});
    expect(l.memos).toHaveLength(LIST_LIMIT);
    expect(l.memos[0].id).toBe(LIST_LIMIT + 50);
    expect(l.projects).toEqual([{ name: "P", count: LIST_LIMIT + 50 }]);
    expect((await db.listLocal({ q: "共通" })).memos).toHaveLength(LIST_LIMIT);
  });

  test("v1 の保存から開くと、軽い一覧が作られる", async () => {
    const f = new IDBFactory();
    await new Promise<void>((ok, ng) => {
      const r = f.open("plasmod-memos", 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("memos", { keyPath: "id" }).put(memo(5, { project: "A" }));
        r.result.createObjectStore("pending", { keyPath: "id" });
        r.result.createObjectStore("meta");
      };
      r.onsuccess = () => (r.result.close(), ok());
      r.onerror = () => ng(r.error);
    });
    const db = createIdb(f);
    expect((await db.listLocal({})).memos.map((m) => m.id)).toEqual([5]);
    expect((await db.listLocal({ q: "本文" })).memos.map((m) => m.id)).toEqual([5]);
    expect((await db.listLocal({})).projects).toEqual([{ name: "A", count: 1 }]);
  });
});
