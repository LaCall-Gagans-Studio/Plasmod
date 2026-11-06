// プロジェクトとタグ
import { type Context } from "hono";
import { PROJECT_STATUSES, ProjectError } from "../projects";
import type { ProjectStatus } from "../../shared/types";
import type { RouteContext } from "./context";

export function projectsRoutes({ app, hub, projects }: RouteContext) {
  // ---- プロジェクト（PJ）----
  const pjFail = (c: Context, e: unknown) =>
    c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, e instanceof ProjectError ? e.status : 500);
  const pjId = (c: Context) => {
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0) throw new ProjectError("不正なプロジェクトID", 400);
    return id;
  };
  app.get("/api/projects", (c) => {
    if (!projects) return c.json({ ok: false, error: "プロジェクトは使えない" }, 404);
    return c.json(c.req.query("view") === "list" ? projects.list() : projects.overview());
  });
  // 設定の画面: すべてのプロジェクトとタグ
  app.get("/api/projects-settings", (c) => {
    if (!projects) return c.json({ ok: false, error: "プロジェクトは使えない" }, 404);
    return c.json({ projects: projects.all(), tags: projects.tags() });
  });
  app.post("/api/projects/:id/merge", async (c) => {
    try {
      if (!projects) throw new ProjectError("プロジェクトは使えない", 404);
      const b = await c.req.json<{ into?: number }>().catch(() => ({}) as { into?: number });
      const p = projects.merge(pjId(c), Number(b.into));
      hub.changed();
      return c.json(p);
    } catch (e) {
      return pjFail(c, e);
    }
  });
  app.delete("/api/projects/:id", (c) => {
    try {
      if (!projects) throw new ProjectError("プロジェクトは使えない", 404);
      projects.remove(pjId(c));
      return c.json({ ok: true });
    } catch (e) {
      return pjFail(c, e);
    }
  });
  app.patch("/api/tags", async (c) => {
    try {
      if (!projects) throw new ProjectError("プロジェクトは使えない", 404);
      const b = await c.req.json<{ from?: string; to?: string }>().catch(() => ({}) as { from?: string; to?: string });
      projects.renameTag(b.from ?? "", b.to ?? "");
      hub.changed();
      return c.json({ ok: true, tags: projects.tags() });
    } catch (e) {
      return pjFail(c, e);
    }
  });
  app.delete("/api/tags", (c) => {
    if (!projects) return c.json({ ok: false, error: "プロジェクトは使えない" }, 404);
    projects.removeTag(c.req.query("name") ?? "");
    hub.changed();
    return c.json({ ok: true, tags: projects.tags() });
  });
  app.get("/api/projects/:id", (c) => {
    try {
      if (!projects) throw new ProjectError("プロジェクトは使えない", 404);
      return c.json(projects.detail(pjId(c)));
    } catch (e) {
      return pjFail(c, e);
    }
  });
  app.post("/api/projects", async (c) => {
    try {
      if (!projects) throw new ProjectError("プロジェクトは使えない", 404);
      const b = await c.req.json<{ name?: string; emoji?: string; description?: string }>().catch(() => ({}) as { name?: string });
      return c.json(projects.create({ name: b.name ?? "", emoji: (b as { emoji?: string }).emoji ?? null, description: (b as { description?: string }).description }));
    } catch (e) {
      return pjFail(c, e);
    }
  });
  app.patch("/api/projects/:id", async (c) => {
    try {
      if (!projects) throw new ProjectError("プロジェクトは使えない", 404);
      const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
      const p = projects.update(pjId(c), {
        name: typeof b.name === "string" ? b.name : undefined,
        description: typeof b.description === "string" ? b.description : undefined,
        status: typeof b.status === "string" && (PROJECT_STATUSES as string[]).includes(b.status) ? (b.status as ProjectStatus) : undefined,
        emoji: typeof b.emoji === "string" || b.emoji === null ? (b.emoji as string | null) : undefined,
        baseUpdatedAt: typeof b.baseUpdatedAt === "number" ? b.baseUpdatedAt : undefined,
      });
      hub.changed();
      return c.json(p);
    } catch (e) {
      return pjFail(c, e);
    }
  });
}
