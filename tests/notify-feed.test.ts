import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import { config } from "../src/server/config";
import { cardNotice, Notifier } from "../src/server/notify";
import { NotifyFeed } from "../src/server/notify-feed";
import { Store } from "../src/server/store";
import type { Card, NoticeEvent } from "../src/shared/types";

const card = (key: string): Card =>
  ({
    key,
    kind: "blocked",
    agent: "dev",
    title: "PR をマージしていいか",
    body: "テストは通った",
    statusLabel: "止まった",
    createdAt: 1,
    options: [
      { id: "approve", label: "進めて", tone: "primary" },
      { id: "revise", label: "指示して進めて", tone: "default", needsText: true },
      { id: "mine", label: "自分でやる", tone: "default" },
      { id: "later", label: "あとで", tone: "quiet" },
      { id: "dismiss", label: "不要", tone: "quiet" },
    ],
  }) as Card;

describe("APK の通知（TASK-250）", () => {
  test("カードの通知: ボタンはその場で返す選択肢だけ・行き先はカード", () => {
    const n = cardNotice(config, card("task:k1"), 1);
    expect(n).toMatchObject({ kind: "card", key: "task:k1", priority: 4, path: "#/card/task%3Ak1" });
    expect(n.actions).toEqual([{ label: "進めて", option: "approve" }]);
    expect(cardNotice(config, card("task:k1"), 2).title).toStartWith("【再通知】");
  });

  test("Notifier: 流れに出し、無くなったカードは clear", async () => {
    const store = new Store(":memory:");
    const feed = new NotifyFeed(store.db);
    const seen: NoticeEvent[] = [];
    feed.subscribe((e) => seen.push(e));
    const n = new Notifier(config, store, feed);
    await n.sweep([card("task:k1")]);
    await n.sweep([card("task:k1")]); // 2回目は再通知の時刻前なので出ない
    n.reply("default", "s1", "終わりました");
    await n.sweep([]);
    expect(seen.map((e) => [e.type, e.type === "clear" ? e.key : e.kind])).toEqual([
      ["notice", "card"],
      ["notice", "reply"],
      ["clear", "task:k1"],
    ]);
    expect(feed.since(0).map((e) => e.id)).toEqual(seen.map((e) => e.id));
    expect(feed.since(seen[1].id).map((e) => e.type)).toEqual(["clear"]);
    expect(feed.last()).toBe(seen[2].id);
  });

  test("/api/notify/stream: since より後の分を送り、そのあとの新しいものも流す", async () => {
    const store = new Store(":memory:");
    const feed = new NotifyFeed(store.db);
    const a = feed.add(cardNotice(config, card("task:a"), 1));
    feed.add(cardNotice(config, card("task:b"), 1));
    const hub = { snapshot: () => ({}), subscribe: () => () => {} };
    const app = createApp({ ...config, devNoAuth: true }, hub as never, store, "/nonexistent", { feed });
    const res = await app.request(`/api/notify/stream?since=${a.id}`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    let text = "";
    const until = async (re: RegExp) => {
      while (!re.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    };
    await until(/task:b/);
    expect(text).toContain("event: hello");
    expect(text).not.toContain("task:a"); // since の分は送らない
    feed.clear("task:b");
    await until(/event: clear/);
    expect(text).toContain("event: clear");
    await reader.cancel();
  });
});

describe("ウィジェット（TASK-249）", () => {
  test("/api/widget: 判断待ちの枚数と一番上の1枚（行き先つき）。無ければ top は null", async () => {
    const store = new Store(":memory:");
    let cards: Card[] = [card("task:k1"), card("perm:t:r")];
    const hub = { snapshot: () => ({}), subscribe: () => () => {}, cards: () => cards };
    const app = createApp({ ...config, devNoAuth: true }, hub as never, store, "/nonexistent");
    const a = await (await app.request("/api/widget")).json();
    expect(a).toMatchObject({ count: 2, top: { key: "task:k1", title: "PR をマージしていいか", label: "止まった", agent: "開発くん", path: "#/card/task%3Ak1" } });
    cards = [];
    expect(await (await app.request("/api/widget")).json()).toMatchObject({ count: 0, top: null });
  });
});
