import { describe, expect, test } from "bun:test";
import { deriveCards } from "../src/server/model";
import { Store } from "../src/server/store";
import { TaskStore } from "../src/server/tasks";
import type { Board, KanbanTask, PermissionRequest } from "../src/shared/types";

// 「カード＝BackLog のタスク」（2026-10-29、例外なし）: カンバン・承認依頼・メモのカードもタスクに写す
const NOW = 1_793_000_000_000;
const NONE = { snoozedUntil: new Map<string, number>(), decidedAt: new Map<string, number>() };
const PROFILES = [{ id: "default", name: "ハブ", initial: "ミ", color: "#000" }];
const kt = (p: Partial<KanbanTask>): KanbanTask => ({
  id: "k1", title: "デプロイ", body: "本番に出す", assignee: "default", status: "blocked", priority: 0, created_by: "default",
  created_at: NOW / 1000 - 600, started_at: null, completed_at: null, last_heartbeat_at: null, block_kind: null, result: null, latest_comment: null, ...p,
});
const board = (...tasks: KanbanTask[]): Board => ({ tasks, active_runs: [] }) as unknown as Board;
const perm: PermissionRequest = { thread: "th1", request_id: "r1", tool_name: "Bash", description: "rm を実行", input_preview: "rm -rf x", thread_title: null, created_at: NOW - 1000 };

function setup() {
  const store = new Store(":memory:");
  const tasks = new TaskStore(store.db);
  const all = new Set(["kanban", "perm", "note"]);
  const cards = (b: Board | null, perms: PermissionRequest[], notes: { id: number; title: string; body: string; created_at: number }[] = [], healthy = all, now = NOW) =>
    deriveCards(b, perms, PROFILES, NONE, now, notes, () => tasks.inbox(), "default", (items) => tasks.mirror(items, healthy, now));
  return { tasks, cards };
}

describe("カード＝BackLog のタスク", () => {
  test("承認依頼・カンバン・メモのカードは、どれも BackLog のタスクになり、カードにその番号が付く（二重には出ない）", () => {
    const { tasks, cards } = setup();
    const memo = [{ id: 4, title: "メモ", body: "あとで見る", created_at: NOW - 5 }];
    const cs = cards(board(kt({})), [perm], memo);
    expect(cs.map((c) => c.key).sort()).toEqual(["note:4", "perm:th1:r1", "task:k1"]);
    const inbox = tasks.inbox();
    expect(inbox.map((t) => [t.source, t.sourceKey]).sort()).toEqual([["kanban", "k1"], ["note", "4"], ["perm", "th1:r1"]]);
    for (const c of cs) expect(inbox.find((t) => t.id === c.recordTaskId)?.ref).toBe(c.recordRef!);
    expect(tasks.inbox().find((t) => t.source === "kanban")?.kanbanId).toBe("k1");
    // 何度呼んでも増えない
    cards(board(kt({})), [perm], memo);
    expect(tasks.inbox()).toHaveLength(3);
  });

  test("元で片付いたら閉じる。ただし読めていない元（bridge が切れた・カンバンが読めない）は閉じない（カードは出し続ける）", () => {
    const { tasks, cards } = setup();
    cards(board(kt({})), [perm]);
    // bridge が切れて承認依頼が見えない・カンバンも読めない: タスクは BackLog のまま、カード（タスクのカード）も出る
    expect(cards(null, [], [], new Set(["note"])).map((c) => c.key).sort()).toEqual(tasks.inbox().map((t) => `apptask:${t.id}`).sort());
    expect(tasks.inbox()).toHaveLength(2);
    cards(board(kt({ status: "running" })), []);
    const all = tasks.list({ status: ["inbox", "todo", "doing", "done"] });
    expect(all.find((t) => t.source === "perm")?.status).toBe("done");
    // カンバンにつながっているものは「任せた」（カンバンが終われば syncKanban で済み）
    expect(all.find((t) => t.source === "kanban")?.status).toBe("doing");
    expect(cards(board(kt({ status: "running" })), [])).toHaveLength(0);
  });

  test("アプリのタスクから任せたカンバンが止まったら、新しく作らず元のタスクを BackLog に戻す", () => {
    const { tasks, cards } = setup();
    const t = tasks.upsert({ source: "mail", key: "m1", title: "見積の返信" }, "default", NOW - 100_000).task;
    tasks.linkKanban(t.id, "k9", "acct", "", "app", NOW - 90_000);
    const cs = cards(board(kt({ id: "k9", title: "見積の返信（下書き）", latest_comment: { body: "宛先が分からない", created_at: NOW / 1000 - 10 } as never })), []);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ key: "task:k9", recordTaskId: t.id, kind: "blocked" });
    const back = tasks.get(t.id)!;
    // 題・本文はアプリのタスクのまま、記録に止まった理由
    expect(back).toMatchObject({ status: "inbox", title: "見積の返信", source: "mail" });
    expect(tasks.events(t.id).some((e) => e.kind === "reopen" && e.text.includes("カンバン k9 が止まった: 宛先が分からない"))).toBe(true);
    expect(tasks.list({ status: ["inbox", "todo", "doing", "done"] })).toHaveLength(1);
  });

  test("タスクの側で閉じたら、元のカードが残っていても出さない。また止まったら（カードが新しくなったら）戻す", () => {
    const { tasks, cards } = setup();
    const [c] = cards(board(kt({})), []);
    tasks.decide(c.recordTaskId!, "done", "", "app", NOW + 10);
    expect(cards(board(kt({})), [], [], undefined, NOW + 20)).toHaveLength(0);
    const again = cards(board(kt({ latest_comment: { body: "また止まった", created_at: NOW / 1000 + 60 } as never })), [], [], undefined, NOW + 70_000);
    expect(again).toHaveLength(1);
    expect(tasks.get(c.recordTaskId!)?.status).toBe("inbox");
  });

  test("不要（完了）は、元のカードが新しくなったときだけ戻す。削除したタスクは戻さない（カードも出ない）", () => {
    const { tasks, cards } = setup();
    const [c] = cards(null, [perm]);
    tasks.decide(c.recordTaskId!, "done", "", "app", NOW + 10, "", "unneeded");
    expect(cards(null, [perm])).toHaveLength(0);
    expect(cards(null, [{ ...perm, created_at: NOW + 1000 }])).toHaveLength(1);
    const [n] = cards(null, [], [{ id: 7, title: "メモ", body: "", created_at: NOW }]);
    tasks.remove(n.recordTaskId!, "app");
    expect(cards(null, [], [{ id: 7, title: "メモ", body: "", created_at: NOW }])).toHaveLength(0);
  });
});

