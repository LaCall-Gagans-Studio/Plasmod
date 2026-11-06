// アプリのタスク（カンバンの /api/tasks とは別）
import { type Context } from "hono";
import { STATUS_LABEL, TASK_STATUSES, TaskError, type TaskStatus } from "../tasks";
import type { RouteContext } from "./context";
import { memoIdOf } from "../../shared/memo-ref";

export function tasksRoutes({ app, cfg, hub, memos, tasks, taskSync }: RouteContext) {
  // ---- 番号のバッジ（TASK-123）: 状態とリンク ----
  app.get("/api/apptasks-badges", (c) => {
    const ids = (c.req.query("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100);
    const STATE_TYPE: Record<TaskStatus, string> = { inbox: "unstarted", todo: "unstarted", doing: "started", done: "completed", dismissed: "canceled" };
    return c.json({
      issues: Object.fromEntries(
        ids.map((id) => {
          const memoId = memoIdOf(id);
          if (memoId !== null) {
            const m = memos?.get(memoId);
            return [id, m ? { id, title: m.title, url: `#/memo/${m.id}`, state: m.archivedAt ? "アーカイブ" : "メモ", stateType: m.archivedAt ? "canceled" : "backlog" } : null];
          }
          const t = tasks?.byRef(id);
          return [id, t ? { id, title: t.title, url: `#/todo/${t.id}`, state: STATUS_LABEL[t.status], stateType: STATE_TYPE[t.status] } : null];
        }),
      ),
    });
  });
  // カード（メモ・判断待ち・承認依頼・受信箱）から、オーナーのタスクを作る
  app.post("/api/apptasks/from-card", async (c) => {
    const body = await c.req.json<{ key?: string; note?: string }>().catch(() => ({}) as { key?: string; note?: string });
    const card = [...hub.cards(), ...hub.cards("only")].find((x) => x.key === body.key);
    if (!card) return c.json({ ok: false, error: "このカードはもう無い" }, 404);
    try {
      const t = hub.taskFromCard(card, (body.note ?? "").trim());
      if (card.taskId) await hub.commentTask(card.taskId, `${cfg.ownerName}（Plasmod）: タスクにした → ${t.ref ?? `#${t.id}`}`);
      return c.json({ ok: true, task: t });
    } catch (e) {
      return taskFail(c, e);
    }
  });

  // ---- タスク（TASK-173）。カンバンの /api/tasks とは別 ----
  const taskFail = (c: Context, e: unknown) =>
    c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, e instanceof TaskError ? e.status : 500);
  const taskId = (c: Context) => {
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0) throw new TaskError("不正なタスクID", 400);
    return id;
  };
  const statusOf = (v: unknown): TaskStatus | undefined => (typeof v === "string" && (TASK_STATUSES as string[]).includes(v) ? (v as TaskStatus) : undefined);
  app.get("/api/apptasks", (c) => {
    if (!tasks) return c.json({ ok: false, error: "タスクは使えない" }, 404);
    const status = (c.req.query("status") ?? "").split(",").map(statusOf).filter((s): s is TaskStatus => !!s);
    const project = c.req.query("project");
    return c.json(tasks.view({ status: status.length ? status : undefined, q: (c.req.query("q") ?? "").slice(0, 200), project: project === undefined ? null : project, tag: c.req.query("tag") || null }));
  });
  // PR のマージでタスクを閉じる処理の様子。画面のタスクの一覧の下に出す
  app.get("/api/apptasks-sync", (c) =>
    c.json({
      pr: taskSync ? { enabled: !!cfg.githubToken && cfg.taskCloseByPr, ...taskSync.prStatus } : { enabled: false },
    }),
  );
  app.post("/api/apptasks-sync", async (c) => {
    if (!taskSync) return c.json({ ok: false, error: "取り込みは使えない" }, 404);
    await taskSync.runAll();
    hub.changed();
    return c.json({ ok: true, pr: taskSync.prStatus });
  });
  app.get("/api/apptasks/:id", (c) => {
    try {
      if (!tasks) throw new TaskError("タスクは使えない", 404);
      const t = tasks.get(taskId(c));
      if (!t) throw new TaskError("このタスクは無い", 404);
      // このタスクに触れているメモ（本文に [[TASK-123]] があるもの）
      const mentions = t.ref && memos ? memos.list({ q: `[[${t.ref}]]`, limit: 50 }).memos : [];
      return c.json({ task: t, events: tasks.events(t.id), links: tasks.links(t.id), memos: mentions, card: hub.cards().find((x) => x.key === `apptask:${t.id}` || x.recordTaskId === t.id)?.key ?? null });
    } catch (e) {
      return taskFail(c, e);
    }
  });
  app.post("/api/apptasks", async (c) => {
    try {
      if (!tasks) throw new TaskError("タスクは使えない", 404);
      const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
      const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
      const t = tasks.create(
        {
          title: str("title") ?? "",
          body: str("body"),
          project: str("project") ?? null,
          due: str("due") ?? null,
          status: statusOf(b.status),
          parentId: typeof b.parentId === "number" ? b.parentId : null,
          tags: Array.isArray(b.tags) ? (b.tags as unknown[]).filter((x): x is string => typeof x === "string") : undefined,
        },
        "app",
      );
      hub.changed();
      return c.json(t);
    } catch (e) {
      return taskFail(c, e);
    }
  });
  app.patch("/api/apptasks/:id", async (c) => {
    try {
      if (!tasks) throw new TaskError("タスクは使えない", 404);
      const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
      const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
      const t = tasks.update(
        taskId(c),
        {
          title: str("title"),
          body: str("body"),
          project: typeof b.project === "string" || b.project === null ? (b.project as string | null) : undefined,
          due: typeof b.due === "string" || b.due === null ? (b.due as string | null) : undefined,
          status: statusOf(b.status),
          tags: Array.isArray(b.tags) ? (b.tags as unknown[]).filter((x): x is string => typeof x === "string") : undefined,
          note: str("note"),
          baseUpdatedAt: typeof b.baseUpdatedAt === "number" ? b.baseUpdatedAt : undefined,
        },
        "app",
      );
      hub.changed();
      return c.json(t);
    } catch (e) {
      return taskFail(c, e);
    }
  });
  // 消す（長押しのメニュー）。判断待ちのカードも一緒に消える
  app.delete("/api/apptasks/:id", (c) => {
    try {
      if (!tasks) throw new TaskError("タスクは使えない", 404);
      tasks.remove(taskId(c), "app");
      hub.changed();
      return c.json({ ok: true });
    } catch (e) {
      return taskFail(c, e);
    }
  });
  // 親を付ける・外す（parent は番号 TASK-123 か数字、null で外す）
  const findTask = (v: unknown) => {
    if (!tasks) throw new TaskError("タスクは使えない", 404);
    const t = typeof v === "number" ? tasks.get(v) : typeof v === "string" ? (/^\d+$/.test(v) ? tasks.get(Number(v)) : tasks.byRef(v.trim().replace(/^#/, ""))) : null;
    if (!t) throw new TaskError(`タスク ${String(v)} が見つからない`, 404);
    return t;
  };
  app.post("/api/apptasks/:id/parent", async (c) => {
    try {
      const b = await c.req.json<{ parent?: unknown }>().catch(() => ({}) as { parent?: unknown });
      const t = tasks!.setParent(taskId(c), b.parent === null || b.parent === "" ? null : findTask(b.parent).id, "app");
      return c.json({ task: t, links: tasks!.links(t.id), events: tasks!.events(t.id) });
    } catch (e) {
      return taskFail(c, e);
    }
  });
  // つながりを足す・外す（kind: blocks＝このタスクが相手を止めている／blocked_by／related）
  app.post("/api/apptasks/:id/link", async (c) => {
    try {
      const b = await c.req.json<{ other?: unknown; kind?: string; on?: boolean }>().catch(() => ({}) as { other?: unknown; kind?: string; on?: boolean });
      const id = taskId(c);
      const o = findTask(b.other).id;
      if (b.kind === "blocked_by") tasks!.link(o, id, "blocks", b.on !== false, "app");
      else tasks!.link(id, o, b.kind === "blocks" ? "blocks" : "related", b.on !== false, "app");
      return c.json({ links: tasks!.links(id), events: tasks!.events(id) });
    } catch (e) {
      return taskFail(c, e);
    }
  });
  app.post("/api/apptasks/:id/comment", async (c) => {
    try {
      if (!tasks) throw new TaskError("タスクは使えない", 404);
      const b = await c.req.json<{ text?: string }>().catch(() => ({}) as { text?: string });
      const t = tasks.comment(taskId(c), b.text ?? "", "app");
      return c.json({ task: t, events: tasks.events(t.id) });
    } catch (e) {
      return taskFail(c, e);
    }
  });
}
