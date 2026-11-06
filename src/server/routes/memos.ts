// メモ
import { type Context } from "hono";
import { MemoError } from "../memos";
import type { RouteContext } from "./context";

export function memosRoutes({ app, memos }: RouteContext) {
  // ---- メモ（TASK-174）----
  const memoFail = (c: Context, e: unknown) =>
    c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, e instanceof MemoError ? e.status : 500);
  const memoId = (c: Context) => {
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0) throw new MemoError("不正なメモID", 400);
    return id;
  };
  type MemoBody = { title?: unknown; body?: unknown; project?: unknown; tags?: unknown; baseUpdatedAt?: unknown };
  const memoInput = (b: MemoBody) => ({
    title: typeof b.title === "string" ? b.title : undefined,
    body: typeof b.body === "string" ? b.body : undefined,
    project: typeof b.project === "string" || b.project === null ? b.project : undefined,
    tags: Array.isArray(b.tags) ? (b.tags as string[]) : undefined,
    baseUpdatedAt: typeof b.baseUpdatedAt === "number" ? b.baseUpdatedAt : undefined,
  });
  app.get("/api/memos-sync", (c) => {
    if (!memos) return c.json({ ok: false, error: "メモは使えない" }, 404);
    return c.json(memos.changedSince(Number(c.req.query("since") ?? 0) || 0));
  });
  app.get("/api/memos", (c) => {
    if (!memos) return c.json({ ok: false, error: "メモは使えない" }, 404);
    const project = c.req.query("project");
    return c.json(
      memos.list({
        q: (c.req.query("q") ?? "").slice(0, 200),
        project: project === undefined ? null : project,
        tag: c.req.query("tag") || null,
        archived: c.req.query("archived") === "1",
      }),
    );
  });
  app.get("/api/memos/:id", (c) => {
    try {
      const m = memos?.get(memoId(c));
      return m ? c.json(m) : c.json({ ok: false, error: "このメモは無い" }, 404);
    } catch (e) {
      return memoFail(c, e);
    }
  });
  app.get("/api/memos/:id/history", (c) => {
    try {
      if (!memos) throw new MemoError("メモは使えない", 404);
      return c.json(memos.history(memoId(c)));
    } catch (e) {
      return memoFail(c, e);
    }
  });
  app.post("/api/memos", async (c) => {
    try {
      if (!memos) throw new MemoError("メモは使えない", 404);
      return c.json(memos.create(memoInput(await c.req.json<MemoBody>().catch(() => ({}))), "app"));
    } catch (e) {
      return memoFail(c, e);
    }
  });
  app.put("/api/memos/:id", async (c) => {
    try {
      if (!memos) throw new MemoError("メモは使えない", 404);
      return c.json(memos.update(memoId(c), memoInput(await c.req.json<MemoBody>().catch(() => ({}))), "app"));
    } catch (e) {
      return memoFail(c, e);
    }
  });
  app.post("/api/memos/:id/:op{archive|restore}", (c) => {
    try {
      if (!memos) throw new MemoError("メモは使えない", 404);
      return c.json(memos.setArchived(memoId(c), c.req.param("op") === "archive", "app"));
    } catch (e) {
      return memoFail(c, e);
    }
  });
}
