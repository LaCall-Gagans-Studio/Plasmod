import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { config } from "../src/server/config";
import { Hub } from "../src/server/hub";
import { FixtureSource } from "../src/server/kanban";
import { MEMO_BOX_HTML } from "../src/server/memo-box";
import { MemoStore } from "../src/server/memos";
import { Store } from "../src/server/store";
import { TaskStore } from "../src/server/tasks";
import { memoIdOf, memoLinkText, memoRef } from "../src/shared/memo-ref";
import { buildLivePreview, focusEffect, isExternalHref, isMemoHash, memoExtensions } from "../src/web/live-preview";
import { localList } from "../src/web/memo-sync";

const widgets = (s: EditorState) => {
  const out: string[] = [];
  buildLivePreview(s).between(0, s.doc.length, (from, to, d) => {
    const w = (d.spec as { widget?: { constructor: { name: string } } }).widget;
    if (w) out.push(`${w.constructor.name}:${s.doc.sliceString(from, to)}`);
  });
  return out;
};

describe("メモとタスクのつながり（エディタ）", () => {
  const DOC = "- [ ] 牛乳を買う\n関連 [[TASK-5]] を見る";
  test("[[TASK-5]] はカーソルの無い行でチップに。カーソルがあれば文字のまま", () => {
    const s = EditorState.create({ doc: DOC, extensions: memoExtensions(() => {}, "") });
    expect(widgets(s)).toContain("TaskRefWidget:[[TASK-5]]");
    const on = s.update({ effects: focusEffect.of(true), selection: EditorSelection.cursor(DOC.indexOf("[[") + 2) }).state;
    expect(widgets(on).some((w) => w.startsWith("TaskRefWidget"))).toBe(false);
  });

  test("チェックの行にカーソルがあると「タスクにする」。タスクにする関数が無い・もう番号がある行には出さない", () => {
    const mk = async () => "TASK-9";
    const s = EditorState.create({ doc: DOC, extensions: memoExtensions(() => {}, "", mk) });
    const on = s.update({ effects: focusEffect.of(true), selection: EditorSelection.cursor(3) }).state;
    expect(widgets(on)).toContain("TaskifyWidget:");
    const none = EditorState.create({ doc: DOC, extensions: memoExtensions(() => {}, "") }).update({ effects: focusEffect.of(true), selection: EditorSelection.cursor(3) }).state;
    expect(widgets(none).some((w) => w.startsWith("TaskifyWidget"))).toBe(false);
    const done = EditorState.create({ doc: "- [ ] 牛乳 [[TASK-9]]", extensions: memoExtensions(() => {}, "", mk) }).update({ effects: focusEffect.of(true), selection: EditorSelection.cursor(3) }).state;
    expect(widgets(done).some((w) => w.startsWith("TaskifyWidget"))).toBe(false);
  });
});

describe("タスクに触れているメモ（API）", () => {
  test("本文に [[番号]] があるメモだけが出る（TASK-1 と TASK-12 を取り違えない）", async () => {
    const store = new Store(":memory:");
    const memos = new MemoStore(store.db);
    const tasks = new TaskStore(store.db);
    const hub = new Hub({ ...config, devNoAuth: true }, new FixtureSource(join(import.meta.dir, "../fixtures/board.json")), store, null, null);
    const app = createApp({ ...config, devNoAuth: true }, hub, store, ".", { memos, tasks });
    const t = tasks.create({ title: "x" }, "app");
    for (let i = 0; i < 11; i++) tasks.create({ title: `y${i}` }, "app");
    memos.create({ title: "触れている", body: `進め方は [[${t.ref}]] を見る` }, "app");
    memos.create({ title: "別", body: "[[TASK-12]]" }, "app");
    const d = await (await app.request(`/api/apptasks/${t.id}`)).json();
    expect(t.ref).toBe("TASK-1");
    expect(d.memos.map((m: { title: string }) => m.title)).toEqual(["触れている"]);
  });
});

