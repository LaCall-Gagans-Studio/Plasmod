import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import webpush from "web-push";
import { NotifyFeed } from "../src/server/notify-feed";
import { pushPayload, validSub, WebPush, type PushSender, type PushSub } from "../src/server/webpush";
import type { AppNotice } from "../src/shared/types";

// 本物の形の端末の鍵（web-push の検査を通る）
const curve = crypto.subtle;
async function realKeys() {
  const pair = (await curve.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array(await curve.exportKey("raw", pair.publicKey));
  return { p256dh: Buffer.from(raw).toString("base64url"), auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url") };
}
const sub = (endpoint: string): PushSub => ({ endpoint, keys: { p256dh: "abc", auth: "def" } });
const NOTICE: AppNotice = { id: 1, at: 1, type: "notice", kind: "card", key: "task:1", title: "題", message: "本文".repeat(300), priority: 5, path: "#/card/task%3A1", actions: [] };

describe("Web Push", () => {
  test("通知サービスの https の住所だけ受け付ける", () => {
    expect(validSub(sub("https://web.push.apple.com/abc"))).toBe(true);
    expect(validSub(sub("https://fcm.googleapis.com/fcm/send/abc"))).toBe(true);
    expect(validSub(sub("https://updates.push.services.mozilla.com/wpush/v2/x"))).toBe(true);
    expect(validSub(sub("http://web.push.apple.com/abc"))).toBe(false);
    expect(validSub(sub("https://127.0.0.1/abc"))).toBe(false);
    expect(validSub(sub("https://evil.example/abc"))).toBe(false);
    expect(validSub(sub("https://push.apple.com.evil.example/abc"))).toBe(false);
    expect(validSub({ endpoint: "https://web.push.apple.com/a" })).toBe(false);
    expect(validSub(null)).toBe(false);
  });

  test("鍵は1回だけ作って保存する", () => {
    const db = new Database(":memory:");
    const a = new WebPush(db, "https://x.ts.net").publicKey();
    expect(a.length).toBeGreaterThan(40);
    expect(new WebPush(db, "https://x.ts.net").publicKey()).toBe(a);
  });

  test("全端末へ送る。なくなった端末は外し、ほかの失敗では外さない", async () => {
    const sent: string[] = [];
    let opts: Parameters<PushSender>[2] | null = null;
    const w = new WebPush(new Database(":memory:"), "https://x.ts.net", async (s, _p, o) => {
      sent.push(s.endpoint);
      opts = o;
      if (s.endpoint.endsWith("gone")) throw Object.assign(new Error("x"), { statusCode: 410 });
      if (s.endpoint.endsWith("busy")) throw Object.assign(new Error("x"), { statusCode: 503 });
    });
    for (const e of ["ok", "gone", "busy"]) w.add(sub(`https://web.push.apple.com/${e}`));
    await w.notify(NOTICE);
    expect(sent.length).toBe(3);
    expect(w.count()).toBe(2);
    expect(w.has("https://web.push.apple.com/gone")).toBe(false);
    expect(opts!).toMatchObject({ urgency: "high", TTL: 86400 });
    expect(opts!.vapidDetails.subject).toBe("https://x.ts.net");
  });

  test("通知の流れにつなぐ。取り消しは送らない", async () => {
    const db = new Database(":memory:");
    const sent: string[] = [];
    const feed = new NotifyFeed(db);
    const w = new WebPush(db, "https://x.ts.net", async (_s, p) => void sent.push(p));
    w.add(sub("https://web.push.apple.com/a"));
    w.attach(feed);
    feed.add({ kind: "card", key: "k", title: "題", message: "本文", priority: 3, path: "#/", actions: [] });
    feed.clear("k");
    await Bun.sleep(10);
    expect(sent.length).toBe(1);
    expect(JSON.parse(sent[0])).toMatchObject({ title: "題", body: "本文", tag: "k", path: "#/", urgent: false });
  });

  test("本文は長すぎないように切る。実際のライブラリで暗号化できる", async () => {
    const payload = pushPayload(NOTICE);
    expect(JSON.parse(payload).body.length).toBe(300);
    const k = webpush.generateVAPIDKeys();
    const d = webpush.generateRequestDetails({ endpoint: "https://web.push.apple.com/a", keys: await realKeys() }, payload, { TTL: 60, vapidDetails: { subject: "https://x.ts.net", publicKey: k.publicKey, privateKey: k.privateKey } });
    expect(d.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(String(d.headers.Authorization)).toStartWith("vapid t=");
    expect(Buffer.from(d.body as Buffer).includes(Buffer.from("本文"))).toBe(false);
  });
});
