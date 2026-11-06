import { describe, expect, test } from "bun:test";
import type { AppTask } from "../src/shared/types";
import { mergeBody, MERGE_MARK, type TaskApi, type TaskDb, type TaskFields, type TaskNew, type TaskPending, TaskSync, type TaskSyncEvent } from "../src/web/task-sync";

const task = (p: Partial<AppTask> & { id: number }): AppTask => ({
  ref: null, parentId: null, tags: [], title: "t", body: "", kind: "todo", status: "todo", source: "app", sourceKey: null, url: null, agent: null, propose: [], project: null, due: null, createdBy: "app", kanbanId: null, eventAt: null, decidedAt: null, inboxAt: 1, createdAt: 1, updatedAt: 1, ...p,
});

function setup() {
  const local = new Map<number, AppTask>();
  const pend = new Map<number, TaskPending>();
  const db: TaskDb = {
    allTasks: async () => [...local.values()],
    getTask: async (id) => local.get(id),
    putTask: async (t) => void local.set(t.id, t),
    deleteTask: async (id) => void local.delete(id),
    allPending: async () => [...pend.values()],
    putPending: async (p) => void pend.set(p.id, p),
    deletePending: async (id) => void pend.delete(id),
  };
  const server = new Map<number, AppTask>();
  let next = 100;
  let clock = 1000;
  let down = false;
  const log: unknown[] = [];
  const fail = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
  const net = () => {
    if (down) throw new TypeError("offline");
  };
  const api: TaskApi = {
    create: async (t: TaskNew) => {
      net();
      log.push(["create", t]);
      const m = task({ ...t, id: next++, ref: `TASK-${next}`, updatedAt: ++clock } as Partial<AppTask> & { id: number });
      server.set(m.id, m);
      return m;
    },
    patch: async (id, f: TaskFields & { baseUpdatedAt?: number }) => {
      net();
      log.push(["patch", id, f]);
      const cur = server.get(id);
      if (!cur) throw fail(404);
      if (f.baseUpdatedAt !== undefined && f.baseUpdatedAt !== cur.updatedAt) throw fail(409);
      const { baseUpdatedAt: _, ...rest } = f;
      const m = { ...cur, ...rest, updatedAt: ++clock } as AppTask;
      server.set(id, m);
      return m;
    },
    get: async (id) => {
      net();
      const m = server.get(id);
      if (!m) throw fail(404);
      return m;
    },
    open: async () => {
      net();
      return [...server.values()].filter((t) => ["inbox", "todo", "doing"].includes(t.status));
    },
  };
  let now = 5000;
  const sync = new TaskSync(db, api, () => ++now);
  const events: TaskSyncEvent[] = [];
  sync.onEvent((e) => events.push(e));
  return { sync, local, pend, server, log, events, setDown: (v: boolean) => (down = v), bump: () => ++clock };
}

