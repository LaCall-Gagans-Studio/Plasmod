import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { RecurError, RecurringStore, occurrences, occursOn, parseCadence } from "../src/server/recurring";
import { TaskStore } from "../src/server/tasks";

// 日本時間の正午（localDay が日付を取り違えない）
const at = (day: string) => Date.parse(`${day}T03:00:00Z`);
const setup = () => {
  const db = new Database(":memory:");
  const tasks = new TaskStore(db, "TASK");
  return { tasks, rec: new RecurringStore(db, tasks) };
};

describe("周期の計算", () => {
  const base = { anchor: "2026-01-01" };
  test("毎週・平日・毎月・N日ごと", () => {
    expect(occursOn({ ...base, cadence: { type: "weekly", days: [1] } }, "2026-11-09")).toBe(true); // 月曜
    expect(occursOn({ ...base, cadence: { type: "weekly", days: [1] } }, "2026-11-10")).toBe(false);
    expect(occursOn({ ...base, cadence: { type: "weekdays" } }, "2026-11-14")).toBe(false); // 土曜
    expect(occursOn({ ...base, cadence: { type: "weekdays" } }, "2026-11-13")).toBe(true);
    expect(occursOn({ ...base, cadence: { type: "every", n: 3 } }, "2026-01-04")).toBe(true);
    expect(occursOn({ ...base, cadence: { type: "every", n: 3 } }, "2026-01-05")).toBe(false);
  });
  test("毎月31日は、31日の無い月では月末に来る（うるう年も）", () => {
    const r = { ...base, cadence: { type: "monthly", day: 31 } as const };
    expect(occurrences(r, "2026-02-01", "2026-02-28")).toEqual(["2026-02-28"]);
    expect(occurrences(r, "2028-02-01", "2028-02-29")).toEqual(["2028-02-29"]);
    expect(occurrences(r, "2026-04-01", "2026-04-30")).toEqual(["2026-04-30"]);
    expect(occurrences(r, "2026-05-01", "2026-05-31")).toEqual(["2026-05-31"]);
  });
  test("起点より前には来ない", () => {
    expect(occursOn({ anchor: "2026-11-10", cadence: { type: "daily" } }, "2026-11-09")).toBe(false);
  });
  test("周期の検査", () => {
    expect(() => parseCadence({ type: "weekly", days: [] })).toThrow(RecurError);
    expect(() => parseCadence({ type: "monthly", day: 32 })).toThrow(RecurError);
    expect(() => parseCadence({ type: "every", n: 0 })).toThrow(RecurError);
    expect(() => parseCadence({ type: "x" })).toThrow(RecurError);
    expect(parseCadence({ type: "weekly", days: [3, 1, 3] })).toEqual({ type: "weekly", days: [1, 3] });
  });
});

describe("浮上", () => {
  test("期日の何日前から Todo として出る。二重には作らない", () => {
    const { tasks, rec } = setup();
    const r = rec.create({ title: "週報", cadence: { type: "weekly", days: [1] }, anchor: "2026-11-01", leadDays: 2, project: "仕事" }, at("2026-11-01"));
    expect(rec.tick(at("2026-11-05"))).toHaveLength(0); // 月曜(9日)まで4日
    const made = rec.tick(at("2026-11-07"));
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ title: "週報", status: "todo", due: "2026-11-09", source: "recur", sourceKey: `${r.id}:2026-11-09`, project: "仕事" });
    expect(rec.tick(at("2026-11-07"))).toHaveLength(0);
    expect(rec.tick(at("2026-11-08"))).toHaveLength(0);
    expect(tasks.list({ source: "recur" })).toHaveLength(1);
  });

  test("前の回が終わっていないうちは重ねない。終わると次が出る（題名が同じでも混ざらない）", () => {
    const { tasks, rec } = setup();
    rec.create({ title: "週報", cadence: { type: "weekly", days: [1] }, anchor: "2026-11-01", leadDays: 0 }, at("2026-11-01"));
    const first = rec.tick(at("2026-11-09"))[0];
    expect(rec.tick(at("2026-11-16"))).toHaveLength(0); // 前の回が Todo のまま
    tasks.update(first.id, { status: "done" }, "test");
    const next = rec.tick(at("2026-11-16"));
    expect(next).toHaveLength(1);
    expect(next[0].due).toBe("2026-11-16");
    expect(next[0].id).not.toBe(first.id);
  });

  test("消した回は作り直さない。止めたルール・削除したルールは作らない。止めていた間の回は作らない", () => {
    const { tasks, rec } = setup();
    const r = rec.create({ title: "ゴミ出し", cadence: { type: "daily" }, anchor: "2026-11-01" }, at("2026-11-01"));
    const t = rec.tick(at("2026-11-09"))[0];
    tasks.remove(t.id, "test");
    expect(rec.tick(at("2026-11-09"))).toHaveLength(0);
    rec.update(r.id, { enabled: false });
    expect(rec.tick(at("2026-11-10"))).toHaveLength(0);
    rec.update(r.id, { enabled: true });
    expect(rec.tick(at("2026-11-12"))[0].due).toBe("2026-11-12"); // 10・11日の分は作らない
    rec.remove(r.id);
    expect(rec.list()).toHaveLength(0);
    expect(tasks.list({ source: "recur", status: ["todo"] })).toHaveLength(1); // 作ったタスクは残る
  });

  test("入力の検査", () => {
    const { rec } = setup();
    expect(() => rec.create({ title: " ", cadence: { type: "daily" } })).toThrow("題が要る");
    expect(() => rec.create({ title: "x", cadence: { type: "daily" }, leadDays: 99 })).toThrow(RecurError);
    expect(() => rec.create({ title: "x", cadence: { type: "daily" }, anchor: "明日" })).toThrow(RecurError);
    expect(() => rec.get(999)).toThrow("見つからない");
  });
});

