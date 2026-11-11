import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { config } from "../src/server/config";
import { Hub } from "../src/server/hub";
import { FixtureSource } from "../src/server/kanban";
import { MemoStore, memoTitle, normalizeTags } from "../src/server/memos";
import { Store } from "../src/server/store";
import type { Memo, MemoEvent, MemoList } from "../src/shared/types";

const fresh = () => new MemoStore(new Store(":memory:").db);

describe("memos", () => {
  test("SQLite の一時ファイルをディスクに作らない（本番は /var/tmp に書けない）", () => {
    expect(new Store(":memory:").db.query("PRAGMA temp_store").get()).toEqual({ temp_store: 2 });
  });

  test("タグは # を外して重複を除く・題が空なら本文の最初の行", () => {
    expect(normalizeTags(["#旅", "旅", "  宿  の 予約 ", "", 3])).toEqual(["旅", "宿 の 予約"]);
    expect(memoTitle("", "\n# 夏の旅行\n本文")).toBe("夏の旅行");
    expect(memoTitle("  ", "")).toBe("無題のメモ");
  });

  test("ピン留めは一覧の先頭・アーカイブで外れる・外すと元の並び", () => {
    const s = fresh();
    const a = s.create({ title: "古い" }, "app", 1000);
    const b = s.create({ title: "新しい" }, "app", 2000);
    expect(s.list().memos.map((m) => m.id)).toEqual([b.id, a.id]);
    const p = s.setPinned(a.id, true, 3000);
    expect(p.pinnedAt).toBe(3000);
    expect(s.list().memos.map((m) => [m.id, m.pinned])).toEqual([[a.id, true], [b.id, false]]);
    // 同期に載るよう更新時刻が進む
    expect(s.changedSince(3000).map((m) => m.id)).toEqual([a.id]);
    s.setPinned(a.id, false, 4000);
    expect(s.list().memos.map((m) => m.id)).toEqual([a.id, b.id]);
    s.setPinned(a.id, true, 5000);
    s.setArchived(a.id, true, "app", 6000);
    expect(s.get(a.id)!.pinnedAt).toBeNull();
    expect(() => s.setPinned(a.id, true)).toThrow("アーカイブ");
  });

  test("削除は履歴・タグ・検索から消し、子は親へ繋ぎ直し、削除の印が同期に出る", () => {
    const s = fresh();
    const top = s.create({ title: "親", tags: ["旅"] }, "app", 1000);
    const mid = s.create({ title: "間", parentId: top.id }, "app", 2000);
    const leaf = s.create({ title: "子", parentId: mid.id }, "app", 3000);
    s.delete(mid.id, 4000);
    expect(s.get(mid.id)).toBeNull();
    expect(() => s.history(mid.id)).toThrow();
    expect(s.get(leaf.id)).toMatchObject({ parentId: top.id, updatedAt: 4000 });
    expect(s.changedSince(4000).map((m) => m.id)).toEqual([leaf.id]);
    expect(s.deletedSince(4000)).toEqual([mid.id]);
    expect(s.deletedSince(4001)).toEqual([]);
    expect(s.list({ q: "間" }).memos).toEqual([]);
    expect(() => s.delete(mid.id)).toThrow("無い");
    // 親のないメモを消すと子は一番上へ
    s.delete(top.id, 5000);
    expect(s.get(leaf.id)!.parentId).toBeNull();
  });

  test("作る・書き換える・履歴が残る", () => {
    const s = fresh();
    const m = s.create({ title: "宿", body: "京都の宿", project: "夏の旅行", tags: ["旅", "予約"] }, "app", 1000);
    expect(m).toMatchObject({ title: "宿", project: "夏の旅行", tags: ["旅", "予約"], author: "app", updatedAt: 1000 });
    const u = s.update(m.id, { body: "奈良の宿", tags: ["旅"], baseUpdatedAt: 1000 }, "app", 2000);
    expect(u).toMatchObject({ body: "奈良の宿", project: "夏の旅行", tags: ["旅"], updatedAt: 2000 });
    expect(s.history(m.id).map((e) => [e.kind, e.body])).toEqual([["edit", "奈良の宿"], ["create", "京都の宿"]]);
  });

  test("変わっていなければ版を増やさない・古い版からの保存は 409", () => {
    const s = fresh();
    const m = s.create({ body: "a" }, "app", 1000);
    expect(s.update(m.id, { body: "a", tags: [] }, "app", 2000).updatedAt).toBe(1000);
    s.update(m.id, { body: "b" }, "app", 2000);
    expect(() => s.update(m.id, { body: "c", baseUpdatedAt: 1000 }, "app", 3000)).toThrow(/ほかで書き換え/);
  });

  test("題も本文も空なら作れない", () => {
    expect(() => fresh().create({ title: " ", body: "  " }, "app")).toThrow(/題か本文/);
  });

  test("一覧: プロジェクト・タグ・語で絞る、アーカイブは別", () => {
    const s = fresh();
    const a = s.create({ title: "宿の予約", body: "奈良 100%", project: "夏の旅行", tags: ["旅"] }, "app", 1000);
    s.create({ title: "PR の確認", body: "Hermes のメモ", project: "Hermes", tags: ["開発"] }, "app", 2000);
    s.create({ title: "買い物", body: "牛乳", tags: ["旅"] }, "app", 3000);
    expect(s.list().memos.map((m) => m.title)).toEqual(["買い物", "PR の確認", "宿の予約"]);
    expect(s.list({ project: "夏の旅行" }).memos.map((m) => m.id)).toEqual([a.id]);
    expect(s.list({ project: "" }).memos.map((m) => m.title)).toEqual(["買い物"]);
    expect(s.list({ tag: "旅" }).memos.length).toBe(2);
    expect(s.list({ q: "奈良 宿" }).memos.map((m) => m.id)).toEqual([a.id]);
    expect(s.list({ q: "夏の" }).memos.map((m) => m.id)).toEqual([a.id]); // プロジェクト名でも当たる
    expect(s.list({ q: "100%" }).memos.length).toBe(1);
    expect(s.list({ q: "%" }).memos.length).toBe(1); // % はそのままの文字として探す
    s.setArchived(a.id, true, "app", 4000);
    const l = s.list();
    expect(l.memos.length).toBe(2);
    expect(l.projects).toEqual([{ name: "Hermes", count: 1 }]);
    expect(l.tags).toEqual([{ name: "旅", count: 1 }, { name: "開発", count: 1 }]);
    expect(s.list({ archived: true }).memos.map((m) => [m.id, m.archived])).toEqual([[a.id, true]]);
    s.setArchived(a.id, false, "app", 5000);
    expect(s.history(a.id).map((e) => e.kind)).toEqual(["restore", "archive", "create"]);
  });
});

