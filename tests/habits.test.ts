import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { GRAPH_DAYS, HabitError, HabitStore, dayOf } from "../src/server/habits";

const NOON = Date.parse("2026-11-06T03:00:00Z"); // 日本時間の正午
const DAY = 86_400_000;
const store = () => new HabitStore(new Database(":memory:"));

describe("ルーティーン", () => {
  test("チェックすると今日の印と草が増え、外すと戻る", () => {
    const s = store();
    const h = s.create({ name: " 散歩 ", emoji: "🚶" }, NOON);
    expect(h).toMatchObject({ name: "散歩", emoji: "🚶", doneToday: false, streak: 0 });
    expect(s.check(h.id, true, undefined, NOON)).toMatchObject({ doneToday: true, streak: 1, total: 1 });
    const ov = s.overview(NOON);
    expect(ov.today).toBe("2026-11-06");
    expect(ov.days).toHaveLength(GRAPH_DAYS);
    expect(ov.days.at(-1)).toEqual({ day: "2026-11-06", count: 1 });
    expect(s.check(h.id, false, undefined, NOON)).toMatchObject({ doneToday: false, total: 0 });
    expect(s.overview(NOON).days.at(-1)!.count).toBe(0);
  });

  test("続いた日数: 今日がまだでも昨日まで続いていれば数え、1日空くと切れる", () => {
    const s = store();
    const h = s.create({ name: "読書" }, NOON);
    s.check(h.id, true, "2026-11-05", NOON);
    s.check(h.id, true, "2026-11-04", NOON);
    expect(s.overview(NOON).habits[0]).toMatchObject({ doneToday: false, streak: 2 });
    expect(s.overview(NOON + DAY).habits[0].streak).toBe(0); // 11/7: 昨日（11/6）が空いている
  });

  test("先の日・変な日付は断る。同じ日を2回付けても1回", () => {
    const s = store();
    const h = s.create({ name: "水" }, NOON);
    expect(() => s.check(h.id, true, "2026-11-07", NOON)).toThrow(HabitError);
    expect(() => s.check(h.id, true, "きのう", NOON)).toThrow(HabitError);
    s.check(h.id, true, undefined, NOON);
    expect(s.check(h.id, true, undefined, NOON).total).toBe(1);
  });

  test("やめると一覧から消えるが、草には残る", () => {
    const s = store();
    const h = s.create({ name: "筋トレ" }, NOON);
    s.check(h.id, true, undefined, NOON);
    s.archive(h.id, NOON);
    const ov = s.overview(NOON);
    expect(ov.habits).toEqual([]);
    expect(ov.days.at(-1)!.count).toBe(1);
    expect(() => s.check(h.id, true, undefined, NOON)).toThrow(HabitError);
  });

  test("並べ替え: 順番が残り、新しいものは一番下。今のルーティーンと合わない並びは断る", () => {
    const s = store();
    const [a, b, c] = ["一", "二", "三"].map((name) => s.create({ name }, NOON));
    s.reorder([c.id, a.id, b.id]);
    expect(s.overview(NOON).habits.map((h) => h.name)).toEqual(["三", "一", "二"]);
    s.create({ name: "四" }, NOON);
    expect(s.overview(NOON).habits.map((h) => h.name)).toEqual(["三", "一", "二", "四"]);
    expect(() => s.reorder([a.id])).toThrow(HabitError);
    expect(() => s.reorder([a.id, a.id, b.id, c.id])).toThrow(HabitError);
  });

  test("名前を変えられる", () => {
    const s = store();
    const h = s.create({ name: "前" }, NOON);
    expect(s.update(h.id, { name: " 後 " }, NOON).name).toBe("後");
    expect(() => s.update(h.id, { name: "" }, NOON)).toThrow(HabitError);
  });

  test("名前は必須。日付は日本時間で切り替わる", () => {
    expect(() => store().create({ name: "  " })).toThrow(HabitError);
    expect(dayOf(Date.parse("2026-11-05T14:59:00Z"))).toBe("2026-11-05");
    expect(dayOf(Date.parse("2026-11-05T15:00:00Z"))).toBe("2026-11-06");
  });
});