describe("ルールの API", () => {
  test("作る → すぐ浮上 → 直す → 消す。不正な入力は 400、無い ID は 404", async () => {
    const { createApp } = await import("../src/server/app");
    const { config } = await import("../src/server/config");
    const { Store } = await import("../src/server/store");
    const store = new Store(":memory:");
    const tasks = new TaskStore(store.db, "TASK");
    const recurring = new RecurringStore(store.db, tasks);
    let changed = 0;
    const app = createApp({ ...config, devNoAuth: true }, { changed: () => changed++ } as never, store, ".", { tasks, recurring });
    const send = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect((await send("POST", "/api/recurring", { title: "毎日", cadence: { type: "weekly", days: [] } })).status).toBe(400);
    const res = await send("POST", "/api/recurring", { title: "毎日の確認", cadence: { type: "daily" } });
    expect(res.status).toBe(200);
    const rule = (await res.json()) as { id: number; leadDays: number };
    expect(tasks.list({ source: "recur" })).toHaveLength(1); // 今日の分がすぐ出る
    expect(changed).toBe(1);
    expect((await send("PATCH", `/api/recurring/${rule.id}`, { leadDays: 3 })).status).toBe(200);
    expect(((await (await send("GET", "/api/recurring")).json()) as { rules: { leadDays: number }[] }).rules[0].leadDays).toBe(3);
    expect((await send("PATCH", "/api/recurring/999", { leadDays: 1 })).status).toBe(404);
    expect((await send("DELETE", `/api/recurring/${rule.id}`)).status).toBe(200);
    expect(((await (await send("GET", "/api/recurring")).json()) as { rules: unknown[] }).rules).toHaveLength(0);
  });
});

describe("その回だけやめる", () => {
  test("やめた回は作らず、戻せる。ルールに無い日・もうタスクになった回は受けない", () => {
    const { tasks, rec } = setup();
    const r = rec.create({ title: "週報", cadence: { type: "weekly", days: [1] }, anchor: "2026-11-01", leadDays: 1 }, at("2026-11-01"));
    expect(() => rec.skip(r.id, "2026-11-10")).toThrow("ルールの回ではない"); // 火曜
    expect(() => rec.skip(r.id, "11/9")).toThrow(RecurError);
    expect(rec.skip(r.id, "2026-11-09").skips).toEqual(["2026-11-09"]);
    expect(rec.tick(at("2026-11-08"))).toHaveLength(0); // やめた回は出ない
    expect(rec.tick(at("2026-11-15"))[0].due).toBe("2026-11-16"); // 次の回は出る
    expect(() => rec.skip(r.id, "2026-11-16")).toThrow("もうタスクになっている");
    expect(rec.skip(r.id, "2026-11-09", false).skips).toEqual([]);
    expect(tasks.list({ source: "recur" })).toHaveLength(1);
    rec.skip(r.id, "2026-11-23");
    rec.remove(r.id);
    expect(rec.list()).toHaveLength(0);
  });

  test("API", async () => {
    const { createApp } = await import("../src/server/app");
    const { config } = await import("../src/server/config");
    const { Store } = await import("../src/server/store");
    const store = new Store(":memory:");
    const tasks = new TaskStore(store.db, "TASK");
    const recurring = new RecurringStore(store.db, tasks);
    const app = createApp({ ...config, devNoAuth: true }, { changed: () => {} } as never, store, ".", { tasks, recurring });
    const send = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const rule = (await (await send("/api/recurring", { title: "x", cadence: { type: "monthly", day: 28 }, anchor: "2030-01-01", leadDays: 0 })).json()) as { id: number };
    expect((await send(`/api/recurring/${rule.id}/skip`, { day: "2030-02-28" })).status).toBe(200);
    expect(((await (await app.request("/api/recurring")).json()) as { rules: { skips: string[] }[] }).rules[0].skips).toEqual(["2030-02-28"]);
    expect((await send(`/api/recurring/${rule.id}/skip`, { day: "2030-02-27" })).status).toBe(400);
    expect((await send(`/api/recurring/999/skip`, { day: "2030-02-28" })).status).toBe(404);
  });
});

