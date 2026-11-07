import { describe, expect, test } from "bun:test";
import type { DevPr } from "../src/shared/types";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { config } from "../src/server/config";
import { Hub } from "../src/server/hub";
import { FixtureSource } from "../src/server/kanban";
import { Store } from "../src/server/store";
import { TaskStore } from "../src/server/tasks";

const FIXTURE = join(import.meta.dir, "../fixtures/board.json");
describe("タスクの番号・レポート・バッジ", () => {
  test("番号: どこから作っても最大の続き。小文字でも引ける", () => {
    const s = new TaskStore(new Store(":memory:").db);
    expect(s.create({ title: "新しい" }, "app").ref).toBe("TASK-1");
    expect(s.upsert({ source: "mail", key: "th1", title: "メール" }, "hermes/default").task.ref).toBe("TASK-2");
    expect(s.byRef("task-2")!.title).toBe("メール");
  });

  test("番号の無いタスクには続きの番号を振る", () => {
    const store = new Store(":memory:");
    const s = new TaskStore(store.db);
    s.create({ title: "a" }, "app");
    s.create({ title: "b" }, "app");
    store.db.exec("UPDATE tasks SET ref = NULL");
    expect(s.assignRefs()).toBe(2);
    expect(s.list({ status: ["todo"] }).map((t) => t.ref).sort()).toEqual(["TASK-1", "TASK-2"]);
  });

  test("レポートの「今日と今週のタスク」はアプリのタスクから", () => {
    const s = new TaskStore(new Store(":memory:").db);
    const now = Date.parse("2026-10-25T03:00:00Z"); // 日本時間 10/25（日）12:00
    s.create({ title: "期限切れ", due: "2026-10-20" }, "app");
    s.create({ title: "今日", due: "2026-10-25" }, "app");
    s.create({ title: "来週", due: "2026-10-27" }, "app");
    const d = s.create({ title: "済んだ" }, "app");
    s.update(d.id, { status: "done" }, "app", now);
    const r = s.summary(now);
    expect(r.today.map((t) => [t.title, !!t.overdue])).toEqual([["期限切れ", true], ["今日", false]]);
    expect(r.week).toEqual([]); // 日曜なので今週は今日まで
    expect(r.done.map((t) => t.title)).toEqual(["済んだ"]);
    expect(r.today[0].url).toMatch(/^#\/todo\/\d+$/);
  });

  test("レポートの「自分のタスク」は Todo だけ。期限順、期限なしは長く動いていない順", () => {
    const s = new TaskStore(new Store(":memory:").db);
    const day = 86_400_000;
    const now = Date.parse("2026-10-25T03:00:00Z");
    s.create({ title: "新しい期限なし" }, "app", now - day);
    s.create({ title: "古い期限なし" }, "app", now - 30 * day);
    s.create({ title: "期限あり", due: "2026-11-20" }, "app", now);
    s.create({ title: "AI に任せた", status: "doing" }, "app", now);
    s.create({ title: "判断待ち", status: "inbox" }, "app", now);
    const d = s.create({ title: "済んだ" }, "app", now);
    s.update(d.id, { status: "done" }, "app", now);
    const mine = s.summary(now).mine;
    expect(mine.map((t) => t.title)).toEqual(["期限あり", "古い期限なし", "新しい期限なし"]);
    expect(mine.map((t) => t.idleDays)).toEqual([0, 30, 1]);
  });

  test("PR はタスクになり、閉じたら完了。オーナーが閉じた・消したものは戻さない", () => {
    const s = new TaskStore(new Store(":memory:").db);
    const pr = (number: number, extra: Partial<DevPr> = {}): DevPr => ({ repo: "org/app", number, title: `PR${number}`, url: `https://example.com/${number}`, author: "a", draft: false, updatedAt: 0, additions: 0, deletions: 0, files: 0, summary: "要約", refs: [], checks: { state: "none", passed: 0, failed: 0, pending: 0 }, previewUrl: null, ...extra });
    const open = () => s.list({ status: ["inbox", "todo", "doing"], source: "github" }).map((t) => [t.title, t.status]);

    expect(s.syncPrs([pr(1), pr(2), pr(3, { draft: true })], true, 1000)).toBe(true);
    expect(open().sort()).toEqual([["app #1 PR1", "todo"], ["app #2 PR2", "todo"]]);
    expect(s.syncPrs([pr(1), pr(2), pr(3, { draft: true })], true, 2000)).toBe(false); // 変わらなければ書かない

    // 題名は合わせる。本文に書き足した分は残す
    const one = s.bySource("github", "org/app#1")!;
    s.update(one.id, { body: "メモ" }, "app", 3000);
    s.syncPrs([pr(1, { title: "新しい題名", summary: "別の要約" }), pr(2)], false, 4000);
    expect(s.bySource("github", "org/app#1")).toMatchObject({ title: "app #1 新しい題名", body: "メモ" });

    // 一覧が途中までのときは閉じない。全部読めたときに無ければ完了
    expect(s.syncPrs([pr(1, { title: "新しい題名" })], false, 5000)).toBe(false);
    expect(s.bySource("github", "org/app#2")!.status).toBe("todo");
    s.syncPrs([pr(1, { title: "新しい題名" })], true, 6000);
    expect(s.bySource("github", "org/app#2")!.status).toBe("done");

    // 下書きが外れたら作る。オーナーが閉じたものは開いたままの PR でも戻さない
    s.update(one.id, { status: "done" }, "app", 7000);
    s.syncPrs([pr(1), pr(3)], true, 8000);
    expect(s.bySource("github", "org/app#1")!.status).toBe("done");
    expect(s.bySource("github", "org/app#3")!.status).toBe("todo");
  });

  test("API: 番号のバッジはタスクから・カードからタスクにする", async () => {
    const store = new Store(":memory:");
    const tasks = new TaskStore(store.db);
    const hub = new Hub({ ...config, devNoAuth: true }, new FixtureSource(FIXTURE), store, null, null);
    hub.setTasks(tasks);
    await hub.refresh();
    const app = createApp({ ...config, devNoAuth: true }, hub, store, ".", { tasks });
    const done = tasks.create({ title: "済んだ" }, "app");
    tasks.update(done.id, { status: "done" }, "app");
    const b = await (await app.request(`/api/apptasks-badges?ids=${done.ref},TASK-404`)).json();
    expect(b.issues[done.ref!]).toMatchObject({ id: done.ref, state: "Done", stateType: "completed" });
    expect(b.issues["TASK-404"]).toBeNull();
    // カードはどれも判断待ちのタスク。「タスクにする」は、そのタスクを「やる」にする
    const card = hub.cards()[0];
    expect(card.recordRef ?? `#${card.appTaskId}`).toMatch(/^(TASK-\d+|#\d+)$/);
    const r = await (await app.request("/api/apptasks/from-card", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: card.key, note: "来週やる" }) })).json();
    expect(r).toMatchObject({ ok: true, task: { id: card.recordTaskId ?? card.appTaskId, status: "todo" } });
    expect(tasks.events(r.task.id).map((e) => e.text)).toContain("自分でやる: 来週やる");
  });
});