describe("メモからメモへのつながり", () => {
  const setup = () => {
    const store = new Store(":memory:");
    const memos = new MemoStore(store.db);
    const tasks = new TaskStore(store.db);
    const hub = new Hub({ ...config, devNoAuth: true }, new FixtureSource(join(import.meta.dir, "../fixtures/board.json")), store, null, null);
    return { memos, tasks, app: createApp({ ...config, devNoAuth: true }, hub, store, ".", { memos, tasks }) };
  };

  test("番号の読み書き。形の違うものは受けない", () => {
    expect(memoRef(9)).toBe("MEMO-9");
    expect(memoRef(-3)).toBeNull();
    expect(memoIdOf("MEMO-9")).toBe(9);
    expect(memoIdOf("memo-9")).toBe(9);
    for (const bad of ["MEMO-09", "MEMO-0", "MEMO-", "TASK-9", "[[MEMO-9]]"]) expect(memoIdOf(bad)).toBeNull();
  });

  test("チェックの行の [[MEMO-9]] はタスクの印にならず、「タスクにする」が残る", () => {
    const mk = async () => "TASK-9";
    const doc = "- [ ] 読む [[MEMO-9]]\n別の行";
    const s = EditorState.create({ doc, extensions: memoExtensions(() => {}, "", mk) });
    const on = s.update({ effects: focusEffect.of(true), selection: EditorSelection.cursor(3) }).state;
    expect(widgets(on)).toContain("TaskifyWidget:");
    const off = s.update({ effects: focusEffect.of(true), selection: EditorSelection.cursor(doc.length) }).state;
    expect(widgets(off)).toContain("TaskRefWidget:[[MEMO-9]]");
  });

  test("バッジ: メモの題とリンク・アーカイブ・無い番号。タスクはそのまま", async () => {
    const { memos, tasks, app } = setup();
    const a = memos.create({ title: "宿の比較", body: "x" }, "app");
    const b = memos.create({ title: "古い", body: "x" }, "app");
    memos.setArchived(b.id, true, "app");
    const t = tasks.create({ title: "予約" }, "app");
    const { issues } = await (await app.request(`/api/apptasks-badges?ids=MEMO-${a.id},MEMO-${b.id},MEMO-404,${t.ref}`)).json();
    expect(issues[`MEMO-${a.id}`]).toEqual({ id: `MEMO-${a.id}`, title: "宿の比較", url: `#/memo/${a.id}`, state: "メモ", stateType: "backlog" });
    expect(issues[`MEMO-${b.id}`]).toMatchObject({ state: "アーカイブ", stateType: "canceled" });
    expect(issues["MEMO-404"]).toBeNull();
    expect(issues[t.ref!]).toMatchObject({ title: "予約", url: `#/todo/${t.id}` });
  });

  test("逆引き: [[MEMO-1]] は MEMO-12 を指すメモと取り違えない", () => {
    const { memos } = setup();
    const target = memos.create({ title: "先", body: "x" }, "app");
    expect(target.id).toBe(1);
    memos.create({ title: "触れている", body: "前提は [[MEMO-1]] を見る" }, "app");
    memos.create({ title: "別", body: "[[MEMO-12]]" }, "app");
    expect(memos.list({ q: memoLinkText(1) }).memos.map((m) => m.title)).toEqual(["触れている"]);
  });

  test("番号で探す: メモの一覧・全体検索でそのメモが一番上（本文で触れているものも出る）", async () => {
    const { memos, app } = setup();
    const target = memos.create({ title: "先", body: "x" }, "app", 1000);
    memos.create({ title: "触れている", body: `[[MEMO-${target.id}]]` }, "app", 2000);
    memos.create({ title: "無関係", body: "y" }, "app", 3000);
    expect(memos.list({ q: `MEMO-${target.id}` }).memos.map((m) => m.title)).toEqual(["先", "触れている"]);
    const hits = await (await app.request(`/api/search?q=MEMO-${target.id}`)).json();
    expect(hits[0]).toMatchObject({ kind: "memo", ref: String(target.id), title: "先" });
    memos.setArchived(target.id, true, "app");
    const again = await (await app.request(`/api/search?q=MEMO-${target.id}`)).json();
    expect(again[0]).toMatchObject({ kind: "memo", ref: String(target.id) });
  });

  test("端末の一覧でも同じ（オフライン）", () => {
    const base = { body: "", project: null, tags: [], parentId: null, author: "app", createdAt: 1, archivedAt: null };
    const all = [
      { ...base, id: 1, title: "先", updatedAt: 1 },
      { ...base, id: 2, title: "触れている", body: "[[MEMO-1]]", updatedAt: 2 },
      { ...base, id: 3, title: "無関係", updatedAt: 3 },
    ];
    expect(localList(all, { q: "MEMO-1" }).memos.map((m) => m.id)).toEqual([1, 2]);
    expect(localList(all, { q: "[[MEMO-1]]" }).memos.map((m) => m.id)).toEqual([2]);
  });
});

