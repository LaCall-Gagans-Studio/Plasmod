import { describe, expect, test } from "bun:test";
import { cronDays, parseCron, shiftDay } from "../src/shared/cron";

describe("cron の展開", () => {
  test("毎月20日 9時は、月に1回だけ来る", () => {
    const r = cronDays("0 9 20 * *", "2026-11-01", "2026-12-31")!;
    expect(r.map((x) => x.day)).toEqual(["2026-11-20", "2026-12-20"]);
    expect(r[0].times).toEqual(["09:00"]);
  });
  test("平日・曜日の名前・日曜は 0 と 7 のどちらでも", () => {
    expect(cronDays("30 8 * * 1-5", "2026-11-23", "2026-11-29")!.map((x) => x.day)).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"]);
    expect(cronDays("0 7 * * sun", "2026-11-22", "2026-11-28")!.map((x) => x.day)).toEqual(["2026-11-22"]);
    expect(cronDays("0 7 * * 7", "2026-11-22", "2026-11-28")!.map((x) => x.day)).toEqual(["2026-11-22"]);
  });
  test("日と曜日の両方に値があると、どちらかに合えば来る", () => {
    expect(cronDays("0 9 1 * mon", "2026-11-01", "2026-11-10")!.map((x) => x.day)).toEqual(["2026-11-01", "2026-11-02", "2026-11-09"]);
  });
  test("時の複数・間隔・範囲", () => {
    expect(cronDays("0 6,18 * * *", "2026-11-22", "2026-11-22")![0].times).toEqual(["06:00", "18:00"]);
    expect(cronDays("*/20 9-10 * * *", "2026-11-22", "2026-11-22")![0].times).toEqual(["09:00", "09:20", "09:40", "10:00", "10:20", "10:40"]);
    expect(cronDays("0 0 1 */3 *", "2026-01-01", "2026-12-31")!.map((x) => x.day)).toEqual(["2026-01-01", "2026-04-01", "2026-07-01", "2026-10-01"]);
  });
  test("読めない式は null", () => {
    expect(parseCron("@daily")).toBeNull();
    expect(parseCron("0 25 * * *")).toBeNull();
    expect(parseCron("every 2h")).toBeNull();
    expect(cronDays("0 9 * *", "2026-11-01", "2026-11-02")).toBeNull();
  });
  test("月またぎの日付計算", () => {
    expect(shiftDay("2026-11-30", 1)).toBe("2026-12-01");
  });
});
