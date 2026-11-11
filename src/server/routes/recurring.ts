// 繰り返しのルール
import type { Context } from "hono";
import { RecurError } from "../recurring";
import type { RouteContext } from "./context";

export function recurringRoutes({ app, recurring, hub }: RouteContext) {
  if (!recurring) return;
  const fail = (c: Context, e: unknown) => c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, e instanceof RecurError ? e.status : 500);
  const idOf = (c: Context) => {
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0) throw new RecurError("不正な ID");
    return id;
  };
  const body = (c: Context) => c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  /** 作った・変えたら、浮上の分もすぐ反映する */
  const surface = () => {
    if (recurring.tick().length) hub.changed();
  };

  app.get("/api/recurring", (c) => c.json({ rules: recurring.list() }));
  app.post("/api/recurring", async (c) => {
    try {
      const r = recurring.create(await body(c));
      surface();
      return c.json(r);
    } catch (e) {
      return fail(c, e);
    }
  });
  app.patch("/api/recurring/:id", async (c) => {
    try {
      const r = recurring.update(idOf(c), await body(c));
      surface();
      return c.json(r);
    } catch (e) {
      return fail(c, e);
    }
  });
  app.delete("/api/recurring/:id", (c) => {
    try {
      recurring.remove(idOf(c));
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });
}