describe("メモの写真", () => {
  const URL = "https://upload.wikimedia.org/a_(b).jpg";
  const DOC = `前の行\n![モスク](${URL})\n後ろの行`;
  test("https の ![名前](URL) はカーソルの無い行で写真に。カーソルがあれば文字のまま", () => {
    const s = EditorState.create({ doc: DOC, extensions: memoExtensions(() => {}, "") });
    expect(widgets(s)).toContain(`ImageWidget:![モスク](${URL})`);
    const on = s.update({ effects: focusEffect.of(true), selection: EditorSelection.cursor(DOC.indexOf("!")) }).state;
    expect(widgets(on).some((w) => w.startsWith("ImageWidget"))).toBe(false);
  });

  test("https 以外は写真にしない", () => {
    for (const u of ["http://example.com/a.jpg", "javascript:alert(1)", "/api/x.png"]) {
      const s = EditorState.create({ doc: `![x](${u})`, extensions: memoExtensions(() => {}, "") });
      expect(widgets(s).some((w) => w.startsWith("ImageWidget"))).toBe(false);
    }
  });
});

describe("メモの html の箱", () => {
  const DOC = "前\n```html\n<b>x</b>\n```\n後";
  test("カーソルが無ければ枠に。箱に触れていれば文字のまま。ほかの言語は箱にしない", () => {
    const s = EditorState.create({ doc: DOC, extensions: memoExtensions(() => {}, "") });
    expect(widgets(s)).toContain("HtmlBoxWidget:```html\n<b>x</b>\n```");
    const on = s.update({ effects: focusEffect.of(true), selection: EditorSelection.cursor(DOC.indexOf("<b>")) }).state;
    expect(widgets(on).some((w) => w.startsWith("HtmlBoxWidget"))).toBe(false);
    const js = EditorState.create({ doc: "```js\n1\n```", extensions: memoExtensions(() => {}, "") });
    expect(widgets(js).some((w) => w.startsWith("HtmlBoxWidget"))).toBe(false);
  });

  test("箱から開けるのは別のメモだけ", () => {
    expect(isMemoHash("#/memo/18")).toBe(true);
    for (const bad of ["#/root/1", "#/memo/1/x", "https://example.com", "#/settings", 18, null]) expect(isMemoHash(bad)).toBe(false);
  });

  test("枠のページ: 外へ通信できない CSP で、自分の画面の中にだけ入れられる", async () => {
    const store = new Store(":memory:");
    const hub = new Hub({ ...config, devNoAuth: true }, new FixtureSource(join(import.meta.dir, "../fixtures/board.json")), store, null, null);
    const app = createApp({ ...config, devNoAuth: true }, hub, store, ".", { memos: new MemoStore(store.db) });
    const r = await app.request("/memo-box");
    const csp = r.headers.get("Content-Security-Policy") ?? "";
    expect(r.status).toBe(200);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("img-src data: blob: https:;");
    expect(csp).toContain("script-src 'unsafe-inline';");
    expect(csp).not.toMatch(/script-src[^;]*https:/);
    expect(r.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });
});

describe("メモのネスト", () => {
  const fresh = () => {
    const store = new Store(":memory:");
    const memos = new MemoStore(store.db);
    const hub = new Hub({ ...config, devNoAuth: true }, new FixtureSource(join(import.meta.dir, "../fixtures/board.json")), store, null, null);
    return { memos, app: createApp({ ...config, devNoAuth: true }, hub, store, ".", { memos }) };
  };
  const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  test("親を付けて作る・子の一覧・親を外す", async () => {
    const { memos, app } = fresh();
    const p = memos.create({ title: "親", body: "x" }, "app");
    const c = await (await post(app, "/api/memos", { title: "子", body: "y", parentId: p.id })).json();
    expect(c.parentId).toBe(p.id);
    memos.create({ title: "別", body: "z" }, "app");
    const l = await (await app.request(`/api/memos?parent=${p.id}`)).json();
    expect(l.memos.map((m: { title: string }) => m.title)).toEqual(["子"]);
    expect(l.memos[0].parentId).toBe(p.id);
    const off = await (await post(app, `/api/memos/${c.id}/parent`, { parent: null })).json();
    expect(off.parentId).toBeNull();
  });

  test("自分や子孫は親にできない。無い親・不正な指定は断る", async () => {
    const { memos, app } = fresh();
    const a = memos.create({ title: "a", body: "x" }, "app");
    const b = memos.create({ title: "b", body: "x", parentId: a.id }, "app");
    const c = memos.create({ title: "c", body: "x", parentId: b.id }, "app");
    expect((await post(app, `/api/memos/${a.id}/parent`, { parent: a.id })).status).toBe(400);
    expect((await post(app, `/api/memos/${a.id}/parent`, { parent: c.id })).status).toBe(400);
    expect((await post(app, `/api/memos/${a.id}/parent`, { parent: 9999 })).status).toBe(404);
    expect((await post(app, `/api/memos/${a.id}/parent`, { parent: "1" })).status).toBe(400);
    expect(memos.get(a.id)!.parentId).toBeNull();
  });

  test("親を変えると更新時刻が進み、同期に載る。本文を変えても親は残る", () => {
    const { memos } = fresh();
    const p = memos.create({ title: "親", body: "x" }, "app", 1000);
    const c = memos.create({ title: "子", body: "y" }, "app", 1000);
    const moved = memos.setParent(c.id, p.id, 2000);
    expect(moved.updatedAt).toBe(2000);
    expect(memos.changedSince(1500).map((m) => m.id)).toEqual([c.id]);
    expect(memos.update(c.id, { body: "z" }, "app", 3000).parentId).toBe(p.id);
  });

  test("オフラインで作ったメモの親が消えていても、書いた分は作られる", () => {
    const { memos } = fresh();
    expect(memos.create({ title: "子", body: "y", parentId: 9999 }, "app").parentId).toBeNull();
  });

  test("古い DB に列を足せる", () => {
    const store = new Store(":memory:");
    store.db.exec("CREATE TABLE memos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, project_id INTEGER, author TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER)");
    store.db.exec("INSERT INTO memos (title, body, author, created_at, updated_at) VALUES ('古い', 'x', 'app', 1, 1)");
    expect(new MemoStore(store.db).get(1)!.parentId).toBeNull();
  });

  test("端末の一覧でも子だけに絞れる", () => {
    const base = { body: "", project: null, tags: [], author: "app", createdAt: 1, archivedAt: null, updatedAt: 1 };
    const all = [{ ...base, id: 1, title: "親", parentId: null }, { ...base, id: 2, title: "子", parentId: 1 }];
    expect(localList(all, { parent: 1 }).memos.map((m) => m.id)).toEqual([2]);
  });
});

test("一覧の抜粋に html の箱の中身を出さない", () => {
  const store = new Store(":memory:");
  const memos = new MemoStore(store.db);
  const m = memos.create({ title: "題", body: "前書きです。\n\n```html\n<style>a{color:red}</style><b>中</b>\n```\n\n後書き" }, "app");
  expect(memos.list({}).memos.find((x) => x.id === m.id)!.excerpt).toBe("前書きです。 後書き");
  const base = { title: "題", project: null, tags: [], parentId: null, author: "app", createdAt: 1, updatedAt: 1, archivedAt: null };
  expect(localList([{ ...base, id: 1, body: "前\n```html\n<b>中</b>\n```" }]).memos[0].excerpt).toBe("前");
});

test("枠のページのスクリプトは、書き出す中身まで含めて文法が正しい", () => {
  const shim = /<script>([\s\S]*)<\/script>/.exec(MEMO_BOX_HTML)![1];
  let written = "";
  let handler: ((e: unknown) => void) | null = null;
  const parent = { postMessage() {} };
  const doc = { open() {}, write: (h: string) => (written = h), close() {} };
  new Function("addEventListener", "removeEventListener", "parent", "document", shim)((_: string, f: (e: unknown) => void) => (handler = f), () => {}, parent, doc);
  handler!({ source: parent, data: { html: "<b>中</b>", dark: true } });
  expect(written).toContain("<b>中</b>");
  expect(written).toContain("data-theme=dark");
  const inner = /<script>([\s\S]*)<\/script>/.exec(written)![1];
  expect(() => new Function(inner)).not.toThrow();
  expect(inner).toContain("#/memo/");
  // 外部リンクは枠の中で開かず、親に頼む（Android の WebView は枠から別窓を開けない）
  expect(inner).toContain("plasmodBox:'external'");
  expect(inner).not.toContain("_blank");
});

test("枠から開ける外部リンクは https だけ", () => {
  expect(isExternalHref("https://yandex.uz/maps/?text=Registon%20maydoni%20Samarqand")).toBe(true);
  for (const h of ["http://example.com/", "javascript:alert(1)", "intent://x#Intent;end", "data:text/html,x", "#/memo/1", "", null, 1]) expect(isExternalHref(h)).toBe(false);
});
