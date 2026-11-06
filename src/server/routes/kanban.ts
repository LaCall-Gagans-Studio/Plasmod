// カンバンのカードの詳細と操作
import { type ShareFile, checkFiles } from "../share";
import type { RouteContext } from "./context";
import { readForm } from "./form";

export function kanbanRoutes({ app, hub, tasks }: RouteContext) {
  // ---- カンバンのカードの詳細とコメント ----
  const TASK_RE = /^[A-Za-z0-9_-]{1,64}$/;
  app.get("/api/tasks/:id", async (c) => {
    if (!TASK_RE.test(c.req.param("id"))) return c.json({ ok: false, error: "不正なカードID" }, 400);
    try {
      return c.json(await hub.task(c.req.param("id")));
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
  app.post("/api/tasks/:id/comment", async (c) => {
    if (!TASK_RE.test(c.req.param("id"))) return c.json({ ok: false, error: "不正なカードID" }, 400);
    try {
      let text = "";
      let files: ShareFile[] = [];
      if ((c.req.header("content-type") ?? "").startsWith("multipart/form-data")) {
        const parsed = await readForm(await c.req.formData());
        files = parsed.files;
        text = parsed.meta.text;
        checkFiles(files);
      } else {
        text = (await c.req.json<{ text?: string }>().catch(() => ({}) as { text?: string })).text ?? "";
      }
      if (!text.trim() && !files.length) return c.json({ ok: false, error: "コメントが空" }, 400);
      await hub.commentTask(c.req.param("id"), text, files);
      return c.json({ ok: true, detail: await hub.task(c.req.param("id")) });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // 仕分け待ち（triage）のカード: 担当を決めて進める／不要（アーカイブ）
  app.post("/api/tasks/:id/specify", async (c) => {
    if (!TASK_RE.test(c.req.param("id"))) return c.json({ ok: false, error: "不正なカードID" }, 400);
    const assignee = (await c.req.json<{ assignee?: string }>().catch(() => ({}) as { assignee?: string })).assignee ?? "";
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(assignee)) return c.json({ ok: false, error: "担当が不正" }, 400);
    try {
      await hub.specifyTask(c.req.param("id"), assignee);
      return c.json({ ok: true, detail: await hub.task(c.req.param("id")) });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
  app.post("/api/tasks/:id/archive", async (c) => {
    if (!TASK_RE.test(c.req.param("id"))) return c.json({ ok: false, error: "不正なカードID" }, 400);
    try {
      await hub.archiveTask(c.req.param("id"));
      return c.json({ ok: true, detail: await hub.task(c.req.param("id")) });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
}
