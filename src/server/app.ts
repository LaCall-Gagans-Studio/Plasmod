import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { requireLogin, sameOriginWrites, SECURITY_HEADERS } from "./auth";
import type { Config } from "./config";
import type { Hub } from "./hub";
import type { Store } from "./store";
import type { AppServices, RouteContext } from "./routes/context";
import { liveRoutes } from "./routes/live";
import { agentsRoutes } from "./routes/agents";
import type { ProfileRegistry } from "./profiles";
import { cardsRoutes } from "./routes/cards";
import { reportsRoutes } from "./routes/reports";
import { kanbanRoutes } from "./routes/kanban";
import { sharesRoutes } from "./routes/shares";
import { tasksRoutes } from "./routes/tasks";
import { systemRoutes } from "./routes/system";
import { devRoutes } from "./routes/dev";
import { mediaRoutes } from "./routes/media";
import { sessionsRoutes } from "./routes/sessions";
import { rootRoutes } from "./routes/root";
import { memosRoutes } from "./routes/memos";
import { projectsRoutes } from "./routes/projects";
import { habitsRoutes } from "./routes/habits";
import { pushRoutes } from "./routes/push";

export type { AppServices } from "./routes/context";

export function createApp(cfg: Config, hub: Hub, store: Store, webRoot: string, services: AppServices & { registry?: ProfileRegistry } = {}) {
  const app = new Hono();
  app.use("*", requireLogin(cfg));
  app.use("*", sameOriginWrites());
  app.use("*", async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(k)) c.header(k, v);
  });

  // API の返事はキャッシュさせない（ブラウザ・インストールしたアプリのどこでも、古い一覧を見せない）
  app.use("/api/*", async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  });

  const ctx: RouteContext = { ...services, app, cfg, hub, store };
  liveRoutes(ctx);
  agentsRoutes(ctx, services.registry);
  cardsRoutes(ctx);
  reportsRoutes(ctx);
  kanbanRoutes(ctx);
  sharesRoutes(ctx);
  tasksRoutes(ctx);
  systemRoutes(ctx);
  devRoutes(ctx);
  mediaRoutes(ctx);
  sessionsRoutes(ctx);
  rootRoutes(ctx);
  memosRoutes(ctx);
  projectsRoutes(ctx);
  habitsRoutes(ctx);
  pushRoutes(ctx);

  // 画面の版（index.html の中身のハッシュ。ビルドするたびに変わる）。インストールしたアプリが古い版のまま開いていないかを、画面が確かめる
  let ver: { mtime: number; id: string } | null = null;
  app.get("/api/version", async (c) => {
    const f = Bun.file(`${webRoot}/index.html`);
    const mtime = (await f.exists()) ? f.lastModified : 0;
    if (!ver || ver.mtime !== mtime) ver = { mtime, id: mtime ? Bun.hash(await f.text()).toString(36) : "dev" };
    return c.json({ id: ver.id });
  });

  // キャッシュ: 名前にハッシュが付く /assets/ はずっと、それ以外（index.html・sw.js・manifest・アイコン）は毎回確かめる。
  // index.html を古いまま使い続けると、インストールしたアプリが前の版で開く
  app.use("/*", async (c, next) => {
    await next();
    if (c.req.path.startsWith("/api/")) return;
    c.header("Cache-Control", c.req.path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
  });
  app.use("/*", serveStatic({ root: webRoot }));
  app.get("*", serveStatic({ path: `${webRoot}/index.html` }));
  return app;
}
