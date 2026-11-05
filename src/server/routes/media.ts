// エージェントが出した写真・ファイル
import { type Context } from "hono";
import { mediaResponse } from "../media";
import type { RouteContext } from "./context";

export function mediaRoutes({ app, media }: RouteContext) {
  // ---- エージェントが出した写真・ファイル ----
  const mediaFail = (c: Context, e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, error: msg }, /見せない|外は見られない|不正|大きすぎ|ファイルではない|許可/.test(msg) ? 403 : 500);
  };
  app.get("/api/media/dev/:thread/:msg/:i", async (c) => {
    if (!media) return c.json({ ok: false, error: "メディアは使えない" }, 404);
    try {
      const f = await media.dev(c.req.param("thread"), c.req.param("msg"), Number(c.req.param("i")));
      return mediaResponse(f.name, f.data, c.req.query("dl") === "1");
    } catch (e) {
      return mediaFail(c, e);
    }
  });
  app.get("/api/media/hermes", async (c) => {
    if (!media) return c.json({ ok: false, error: "メディアは使えない" }, 404);
    try {
      const f = await media.hermes(c.req.query("path") ?? "");
      return mediaResponse(f.name, f.data, c.req.query("dl") === "1");
    } catch (e) {
      return mediaFail(c, e);
    }
  });
}
