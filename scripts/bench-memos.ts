// 端末のメモ保存の測定。前（全件 getAll → localList）と後（索引で LIST_LIMIT 件）を、同じ件数・同じ本文量で比べる。
// 使い方: bun scripts/bench-memos.ts [件数,件数,...]   （既定 78,2000,5000,20000。本文は約11KB/件）
// fake-indexeddb（メモリ上の実装）なので絶対値は実機と違う。同じ測り方の前後の比として読む。
import { IDBFactory } from "fake-indexeddb";
import type { Memo } from "../src/shared/types";
import { createIdb, rowOf } from "../src/web/memo-idb";
import { localList } from "../src/web/memo-sync";

const sizes = (process.argv[2] ?? "78,2000,5000,20000").split(",").map(Number);
const BODY = 11_000;
const words = ["会議", "議事録", "設計", "買い物", "旅行", "メモ", "確認", "予定", "仕様", "調査"];

function makeMemo(i: number): Memo {
  let body = "";
  for (let k = i; body.length < BODY; k += 7) body += `${words[k % words.length]}${k}について。`;
  return { id: i, title: `メモ ${i} ${words[i % words.length]}`, body, project: i % 5 ? `PJ${i % 5}` : null, tags: [`t${i % 8}`], parentId: null, author: "app", createdAt: i, updatedAt: i * 1000, archivedAt: null };
}

async function seed(f: IDBFactory, n: number) {
  const db = createIdb(f);
  await db.getLastSync(); // 開く
  const d = await new Promise<IDBDatabase>((ok) => ((r) => (r.onsuccess = () => ok(r.result)))(f.open("plasmod-memos", 2)));
  await new Promise<void>((ok) => {
    const t = d.transaction(["memos", "summaries", "meta"], "readwrite");
    const f = { projects: {} as Record<string, number>, tags: {} as Record<string, number> };
    for (let i = 1; i <= n; i++) {
      const m = makeMemo(i);
      t.objectStore("memos").put(m);
      t.objectStore("summaries").put(rowOf(m));
      if (m.project) f.projects[m.project] = (f.projects[m.project] ?? 0) + 1;
      for (const g of m.tags) f.tags[g] = (f.tags[g] ?? 0) + 1;
    }
    t.objectStore("meta").put(f, "facets");
    t.oncomplete = () => ok();
  });
  return { db, raw: d };
}

async function time<T>(fn: () => Promise<T>, reps = 3): Promise<number> {
  const ts: number[] = [];
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    await fn();
    ts.push(performance.now() - t0);
  }
  return Math.round(ts.sort((a, b) => a - b)[Math.floor(reps / 2)]);
}

const rows: Record<string, string | number>[] = [];
for (const n of sizes) {
  const f = new IDBFactory();
  const { db, raw } = await seed(f, n);
  const getAll = () => new Promise<Memo[]>((ok) => ((r) => (r.onsuccess = () => ok(r.result)))(raw.transaction("memos").objectStore("memos").getAll()));
  // 前: 全件の写し（本文込み）を読んで、全件を絞って並べる。同期のたびの purgeArchived も同じ getAll
  const before = {
    list: () => getAll().then((all) => localList(all, {})),
    searchHit: () => getAll().then((all) => localList(all, { q: "議事録" })),
    searchMiss: () => getAll().then((all) => localList(all, { q: "存在しない語zzz" })),
    purge: () => getAll().then((all) => all.filter((m) => m.archivedAt).length),
  };
  const after = {
    list: () => db.listLocal({}),
    searchHit: () => db.listLocal({ q: "議事録" }),
    searchMiss: () => db.listLocal({ q: "存在しない語zzz" }),
    purge: () => db.archivedIds(),
  };
  for (const k of ["list", "searchHit", "searchMiss", "purge"] as const) {
    rows.push({ 件数: n, 操作: { list: "一覧", searchHit: "検索(多く当たる語)", searchMiss: "検索(当たらない語)", purge: "同期の掃除" }[k], 前ms: await time(before[k]), 後ms: await time(after[k]) });
  }
  raw.close();
}
console.table(rows);
console.log("| 件数 | 操作 | 前 ms | 後 ms |\n|---|---|---|---|\n" + rows.map((r) => `| ${r.件数} | ${r.操作} | ${r.前ms} | ${r.後ms} |`).join("\n"));
