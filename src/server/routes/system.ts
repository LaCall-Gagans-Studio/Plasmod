// システム（使用量・モデル・VPS・定期実行・ファイル）
import { type Context } from "hono";
import { AppSettings } from "../profiles";
import type { RouteContext } from "./context";

export function systemRoutes({ app, system, connections, store }: RouteContext) {
  // ---- システム ----
  const sysFail = (c: Context, e: unknown) =>
    c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, e instanceof Error && /見せない|外は見られない|不正/.test(e.message) ? 403 : 500);
  app.get("/api/system/usage", async (c) => {
    if (!system) return c.json({ ok: false, error: "システムは使えない" }, 404);
    try {
      return c.json(await system.usage(c.req.query("force") === "1"));
    } catch (e) {
      return sysFail(c, e);
    }
  });
  // プロフィールカードの総トークン数。Hermes の各プロファイルの30日合計（System の「トークン」と同じ定義）。
  // 30日の窓から古い分が落ちても減らないよう、これまでの最大値を覚えて返す
  app.get("/api/system/tokens-total", async (c) => {
    const settings = new AppSettings(store.db);
    const stored = Number(settings.get("tokens_peak") ?? 0) || 0;
    let now = 0;
    try {
      const u = system ? await system.usage() : null;
      for (const h of Object.values(u?.hermes ?? {})) if (!("error" in h)) now += h.d30.tokens || 0;
    } catch {
      /* 取れなければ覚えている値 */
    }
    const total = Math.max(stored, Math.round(now));
    if (total > stored) settings.set("tokens_peak", String(total));
    return c.json({ tokens: total });
  });
  app.get("/api/system/connections", async (c) => {
    if (!connections) return c.json({ ok: false, error: "接続の状況は使えない" }, 404);
    try {
      return c.json(await connections.view(c.req.query("force") === "1"));
    } catch (e) {
      return sysFail(c, e);
    }
  });
  app.get("/api/system/credits", async (c) => {
    if (!system) return c.json({ ok: false, error: "システムは使えない" }, 404);
    return c.json(await system.credits(c.req.query("force") === "1"));
  });
  app.get("/api/system/models", async (c) => (system ? c.json(await system.models()) : c.json([], 404)));
  app.get("/api/system/agents", async (c) => (system ? c.json(await system.agents()) : c.json([], 404)));
  app.get("/api/system/vps-series", (c) => (system ? c.json({ samples: system.vpsSeries() }) : c.json({ ok: false, error: "システムは使えない" }, 404)));
  app.get("/api/system/vps", async (c) => (system ? c.json(await system.vps()) : c.json({ ok: false, error: "システムは使えない" }, 404)));
  app.get("/api/system/schedules", async (c) => (system ? c.json(await system.schedules()) : c.json({ ok: false, error: "システムは使えない" }, 404)));
  app.post("/api/system/models", async (c) => {
    const body = await c.req.json<{ key?: string; choice?: string }>().catch(() => ({}) as { key?: string; choice?: string });
    try {
      if (!system) throw new Error("システムは使えない");
      await system.setModel(String(body.key ?? ""), String(body.choice ?? ""));
      return c.json({ ok: true, models: await system.models() });
    } catch (e) {
      return sysFail(c, e);
    }
  });
  app.get("/api/system/fs/:root", async (c) => {
    try {
      if (!system) throw new Error("システムは使えない");
      const path = c.req.query("path") ?? "";
      return c.json(c.req.query("read") === "1" ? await system.fsRead(c.req.param("root"), path) : await system.fsList(c.req.param("root"), path));
    } catch (e) {
      return sysFail(c, e);
    }
  });
}
