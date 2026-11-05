// 共有メニューから来たもの
import { fileResponse } from "../share";
import type { RouteContext } from "./context";
import { readForm } from "./form";

export function sharesRoutes({ app, shares }: RouteContext) {
  // ---- 共有メニューから来たもの（チャットの添付になる） ----
  // Android の共有メニュー（manifest の share_target）から来る。いったんここに置き、
  // アプリがチャットの添付として取り込んだら消す（宛先は選ばせない）。
  app.post("/share", async (c) => {
    if (!shares) return c.text("共有は使えない", 404);
    try {
      const { meta, files } = await readForm(await c.req.formData());
      return c.redirect(`/#/share/${shares.save(meta, files)}`, 303);
    } catch (e) {
      return c.redirect(`/#/share/error?m=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`, 303);
    }
  });
  app.get("/api/shares/:id", (c) => {
    try {
      const info = shares?.get(c.req.param("id"));
      return info ? c.json(info) : c.json({ error: "無い（もう取り込んだか、期限切れ）" }, 404);
    } catch {
      return c.json({ error: "不正な ID" }, 400);
    }
  });
  app.get("/api/shares/:id/files/:n", (c) => {
    try {
      const f = shares?.file(c.req.param("id"), Number(c.req.param("n")));
      if (!f) return c.text("not found", 404);
      return fileResponse(f.name, f.type, f.data);
    } catch {
      return c.text("bad request", 400);
    }
  });
  app.delete("/api/shares/:id", (c) => {
    try {
      shares?.remove(c.req.param("id"));
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false, error: "不正な ID" }, 400);
    }
  });
}
