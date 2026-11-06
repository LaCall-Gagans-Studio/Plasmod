// レポート（ストーリー型のスライド）をボードから組み立てる（純粋関数）。
// 先に実務（タスク・メモ・ルーティーン・判断待ち）を見せ、カンバンとエージェントの実績は最後の「まとめ」1枚に寄せる。
import type { AgentProfile, Board, Card, Report, ReportSlide } from "../shared/types";
import { isInboxTask, profileOf } from "./model";

const HOUR = 3600_000;

export function buildReport(board: Board | null, cards: Card[], profiles: AgentProfile[], now = Date.now(), hours = 24): Report {
  const since = (now - hours * HOUR) / 1000;
  const tasks = board?.tasks ?? [];
  const done = tasks
    .filter((t) => t.status === "done" && (t.completed_at ?? 0) >= since)
    .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));
  const running = tasks.filter((t) => t.status === "running");

  // エージェントごとの「片付けた数＋実行中」
  const per = new Map<string, { done: number; running: number }>();
  for (const t of done) {
    if (isInboxTask(t)) continue; // オーナー宛ての受信箱はエージェントの実績ではない
    const id = t.assignee ?? "unassigned";
    per.set(id, { ...(per.get(id) ?? { done: 0, running: 0 }), done: (per.get(id)?.done ?? 0) + 1 });
  }
  for (const t of running) {
    const id = t.assignee ?? "unassigned";
    per.set(id, { ...(per.get(id) ?? { done: 0, running: 0 }), running: (per.get(id)?.running ?? 0) + 1 });
  }
  const ranked = [...per.entries()].filter(([id]) => id !== "unassigned").sort((a, b) => b[1].done - a[1].done || b[1].running - a[1].running);

  const slides: ReportSlide[] = [
    {
      kind: "waiting",
      items: cards.slice(0, 4).map((c) => ({ key: c.key, agent: profileOf(profiles, c.agent).name, label: c.statusLabel, title: c.title })),
    },
    {
      kind: "digest",
      done: done.length,
      running: running.length,
      cards: done.slice(0, 3).map((t) => {
        const p = profileOf(profiles, t.assignee);
        return { name: t.title, agent: p.name, color: p.color };
      }),
      agents: ranked.slice(0, 4).map(([id, v]) => {
        const p = profileOf(profiles, id);
        return { id, name: p.name, done: v.done, running: v.running, color: p.color };
      }),
      tasksDone: [],
    },
  ];

  return { at: now, hours, slides };
}

/** 検索用の平文 */
export function reportText(r: Report): string {
  return r.slides
    .map((s) => {
      switch (s.kind) {
        case "digest":
          return [`片付いた ${s.done} 件・実行中 ${s.running} 件`, ...s.cards.map((c) => `${c.name}（${c.agent}）`), ...s.agents.map((a) => `${a.name}: ${a.done}件`)].join("\n");
        case "waiting":
          return `判断待ち ${s.items.length} 件\n${s.items.map((i) => `${i.agent} ${i.label}: ${i.title}`).join("\n")}`;
      }
    })
    .join("\n");
}
