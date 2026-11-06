// 入り口の本人確認。入り口は Tailscale だけ。
// tailscale serve → unix ソケット → ここ。tailscaled が付ける Tailscale-User-Login を、許可リストと照らす。
// サーバーの TCP（127.0.0.1）は VPS の中の誰でも叩けるので、ヘッダーを信用しない（認証なしのパス以外は 403）。
import type { Context, MiddlewareHandler } from "hono";
import type { Config } from "./config";

type AuthConfig = Pick<Config, "allowedLogins" | "devNoAuth"> & { tailscaleSelfIps?: string[] };

/**
 * Tailscale の入口（tailscale serve → unix ソケット）から来たリクエストの印。
 * ソケットは tailscaled（root）とアプリ自身しか開けないので、そこから来た Tailscale-User-Login は tailscaled が付けたもの。
 * 印は Symbol なので、リクエストの中身（ヘッダーなど）では作れない
 */
export const VIA_TAILSCALE = Symbol("via-tailscale");
export const tailscaleEnv = () => ({ [VIA_TAILSCALE]: true });
const viaTailscale = (env: unknown) => !!env && typeof env === "object" && (env as Record<symbol, unknown>)[VIA_TAILSCALE] === true;

/**
 * Tailscale の入口から来た本人（許可リストにあるログイン名）。違えば null。
 * VPS 自身から tailnet 越しに来たもの（開発エージェント＝cc など VPS の中のユーザー）は、本人の名前が付いていても通さない。
 * VPS の端末の持ち主もオーナーなので、tailscaled は同じ本人の名前を付けてくる。ここで弾かないと、
 * 開発エージェントが自分の承認依頼を自分で「許可」できてしまう。どこから来たか分からないもの・VPS の住所が分からないときも通さない
 */
function tailscaleLogin(c: Context, cfg: AuthConfig): string | null {
  if (!viaTailscale(c.env)) return null;
  const from = (c.req.header("X-Forwarded-For") ?? "").split(",")[0].trim().toLowerCase();
  const self = cfg.tailscaleSelfIps ?? ["*"];
  if (!from || self.includes("*") || self.includes(from)) return null;
  const login = c.req.header("Tailscale-User-Login") ?? "";
  return login && cfg.allowedLogins.includes(login) ? login : null;
}

/** 認証なしで通すパス: 死活確認と、外の送り手の知らせの受け口（受け口の中でトークンを照らす） */
export const isPublicPath = (path: string) => path === "/api/health" || path === "/notify-relay";

/** Tailscale の入口（unix ソケット）から来たか（受け口を 127.0.0.1 だけに絞るため） */
export const fromTailscale = (env: unknown) => viaTailscale(env);

export function requireLogin(cfg: AuthConfig): MiddlewareHandler {
  return async (c, next) => {
    if (isPublicPath(c.req.path) || cfg.devNoAuth) return next();
    return tailscaleLogin(c, cfg) ? next() : c.text("forbidden", 403);
  };
}

/**
 * root 作業の承認用。Tailscale の入口から来た、VPS の外の本人だけ（このうえで plasmod-rootd がパスワードを照らす）。
 * 認証なしのパスも通さない。c.get("loginName") に承認者の名前を入れる
 */
export function requireRootLogin(cfg: AuthConfig): MiddlewareHandler {
  return async (c, next) => {
    if (cfg.devNoAuth) {
      c.set("loginName", "dev");
      return next();
    }
    const login = tailscaleLogin(c, cfg);
    if (!login) return c.text("forbidden", 403);
    c.set("loginName", `${login}（Tailscale）`);
    return next();
  };
}

/**
 * 別のサイトからの書き込みを断る（CSRF）。Tailscale の本人確認は Cookie と同じで、ブラウザが自動で通るので、
 * 悪いサイトを開いただけで、そこから判断や依頼を送れてしまう。読み取りは CORS で守られている。
 * Android アプリの通知のボタンは、どちらのヘッダーも付けないので通る
 */
export function sameOriginWrites(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD" || isPublicPath(c.req.path)) return next();
    const site = c.req.header("Sec-Fetch-Site");
    if (site && site !== "same-origin" && site !== "none") return c.text("forbidden", 403);
    const origin = c.req.header("Origin");
    if (origin) {
      let host = "";
      try {
        host = new URL(origin).host;
      } catch {
        return c.text("forbidden", 403);
      }
      // tailscale serve は unix ソケットへ渡すとき Host を localhost に置き換え、元の住所を X-Forwarded-Host に入れる（tailscaled が上書きするので偽れない）
      if (host !== (c.req.header("X-Forwarded-Host") ?? c.req.header("Host"))) return c.text("forbidden", 403);
    }
    return next();
  };
}

/** 画面の守り。スクリプトは自分のものだけ、ほかのサイトの枠の中に入れない（Content-Security-Policy） */
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};
