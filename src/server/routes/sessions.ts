// セッション
import { applyMarks } from "../sessions";
import { type ShareFile, checkFiles } from "../share";
import type { RouteContext } from "./context";
import { readForm } from "./form";

export function sessionsRoutes({ app, store, sessions }: RouteContext) {
  // ---- セッション ----
  const AGENT_RE = /^[a-z0-9_-]{1,32}$/;
  const fail = (e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) });
  app.get("/api/sessions", (c) => c.json({ agents: sessions?.agents() ?? [] }));
  app.get("/api/sessions/:agent", async (c) => {
    if (!sessions || !AGENT_RE.test(c.req.param("agent"))) return c.json(fail("知らないエージェント"), 404);
    try {
      const agent = c.req.param("agent");
      return c.json({ ok: true, sessions: applyMarks(agent, await sessions.list(agent), store.sessionMarks(agent)) });
    } catch (e) {
      return c.json(fail(e), 500);
    }
  });
  // 長押しメニュー: ピン留め・削除（アプリの一覧から外すだけ。Hermes の記録は消さない）
  app.post("/api/sessions/:agent/:id/mark", async (c) => {
    const agent = c.req.param("agent");
    if (!sessions || !AGENT_RE.test(agent)) return c.json(fail("知らないエージェント"), 404);
    const b = await c.req.json<{ pinned?: unknown; hidden?: unknown; title?: unknown; rename?: unknown }>().catch(() => ({}) as Record<string, unknown>);
    const flag = (v: unknown) => (typeof v === "boolean" ? v : undefined);
    const m = {
      pinned: flag(b.pinned),
      hidden: flag(b.hidden),
      title: typeof b.title === "string" ? b.title : undefined,
      rename: typeof b.rename === "string" || b.rename === null ? (b.rename as string | null) : undefined,
    };
    if (m.pinned === undefined && m.hidden === undefined && m.rename === undefined) return c.json(fail("pinned・hidden・rename のどれかが要る"), 400);
    store.markSession(agent, c.req.param("id").slice(0, 200), m);
    return c.json({ ok: true });
  });
  app.get("/api/sessions/:agent/:id", async (c) => {
    if (!sessions || !AGENT_RE.test(c.req.param("agent"))) return c.json(fail("知らないエージェント"), 404);
    try {
      return c.json({ ok: true, view: await sessions.view(c.req.param("agent"), c.req.param("id")) });
    } catch (e) {
      return c.json(fail(e), 500);
    }
  });
  app.get("/api/sessions/:agent/:id/older", async (c) => {
    if (!sessions || !AGENT_RE.test(c.req.param("agent"))) return c.json(fail("知らないエージェント"), 404);
    const before = c.req.query("before") ?? "";
    if (!before || before.length > 100) return c.json(fail("before が要る"), 400);
    try {
      const page = await sessions.older(c.req.param("agent"), c.req.param("id"), before, Math.max(0, Number(c.req.query("offset") ?? 0) || 0));
      return c.json({ ok: true, ...page });
    } catch (e) {
      return c.json(fail(e), 500);
    }
  });
  app.post("/api/sessions/:agent/send", async (c) => {
    if (!sessions || !AGENT_RE.test(c.req.param("agent"))) return c.json(fail("知らないエージェント"), 404);
    try {
      let id: string | null = null;
      let text = "";
      let files: ShareFile[] = [];
      if ((c.req.header("content-type") ?? "").startsWith("multipart/form-data")) {
        // 添付つき（写真・PDF など）
        const form = await c.req.formData();
        const parsed = await readForm(form);
        files = parsed.files;
        text = parsed.meta.text;
        id = typeof form.get("id") === "string" && form.get("id") ? String(form.get("id")) : null;
        checkFiles(files);
      } else {
        const body = await c.req.json<{ id?: string | null; text?: string }>().catch(() => ({}) as { id?: string | null; text?: string });
        id = body.id ?? null;
        text = body.text ?? "";
      }
      const sid = await sessions.send(c.req.param("agent"), id, text, files);
      return c.json({ ok: true, id: sid });
    } catch (e) {
      return c.json(fail(e), 500);
    }
  });
  app.post("/api/sessions/:agent/:id/stop", async (c) => {
    if (!sessions) return c.json(fail("セッションは使えない"), 404);
    try {
      await sessions.stop(c.req.param("agent"), c.req.param("id"));
      return c.json({ ok: true });
    } catch (e) {
      return c.json(fail(e), 500);
    }
  });
}