describe("カードの判断はタスクに残る（Hub）", () => {
  test("進めて → 任せ中（カンバンにつながったまま）、完了 → 完了", async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { config } = await import("../src/server/config");
    const { Hub } = await import("../src/server/hub");
    const { FixtureSource } = await import("../src/server/kanban");
    const path = join(mkdtempSync(join(tmpdir(), "gh-cat-")), "board.json");
    writeFileSync(path, readFileSync(join(import.meta.dir, "../fixtures/board.json"), "utf8"));
    const store = new Store(":memory:");
    const tasks = new TaskStore(store.db);
    const hub = new Hub(config, new FixtureSource(path), store, null, null);
    hub.setTasks(tasks);
    await hub.refresh();
    const cs = hub.cards();
    expect(cs.every((c) => c.recordTaskId || c.appTaskId)).toBe(true);
    expect(cs.length).toBe(tasks.inbox().length);
    const blocked = cs.find((c) => c.key === "task:t_8f2a")!;
    const review = cs.find((c) => c.key === "task:t_91c0")!;
    await hub.act(blocked.key, "approve", "進めて", "app");
    await hub.act(review.key, "complete", "", "app");
    expect(tasks.get(blocked.recordTaskId!)).toMatchObject({ status: "doing", kanbanId: "t_8f2a" });
    expect(tasks.events(blocked.recordTaskId!).some((e) => e.kind === "decide" && e.text === "進めて: 進めて")).toBe(true);
    expect(tasks.get(review.recordTaskId!)?.status).toBe("done");
    expect(tasks.inbox()).toHaveLength(0);
    expect(hub.cards()).toHaveLength(0);
  });
});

