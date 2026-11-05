// レポート・速さ・ウィジェット・メニューの数字
import type { NavBadges, ReportSlide } from "../../shared/types";
import { PerfLog } from "../perf";
import type { RouteContext } from "./context";

export function reportsRoutes({ app, cfg, hub, store, dev, system, rootd, watch, tasks, memos, habits }: RouteContext) {
  // レポート: 今日のタスク → メモ → 習慣 → 判断待ち → 定期報告 → 監察 → まとめ（実績はここに1枚）
  app.get("/api/report", async (c) => {
    const r = hub.report();
    // 定期報告（実働の cron）と監察チームの報告は、最後のまとめの前に、この順で
    if (watch?.configured) {
      try {
        const d = await watch.routine();
        if (d.items.length || d.late.length || d.error) r.slides.splice(r.slides.length - 1, 0, { kind: "routine", ...d });
        const w = await watch.latest();
        if (w.items.length || w.error) r.slides.splice(r.slides.length - 1, 0, { kind: "watch", ...w });
      } catch {
        /* 定期報告の枚が出ないだけ */
      }
    }
    const first: ReportSlide[] = [];
    if (tasks) {
      const t = tasks.summary();
      first.push({ kind: "tasks", today: t.today, week: t.week, doing: t.doing });
      for (const s of r.slides) if (s.kind === "digest") s.tasksDone = t.done;
    }
    const recent = memos?.list({}).memos.slice(0, 5) ?? [];
    if (recent.length) first.push({ kind: "memos", items: recent.map((m) => ({ id: m.id, title: m.title, project: m.project, excerpt: m.excerpt, at: m.updatedAt })) });
    const hs = habits?.overview().habits ?? [];
    if (hs.length) first.push({ kind: "habits", items: hs });
    r.slides.unshift(...first);
    return c.json(r);
  });

  app.get("/api/watch", async (c) => {
    if (!watch?.configured) return c.json({ reports: [], errors: [], late: [] });
    return c.json(await watch.all(c.req.query("force") === "1"));
  });

  // 下のメニューの数字: ホーム＝判断待ちのカード＋root の承認待ち、Dev＝下書きでない PR、ウォッチング＝止まっているカード、システム＝root の承認待ち
  // 速さの記録（設定の VPS に出す）
  let perfLog: PerfLog | null = null;
  const perf = () => (perfLog ??= new PerfLog(store.db));
  app.post("/api/perf", async (c) => {
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    perf().add(b.name, b.via, b.ms);
    return c.json({ ok: true });
  });
  app.get("/api/perf", (c) => c.json(perf().summary()));

  // ホーム画面のウィジェット（APK、TASK-249）: 判断待ちの枚数と一番上の1枚だけ。軽く返す
  app.get("/api/widget", (c) => {
    const cards = hub.cards();
    const top = cards[0];
    const name = (id: string) => cfg.profiles.find((p) => p.id === id)?.name ?? (id === "me" ? cfg.ownerName : id);
    return c.json({
      count: cards.length,
      top: top ? { key: top.key, title: top.title, label: top.statusLabel, agent: name(top.agent), createdAt: top.createdAt, path: `#/card/${encodeURIComponent(top.key)}` } : null,
      at: Date.now(),
    });
  });

  app.get("/api/badges", async (c) => {
    const snap = hub.snapshot();
    let root = 0;
    if (rootd) {
      try {
        const r = (await rootd.call({ op: "list" })) as { requests?: { status: string }[] };
        root = (r.requests ?? []).filter((x) => x.status === "pending").length;
      } catch {
        /* 数字が出ないだけ */
      }
    }
    const badges: NavBadges = {
      home: snap.cards.filter((x) => x.kind !== "note").length + root,
      dev: (dev?.snapshot().prs ?? []).filter((p) => !p.draft).length,
      watching: (snap.board?.tasks ?? []).filter((t) => t.status === "blocked").length,
      system: root,
    };
    return c.json(badges);
  });
}
