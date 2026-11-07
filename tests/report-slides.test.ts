import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { config } from "../src/server/config";
import { Hub } from "../src/server/hub";
import { FixtureSource } from "../src/server/kanban";
import { Store } from "../src/server/store";
import { TaskStore } from "../src/server/tasks";
import type { NavBadges, Report } from "../src/shared/types";

describe("レポートと下のメニューの数字", () => {
  async function setup() {
    const store = new Store(":memory:");
    const hub = new Hub(config, new FixtureSource(join(import.meta.dir, "../fixtures/board.json")), store, null, null);
    await hub.refresh();
    return createApp({ ...config, devNoAuth: true }, hub, store, ".", { tasks: new TaskStore(store.db) });
  }

  test("タスクの枚が先頭、自分のタスク、判断待ちの順、実績のまとめが最後", async () => {
    const r = (await (await (await setup()).request("/api/report")).json()) as Report;
    expect(r.slides.map((s) => s.kind)).toEqual(["tasks", "mine", "waiting", "digest"]);
  });

  test("数字: ホーム＝判断待ちのカード、ウォッチング＝止まっているカード", async () => {
    const app = await setup();
    const n = (await (await app.request("/api/badges")).json()) as NavBadges;
    expect(n.home).toBeGreaterThan(0);
    expect(n.watching).toBe(1);
    expect(n).toMatchObject({ dev: 0, system: 0 });
  });
});
