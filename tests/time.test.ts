import { afterEach, describe, expect, test } from "bun:test";
import { getTimeZone, localDay, setTimeZone, tzOffsetMs } from "../src/shared/time";

const orig = getTimeZone();
afterEach(() => setTimeZone(orig));

describe("タイムゾーン", () => {
  test("同じ時刻でも、ゾーンで日付が変わる", () => {
    const t = Date.parse("2026-11-05T20:00:00Z");
    setTimeZone("Asia/Tokyo");
    expect(localDay(t)).toBe("2026-11-06");
    expect(tzOffsetMs(t)).toBe(9 * 3600_000);
    setTimeZone("America/New_York");
    expect(localDay(t)).toBe("2026-11-05");
    expect(tzOffsetMs(t)).toBe(-5 * 3600_000);
  });

  test("夏時間も見る", () => {
    setTimeZone("America/New_York");
    expect(tzOffsetMs(Date.parse("2026-07-01T12:00:00Z"))).toBe(-4 * 3600_000);
  });

  test("不正な名前は無視する", () => {
    setTimeZone("Asia/Tokyo");
    setTimeZone("Mars/Base");
    setTimeZone(undefined);
    expect(getTimeZone()).toBe("Asia/Tokyo");
  });

  test("/api/about で画面に渡す値も、ずれは秒の端数の影響を受けない", () => {
    setTimeZone("Asia/Kolkata");
    expect(tzOffsetMs(1793980000123)).toBe(5.5 * 3600_000);
  });
});
