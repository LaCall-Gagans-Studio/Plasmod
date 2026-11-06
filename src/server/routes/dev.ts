// Dev（PR・デプロイ）
import { devRequestText } from "../dev";
import { AppSettings } from "../profiles";
import { CLAUDE_AGENT } from "../../shared/types";
import type { RouteContext } from "./context";

/** PR のマージ・差し戻しを頼む相手。設定で選んだエージェント、無ければ Claude Code、それも無ければ最初のエージェント */
export function devTarget({ store, sessions, cfg }: Pick<RouteContext, "store" | "sessions" | "cfg">): string {
  const ids = sessions?.agents().map((a) => a.id) ?? [];
  const chosen = new AppSettings(store.db).get("dev_agent");
  if (chosen && ids.includes(chosen)) return chosen;
  return ids.includes(CLAUDE_AGENT) ? CLAUDE_AGENT : (ids[0] ?? cfg.hubProfile ?? "default");
}

export function devRoutes(ctx: RouteContext) {
  const { app, sessions, dev, store, cfg } = ctx;
  app.get("/api/dev-settings", (c) =>
    c.json({ agent: devTarget(ctx), agents: (sessions?.agents() ?? []).map((a) => ({ id: a.id, name: cfg.profiles.find((p) => p.id === a.id)?.name ?? a.id })) }),
  );
  app.patch("/api/dev-settings", async (c) => {
    const b = await c.req.json<{ agent?: unknown }>().catch(() => ({}) as { agent?: unknown });
    if (typeof b.agent !== "string" || !sessions?.agents().some((a) => a.id === b.agent)) return c.json({ ok: false, error: "そのエージェントはいない" }, 400);
    new AppSettings(store.db).set("dev_agent", b.agent);
    return c.json({ ok: true, agent: b.agent });
  });
  // ---- Dev ----
  app.get("/api/dev", (c) => c.json(dev?.snapshot() ?? { prs: [], fetchedAt: 0, error: "Dev は使えない" }));
  app.post("/api/dev/refresh", async (c) => c.json((await dev?.refresh()) ?? null));
  // マージ・差し戻しはエージェントへの依頼として送る（マージの実行は承認ボタンを通る）
  app.post("/api/dev/request", async (c) => {
    type Body = { action?: "merge" | "revise"; prs?: { repo: string; number: number }[]; note?: string };
    const body = await c.req.json<Body>().catch(() => ({}) as Body);
    const known = new Map((dev?.snapshot().prs ?? []).map((p) => [`${p.repo}#${p.number}`, p]));
    const prs = (body.prs ?? []).map((p) => known.get(`${p.repo}#${p.number}`)).filter((p) => !!p);
    if (!sessions || !prs.length || (body.action !== "merge" && body.action !== "revise"))
      return c.json({ ok: false, error: "PR か操作が正しくない" }, 400);
    if (body.action === "revise" && !body.note?.trim()) return c.json({ ok: false, error: "差し戻しには指摘が要る" }, 400);
    try {
      const agent = devTarget(ctx);
      const id = await sessions.send(agent, null, devRequestText(body.action, prs, (body.note ?? "").trim()));
      return c.json({ ok: true, agent, session: id });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
}
