import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MonthScroller, WeekScroller } from "../src/web/Calendar";

const props = { anchor: "2026-11-11", today: "2026-11-11", sel: "2026-11-11", byDay: new Map(), onSel: () => {}, onRange: () => {}, onTitle: () => {}, api: { current: null } };

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
});
