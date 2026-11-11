import { describe, expect, test } from "bun:test";
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
  const projects = new ProjectStore(store.db, memos, tasks);
  return { store, memos, tasks, projects };
};

describe("プロジェクト（PJ）", () => {
  test("期限切れと3日以内は urgent に入る（サブタスクも。4日先・期日なし・完了は入らない）", () => {
    const { tasks, projects } = setup();
    const now = Date.parse("2026-11-06T03:00:00Z");
    projects.create({ name: "A" }, 1000);
    const parent = tasks.create({ title: "親", project: "A" }, "app");
    const add = (title: string, due: string | null) => tasks.create({ title, project: "A", due }, "app");
    add("切れた", "2026-11-01");
    add("3日後", "2026-11-09");
    add("4日後", "2026-11-10");
    add("期日なし", null);
    const child = add("子で近い", "2026-11-06");
    tasks.setParent(child.id, parent.id, "app");
    const fin = add("完了済み", "2026-11-06");
    tasks.setStatusBy(fin.id, "done", "", "app");
    const a = projects.overview(Infinity, now).projects.find((p) => p.name === "A")!;
    expect(a.urgent.map((t) => t.title).sort()).toEqual(["3日後", "切れた", "子で近い"].sort());
    expect(a.tasks.map((t) => t.title)).not.toContain("子で近い"); // 開いたときは親の下
  });

  test("作る・説明と状態と絵文字・名前の変更はメモとタスクにも効く・同じ名前は 409", () => {
    const { memos, tasks, projects } = setup();
    const p = projects.create({ name: "夏の旅行", emoji: "🧳" }, 1000);
    expect(p).toMatchObject({ name: "夏の旅行", status: "active", emoji: "🧳", description: "" });
    tasks.create({ title: "宿", project: "夏の旅行" }, "app");
    memos.create({ title: "メモ", project: "夏の旅行" }, "app");
    const u = projects.update(p.id, { name: "大いなる夏の旅行", description: "# 計画", status: "paused", baseUpdatedAt: p.updatedAt }, 2000);
    expect(u).toMatchObject({ name: "大いなる夏の旅行", status: "paused", openTasks: 1, memos: 1 });
    expect(tasks.list({ status: ["todo"] })[0].project).toBe("大いなる夏の旅行");
    expect(() => projects.update(p.id, { name: "x", baseUpdatedAt: p.updatedAt }, 3000)).toThrow(/ほかで書き換え/);
    projects.create({ name: "別" });
    expect(() => projects.update(p.id, { name: "別" })).toThrow(/同じ名前/);
    expect(() => projects.create({ name: " " })).toThrow(/名前/);
  });

  test("プロジェクトごとの先頭の枠には、親も開いているサブタスクを数えない（画面で親の下に畳む）", () => {
    const { tasks, projects } = setup();
    const parent = tasks.create({ title: "親", project: "A" }, "app");
    for (let i = 0; i < 4; i++) tasks.create({ title: `子 ${i}`, project: "A", parentId: parent.id, due: "2000-01-01" }, "app");
    tasks.create({ title: "ほか", project: "A" }, "app");
    // 既定では省略しない（7件あっても全部返す）
    for (let i = 0; i < 6; i++) tasks.create({ title: `増やす ${i}`, project: "A" }, "app");
    expect(projects.overview().projects.find((p) => p.name === "A")!.tasks.length).toBe(8);
    const a = projects.overview(2).projects.find((p) => p.name === "A")!;
    expect(a.tasks.length).toBe(2);
    expect(projects.overview().projects.find((p) => p.name === "A")!.tasks.find((t) => t.title === "親")!.openChildren).toBe(4);
    expect(tasks.links(parent.id).children.length).toBe(4);
  });

  test("中身と一覧（プロジェクトごと・未仕訳・期限切れの数）", () => {
    const { memos, tasks, projects } = setup();
    tasks.create({ title: "遅れ", project: "A", due: "2000-01-01" }, "app");
    tasks.create({ title: "近い", project: "A", due: "2999-01-01" }, "app");
    const d = tasks.create({ title: "済んだ", project: "A" }, "app");
    tasks.update(d.id, { status: "done" }, "app");
    tasks.create({ title: "ばらばら" }, "app");
    memos.create({ title: "Aのメモ", project: "A" }, "app");
    const a = projects.byName("A")!;
    expect(a).toMatchObject({ openTasks: 2, lateTasks: 1, nextDue: "2000-01-01", memos: 1 });
    const det = projects.detail(a.id);
    expect(det.tasks.map((t) => t.title)).toEqual(["遅れ", "近い"]);
    expect(det.doneTasks.map((t) => t.title)).toEqual(["済んだ"]);
    expect(det.memos.map((m) => m.title)).toEqual(["Aのメモ"]);
    const ov = projects.overview();
    expect(ov.projects.map((p) => p.name)).toEqual(["A"]);
    expect(ov.none).toMatchObject({ openTasks: 1, memos: 0 });
  });

  test("API: 一覧・中身・作る・書き換える", async () => {
    const { store, memos, tasks, projects } = setup();
    const hub = new Hub({ ...config, devNoAuth: true }, new FixtureSource(join(import.meta.dir, "../fixtures/board.json")), store, null, null);
    const app = createApp({ ...config, devNoAuth: true }, hub, store, ".", { memos, tasks, projects });
    const call = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const p = await (await call("POST", "/api/projects", { name: "PJ1", emoji: "🔧" })).json();
    expect(p).toMatchObject({ name: "PJ1", emoji: "🔧" });
    expect((await call("POST", "/api/projects", { name: "PJ1" })).status).toBe(409);
    expect((await call("PATCH", `/api/projects/${p.id}`, { description: "説明", status: "done" })).status).toBe(200);
    expect((await (await call("GET", `/api/projects/${p.id}`)).json()).project).toMatchObject({ description: "説明", status: "done" });
    expect((await (await call("GET", "/api/projects?view=list")).json()).map((x: { name: string }) => x.name)).toEqual(["PJ1"]);
    expect((await call("GET", "/api/projects/999")).status).toBe(404);
  });
});
