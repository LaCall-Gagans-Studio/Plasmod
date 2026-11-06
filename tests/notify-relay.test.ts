import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import { tailscaleEnv } from "../src/server/auth";
import { config } from "../src/server/config";
import { NotifyFeed } from "../src/server/notify-feed";
import { clickToPath, decodeHeader, parseRelay, tokenOk } from "../src/server/notify-relay";
import { Store } from "../src/server/store";

describe("知らせの受け口（自動デプロイ・plasmod-rootd の知らせを APK へ）", () => {
  test("2つの送り方を読む: JSON（plasmod-rootd）と、本文＋見出し（自動デプロイの curl）", () => {
    const j = parseRelay(new Headers({ "content-type": "application/json" }), JSON.stringify({ topic: "plasmod", title: "root 作業の承認待ち", message: "Tailscale の入口", priority: 4, tags: ["lock"], click: "https://hermes.example/#/root" }));
    expect(j).toEqual({ title: "root 作業の承認待ち", message: "Tailscale の入口", priority: 4, tags: ["lock"], click: "https://hermes.example/#/root" });
    // curl -H "Title: 反映した" は UTF-8 のまま届き、latin1 として読まれている
    const latin1 = Buffer.from("反映した", "utf8").toString("latin1");
    const t = parseRelay(new Headers({ Title: latin1, Priority: "high", Tags: "rocket,ok" }), "abc1234 を /opt に入れた");
    expect(t).toEqual({ title: "反映した", message: "abc1234 を /opt に入れた", priority: 4, tags: ["rocket", "ok"], click: "" });
    expect(decodeHeader("plain")).toBe("plain");
    expect(clickToPath("https://hermes.example/#/root")).toBe("#/root");
    expect(clickToPath("")).toBe("");
  });

  test("トークンの照合", () => {
    expect(tokenOk("Bearer tk_123", "tk_123")).toBe(true);
    expect(tokenOk("Bearer tk_12", "tk_123")).toBe(false);
    expect(tokenOk(undefined, "tk_123")).toBe(false);
    expect(tokenOk("Bearer x", "")).toBe(false); // トークンが設定されていなければ全部断る
  });

  test("受け口: 127.0.0.1 からトークンつきなら流れに入れる。Tailscale・トークン違いは断る", async () => {
    const store = new Store(":memory:");
    const feed = new NotifyFeed(store.db);
    const cfg = { ...config, devNoAuth: false, relayToken: "tk_123" };
    const hub = { snapshot: () => ({}), subscribe: () => () => {} };
    const app = createApp(cfg, hub as never, store, "/nonexistent", { feed });
    const post = (path: string, headers: Record<string, string>, body: string, env?: object) => app.request(path, { method: "POST", headers, body }, env);
    const ok = await post("/notify-relay", { Authorization: "Bearer tk_123", Title: Buffer.from("止めた", "utf8").toString("latin1"), Priority: "4" }, "broker/ が変わった");
    expect(ok.status).toBe(200);
    const [n] = feed.since(0);
    expect(n).toMatchObject({ type: "notice", kind: "system", title: "止めた", message: "broker/ が変わった", priority: 4, path: "" });
    expect((await post("/notify-relay", { Authorization: "Bearer tk_123", "Content-Type": "application/json" }, JSON.stringify({ title: "承認待ち", message: "x", click: "https://h/#/root" }))).status).toBe(200);
    expect(feed.since(n.id)[0]).toMatchObject({ title: "承認待ち", path: "#/root" });
    // 断る
    expect((await post("/notify-relay", { Authorization: "Bearer wrong" }, "x")).status).toBe(403);
    expect((await post("/notify-relay", {}, "x")).status).toBe(403);
    expect((await post("/notify-relay", { Authorization: "Bearer tk_123", "X-Forwarded-For": "100.64.0.9", "Tailscale-User-Login": "owner@example.com" }, "x", tailscaleEnv())).status).toBe(403);
    expect(feed.since(0)).toHaveLength(2);
  });
});
