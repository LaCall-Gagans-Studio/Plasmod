// システム（使用量・モデル・VPS・定期実行・ファイル）
import { type Context } from "hono";
import type { RouteContext } from "./context";

export function systemRoutes({ app, system, connections }: RouteContext) {
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
    // agent を渡されたら、そのエージェントの接続先の残高を返す（Nous なら Nous、Venice・OpenRouter ならその残高）。分からなければ null
    const agent = c.req.query("agent");
    const force = c.req.query("force") === "1";
    if (agent) {
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(agent)) return c.json(null);
      const provider = await system.providerOf(agent);
      if (!provider) return c.json(null);
      if (provider !== "nous") return c.json(await system.balance(agent, force));
    }
    return c.json(await system.credits(force));
  });
  app.get("/api/system/balances", async (c) => (system ? c.json(await system.balances()) : c.json([], 404)));
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
