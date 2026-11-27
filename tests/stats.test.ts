import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { HabitStore } from "../src/server/habits";
import { MemoStore } from "../src/server/memos";
import { StatsStore, rangeOf } from "../src/server/stats";
import { TaskStore } from "../src/server/tasks";
import { localDay } from "../src/shared/time";

const DAY = 86_400_000;

describe("統計", () => {
  test("期間: 今週は月曜から日曜、今月は1日から末日、30日は今日まで", () => {
    expect(rangeOf("week", "2026-11-27")).toEqual({ from: "2026-11-23", to: "2026-11-29" });
    expect(rangeOf("week", "2026-11-23")).toEqual({ from: "2026-11-23", to: "2026-11-29" });
    expect(rangeOf("week", "2026-11-29")).toEqual({ from: "2026-11-23", to: "2026-11-29" });
    expect(rangeOf("month", "2026-02-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(rangeOf("30d", "2026-11-27")).toEqual({ from: "2026-10-29", to: "2026-11-27" });
  });

  test("日ごとに、作った・期限内・遅れ・期限なしの完了・ルーティーン・メモを数える。不要は数えない", () => {
    const db = new Database(":memory:");
    const tasks = new TaskStore(db);
    const memos = new MemoStore(db);
    const habits = new HabitStore(db);
    const stats = new StatsStore(db);
    const now = Date.now();
    const today = localDay(now);
    const a = tasks.create({ title: "期限内", due: today }, "app");
    const b = tasks.create({ title: "遅れ", due: "2000-01-01" }, "app");
    const c = tasks.create({ title: "期限なし" }, "app");
    const d = tasks.create({ title: "不要" }, "app");
    tasks.create({ title: "開いたまま", due: "2000-01-02" }, "app");
    for (const t of [a, b, c]) tasks.update(t.id, { status: "done" }, "app");
    tasks.update(d.id, { status: "done", doneReason: "unneeded" }, "app");
    // 前からあったタスク（期間の始めに開いていた）
    const old = tasks.create({ title: "前から" }, "app");
    db.query("UPDATE tasks SET created_at = ? WHERE id = ?").run(now - 60 * DAY, old.id);
    memos.create({ title: "m", tags: ["設計"] }, "app");
    const h = habits.create({ name: "走る" });
    habits.check(h.id, true);

    const r = stats.report("30d", now);
    const t = r.days.find((x) => x.day === today)!;
    expect(t).toMatchObject({ created: 4, onTime: 1, late: 1, noDue: 1, habits: 1, memos: 1 });
    expect(r.openAtStart).toBe(1);
    expect(r.overdue).toBe(1);
    expect(r.habitCount).toBe(1);
    expect(r.tags[0]).toEqual({ name: "設計", count: 1 });
    expect(habits.overview(now).habits[0].week).toEqual([false, false, false, false, false, false, true]);
  });
});
