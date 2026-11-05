// 判断待ちのカード・検索・メモカード
import { ActError } from "../hub";
import { type ShareFile, checkFiles } from "../share";
import type { SnoozeKind } from "../../shared/types";
import { filterHits } from "../search";
import type { RouteContext } from "./context";
import { readForm } from "./form";

const SNOOZE_KINDS: SnoozeKind[] = ["3h", "morning", "week"];

export function cardsRoutes({ app, hub, tasks, memos }: RouteContext) {
  const act = async (key: string, option: string, text: string, via: string, files: ShareFile[] = [], snooze?: SnoozeKind) => {
    try {
      await hub.act(key, option, text, via, files, snooze);
      return { status: 200 as const, body: { ok: true } };
    } catch (e) {
      const status: ActError["status"] | 500 = e instanceof ActError ? e.status : 500;
      return { status, body: { ok: false, error: e instanceof Error ? e.message : String(e) } };
    }
  };

  // 添付があるときは multipart（option・text・files）、無ければ JSON
  app.post("/api/cards/:key/act", async (c) => {
    let body: { option?: string; text?: string; snooze?: string } = {};
    let files: ShareFile[] = [];
    if ((c.req.header("content-type") ?? "").startsWith("multipart/form-data")) {
      const form = await c.req.formData();
      const parsed = await readForm(form);
      files = parsed.files;
      body = { snooze: typeof form.get("snooze") === "string" ? String(form.get("snooze")) : undefined, option: typeof form.get("option") === "string" ? String(form.get("option")) : "", text: parsed.meta.text };
      try {
        checkFiles(files);
      } catch (e) {
        return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
      }
    } else body = await c.req.json<{ option?: string; text?: string; snooze?: string }>().catch(() => ({}) as { option?: string; text?: string });
    if (!body.option) return c.json({ ok: false, error: "option が要る" }, 400);
    if (body.snooze && !SNOOZE_KINDS.includes(body.snooze as SnoozeKind)) return c.json({ ok: false, error: "snooze が不正" }, 400);
    const r = await act(c.req.param("key"), body.option, body.text ?? "", "app", files, body.snooze as SnoozeKind | undefined);
    return c.json(r.body, r.status);
  });

  // カードにコメントだけ書く（判断はしない）。タスクの記録に残し、カンバンのカードならそちらにも
  app.post("/api/cards/:key/comment", async (c) => {
    let text = "";
    let files: ShareFile[] = [];
    try {
      if ((c.req.header("content-type") ?? "").startsWith("multipart/form-data")) {
        const parsed = await readForm(await c.req.formData());
        files = parsed.files;
        text = parsed.meta.text ?? "";
        checkFiles(files);
      } else text = (await c.req.json<{ text?: string }>().catch(() => ({}) as { text?: string })).text ?? "";
      if (!text.trim() && !files.length) return c.json({ ok: false, error: "コメントが空" }, 400);
      await hub.commentCard(c.req.param("key"), text, files);
      return c.json({ ok: true });
    } catch (e) {
      const status: ActError["status"] | 500 = e instanceof ActError ? e.status : 500;
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, status);
    }
  });

  app.get("/api/search", (c) => {
    const hits = hub.find((c.req.query("q") ?? "").slice(0, 200));
    const days = Number(c.req.query("days") ?? 0);
    const agent = c.req.query("agent") ?? "";
    const project = c.req.query("project") ?? "";
    return c.json(
      filterHits(hits, { since: days > 0 ? Date.now() - days * 86_400_000 : 0, agent, project }, {
        taskOf: (id) => tasks?.get(id) ?? null,
        memoOf: (id) => memos?.get(id) ?? null,
      }),
    );
  });

  app.post("/api/notes", async (c) => {
    const body = await c.req.json<{ title?: string; body?: string; source?: string }>().catch(() => ({}) as { title?: string; body?: string; source?: string });
    const title = (body.title ?? "").trim();
    if (!title) return c.json({ ok: false, error: "title が要る" }, 400);
    const n = hub.addNote(title, (body.body ?? "").trim(), body.source ?? null);
    return c.json({ ok: true, key: `note:${n.id}` });
  });

  app.post("/api/cards/:key/seen", (c) => {
    hub.markSeen(c.req.param("key"));
    return c.json({ ok: true });
  });
}
