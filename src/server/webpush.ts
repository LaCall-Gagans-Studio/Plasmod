// ブラウザと PWA（iPhone を含む）への通知（Web Push）。VPS から外へ送るだけで、入口は開けない。
// 中身は端末の鍵で暗号化され、通知サービス（Apple・Google など）には読めない。
// 取り消し（clear）は送らない: iOS は通知を出さない push を許さないので。同じ key の通知は端末で上書きされる
import type { Database } from "bun:sqlite";
import webpush from "web-push";
import type { AppNotice, NoticeEvent } from "../shared/types";
import type { NotifyFeed } from "./notify-feed";

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type PushSender = (sub: PushSub, payload: string, opts: { TTL: number; urgency: "normal" | "high"; vapidDetails: { subject: string; publicKey: string; privateKey: string } }) => Promise<unknown>;

const MAX_ENDPOINT = 1024;
const B64URL = /^[A-Za-z0-9_-]+$/;
/** 端末がしばらく圏外でも届ける時間（秒） */
const TTL = 86_400;

/** 通知サービスの住所だけを許す（内向きの住所に送らせない） */
export function validSub(v: unknown): v is PushSub {
  const s = v as PushSub | null;
  if (!s || typeof s.endpoint !== "string" || s.endpoint.length > MAX_ENDPOINT) return false;
  if (typeof s.keys?.p256dh !== "string" || typeof s.keys?.auth !== "string" || !B64URL.test(s.keys.p256dh) || !B64URL.test(s.keys.auth)) return false;
  try {
    const u = new URL(s.endpoint);
    if (u.protocol !== "https:") return false;
    return /(^|\.)(push\.apple\.com|googleapis\.com|mozilla\.com|mozaws\.net|windows\.com|microsoft\.com)$/.test(u.hostname);
  } catch {
    return false;
  }
}

export function pushPayload(n: AppNotice): string {
  return JSON.stringify({ title: n.title, body: n.message.slice(0, 300), path: n.path, tag: n.key, urgent: n.priority >= 5 });
}

export class WebPush {
  constructor(
    private db: Database,
    private subject: string,
    private send: PushSender = (sub, payload, opts) => webpush.sendNotification(sub, payload, opts),
  ) {
    db.exec("CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS push_vapid (id INTEGER PRIMARY KEY CHECK (id = 1), public_key TEXT NOT NULL, private_key TEXT NOT NULL)");
  }

  private vapid(): { publicKey: string; privateKey: string } {
    const r = this.db.query("SELECT public_key, private_key FROM push_vapid WHERE id = 1").get() as { public_key: string; private_key: string } | null;
    if (r) return { publicKey: r.public_key, privateKey: r.private_key };
    const k = webpush.generateVAPIDKeys();
    this.db.query("INSERT INTO push_vapid (id, public_key, private_key) VALUES (1, ?, ?)").run(k.publicKey, k.privateKey);
    return k;
  }

  publicKey(): string {
    return this.vapid().publicKey;
  }

  add(sub: PushSub, now = Date.now()) {
    this.db.query("INSERT INTO push_subs (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth").run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, now);
  }

  remove(endpoint: string) {
    this.db.query("DELETE FROM push_subs WHERE endpoint = ?").run(endpoint);
  }

  has(endpoint: string): boolean {
    return !!this.db.query("SELECT 1 FROM push_subs WHERE endpoint = ?").get(endpoint);
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM push_subs").get() as { n: number }).n;
  }

  /** 全部の端末へ。もう無い端末（404・410）は外す */
  async notify(n: AppNotice): Promise<void> {
    const subs = this.db.query("SELECT endpoint, p256dh, auth FROM push_subs").all() as { endpoint: string; p256dh: string; auth: string }[];
    if (!subs.length) return;
    const payload = pushPayload(n);
    const opts = { TTL, urgency: n.priority >= 4 ? ("high" as const) : ("normal" as const), vapidDetails: { subject: this.subject, ...this.vapid() } };
    await Promise.all(
      subs.map(async (s) => {
        try {
          await this.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, opts);
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) this.remove(s.endpoint);
          else console.warn(`Web Push を送れない: HTTP ${status ?? "?"} ${new URL(s.endpoint).hostname}`);
        }
      }),
    );
  }

  /** 通知の流れにつなぐ */
  attach(feed: NotifyFeed) {
    feed.subscribe((e: NoticeEvent) => {
      if (e.type === "notice") void this.notify(e);
    });
  }
}