describe("タスクのオフライン", () => {
  test("未完了だけを端末に写す。完了・削除で無くなったものは消える", async () => {
    const x = setup();
    x.server.set(1, task({ id: 1, title: "開いている" }));
    x.server.set(2, task({ id: 2, title: "完了", status: "done" }));
    await x.sync.run();
    expect([...x.local.keys()]).toEqual([1]);
    x.server.get(1)!.status = "done";
    await x.sync.run();
    expect(x.local.size).toBe(0);
    x.server.set(3, task({ id: 3 }));
    await x.sync.run();
    x.server.delete(3);
    await x.sync.run();
    expect(x.local.size).toBe(0);
  });

  test("オフラインで作ると負の番号。つながると本当の番号になり、親子もつながる", async () => {
    const x = setup();
    const parent = await x.sync.create({ title: "親" });
    const child = await x.sync.create({ title: "子", parentId: parent.id });
    expect(parent.id).toBeLessThan(0);
    x.setDown(true);
    await x.sync.run();
    expect(x.sync.status).toMatchObject({ offline: true, pending: 2 });
    x.setDown(false);
    await x.sync.run();
    expect(x.sync.status).toMatchObject({ offline: false, pending: 0 });
    const made = x.log.filter((l) => (l as unknown[])[0] === "create").map((l) => ((l as unknown[])[1] as TaskNew).title);
    expect(made).toEqual(["親", "子"]);
    const pid = x.sync.resolve(parent.id);
    const cid = x.sync.resolve(child.id);
    expect(pid).toBeGreaterThan(0);
    expect(cid).toBeGreaterThan(0);
    expect(x.events.filter((e) => e.type === "remap").length).toBe(2);
    expect([...x.local.keys()].every((id) => id > 0)).toBe(true);
    // 子は本当の番号の親に付いて送られる
    expect(x.server.get(cid)!.parentId).toBe(pid);
  });

  test("オフラインの変更を、作ったあとの変更も含めて送る。同じ項目は新しい値", async () => {
    const x = setup();
    x.server.set(1, task({ id: 1, title: "前", updatedAt: 10 }));
    await x.sync.run();
    await x.sync.patch(1, { title: "中" });
    await x.sync.patch(1, { title: "後", due: "2026-12-01" });
    expect(x.local.get(1)!.title).toBe("後");
    await x.sync.run();
    expect(x.server.get(1)).toMatchObject({ title: "後", due: "2026-12-01" });
    expect(x.pend.size).toBe(0);
    const made = await x.sync.create({ title: "新" });
    await x.sync.patch(made.id, { body: "足した" });
    await x.sync.run();
    expect(x.server.get(x.sync.resolve(made.id))!.body).toBe("足した");
  });

  test("オフラインで完了にすると、送ったあと端末から消える", async () => {
    const x = setup();
    x.server.set(1, task({ id: 1 }));
    await x.sync.run();
    await x.sync.patch(1, { status: "done" });
    expect((await x.sync.list({ status: ["todo"] })).tasks).toEqual([]);
    await x.sync.run();
    expect(x.server.get(1)!.status).toBe("done");
    expect(x.local.size).toBe(0);
  });

  test("ほかでも変わっていたら: 項目はこちら、本文は両方残す", async () => {
    const x = setup();
    x.server.set(1, task({ id: 1, title: "前", body: "元", updatedAt: 10 }));
    await x.sync.run();
    await x.sync.patch(1, { title: "こちら", body: "こちらの本文" });
    x.server.set(1, { ...x.server.get(1)!, body: "AI の本文", updatedAt: x.bump() });
    await x.sync.run();
    const s = x.server.get(1)!;
    expect(s.title).toBe("こちら");
    expect(s.body).toContain("AI の本文");
    expect(s.body).toContain("こちらの本文");
    expect(s.body).toContain(MERGE_MARK);
    expect(x.events.some((e) => e.type === "merged")).toBe(true);
  });

  test("本文を変えていない衝突は、サーバーの本文を残す", async () => {
    const x = setup();
    x.server.set(1, task({ id: 1, body: "元", updatedAt: 10 }));
    await x.sync.run();
    await x.sync.patch(1, { due: "2026-12-01" });
    x.server.set(1, { ...x.server.get(1)!, body: "AI の本文", updatedAt: x.bump() });
    await x.sync.run();
    expect(x.server.get(1)).toMatchObject({ body: "AI の本文", due: "2026-12-01" });
  });

  test("サーバーから消えていたら: 文を書いていれば作り直す。状態だけなら捨てる", async () => {
    const x = setup();
    x.server.set(1, task({ id: 1, title: "前" }));
    x.server.set(2, task({ id: 2 }));
    await x.sync.run();
    await x.sync.patch(1, { body: "残したい" });
    await x.sync.patch(2, { status: "done" });
    x.server.delete(1);
    x.server.delete(2);
    await x.sync.run();
    expect([...x.server.values()].map((t) => t.body)).toEqual(["残したい"]);
    expect(x.pend.size).toBe(0);
  });

  test("受け付けられない変更で同期全体を止めない", async () => {
    const x = setup();
    const a = await x.sync.create({ title: "" });
    const b = await x.sync.create({ title: "通る" });
    const api = (x.sync as unknown as { api: TaskApi }).api;
    const orig = api.create;
    api.create = async (t) => {
      if (!t.title) throw Object.assign(new Error("題が要る"), { status: 400 });
      return orig(t);
    };
    await x.sync.run();
    expect(x.events.some((e) => e.type === "rejected" && e.id === a.id)).toBe(true);
    expect(x.sync.resolve(b.id)).toBeGreaterThan(0);
    expect(x.pend.size).toBe(0);
  });

  test("写しが無いタスクは変えられない。送っていない変更はサーバーの版で上書きしない", async () => {
    const x = setup();
    await expect(x.sync.patch(9, { title: "x" })).rejects.toThrow("オフライン");
    x.server.set(1, task({ id: 1, title: "前" }));
    await x.sync.run();
    await x.sync.patch(1, { title: "手元" });
    x.setDown(true);
    expect(await x.sync.adopt(task({ id: 1, title: "サーバー" }))).toBe(false);
    expect(x.local.get(1)!.title).toBe("手元");
  });

  test("端末の一覧: 語・プロジェクト・タグ・状態で絞り、子の数を数える", async () => {
    const x = setup();
    x.server.set(1, task({ id: 1, title: "親", project: "旅", tags: ["a"], due: "2026-01-01" }));
    x.server.set(2, task({ id: 2, title: "子", parentId: 1 }));
    x.server.set(3, task({ id: 3, title: "別", status: "inbox" }));
    await x.sync.run();
    const all = await x.sync.list({ status: ["todo"] });
    expect(all.tasks.map((t) => t.id)).toEqual([1, 2]);
    expect(all.tasks[0].openChildren).toBe(1);
    expect(all.counts.inbox).toBe(1);
    expect(all.projects).toEqual([{ name: "旅", count: 1 }]);
    expect((await x.sync.list({ q: "別" })).tasks.map((t) => t.id)).toEqual([3]);
    expect((await x.sync.list({ project: "" })).tasks.map((t) => t.id).sort()).toEqual([2, 3]);
    expect((await x.sync.list({ tag: "a" })).tasks.map((t) => t.id)).toEqual([1]);
    expect((await x.sync.links(1)).children.map((t) => t.id)).toEqual([2]);
  });

  test("本文の統合", () => {
    expect(mergeBody("A", "A", "元")).toBe("A");
    expect(mergeBody("元", "手元", "元")).toBe("手元");
    expect(mergeBody("AI", "元", "元")).toBe("AI");
    expect(mergeBody("AI", "手元", "元")).toBe(`AI\n\n${MERGE_MARK}\n手元`);
  });
});
