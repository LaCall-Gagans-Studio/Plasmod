// Dev（PR・デプロイ）
import { devRequestText } from "../dev";
import type { RouteContext } from "./context";

export function devRoutes({ app, sessions, dev }: RouteContext) {
  // ---- Dev ----
  app.get("/api/dev", (c) => c.json(dev?.snapshot() ?? { prs: [], fetchedAt: 0, error: "Dev は使えない" }));
  app.post("/api/dev/refresh", async (c) => c.json((await dev?.refresh()) ?? null));
  // マージ・差し戻しは開発エージェントへの依頼として送る（マージの実行は承認ボタンを通る）
  app.post("/api/dev/request", async (c) => {
    type Body = { action?: "merge" | "revise"; prs?: { repo: string; number: number }[]; note?: string };
    const body = await c.req.json<Body>().catch(() => ({}) as Body);
    const known = new Map((dev?.snapshot().prs ?? []).map((p) => [`${p.repo}#${p.number}`, p]));
    const prs = (body.prs ?? []).map((p) => known.get(`${p.repo}#${p.number}`)).filter((p) => !!p);
    if (!sessions || !prs.length || (body.action !== "merge" && body.action !== "revise"))
      return c.json({ ok: false, error: "PR か操作が正しくない" }, 400);
    if (body.action === "revise" && !body.note?.trim()) return c.json({ ok: false, error: "差し戻しには指摘が要る" }, 400);
    try {
      const id = await sessions.send("dev", null, devRequestText(body.action, prs, (body.note ?? "").trim()));
      return c.json({ ok: true, session: id });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
}
