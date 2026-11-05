// 習慣
import type { Context } from "hono";
import { HabitError } from "../habits";
import type { RouteContext } from "./context";

export function habitsRoutes({ app, habits }: RouteContext) {
  if (!habits) return;
  const fail = (c: Context, e: unknown) => c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, e instanceof HabitError ? e.status : 500);
  const idOf = (c: Context) => {
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0) throw new HabitError("不正な ID");
    return id;
  };
  const body = (c: Context) => c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  app.get("/api/habits", (c) => c.json(habits.overview()));
  app.post("/api/habits", async (c) => {
    try {
      return c.json(habits.create(await body(c)));
    } catch (e) {
      return fail(c, e);
    }
  });
  app.post("/api/habits/order", async (c) => {
    try {
      habits.reorder((await body(c)).ids);
      return c.json(habits.overview());
    } catch (e) {
      return fail(c, e);
    }
  });
  app.patch("/api/habits/:id", async (c) => {
    try {
      return c.json(habits.update(idOf(c), await body(c)));
    } catch (e) {
      return fail(c, e);
    }
  });
  app.delete("/api/habits/:id", (c) => {
    try {
      habits.archive(idOf(c));
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });
  app.post("/api/habits/:id/check", async (c) => {
    try {
      const b = await body(c);
      return c.json(habits.check(idOf(c), b.done !== false, b.day));
    } catch (e) {
      return fail(c, e);
    }
  });
}
