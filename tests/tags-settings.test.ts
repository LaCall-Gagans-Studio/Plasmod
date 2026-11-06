import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { config } from "../src/server/config";
import { Hub } from "../src/server/hub";
import { FixtureSource } from "../src/server/kanban";
import { MemoStore } from "../src/server/memos";
import { ProjectStore } from "../src/server/projects";
import { Store } from "../src/server/store";
import { TaskStore } from "../src/server/tasks";

const setup = () => {
  const store = new Store(":memory:");
  const memos = new MemoStore(store.db);
  const tasks = new TaskStore(store.db);
  return { store, memos, tasks, projects: new ProjectStore(store.db, memos, tasks) };
};

describe("タスクのタグ", () => {
  test("作る・書き換える・タグで絞る・記録に残る", () => {
    const { tasks } = setup();
    const t = tasks.create({ title: "a", tags: ["#旅", "旅", "予約"] }, "app");
    expect(t.tags.sort()).toEqual(["予約", "旅"]);
    tasks.create({ title: "b", tags: ["開発"] }, "app");
    expect(tasks.view({ tag: "旅" }).tasks.map((x) => x.title)).toEqual(["a"]);
    const u = tasks.update(t.id, { tags: ["旅"] }, "app");
    expect(u.tags).toEqual(["旅"]);
    expect(tasks.events(t.id)[0].text).toContain("タグ → #旅");
  });

  test("古いデータベース（タグ・親・番号の列が無い）でも起動できる", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE memo_projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, source_key TEXT, url TEXT, agent TEXT, propose TEXT NOT NULL DEFAULT '[]', project_id INTEGER, due TEXT, created_by TEXT NOT NULL, kanban_id TEXT, event_at INTEGER, decided_at INTEGER, inbox_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO tasks (title, body, kind, status, source, created_by, inbox_at, created_at, updated_at) VALUES ('古い', '', 'todo', 'todo', 'app', 'app', 1, 1, 1);`);
    const t = new TaskStore(db);
    expect(t.list({ status: ["todo"] })[0]).toMatchObject({ title: "古い", tags: [], parentId: null, ref: null });
  });
});

describe("プロジェクトとタグの設定", () => {
  test("タグの名前を変える（同じ名前があればまとめる）・外す。メモとタスクの両方に効く", () => {
    const { memos, tasks, projects } = setup();
    const m = memos.create({ title: "m", tags: ["旅行"] }, "app");
    const t = tasks.create({ title: "t", tags: ["旅行", "旅"] }, "app");
    expect(projects.tags()).toEqual([{ name: "旅行", memos: 1, tasks: 1 }, { name: "旅", memos: 0, tasks: 1 }]);
    projects.renameTag("旅行", "旅");
    expect(memos.get(m.id)!.tags).toEqual(["旅"]);
    expect(tasks.get(t.id)!.tags).toEqual(["旅"]);
    projects.removeTag("旅");
    expect(projects.tags()).toEqual([]);
  });

  test("プロジェクトをまとめる（説明を引き継ぐ）・空なら消せる・残っていれば断る", () => {
    const { memos, tasks, projects } = setup();
    const a = projects.create({ name: "旧", description: "旧の説明" });
    const b = projects.create({ name: "新" });
    tasks.create({ title: "t", project: "旧" }, "app");
    memos.create({ title: "m", project: "旧" }, "app");
    expect(() => projects.remove(a.id)).toThrow(/残っている/);
    const merged = projects.merge(a.id, b.id);
    expect(merged).toMatchObject({ name: "新", openTasks: 1, memos: 1, description: "旧の説明" });
    expect(projects.get(a.id)).toBeNull();
    const c = projects.create({ name: "空" });
    projects.remove(c.id);
    expect(projects.get(c.id)).toBeNull();
    expect(() => projects.merge(b.id, b.id)).toThrow(/同じ/);
  });

  test("API: 設定の一覧・タグの変更と外す・まとめる・消す・タスクのタグ", async () => {
    const { store, memos, tasks, projects } = setup();
    const hub = new Hub({ ...config, devNoAuth: true }, new FixtureSource(join(import.meta.dir, "../fixtures/board.json")), store, null, null);
    const app = createApp({ ...config, devNoAuth: true }, hub, store, ".", { memos, tasks, projects });
    const call = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await (await call("POST", "/api/apptasks", { title: "x", tags: ["a"] })).json();
    expect(t.tags).toEqual(["a"]);
    expect((await (await call("PATCH", `/api/apptasks/${t.id}`, { tags: ["a", "b"] })).json()).tags.sort()).toEqual(["a", "b"]);
    expect((await (await call("GET", "/api/apptasks?tag=b")).json()).tasks.length).toBe(1);
    expect((await (await call("PATCH", "/api/tags", { from: "b", to: "c" })).json()).tags.map((x: { name: string }) => x.name).sort()).toEqual(["a", "c"]);
    expect((await (await call("DELETE", "/api/tags?name=a")).json()).tags.map((x: { name: string }) => x.name)).toEqual(["c"]);
    const p1 = await (await call("POST", "/api/projects", { name: "P1" })).json();
    const p2 = await (await call("POST", "/api/projects", { name: "P2" })).json();
    expect((await call("POST", `/api/projects/${p1.id}/merge`, { into: p2.id })).status).toBe(200);
    expect((await call("DELETE", `/api/projects/${p2.id}`)).status).toBe(200);
    expect((await (await call("GET", "/api/projects-settings")).json()).projects).toEqual([]);
  });
});
