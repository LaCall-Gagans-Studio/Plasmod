import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CronJob } from "../src/shared/types";
import { MonthScroller, WeekScroller, cronItems } from "../src/web/Calendar";

const props = { anchor: "2026-11-11", today: "2026-11-11", sel: "2026-11-11", byDay: new Map(), who: () => null, onSel: () => {}, onRange: () => {}, onTitle: () => {}, api: { current: null } };

describe("タスクカレンダーの無限スクロール", () => {
  test("月は週の行（縦）をまとめて並べ、今日を含む。月曜始まりで、行は連続している", () => {
    const html = renderToStaticMarkup(<MonthScroller {...props} />);
    const weeks = [...html.matchAll(/data-week="(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]);
    expect(weeks).toHaveLength(28);
    expect(weeks).toContain("2026-11-09"); // 今日(水)を含む週の月曜
    for (const w of weeks) expect(new Date(`${w}T00:00:00Z`).getUTCDay()).toBe(1);
    for (let i = 1; i < weeks.length; i++) expect(Date.parse(weeks[i]) - Date.parse(weeks[i - 1])).toBe(7 * 86_400_000);
    expect(html).toContain("タスクカレンダー（月）");
  });

  test("週は日の列（横）を連続して並べる", () => {
    const html = renderToStaticMarkup(<WeekScroller {...props} />);
    const days = [...html.matchAll(/data-day="(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]);
    expect(days).toHaveLength(56);
    expect(days).toContain("2026-11-11");
    for (let i = 1; i < days.length; i++) expect(Date.parse(days[i]) - Date.parse(days[i - 1])).toBe(86_400_000);
    expect(html).toContain("タスクカレンダー（週）");
  });

  test("Hermes の cron は、今日から先の来る日に並ぶ。止めたものは出ない。式で数えられないものは次の1回だけ", () => {
    const job = (o: Partial<CronJob>): CronJob => ({
      profile: "acct", id: "a", name: "請求書の確認", schedule: "0 9 2 * *", kind: "cron", enabled: true, state: "scheduled", paused_reason: null,
      next_run_at: null, last_run_at: null, last_status: null, last_error: null, last_delivery_error: null, failure_streak: 0,
      repeat: { times: null, completed: 0 }, skills: [], model: null, script: false, no_agent: false, deliver: [], prompt: null, ...o,
    });
    const items = cronItems(
      [job({}), job({ id: "b", enabled: false, state: "paused" }), job({ id: "c", kind: "interval", schedule: "every 2h", next_run_at: "2026-11-23T10:30:00+09:00" })],
      "2026-11-01", "2026-12-31", "2026-11-22",
    );
    expect(items.filter((i) => i.job!.id === "a").map((i) => i.day)).toEqual(["2026-12-02"]); // 11/2 は過ぎている
    expect(items.some((i) => i.job!.id === "b")).toBe(false);
    expect(items.filter((i) => i.job!.id === "c").map((i) => i.day)).toEqual(["2026-11-23"]);
  });
});