describe("仕分け待ち（triage）も BackLog のタスク", () => {
  test("カードになり、実働のエージェントごとの「〇〇に任せる」（今の担当が先頭）・不要・あとで", () => {
    const { tasks, cards } = setup();
    const profiles = [...PROFILES, { id: "dev", name: "開発くん", initial: "つ", color: "#000" }, { id: "audit", name: "監査", initial: "監", color: "#000", team: "watch" as const }];
    const cs = deriveCards(board(kt({ id: "k5", status: "triage", assignee: "dev" })), [], profiles, NONE, NOW, [], () => tasks.inbox(), "default", (i) => tasks.mirror(i, new Set(["kanban"]), NOW));
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ key: "task:k5", kind: "triage", statusLabel: "仕分け" });
    expect(cs[0].options.map((o) => o.id)).toEqual(["to-dev", "to-default", "mine", "later", "archive"]);
    expect(tasks.inbox()[0]).toMatchObject({ source: "kanban", kanbanId: "k5" });
    expect(tasks.events(tasks.inbox()[0].id)[0].text).toContain("仕分け待ちになった");
    void cards;
  });

  test("〇〇に任せる → カンバンの担当を決めて todo、タスクは任せ中。不要 → アーカイブ、タスクは完了（不要）", async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { config } = await import("../src/server/config");
    const { Hub } = await import("../src/server/hub");
    const { FixtureSource } = await import("../src/server/kanban");
    const base = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/board.json"), "utf8")) as Board;
    const path = join(mkdtempSync(join(tmpdir(), "gh-tri-")), "board.json");
    writeFileSync(path, JSON.stringify({ ...base, tasks: [...base.tasks, kt({ id: "k6", status: "triage", assignee: null }), kt({ id: "k7", status: "triage", title: "要らない" })] }));
    const store = new Store(":memory:");
    const tasks = new TaskStore(store.db);
    const source = new FixtureSource(path);
    const hub = new Hub(config, source, store, null, null);
    hub.setTasks(tasks);
    await hub.refresh();
    const a = hub.cards().find((c) => c.key === "task:k6")!;
    const b = hub.cards().find((c) => c.key === "task:k7")!;
    await hub.act(a.key, "to-dev", "急ぎで", "app");
    await hub.act(b.key, "archive", "", "app");
    expect(source.log).toContain("specify k6 dev");
    expect(source.log).toContain("archive k7");
    expect(tasks.get(a.recordTaskId!)).toMatchObject({ status: "doing", kanbanId: "k6" });
    expect(tasks.get(b.recordTaskId!)).toMatchObject({ status: "done", doneReason: "unneeded" });
    await expect(hub.act(hub.cards()[0]?.key ?? "x", "to-../x", "", "app")).rejects.toThrow();
  });
});

describe("カードの操作（2026-10-29）", () => {
  async function hubWith(extra: KanbanTask[] = []) {
    const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { config } = await import("../src/server/config");
    const { Hub } = await import("../src/server/hub");
    const { FixtureSource } = await import("../src/server/kanban");
    const base = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/board.json"), "utf8")) as Board;
    const path = join(mkdtempSync(join(tmpdir(), "gh-ops-")), "board.json");
    writeFileSync(path, JSON.stringify({ ...base, tasks: [...base.tasks, ...extra] }));
    const store = new Store(":memory:");
    const tasks = new TaskStore(store.db);
    const source = new FixtureSource(path);
    const hub = new Hub(config, source, store, null, null);
    hub.setTasks(tasks);
    await hub.refresh();
    return { hub, tasks, source };
  }

  test("どの種類にも「自分でやる」「不要」。止まったカンバンで自分でやる → カンバンは片付け、タスクはやる", async () => {
    const { hub, tasks, source } = await hubWith();
    const c = hub.cards().find((x) => x.key === "task:t_8f2a")!;
    expect(c.options.map((o) => o.id)).toEqual(["approve", "revise", "mine", "later", "dismiss"]);
    await hub.act(c.key, "mine", "こっちでやる", "app");
    expect(source.log).toContain("archive t_8f2a");
    expect(tasks.get(c.recordTaskId!)?.status).toBe("todo");
    const r = hub.cards().find((x) => x.key === "task:t_91c0")!;
    await hub.act(r.key, "dismiss", "", "app");
    expect(source.log).toContain("archive t_91c0");
    expect(tasks.get(r.recordTaskId!)).toMatchObject({ status: "done", doneReason: "unneeded" });
  });

  test("カードに番号と親が付く。コメントだけ書くと、タスクの記録とカンバンの両方に残る", async () => {
    const { hub, tasks, source } = await hubWith();
    const c = hub.cards().find((x) => x.key === "task:t_8f2a")!;
    expect(c.recordRef).toMatch(/^TASK-\d+$/);
    const parent = tasks.create({ title: "demo の作り替え" }, "app");
    tasks.setParent(c.recordTaskId!, parent.id, "app");
    expect(hub.cards().find((x) => x.key === c.key)?.parent).toEqual({ id: parent.id, ref: parent.ref, title: "demo の作り替え" });
    await hub.commentCard(c.key, "マージ前にもう一度見たい");
    expect(tasks.events(c.recordTaskId!).some((e) => e.kind === "comment" && e.text === "マージ前にもう一度見たい")).toBe(true);
    expect(source.log.some((l) => l.startsWith("comment t_8f2a") && l.includes("マージ前にもう一度見たい"))).toBe(true);
    // アプリのタスクのカードにも番号（recordRef）
    const t = tasks.upsert({ source: "mail", key: "m1", title: "返信するか？" }, "hermes/default").task;
    expect(hub.cards().find((x) => x.appTaskId === t.id)?.recordRef).toBe(t.ref!);
    await expect(hub.commentCard(`apptask:${t.id}`, "x", [{ name: "a.txt", data: new Uint8Array([1]) }])).rejects.toThrow("添付");
  });
});
