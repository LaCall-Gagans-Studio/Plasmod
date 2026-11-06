import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { config } from "../src/server/config";
import { Hub } from "../src/server/hub";
import { FixtureSource } from "../src/server/kanban";
import { Store } from "../src/server/store";
import { TaskStore } from "../src/server/tasks";

const fresh = () => new TaskStore(new Store(":memory:").db);

describe("タスク同士のつながり", () => {
  test("消す: 子は1つ上の親へ・つながりも消える・同じ元からは入れ直さない・番号は使い回さない", () => {
    const s = fresh();
    const top = s.create({ title: "上" }, "app");
    const p = s.create({ title: "消す", parentId: top.id }, "app");
    const c = s.create({ title: "子", parentId: p.id }, "app");
    const o = s.create({ title: "ほか" }, "app");
    s.link(p.id, o.id, "blocks", true, "app");
    s.remove(p.id, "app");
    expect(s.get(p.id)).toBeNull();
    expect(s.get(c.id)!.parentId).toBe(top.id);
    expect(s.links(o.id).blockedBy).toEqual([]);
    const m = s.upsert({ source: "mail", key: "thread-1", title: "メール" }, "hermes/default");
    s.remove(m.task.id, "app");
    expect(s.upsert({ source: "mail", key: "thread-1", title: "メール" }, "hermes/default")).toMatchObject({ action: "ignored", reason: "オーナーが削除済み" });
    const last = s.create({ title: "最後" }, "app");
    s.remove(last.id, "app");
    expect(s.create({ title: "次" }, "app").ref).not.toBe(last.ref);
    expect(() => s.remove(9999, "app")).toThrow(/無い/);
  });

  test("親子: サブタスクは親のプロジェクトを引き継ぐ・開いている子の数・子孫は親にできない", () => {
    const s = fresh();
    const p = s.create({ title: "親", project: "P" }, "app");
    const c = s.create({ title: "子", parentId: p.id }, "app");
    const g = s.create({ title: "孫", parentId: c.id }, "app");
    expect(c).toMatchObject({ parentId: p.id, project: "P" });
    expect(s.get(p.id)!.openChildren).toBe(1);
    expect(() => s.setParent(p.id, g.id, "app")).toThrow(/子孫/);
    s.update(c.id, { status: "done" }, "app");
    expect(s.list({ status: ["todo"] }).find((t) => t.id === p.id)!.openChildren).toBeUndefined();
    expect(s.links(p.id).children.map((t) => t.title)).toEqual(["子"]);
    s.setParent(c.id, null, "app");
    expect(s.links(p.id).children).toEqual([]);
  });

  test("止めている／止められている／関連（向きなし）", () => {
    const s = fresh();
    const a = s.create({ title: "a" }, "app");
    const b = s.create({ title: "b" }, "app");
    const c = s.create({ title: "c" }, "app");
    s.link(a.id, b.id, "blocks", true, "app");
    s.link(c.id, a.id, "related", true, "app");
    expect(s.links(a.id)).toMatchObject({ blocks: [{ title: "b" }], blockedBy: [], related: [{ title: "c" }] });
    expect(s.links(b.id).blockedBy.map((t) => t.title)).toEqual(["a"]);
    expect(s.links(c.id).related.map((t) => t.title)).toEqual(["a"]);
    s.link(a.id, c.id, "related", false, "app");
    expect(s.links(c.id).related).toEqual([]);
    expect(() => s.link(a.id, a.id, "related", true, "app")).toThrow(/同じ/);
  });

  test("API: 親・つながり・サブタスク", async () => {
    const store = new Store(":memory:");
    const tasks = new TaskStore(store.db);
    const hub = new Hub({ ...config, devNoAuth: true }, new FixtureSource(join(import.meta.dir, "../fixtures/board.json")), store, null, null);
    const app = createApp({ ...config, devNoAuth: true }, hub, store, ".", { tasks });
    const call = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const a = await (await call("POST", "/api/apptasks", { title: "a" })).json();
    const b = await (await call("POST", "/api/apptasks", { title: "b" })).json();
    const sub = await (await call("POST", "/api/apptasks", { title: "sub", parentId: a.id })).json();
    expect(sub.parentId).toBe(a.id);
    expect((await (await call("POST", `/api/apptasks/${b.id}/parent`, { parent: a.ref })).json()).task.parentId).toBe(a.id);
    const l = await (await call("POST", `/api/apptasks/${a.id}/link`, { other: b.ref, kind: "blocked_by" })).json();
    expect(l.links.blockedBy.map((t: { ref: string }) => t.ref)).toEqual([b.ref]);
    expect((await call("POST", `/api/apptasks/${a.id}/link`, { other: "TASK-999", kind: "related" })).status).toBe(404);
    const d = await (await call("GET", `/api/apptasks/${a.id}`)).json();
    expect(d.links.children.map((t: { title: string }) => t.title).sort()).toEqual(["b", "sub"]);
  });
});
