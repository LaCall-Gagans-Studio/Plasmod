// 定期報告（ハブの見回り・ops の朝の運用レポート・監察チームの週1回の報告など、cron の出力）を全文で読む。#/watch
import { useEffect, useState } from "react";
import type { Snapshot, WatchReport } from "../shared/types";
import { RichText } from "./markdown";
import { remember, useAgents } from "./session-data";
import { Avatar, Page, ago, profileOf } from "./ui";
import { Skeleton } from "./loading";

type Late = { agent: string; name: string; reason: string };

/** 報告を引用した書きかけを置いて、そのエージェントとの新しいセッションを開く（送るのはオーナー） */
function talkAbout(r: WatchReport) {
  const date = new Date(r.at).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
  remember(`gh-draft:${r.agent}:new`, `「${r.name}」（${date}）の報告について:\n> ${plainSummary(r.text, 300)}\n\n`);
  location.hash = `#/session/${r.agent}/new`;
}

/** Markdown の記号を落として、頭から n 文字（レポートの1枚・一覧の要約用） */
export function plainSummary(text: string, n: number): string {
  const s = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "・")
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function WatchPage({ snap }: { snap: Snapshot | null }) {
  const [data, setData] = useState<{ reports: WatchReport[]; errors: { agent: string; error: string }[]; late?: Late[] } | null>(null);
  const chat = new Set(useAgents().filter((a) => a.available).map((a) => a.id));
  const [open, setOpen] = useState<string | null>(null);
  const [who, setWho] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/watch").then((r) => r.json()).then((b) => {
      setData(b);
      if (b.reports?.[0]) setOpen(`${b.reports[0].agent}:${b.reports[0].at}`);
    }).catch(() => setData({ reports: [], errors: [] }));
  }, []);
  // 報告のあるプロファイルを、アプリの並び（実働 → 監察）の順に。並びに無いもの（ops など）は後ろ
  const order = (snap?.agents ?? []).map((a) => a.id);
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  const who_ = [...new Set((data?.reports ?? []).map((r) => r.agent))].sort((a, b) => rank(a) - rank(b));
  const list = (data?.reports ?? []).filter((r) => !who || r.agent === who);
  return (
    <Page title="定期報告" current="#/">
      <div className="flex gap-1.5 overflow-x-auto px-4 pt-2.5">
        {[{ id: null as string | null, name: "全員" }, ...who_.map((id) => ({ id: id as string | null, name: snap ? profileOf(snap.agents, id).name : id }))].map((x) => (
          <button key={x.id ?? "all"} onClick={() => setWho(x.id)} className={`min-h-9 flex-none rounded-full px-3.5 text-xs ${who === x.id ? "bg-ink font-bold text-paper" : "border border-line-2 text-ink-2"}`}>{x.name}</button>
        ))}
      </div>
      <div className="flex flex-col gap-2.5 px-4 pb-6 pt-3">
        {!data && <Skeleton />}
        {data?.errors.map((e) => <div key={e.agent} className="rounded-xl bg-orange/10 px-3 py-2 text-xs text-orange-ink">{e.agent}: {e.error}</div>)}
        {data?.late?.filter((l) => !who || l.agent === who).map((l) => (
          <div key={`${l.agent}:${l.name}`} className="rounded-xl bg-orange/10 px-3 py-2 text-xs text-orange-ink">⚠ {snap ? profileOf(snap.agents, l.agent).name : l.agent}「{l.name}」: {l.reason}</div>
        ))}
        {data && list.length === 0 && <div className="text-[13px] text-mute">まだ報告はない。定期実行（cron）が動くと、こことレポートに出る。</div>}
        {list.map((r) => {
          const k = `${r.agent}:${r.at}`;
          const p = snap ? profileOf(snap.agents, r.agent) : null;
          const isOpen = open === k;
          return (
            <div key={k} className={`overflow-hidden rounded-xl border bg-panel ${isOpen ? "border-lime-line" : "border-line"}`}>
              <button onClick={() => setOpen(isOpen ? null : k)} className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left">
                {p && <Avatar p={p} size={32} />}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[13.5px] font-bold">{p?.name ?? r.agent}<span className="ml-1.5 text-[11px] font-normal text-mute">{r.name} · {new Date(r.at).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })}（{ago(r.at)}）</span></span>
                  {!isOpen && <span className={`line-clamp-2 text-[12px] leading-snug ${r.ok ? "text-ink-2" : "text-orange-ink"}`}>{r.ok ? plainSummary(r.text, 140) : "実行に失敗した"}</span>}
                </span>
              </button>
              {isOpen && (
                <div className="border-t border-line px-3.5 py-3 text-[13.5px] leading-7 text-ink-2">
                  <RichText text={r.text} />
                  {chat.has(r.agent) && (
                    <button onClick={() => talkAbout(r)} className="mt-3 flex min-h-10 items-center rounded-full border border-line-2 px-4 text-[12.5px] font-semibold text-ink">
                      このことで{p?.name ?? r.agent}と話す
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Page>
  );
}
