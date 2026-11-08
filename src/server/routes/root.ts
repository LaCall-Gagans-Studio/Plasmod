// root 作業の承認（plasmod-rootd）
import { type Context } from "hono";
import { requireRootLogin } from "../auth";
import { AllowlistError, cleanLogins, cleanModels, loginsScript, modelsScript } from "../allowlists";
import { validRootId } from "../root";
import type { RouteContext } from "./context";

export function rootRoutes({ app, cfg, store, rootd, system }: RouteContext) {
  // ---- root 作業の承認（plasmod-rootd）----
  // Tailscale の入口から来た VPS の外の本人が必須。パスワードは plasmod-rootd（root）が照合する。ここでは保存もログもしない。
  app.use("/api/root/*", requireRootLogin(cfg));
  app.use("/api/root/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    return next();
  });
  const rootFail = (c: Context, e: unknown) => c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  const rootStatus = (r: { code?: string }) =>
    r.code === "locked" ? 429 : r.code === "bad_password" || r.code === "no_password" ? 403 : r.code === "not_found" ? 404 : r.code === "forbidden" ? 403 : 409;
  app.get("/api/root/requests", async (c) => {
    if (!rootd) return c.json({ ok: false, error: "plasmod-rootd は使えない" }, 404);
    try {
      return c.json(await rootd.call({ op: "list" }));
    } catch (e) {
      return rootFail(c, e);
    }
  });
  app.get("/api/root/requests/:id", async (c) => {
    if (!rootd) return c.json({ ok: false, error: "plasmod-rootd は使えない" }, 404);
    if (!validRootId(c.req.param("id"))) return c.json({ ok: false, error: "ID が不正" }, 400);
    try {
      const r = await rootd.call({ op: "get", id: c.req.param("id") });
      return c.json(r, r.ok ? 200 : rootStatus(r));
    } catch (e) {
      return rootFail(c, e);
    }
  });
  app.post("/api/root/requests/:id/approve", async (c) => {
    if (!rootd) return c.json({ ok: false, error: "plasmod-rootd は使えない" }, 404);
    if (!validRootId(c.req.param("id"))) return c.json({ ok: false, error: "ID が不正" }, 400);
    const body = await c.req.json<{ digest?: unknown; password?: unknown }>().catch(() => ({}) as { digest?: unknown; password?: unknown });
    if (typeof body.digest !== "string" || typeof body.password !== "string" || !body.password)
      return c.json({ ok: false, error: "digest とパスワードが要る" }, 400);
    try {
      const r = await rootd.call({
        op: "approve",
        id: c.req.param("id"),
        digest: body.digest,
        password: body.password,
        by: String(c.get("loginName" as never) ?? ""),
      });
      return c.json(r, r.ok ? 200 : rootStatus(r));
    } catch (e) {
      return rootFail(c, e);
    }
  });
  // 部品の依頼を「元に戻す」: plasmod-rootd が戻す依頼を作り、同じパスワードで承認する（照合は root 側）
  app.post("/api/root/requests/:id/undo", async (c) => {
    if (!rootd) return c.json({ ok: false, error: "plasmod-rootd は使えない" }, 404);
    if (!validRootId(c.req.param("id"))) return c.json({ ok: false, error: "ID が不正" }, 400);
    const body = await c.req.json<{ password?: unknown }>().catch(() => ({}) as { password?: unknown });
    if (typeof body.password !== "string" || !body.password) return c.json({ ok: false, error: "パスワードが要る" }, 400);
    try {
      const r = await rootd.call({ op: "undo", id: c.req.param("id"), password: body.password, by: String(c.get("loginName" as never) ?? "") });
      return c.json(r, r.ok ? 200 : rootStatus(r));
    } catch (e) {
      return rootFail(c, e);
    }
  });
  // オーナーが打ったコマンド: 依頼を作って、同じパスワードで承認する（照合は plasmod-rootd）。本文はログに出さない
  // Nous のログイン・MCP の有効無効（設定の「接続」）。どちらも毎回パスワード。MCP のログインはダッシュボードで行う
  app.post("/api/root/connections/:action", async (c) => {
    if (!rootd) return c.json({ ok: false, error: "plasmod-rootd は使えない" }, 404);
    const action = c.req.param("action");
    if (action !== "reconnect" && action !== "toggle") return c.json({ ok: false, error: "知らない操作" }, 404);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    if (typeof body.password !== "string" || !body.password) return c.json({ ok: false, error: "パスワードが要る" }, 400);
    const by = String(c.get("loginName" as never) ?? "");
    try {
      const r =
        action === "reconnect"
          ? await rootd.call({ op: "nous_login", password: body.password, by })
          : await rootd.call({ op: "mcp_toggle", profile: body.profile, name: body.name, enable: body.enable, password: body.password, by });
      return c.json(r, r.ok ? 200 : rootStatus(r));
    } catch (e) {
      return rootFail(c, e);
    }
  });
  // 許可リストを見る。ログインは今動いているアプリの設定、モデルは仲介が読んだ /etc/plasmod-models.json
  app.get("/api/root/allowlists", async (c) => {
    const m = system ? await system.modelAllowlist() : { models: {}, current: {}, error: "システムは使えない" };
    return c.json({ logins: cfg.allowedLogins, me: cfg.devNoAuth ? "" : String(c.get("loginName" as never) ?? "").replace(/（Tailscale）$/, ""), rootd: !!rootd, ...m });
  });
  // 許可リスト（ログイン・モデル）の書き換え。決まった形のスクリプトにして、持ち主のパスワードで実行する
  app.post("/api/root/allowlist/:kind", async (c) => {
    if (!rootd) return c.json({ ok: false, error: "plasmod-rootd は使えない" }, 404);
    const body = await c.req.json<{ logins?: unknown; models?: unknown; password?: unknown }>().catch(() => ({}) as Record<string, unknown>);
    if (typeof body.password !== "string" || !body.password) return c.json({ ok: false, error: "パスワードが要る" }, 400);
    const by = String(c.get("loginName" as never) ?? "");
    let command: string;
    try {
      if (c.req.param("kind") === "logins") command = loginsScript(cleanLogins(body.logins, cfg.devNoAuth ? "" : by.replace(/（Tailscale）$/, "")));
      else if (c.req.param("kind") === "models") command = modelsScript(cleanModels(body.models));
      else return c.json({ ok: false, error: "知らない種類" }, 404);
    } catch (e) {
      if (e instanceof AllowlistError) return c.json({ ok: false, error: e.message }, 400);
      throw e;
    }
    try {
      const r = await rootd.call({ op: "run", command, password: body.password, by });
      return c.json(r, r.ok ? 200 : rootStatus(r));
    } catch (e) {
      return rootFail(c, e);
    }
  });
  app.post("/api/root/run", async (c) => {
    if (!rootd) return c.json({ ok: false, error: "plasmod-rootd は使えない" }, 404);
    const body = await c.req.json<{ command?: unknown; password?: unknown }>().catch(() => ({}) as { command?: unknown; password?: unknown });
    if (typeof body.command !== "string" || !body.command.trim()) return c.json({ ok: false, error: "コマンドが要る" }, 400);
    if (typeof body.password !== "string" || !body.password) return c.json({ ok: false, error: "パスワードが要る" }, 400);
    try {
      const r = await rootd.call({ op: "run", command: body.command, password: body.password, by: String(c.get("loginName" as never) ?? "") });
      return c.json(r, r.ok ? 200 : rootStatus(r));
    } catch (e) {
      return rootFail(c, e);
    }
  });
  app.post("/api/root/requests/:id/reject", async (c) => {
    if (!rootd) return c.json({ ok: false, error: "plasmod-rootd は使えない" }, 404);
    if (!validRootId(c.req.param("id"))) return c.json({ ok: false, error: "ID が不正" }, 400);
    try {
      const r = await rootd.call({ op: "reject", id: c.req.param("id"), by: String(c.get("loginName" as never) ?? "") });
      return c.json(r, r.ok ? 200 : rootStatus(r));
    } catch (e) {
      return rootFail(c, e);
    }
  });
}
