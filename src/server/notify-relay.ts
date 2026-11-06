// 外の送り手（自動デプロイ・plasmod-rootd）の知らせの受け口。
// ここで受けて APK の通知の流れに入れる。受けるのは 127.0.0.1 の TCP だけ（Tailscale から来たものは断る）、かつトークンが合うものだけ。
import { timingSafeEqual } from "node:crypto";
import type { AppNotice } from "../shared/types";

export const RELAY_PATH = "/notify-relay";

export interface RelayMessage {
  title: string;
  message: string;
  priority: number;
  tags: string[];
  /** 押したときの行き先（アプリの中の #/…） */
  click: string;
}

const PRIORITY: Record<string, number> = { min: 1, low: 2, default: 3, high: 4, max: 5, urgent: 5 };
const priorityOf = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isInteger(n) && n >= 1 && n <= 5) return n;
  return PRIORITY[String(v ?? "").toLowerCase()] ?? 3;
};

/** curl は日本語の見出しを UTF-8 のまま送るが、受け側では latin1 として読まれる。UTF-8 に読み直す */
export function decodeHeader(v: string | undefined): string {
  if (!v) return "";
  if (!/[\u0080-ÿ]/.test(v) || /[^\u0000-ÿ]/.test(v)) return v;
  const u = Buffer.from(v, "latin1").toString("utf8");
  return u.includes("�") ? v : u;
}

/** 2つの送り方を読む: JSON（{topic,title,message,priority,tags,click}）と、本文＋見出し（Title・Priority・Tags・Click） */
export function parseRelay(headers: Headers, body: string): RelayMessage {
  const h = (...names: string[]) => decodeHeader(names.map((n) => headers.get(n) ?? undefined).find((x) => x !== undefined));
  if ((headers.get("content-type") ?? "").includes("application/json") || body.trimStart().startsWith("{")) {
    try {
      const o = JSON.parse(body) as Record<string, unknown>;
      return {
        title: String(o.title ?? ""),
        message: String(o.message ?? ""),
        priority: priorityOf(o.priority),
        tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
        click: String(o.click ?? ""),
      };
    } catch {
      // JSON でなければ本文として読む
    }
  }
  return {
    title: h("x-title", "title", "t"),
    message: body,
    priority: priorityOf(h("x-priority", "priority", "p") || 3),
    tags: h("x-tags", "tags", "ta").split(",").map((s) => s.trim()).filter(Boolean),
    click: h("x-click", "click"),
  };
}

/** click（https://…/#/root など）を、アプリの中の行き先（#/root）にする */
export const clickToPath = (click: string) => {
  const i = click.indexOf("#/");
  return i >= 0 ? click.slice(i) : "";
};

export function relayNotice(m: RelayMessage, now = Date.now()): Omit<AppNotice, "id" | "at" | "type"> {
  return {
    kind: "system",
    key: `system:${now}:${Math.random().toString(36).slice(2, 8)}`,
    title: m.title.slice(0, 200) || "Plasmod",
    message: m.message.slice(0, 2000),
    priority: m.priority,
    path: clickToPath(m.click),
    actions: [],
  };
}

/** Authorization: Bearer <PLASMOD_NOTIFY_TOKEN> が合うか（時間で比べ方が漏れないように） */
export function tokenOk(auth: string | undefined, token: string): boolean {
  if (!token) return false;
  const got = Buffer.from((auth ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}
