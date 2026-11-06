import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import { config } from "../src/server/config";
import { PerfLog } from "../src/server/perf";
import { Store } from "../src/server/store";
import { replySeen } from "../src/web/perf";
import type { SessionView } from "../src/shared/types";

describe("速さの記録", () => {
  test("中央値と遅い方を、種類・端末ごとに出す。おかしな値と古い記録は入らない", () => {
    const log = new PerfLog(new Store(":memory:").db);
    const now = 100 * 86_400_000;
    for (const ms of [100, 200, 300, 400, 5000]) log.add("startup", "apk", ms, now);
    log.add("startup", "browser", 50, now);
    log.add("session_new", "apk", 9000, now - 40 * 86_400_000); // 30日より前
    log.add("nope", "apk", 1, now);
    log.add("startup", "pc", 1, now);
    log.add("startup", "apk", -1, now);
    log.add("startup", "apk", "x", now);
    expect(log.summary(30, now).sort((a, b) => a.via.localeCompare(b.via))).toEqual([
      { name: "startup", via: "apk", n: 5, p50: 300, p90: 5000 },
      { name: "startup", via: "browser", n: 1, p50: 50, p90: 50 },
    ]);
  });

  test("API: 送ると集計に入る。変な本文でも 200", async () => {
    const store = new Store(":memory:");
    const app = createApp({ ...config, devNoAuth: true }, { snapshot: () => ({}), subscribe: () => () => {} } as never, store, "/nonexistent");
    const post = (body: string) => app.request("/api/perf", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    expect((await post(JSON.stringify({ name: "session_reply", via: "browser", ms: 1234 }))).status).toBe(200);
    expect((await post("not json")).status).toBe(200);
    expect(await (await app.request("/api/perf")).json()).toEqual([{ name: "session_reply", via: "browser", n: 1, p50: 1234, p90: 1234 }]);
  });

  test("返事の判定: 送った発言より後のエージェントの文だけ数える", () => {
    const chat = (messages: { role: string; text: string }[]): SessionView => ({ kind: "chat", messages, alive: true, working: false });
    expect(replySeen(chat([{ role: "user", text: "前の話" }, { role: "assistant", text: "前の返事" }]), "こんにちは")).toBe(false);
    expect(replySeen(chat([{ role: "assistant", text: "前の返事" }, { role: "user", text: "こんにちは" }]), "こんにちは")).toBe(false);
    expect(replySeen(chat([{ role: "user", text: "こんにちは" }, { role: "steps", text: "" }]), "こんにちは")).toBe(false);
    expect(replySeen(chat([{ role: "user", text: "こんにちは" }, { role: "assistant", text: "はい" }]), "こんにちは")).toBe(true);
    const term = (messages: { author: string; content: string; at: number }[]) => ({ kind: "terminal", text: "", alive: true, working: false, messages }) as unknown as SessionView;
    expect(replySeen(term([{ author: "owner", content: "やって", at: 1 }, { author: "system", content: "承認待ち", at: 2 }]), "やって")).toBe(false);
    expect(replySeen(term([{ author: "owner", content: "やって", at: 1 }, { author: "dev", content: "了解", at: 2 }]), "やって")).toBe(true);
  });
});

describe("起動の内訳", () => {
  test("足すと全体になり、入口の画面は APK のときだけ", async () => {
    const { startupStages } = await import("../src/web/perf");
    const s = startupStages({ launch: 1000, origin: 7000, responseEnd: 500, contentLoaded: 900, now: 1500 });
    expect(s).toEqual([
      { name: "startup_entry", ms: 6000 },
      { name: "startup_doc", ms: 500 },
      { name: "startup_script", ms: 400 },
      { name: "startup_data", ms: 600 },
    ]);
    expect(s.reduce((a, x) => a + x.ms, 0)).toBe(7500);
    expect(startupStages({ launch: 0, origin: 7000, responseEnd: 500, contentLoaded: 900, now: 1500 }).map((x) => x.name)).toEqual(["startup_doc", "startup_script", "startup_data"]);
  });

  test("まだ読み終わっていなくても負の値にしない", async () => {
    const { startupStages } = await import("../src/web/perf");
    expect(startupStages({ launch: 0, origin: 0, responseEnd: 500, contentLoaded: 0, now: 400 }).map((x) => x.ms)).toEqual([500, 0, 0]);
  });
});
