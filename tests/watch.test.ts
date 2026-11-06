import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { config } from "../src/server/config";
import { Hub } from "../src/server/hub";
import { FixtureSource } from "../src/server/kanban";
import { Store } from "../src/server/store";
import { WatchService } from "../src/server/watch";
import type { Report } from "../src/shared/types";

const NOW = Date.now();
const S = Math.floor(NOW / 1000);

function broker(calls: string[][], cron: string | null = null) {
  return async (...a: string[]) => {
    calls.push(a);
    if (a[0] === "cron") {
      if (cron === null) throw new Error("unknown");
      return cron;
    }
    if (a[0] !== "cron-output") throw new Error("unknown");
    if (a[1] === "auditor") return JSON.stringify([
      { job: "j1", name: "週次監査", at: S - 3600, ok: true, text: "## 今週\n問題なし" },
      { job: "j1", name: "週次監査", at: S - 8 * 86400, ok: true, text: "先週" },
    ]);
    if (a[1] === "its") return JSON.stringify([{ job: "j2", name: "改善提案", at: S - 20 * 86400, ok: true, text: "古い" }]);
    if (a[1] === "default") return JSON.stringify([
      { job: "m1", name: "見回り", at: S - 600, ok: true, text: "21時の見回り" },
      { job: "m1", name: "見回り", at: S - 4 * 3600, ok: true, text: "17時の見回り" },
      { job: "m1", name: "見回り", at: S - 30 * 3600, ok: true, text: "昨日" },
    ]);
    if (a[1] === "ops") return JSON.stringify([{ job: "o1", name: "朝の運用レポート", at: S - 12 * 3600, ok: false, text: "" }]);
    throw new Error("知らないプロファイル");
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const job = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, enabled: true, state: "scheduled", next_run_at: iso(NOW + 3600_000), last_status: "ok", ...extra });
const CRON = JSON.stringify({
  default: [job("m1", "見回り")],
  ops: [job("o1", "朝の運用レポート", { last_status: "error" })],
  auditor: [job("j1", "週次監査")],
  its: [job("j2", "改善提案", { next_run_at: iso(NOW - 2 * 3600_000) })],
  strategy: [job("j3", "振り返り", { enabled: false, next_run_at: iso(NOW - 2 * 3600_000) })],
  acct: [],
});

describe("監察チーム", () => {
  test("既定のプロファイルに監察の3人がいる", () => {
    expect(config.profiles.filter((p) => p.team === "watch").map((p) => [p.id, p.name])).toEqual([["auditor", "監査"], ["its", "ITS"], ["strategy", "戦略立案"]]);
  });

  test("報告は新しい順。レポート用はプロファイルごとに8日以内の最新1件。まだ無いプロファイルはエラーにしない", async () => {
    const calls: string[][] = [];
    const w = new WatchService(broker(calls), config.profiles);
    const all = await w.all();
    expect(all.reports.filter((r) => r.agent !== "default").map((r) => [r.agent, r.text])).toEqual([["auditor", "## 今週\n問題なし"], ["auditor", "先週"], ["its", "古い"]]);
    expect(all.errors).toEqual([]);
    // cron が読めないときは、設定のプロファイル（開発くんを除く）を全部読む
    expect(calls.filter((c) => c[0] === "cron-output").map((c) => c[1]).sort()).toEqual(["acct", "auditor", "default", "design", "its", "strategy"]);
    const latest = await w.latest("watch", NOW);
    expect(latest.items.map((r) => r.agent)).toEqual(["auditor"]);
    expect(latest.items[0].at).toBe((S - 3600) * 1000);
  });

  test("レポートに「監察」の1枚をまとめの前に足す", async () => {
    const store = new Store(":memory:");
    const hub = new Hub(config, new FixtureSource(join(import.meta.dir, "../fixtures/board.json")), store, null, null);
    await hub.refresh();
    const w = new WatchService(broker([], CRON), config.profiles);
    const app = createApp({ ...config, devNoAuth: true }, hub, store, ".", { watch: w });
    const r = (await (await app.request("/api/report")).json()) as Report;
    expect(r.slides.at(-2)).toMatchObject({ kind: "watch", items: [{ agent: "auditor", name: "週次監査" }] });
    expect(r.slides.at(-3)).toMatchObject({ kind: "routine" });
    expect(r.slides.at(-1)!.kind).toBe("digest");
    const list = (await (await app.request("/api/watch")).json()) as { reports: unknown[] };
    expect(list.reports.length).toBe(7);
  });

  test("定期報告: cron のあるプロファイル（並びに無い ops も）を読み、実働はジョブごとに26時間以内の最新1件。動いていないジョブも出す", async () => {
    const calls: string[][] = [];
    const w = new WatchService(broker(calls, CRON), config.profiles);
    const d = await w.routine(NOW);
    expect(calls.filter((c) => c[0] === "cron-output").map((c) => c[1]).sort()).toEqual(["auditor", "default", "its", "ops", "strategy"]);
    expect(d.items.map((r) => [r.agent, r.text])).toEqual([["default", "21時の見回り"], ["ops", ""]]);
    expect(d.items[1].ok).toBe(false);
    // 前回が失敗した ops と、予定を過ぎた its。止めてある strategy は出さない
    expect(d.late).toEqual([
      { agent: "ops", name: "朝の運用レポート", reason: "前回の実行が失敗した" },
      { agent: "its", name: "改善提案", reason: "予定の時刻を過ぎても動いていない" },
    ]);
    // 監察の1枚には実働の報告を混ぜない
    expect((await w.latest("watch", NOW)).items.map((r) => r.agent)).toEqual(["auditor"]);
  });
});
