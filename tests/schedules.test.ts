import { describe, expect, test } from "bun:test";
import { SystemService } from "../src/server/system";
import { cronText, timerText, when } from "../src/web/Schedules";

const LIST = [
  { next: 1792497768546087, left: 1792497768546087, last: 1792497645544697, passed: 1, unit: "plasmod-deploy.timer", activates: "plasmod-deploy.service" },
  { next: 1792508400000000, left: 1, last: null, passed: null, unit: "apt-daily.timer", activates: "apt-daily.service" },
];
const SHOW_TIMERS = `Id=plasmod-deploy.timer
Description=deploy timer
TimersMonotonic={ OnUnitInactiveUSec=2min ; next_elapse=3d }
TimersMonotonic={ OnBootUSec=2min ; next_elapse=2min }

Id=apt-daily.timer
Description=Daily apt
TimersCalendar={ OnCalendar=*-*-* 06,18:00:00 ; next_elapse=Wed 2026-10-21 06:00:00 JST }
`;
const SHOW_SERVICES = `Id=plasmod-deploy.service
Description=Plasmod の自動デプロイ
Result=exit-code

Id=apt-daily.service
Description=Daily apt download activities
Result=success
`;

function svc(broker: ((...a: string[]) => Promise<string>) | null) {
  const calls: string[][] = [];
  const systemctl = async (...a: string[]) => {
    calls.push(a);
    if (a[0] === "list-timers") return JSON.stringify(LIST);
    if (a[0] === "show") return a.includes("plasmod-deploy.timer") ? SHOW_TIMERS : SHOW_SERVICES;
    throw new Error("unknown");
  };
  return { s: new SystemService(null, broker, [], (id) => ({ default: "ハブ" })[id] ?? id, systemctl), calls };
}

describe("定期実行", () => {
  test("Hermes の cron はプロファイルを付けて並べ、読めないプロファイルはエラーに出す", async () => {
    const { s } = svc(async (...a) => {
      expect(a).toEqual(["cron"]);
      return JSON.stringify({ default: [{ id: "f430", name: "見回り", schedule: "0 8 * * *", kind: "cron", enabled: true, state: "scheduled" }], design: { error: "jobs.json を読めない" } });
    });
    const r = await s.schedules();
    expect(r.hermes).toMatchObject([{ profile: "default", id: "f430", name: "見回り" }]);
    expect(r.errors).toEqual([{ source: "design", error: "jobs.json を読めない" }]);
  });

  test("systemd のタイマー: スケジュール・説明・前回の結果をまとめる", async () => {
    const { s, calls } = svc(null);
    const r = await s.schedules();
    expect(r.timers).toEqual([
      { unit: "plasmod-deploy.timer", activates: "plasmod-deploy.service", description: "Plasmod の自動デプロイ", schedule: "OnUnitInactiveSec=2min / OnBootSec=2min", next: 1792497768546, last: 1792497645545, result: "exit-code", os: false },
      { unit: "apt-daily.timer", activates: "apt-daily.service", description: "Daily apt download activities", schedule: "OnCalendar=*-*-* 06,18:00:00", next: 1792508400000, last: null, result: "success", os: true },
    ]);
    // show に渡す名前の前に -- を置く（名前がオプションとして読まれないように）
    expect(calls.filter((c) => c[0] === "show").every((c) => c.indexOf("--") === 3)).toBe(true);
  });

  test("仲介や systemctl が落ちても、もう片方は出す", async () => {
    const s = new SystemService(null, async () => { throw new Error("sudo: 失敗"); }, [], (x) => x, async () => { throw new Error("no systemd"); });
    const r = await s.schedules();
    expect(r.hermes).toEqual([]);
    expect(r.timers).toEqual([]);
    expect(r.errors.map((e) => e.source)).toEqual(["Hermes", "systemd"]);
  });

  test("cron の式を日本語に（よくある形だけ）", () => {
    expect(cronText("0 8,12,17,21 * * *")).toBe("毎日 8・12・17・21時");
    expect(cronText("30 9 * * 1")).toBe("毎週月 9:30");
    expect(cronText("0 9 * * 1-5")).toBe("平日 9時");
    expect(cronText("15 * * * *")).toBe("毎日 毎時15分");
    expect(cronText("*/5 * * * *")).toBe("*/5 * * * *");
    expect(cronText("0 0 1 * *")).toBe("0 0 1 * *");
  });

  test("systemd のスケジュールを短く", () => {
    expect(timerText("OnCalendar=*-*-* 03:00:00 Asia/Tokyo")).toBe("毎日 03:00");
    expect(timerText("OnCalendar=Sun *-*-* 03:10:00")).toBe("毎週日 03:10");
    expect(timerText("OnUnitInactiveSec=2min / OnBootSec=2min")).toBe("前回が終わって 2min ごと · 起動の 2min 後");
    expect(timerText("OnCalendar=*-*-* *:00/10:00")).toBe("*-*-* *:00/10:00");
  });

  test("これからの時刻", () => {
    const now = new Date(2026, 9, 20, 20, 0).getTime();
    expect(when(new Date(2026, 9, 20, 21, 0).getTime(), now)).toBe("今日 21:00");
    expect(when(new Date(2026, 9, 21, 8, 5).getTime(), now)).toBe("明日 8:05");
    expect(when(new Date(2026, 9, 24, 3, 10).getTime(), now)).toBe("10/24 3:10");
    expect(when(null, now)).toBe("—");
  });
});