describe("期日の範囲で読む（カレンダー）", () => {
  test("範囲の中の期日だけ返る。範囲を指定しないときは全部", () => {
    const { tasks } = setup();
    for (const [i, due] of ["2026-10-31", "2026-11-01", "2026-11-30", "2026-12-01"].entries()) tasks.create({ title: `t${i}`, due }, "test");
    tasks.create({ title: "期日なし" }, "test");
    const titles = (o: { dueFrom?: string; dueTo?: string }) => tasks.view({ status: ["todo"], ...o }).tasks.map((t) => t.title).sort();
    expect(titles({ dueFrom: "2026-11-01", dueTo: "2026-11-30" })).toEqual(["t1", "t2"]);
    expect(titles({ dueFrom: "2026-12-01" })).toEqual(["t3"]);
    expect(titles({})).toHaveLength(5);
  });
});

describe("担当のエージェント", () => {
  test("担当があるルールの回は、浮上と同時にカンバンに渡す。渡せなければ Todo のまま理由を残す", async () => {
    const { tasks, rec } = setup();
    rec.agentOk = (id) => (["acct", "dev"].includes(id) ? id : null);
    const handed: string[] = [];
    rec.delegate = async (t, rule) => void handed.push(`${rule.agent}:${t.title}`);
    expect(() => rec.create({ title: "x", cadence: { type: "daily" }, agent: "nobody" })).toThrow("使えない");
    const r = rec.create({ title: "請求書の確認", cadence: { type: "daily" }, anchor: "2026-11-01", leadDays: 0, agent: "acct" }, at("2026-11-01"));
    expect(r.agent).toBe("acct");
    const made = rec.tick(at("2026-11-09"));
    expect(made[0]).toMatchObject({ agent: "acct", status: "todo" });
    await Promise.resolve();
    expect(handed).toEqual(["acct:請求書の確認"]);
    // 担当を外すとオーナーの Todo。空文字・null で外れる
    expect(rec.update(r.id, { agent: "" }).agent).toBeNull();

    // 渡せなかった回
    const { tasks: t2, rec: r2 } = setup();
    r2.delegate = async () => {
      throw new Error("カンバンが応答しない");
    };
    r2.create({ title: "週報", cadence: { type: "daily" }, anchor: "2026-11-01", leadDays: 0, agent: "dev" }, at("2026-11-01"));
    const [t] = r2.tick(at("2026-11-09"));
    await new Promise((r) => setTimeout(r, 0));
    const after = t2.get(t.id)!;
    expect(after.status).toBe("todo");
    expect(t2.events(t.id).some((e) => e.text.includes("カンバンが応答しない"))).toBe(true);
    void tasks;
  });
});

describe("エージェントからの登録（plasmod-task recur）", () => {
  test("add は同じ題を1件にまとめ、edit・skip・remove ができる", async () => {
    const { MemoSpool } = await import("../src/server/memo-spool");
    const { MemoStore } = await import("../src/server/memos");
    const db = new Database(":memory:");
    const tasks = new TaskStore(db, "TASK");
    const rec = new RecurringStore(db, tasks);
    let changed = 0;
    const sp = new MemoSpool(new MemoStore(db), "/nonexistent", new Map(), tasks, () => changed++, null, null, rec);
    const run = (op: string, a: Record<string, unknown>) => sp.run(op, a, "hermes/mica") as { action: string; rule: { id: number; title: string; cadence: unknown; agent: string | null; enabled: boolean; skips: string[] } };
    const a = run("recur.add", { title: "月次の請求", cadence: { type: "monthly", day: 25 }, anchor: "2026-01-01", leadDays: 3, agent: "" });
    expect(a.action).toBe("created");
    const b = run("recur.add", { title: " 月次の請求 ", leadDays: 5 });
    expect(b.action).toBe("updated");
    expect(b.rule.id).toBe(a.rule.id);
    expect(b.rule.cadence).toEqual({ type: "monthly", day: 25 }); // 渡さなかった項目は変わらない
    expect(rec.list()).toHaveLength(1);
    expect(run("recur.edit", { id: a.rule.id, enabled: false }).rule.enabled).toBe(false);
    expect(run("recur.skip", { id: a.rule.id, day: "2027-01-25" }).rule.skips).toEqual(["2027-01-25"]);
    expect((sp.run("recur.list", {}, "x") as { rules: unknown[] }).rules).toHaveLength(1);
    expect(() => run("recur.add", { title: "x", cadence: { type: "weekly", days: [] } })).toThrow(RecurError);
    expect(() => sp.run("recur.nope", {}, "x")).toThrow(RecurError);
    run("recur.remove", { id: a.rule.id });
    expect(rec.list()).toHaveLength(0);
  });
});
