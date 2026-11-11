// 死活確認・画面への流れ・外の送り手の受け口・APK の通知
import { type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { fromTailscale } from "../auth";
import { parseRelay, relayNotice, tokenOk } from "../notify-relay";
import type { RouteContext } from "./context";
import { devTarget } from "./dev";
import { AppSettings } from "../profiles";
import { TokenTotal } from "../token-total";
import { CLAUDE_AGENT } from "../../shared/types";
import pkg from "../../../package.json";
import { getTimeZone } from "../../shared/time";

export function liveRoutes(ctx: RouteContext) {
  const { app, cfg, hub, rootd, feed } = ctx;
  const nameOf = (id: string) => cfg.profiles.find((p) => p.id === id)?.name ?? id;
  // 初回の案内。呼び名を決めてある環境（前から使っている環境）は終わったものとして扱う
  const settings = () => new AppSettings(ctx.store.db);
  const usedBefore = cfg.ownerName !== "オーナー";
  // 持ち主のプロフィールカード。使い始めの日は、いちばん古いタスクかメモの日（無ければ今日）を1度だけ決める
  const ownerCard = () => {
    try {
      const s = settings();
      let joined = Number(s.get("joined_at"));
      if (!joined) {
        const db = ctx.store.db;
        const oldest = (t: string) => {
          try {
            return (db.query(`SELECT MIN(created_at) AS m FROM ${t}`).get() as { m: number | null }).m;
          } catch {
            return null;
          }
        };
        joined = Math.min(Date.now(), oldest("tasks") ?? Infinity, oldest("memos") ?? Infinity);
        s.set("joined_at", String(joined));
      }
      return { ownerTitle: s.get("owner_title") ?? "", ownerColor: s.get("owner_color") ?? undefined, ownerAvatar: s.get("owner_avatar") || undefined, joinedAt: joined, tokensTotal: new TokenTotal(s).get() };
    } catch {
      return {};
    }
  };
  const setupDone = () => usedBefore || settings().get("setup_done") === "1";
  app.get("/api/setup", (c) =>
    c.json({
      done: setupDone(),
      agents: (ctx.sessions?.agents() ?? []).map((a) => ({ ...a, name: nameOf(a.id) })),
      teams: cfg.teams,
      github: !!cfg.githubToken,
      rootd: !!rootd,
      publicUrl: cfg.publicUrl,
    }),
  );
  app.post("/api/setup/done", (c) => {
    settings().set("setup_done", "1");
    return c.json({ ok: true });
  });
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/about", (c) =>
    c.json({
      name: "Plasmod",
      version: pkg.version,
      owner: cfg.ownerName,
      ownerIsDefault: cfg.ownerName === "オーナー",
      devAgent: nameOf(devTarget(ctx)),
      claudeAgent: ctx.sessions?.agents().some((a) => a.runtime === "claude-code") ? nameOf(CLAUDE_AGENT) : null,
      github: !!cfg.githubToken,
      setupDone: setupDone(),
      ...ownerCard(),
      developer: cfg.developer,
      repoUrl: cfg.repoUrl,
      license: "MIT",
      timeZone: getTimeZone(),
    }),
  );
  // 作るのにかかった時間を Server-Timing で返す（起動の「最初のデータ」が、サーバーと通信のどちらで遅いかを分ける）
  app.get("/api/snapshot", (c) => {
    const t0 = performance.now();
    const s = hub.snapshot();
    const body = JSON.stringify(s);
    c.header("Server-Timing", `snap;dur=${(performance.now() - t0).toFixed(1)}`);
    c.header("Content-Type", "application/json; charset=UTF-8");
    return c.body(body);
  });

  app.get("/api/stream", (c) => {
    const res = streamSSE(c, async (stream) => {
      let alive = true;
      const send = (s: unknown) => stream.writeSSE({ event: "snapshot", data: JSON.stringify(s) });
      const off = hub.subscribe((s) => void send(s));
      stream.onAbort(() => {
        alive = false;
        off();
      });
      await send(hub.snapshot());
      while (alive) {
        await stream.sleep(25_000);
        if (alive) await stream.writeSSE({ event: "ping", data: "" });
      }
    });
    // 途中で貯めたり圧縮したりさせない（中継がまとめて流すと、新しいカードが届かない）
    res.headers.set("Cache-Control", "no-cache, no-transform");
    res.headers.set("X-Accel-Buffering", "no");
    return res;
  });

  // 外の送り手（自動デプロイ・plasmod-rootd が PLASMOD_NOTIFY_URL に送る知らせ）の受け口
  // 127.0.0.1 の TCP だけ・PLASMOD_NOTIFY_TOKEN が合うものだけ。APK の通知の流れに入れる
  const relay = async (c: Context) => {
    if (fromTailscale(c.env)) return c.text("forbidden", 403);
    if (!tokenOk(c.req.header("authorization"), cfg.relayToken)) return c.text("forbidden", 403);
    const e = feed?.add(relayNotice(parseRelay(c.req.raw.headers, await c.req.text())));
    return c.json({ id: String(e?.id ?? ""), event: "message" });
  };
  app.post("/notify-relay", relay);

  // APK の通知（TASK-250）: つなぎっぱなしで受け取る。?since=<最後に受け取った id> でつながっていなかった間の分も送る。
  // since が無ければ（初めての端末）、今の id を hello で知らせて、ここから先だけ
  app.get("/api/notify/stream", (c) => {
    if (!feed) return c.json({ ok: false, error: "通知の流れが無い" }, 404);
    const since = Number(c.req.query("since"));
    const res = streamSSE(c, async (stream) => {
      let alive = true;
      const send = (e: { id: number; type: string }) => stream.writeSSE({ id: String(e.id), event: e.type, data: JSON.stringify(e) });
      // 先に受け口を作ってから、たまっていた分を送る（その間に来たものを落とさない。重なりは id で弾く）
      let sent = Number.isFinite(since) && since >= 0 ? since : feed.last();
      const off = feed.subscribe((e) => {
        if (e.id <= sent) return;
        sent = e.id;
        void send(e);
      });
      stream.onAbort(() => {
        alive = false;
        off();
      });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ last: feed.last() }) });
      for (const e of feed.since(sent, 200)) {
        if (e.id <= sent) continue;
        sent = e.id;
        await send(e);
      }
      while (alive) {
        await stream.sleep(25_000);
        if (alive) await stream.writeSSE({ event: "ping", data: "" });
      }
    });
    res.headers.set("Cache-Control", "no-cache, no-transform");
    res.headers.set("X-Accel-Buffering", "no");
    return res;
  });
}
