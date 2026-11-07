// Web Push の登録
import { validSub } from "../webpush";
import type { RouteContext } from "./context";

export function pushRoutes({ app, webPush }: RouteContext) {
  if (!webPush) return;
  app.get("/api/push", (c) => {
    const endpoint = c.req.query("endpoint");
    return c.json({ publicKey: webPush.publicKey(), subscribed: endpoint ? webPush.has(endpoint) : false });
  });
  app.post("/api/push", async (c) => {
    const b = await c.req.json<unknown>().catch(() => null);
    if (!validSub(b)) return c.json({ ok: false, error: "登録の形が正しくない" }, 400);
    webPush.add(b);
    return c.json({ ok: true });
  });
  app.delete("/api/push", async (c) => {
    const b = await c.req.json<{ endpoint?: unknown }>().catch(() => ({}) as { endpoint?: unknown });
    if (typeof b.endpoint !== "string") return c.json({ ok: false, error: "endpoint が要る" }, 400);
    webPush.remove(b.endpoint);
    return c.json({ ok: true });
  });
}
