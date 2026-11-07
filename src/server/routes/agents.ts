// エージェントの見た目と、持ち主の呼び名の設定
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";
import { AppSettings, type ProfileRegistry } from "../profiles";
import { TeamError } from "../teams";
import { DEFAULT_TEAM } from "../../shared/types";
import type { RouteContext } from "./context";

const AVATAR_MAX = 2 * 1024 * 1024;

/** 中身の先頭で種類を決める（送られてきた種類は信じない）。SVG は入れない（スクリプトを含められるので） */
export function avatarExt(b: Uint8Array): "png" | "jpg" | "webp" | null {
  const at = (s: number[], off = 0) => s.every((x, i) => b[off + i] === x);
  if (at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (at([0xff, 0xd8, 0xff])) return "jpg";
  if (at([0x52, 0x49, 0x46, 0x46]) && at([0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}
const AVATAR_TYPE = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const;
const AVATAR_FILE = /^[a-z0-9_-]{1,32}-[0-9]{1,16}\.(png|jpg|webp)$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

export function agentsRoutes({ app, cfg, hub, store, teams }: RouteContext, registry?: ProfileRegistry) {
  // チーム
  const teamFail = (c: Context, e: unknown) => c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, e instanceof TeamError ? e.status : 500);
  const body = (c: Context) => c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const teamsNow = () => ({ teams: cfg.teams, agents: registry?.all() ?? [] });
  app.get("/api/teams", (c) => c.json(teamsNow()));
  app.post("/api/teams", async (c) => {
    try {
      if (!teams) throw new TeamError("使えない", 404);
      teams.create(await body(c));
      hub.changed();
      return c.json(teamsNow());
    } catch (e) {
      return teamFail(c, e);
    }
  });
  app.patch("/api/teams/:id", async (c) => {
    try {
      if (!teams) throw new TeamError("使えない", 404);
      teams.update(c.req.param("id"), await body(c));
      hub.changed();
      return c.json(teamsNow());
    } catch (e) {
      return teamFail(c, e);
    }
  });
  app.delete("/api/teams/:id", (c) => {
    try {
      if (!teams) throw new TeamError("使えない", 404);
      const id = c.req.param("id");
      teams.remove(id);
      // メンバーは既定のチームへ
      for (const p of registry?.all() ?? []) if (p.team === id) registry!.setOverride(p.id, { team: DEFAULT_TEAM });
      hub.changed();
      return c.json(teamsNow());
    } catch (e) {
      return teamFail(c, e);
    }
  });

  const dir = () => join(cfg.dataDir, "avatars");

  app.patch("/api/about", async (c) => {
    const b = await c.req.json<{ owner?: unknown }>().catch(() => ({}) as { owner?: unknown });
    const owner = typeof b.owner === "string" ? b.owner.trim().slice(0, 40) : "";
    if (!owner) return c.json({ ok: false, error: "呼び名が空" }, 400);
    new AppSettings(store.db).set("owner", owner);
    cfg.ownerName = owner;
    hub.changed();
    return c.json({ ok: true, owner });
  });

  app.get("/api/agents-settings", (c) => {
    if (!registry) return c.json({ ok: false, error: "使えない" }, 404);
    return c.json({ agents: registry.all() });
  });

  app.patch("/api/agents-settings/:id", async (c) => {
    if (!registry) return c.json({ ok: false, error: "使えない" }, 404);
    const b = await c.req.json<{ name?: unknown; color?: unknown; hidden?: unknown; avatar?: unknown; role?: unknown; team?: unknown }>().catch(() => ({}) as Record<string, unknown>);
    const patch: { name?: string; color?: string; hidden?: boolean; avatar?: null; role?: string; team?: string } = {};
    if (typeof b.name === "string") patch.name = b.name.trim().slice(0, 40);
    if (typeof b.color === "string") {
      if (!COLOR.test(b.color)) return c.json({ ok: false, error: "色が不正" }, 400);
      patch.color = b.color;
    }
    if (typeof b.hidden === "boolean") patch.hidden = b.hidden;
    if (typeof b.role === "string") patch.role = b.role.trim().slice(0, 40);
    if (b.avatar === null) patch.avatar = null;
    if (b.team !== undefined) {
      if (typeof b.team !== "string" || !cfg.teams.some((t) => t.id === b.team)) return c.json({ ok: false, error: "そのチームはない" }, 400);
      patch.team = b.team;
    }
    try {
      registry.setOverride(c.req.param("id"), patch);
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 404);
    }
    hub.changed();
    return c.json({ agents: registry.all() });
  });

  app.post("/api/agents-settings/:id/avatar", async (c) => {
    if (!registry) return c.json({ ok: false, error: "使えない" }, 404);
    const id = c.req.param("id");
    if (!/^[a-z0-9_-]{1,32}$/.test(id) || !registry.all().some((p) => p.id === id)) return c.json({ ok: false, error: "このエージェントは無い" }, 404);
    const f = (await c.req.formData().catch(() => null))?.get("file");
    if (!f || typeof f === "string") return c.json({ ok: false, error: "画像が要る" }, 400);
    if (f.size > AVATAR_MAX) return c.json({ ok: false, error: "2MB まで" }, 400);
    const data = new Uint8Array(await f.arrayBuffer());
    const ext = avatarExt(data);
    if (!ext) return c.json({ ok: false, error: "PNG・JPEG・WebP だけ" }, 400);
    mkdirSync(dir(), { recursive: true });
    const name = `${id}-${Date.now()}.${ext}`;
    await Bun.write(join(dir(), name), data);
    registry.setOverride(id, { avatar: `/api/avatars/${name}` });
    hub.changed();
    return c.json({ agents: registry.all() });
  });

  app.get("/api/avatars/:file", async (c) => {
    const name = c.req.param("file");
    if (!AVATAR_FILE.test(name)) return c.text("not found", 404);
    const f = Bun.file(join(dir(), name));
    if (!(await f.exists())) return c.text("not found", 404);
    return new Response(f, { headers: { "Content-Type": AVATAR_TYPE[name.split(".").pop() as keyof typeof AVATAR_TYPE], "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=31536000, immutable" } });
  });
}