describe("memos API", () => {
  const setup = () => {
    const store = new Store(":memory:");
    const hub = new Hub({ ...config, devNoAuth: true }, new FixtureSource(join(import.meta.dir, "../fixtures/board.json")), store, null, null);
    const app = createApp({ ...config, devNoAuth: true }, hub, store, ".", { memos: new MemoStore(store.db) });
    const call = (method: string, path: string, body?: unknown) =>
      app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { call };
  };

  test("作って・読んで・書き換えて・アーカイブ", async () => {
    const { call } = setup();
    const created = (await (await call("POST", "/api/memos", { body: "# 見出し\n本文", project: "P", tags: ["x"] })).json()) as Memo;
    expect(created.title).toBe("見出し");
    expect(((await (await call("GET", `/api/memos/${created.id}`)).json()) as Memo).tags).toEqual(["x"]);
    const r = await call("PUT", `/api/memos/${created.id}`, { body: "変えた", baseUpdatedAt: created.updatedAt });
    expect(r.status).toBe(200);
    const stale = await call("PUT", `/api/memos/${created.id}`, { body: "古い", baseUpdatedAt: created.updatedAt });
    expect(stale.status).toBe(409);
    expect((await call("POST", `/api/memos/${created.id}/archive`)).status).toBe(200);
    expect(((await (await call("GET", "/api/memos")).json()) as MemoList).memos).toEqual([]);
    expect(((await (await call("GET", "/api/memos?archived=1")).json()) as MemoList).memos.length).toBe(1);
    expect(((await (await call("GET", `/api/memos/${created.id}/history`)).json()) as MemoEvent[]).map((e) => e.kind)).toEqual(["archive", "edit", "create"]);
  });

  test("不正な ID・無いメモ・空のメモ", async () => {
    const { call } = setup();
    expect((await call("GET", "/api/memos/abc")).status).toBe(400);
    expect((await call("GET", "/api/memos/99")).status).toBe(404);
    expect((await call("PUT", "/api/memos/99", { body: "x" })).status).toBe(404);
    expect((await call("POST", "/api/memos", { body: "" })).status).toBe(400);
  });
});

describe("一覧の抜き出し", () => {
  test("Markdown の記号を落とす", () => {
    const { excerptOf } = require("../src/server/memos") as typeof import("../src/server/memos");
    expect(excerptOf("## 候補\n- **A 宿** — 駅前\n- [x] 確認した\n> 寒い\n[Booking](https://b.com) で `14時`\n```bash\nls\n```")).toBe("候補 A 宿 — 駅前 確認した 寒い Booking で 14時 ls");
  });
});

describe("同期用の取得", () => {
  test("この時刻以降に変わったメモを全文で返す。アーカイブも含む", () => {
    const db = new Database(":memory:");
    const s = new MemoStore(db);
    const a = s.create({ title: "古い", body: "本文" }, "app", 1000);
    const b = s.create({ title: "新しい", body: "本文2" }, "app", 2000);
    s.setArchived(b.id, true, "app", 3000);
    expect(s.changedSince(1500).map((m) => m.id)).toEqual([b.id]);
    expect(s.changedSince(1500)[0].archivedAt).toBe(3000);
    expect(s.changedSince(0).map((m) => m.body)).toEqual(["本文", "本文2"]);
    expect(a.id).not.toBe(b.id);
  });
});
