import { useEffect, useState } from "react";
import { type AppTask, type AppTaskList, type MemoList, type MemoSummary, hoursLabel, staleHours, type Snapshot } from "../shared/types";
import { SessionPanel } from "./Session";
import { fetchTaskList } from "./task-db";
import { Avatar, COL, Icon, Nav, RAIL, profileOf } from "./ui";
import { getAbout } from "./identity";

const RING = { permission: "var(--color-ring-orange)", blocked: "var(--color-ring-orange)", review: "var(--color-ring-lime)", triage: "#8FB8FF", note: "#8FB8FF", confirm: "#B8A1FF", reply: "#B8A1FF", todo: "#B8A1FF" } as const;

/** 承認待ちの root 作業の依頼（plasmod-rootd）。カードと同じ列に並べる */
function useRootPending() {
  const [items, setItems] = useState<{ id: string; title: string; requester?: string }[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/root/requests")
        .then((r) => r.json())
        .then((b: { requests?: { id: string; title: string; status: string; requester?: string }[] }) => alive && setItems((b.requests ?? []).filter((r) => r.status === "pending")))
        .catch(() => {});
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return items;
}

/** 広い画面（xl 以上）の右の列: 判断待ちを題名つきで並べる・最近のメモ */
function HomeAside({ snap }: { snap: Snapshot }) {
  const [memos, setMemos] = useState<MemoSummary[]>([]);
  const [due, setDue] = useState<AppTask[]>([]);
  useEffect(() => {
    fetch("/api/memos")
      .then((r) => (r.ok ? r.json() : null))
      .then((l: MemoList | null) => l && setMemos(l.memos.slice(0, 6)))
      .catch(() => {});
  }, []);
  // 今日まで・期限切れのタスク（やる・任せ中）。一覧が変わるたび（snap）に取り直す
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  useEffect(() => {
    fetchTaskList(new URLSearchParams({ status: "todo,doing" }))
      .then((l: AppTaskList) => setDue(l.tasks.filter((t) => t.due && t.due <= today)))
      .catch(() => {});
  }, [snap, today]);
  return (
    <aside className="hidden w-[340px] flex-none flex-col gap-5 overflow-y-auto pr-4 xl:flex 2xl:w-[400px]" aria-label="判断待ちと最近のメモ">
      <section className="flex flex-col gap-1.5">
        <div className="flex items-baseline px-1 text-[12px] font-semibold text-mute">
          判断待ち<span className="ml-auto tabular-nums">{snap.cards.length}</span>
        </div>
        {snap.cards.length === 0 && <div className="px-1 text-[12.5px] text-mute">ありません</div>}
        {snap.cards.map((c) => {
          const p = profileOf(snap.agents, c.agent);
          const h = staleHours(c);
          return (
            <a key={c.key} href={`#/card/${encodeURIComponent(c.key)}`} className="flex items-start gap-2.5 rounded-xl border border-line bg-panel px-3 py-2.5 text-ink no-underline hover:border-line-2">
              <Avatar p={p} size={28} ring={RING[c.kind]} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="line-clamp-2 text-[13px] font-semibold leading-snug">{c.title}</span>
                <span className={`text-[11px] ${h !== null ? "font-semibold text-red-ink" : "text-mute"}`}>{h !== null ? hoursLabel(h).short : c.statusLabel} · {p.name}</span>
              </span>
            </a>
          );
        })}
      </section>
      <section className="flex flex-col gap-1">
        <div className="flex items-baseline px-1 text-[12px] font-semibold text-mute">
          今日・期限切れのタスク<a href="#/todos" className="ml-auto text-[11.5px] font-normal text-mute">すべて ›</a>
        </div>
        {due.length === 0 && <div className="px-1 text-[12.5px] text-mute">ありません</div>}
        {due.map((t) => (
          <a key={t.id} href={`#/todo/${t.id}`} className="flex items-baseline gap-2 rounded-lg px-2 py-1.5 text-ink no-underline hover:bg-chip">
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{t.title}</span>
            <span className={`flex-none text-[11px] font-semibold ${t.due! < today ? "text-red-ink" : "text-orange-ink"}`}>{t.due! < today ? "期限切れ" : "今日"}</span>
          </a>
        ))}
      </section>
      <section className="flex flex-col gap-1">
        <div className="flex items-baseline px-1 text-[12px] font-semibold text-mute">
          最近のメモ<a href="#/memos" className="ml-auto text-[11.5px] font-normal text-mute">すべて ›</a>
        </div>
        {memos.length === 0 && <div className="px-1 text-[12.5px] text-mute">まだありません</div>}
        {memos.map((m) => (
          <a key={m.id} href={`#/memo/${m.id}`} className="flex flex-col rounded-lg px-2 py-1.5 text-ink no-underline hover:bg-chip">
            <span className="truncate text-[13px] font-semibold">{m.title}</span>
            <span className="truncate text-[11.5px] text-mute">{[m.project, ...m.tags.map((t) => `#${t}`)].filter(Boolean).join(" ") || m.excerpt}</span>
          </a>
        ))}
      </section>
    </aside>
  );
}

/** カードの下に出す短い題名。先頭の【】や [] を除いて5文字 */
export function shortTitle(title: string): string {
  const t = title.replace(/^\s*(?:\[[^\]]*\]|【[^】]*】|（[^）]*）|\([^)]*\))\s*/, "").trim() || title.trim();
  return [...t].slice(0, 5).join("");
}
const SHORT = "max-w-[68px] truncate text-[10.5px] leading-tight text-ink-2";

/** 依頼した OS のユーザーから、顔にするエージェント */
const REQUESTER: Record<string, string> = { cc: "dev", hermes: "default" };

export function Home({ snap, online }: { snap: Snapshot | null; online: boolean }) {
  const running = snap?.agents.filter((a) => a.state === "running").length ?? 0;
  const roots = useRootPending();
  // 右上の「!」: 画面の更新が止まっている・開発エージェントにつながっていない・カンバンが読めない
  const problems = [
    !online && "接続を待っています",
    snap?.devEnabled && !snap.bridgeConnected && "開発エージェントの bridge に未接続",
    snap?.boardError && `カンバンを読めない: ${snap.boardError}`,
  ].filter((x): x is string => !!x);
  return (
    <div className={`h-full ${RAIL}`}>
      <div className={`${COL} flex h-full flex-col`}>
        {/* 一番上の列: 左にレポート・判断待ちのカード、右端にアプリのアイコン・検索・接続状況の小さなマス */}
        <div className="flex items-start gap-3 pb-4 pl-5 pr-4 pt-[max(env(safe-area-inset-top),14px)]">
          {/* 右端は薄くして、カードが続いていることを見せる（右上の小さなマスで切れて見えないように） */}
          <div className="flex min-w-0 flex-1 gap-3.5 overflow-x-auto pr-4 [mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)] [scrollbar-width:none]" role="list" aria-label="判断待ちのカード">
            <a href="#/report" className="flex w-[68px] flex-none flex-col items-center gap-1.5" role="listitem">
              <span className="flex size-16 items-center justify-center rounded-full border-[3px] border-ring-lime p-[3px]">
                <span className="flex size-full items-center justify-center rounded-full bg-ink text-paper"><Icon name="insights" size={26} /></span>
              </span>
              <span className="text-[11px]">レポート</span>
            </a>
            {/* root の承認はいちばん左（カードより先） */}
            {snap &&
              roots.map((r) => (
                <a key={r.id} href={`#/root/${r.id}`} className="flex w-[68px] flex-none flex-col items-center gap-1" role="listitem" title={r.title}>
                  <Avatar p={profileOf(snap.agents, REQUESTER[r.requester ?? ""] ?? r.requester ?? "root")} size={64} ring="var(--color-red-ink)" />
                  <span className={SHORT}>{shortTitle(r.title)}</span>
                  <span className="max-w-[68px] truncate text-[11px] font-semibold text-red-ink">root 承認</span>
                </a>
              ))}
            {snap?.cards.map((c) => {
              const p = profileOf(snap.agents, c.agent);
              const h = staleHours(c);
              return (
                <a key={c.key} href={`#/card/${encodeURIComponent(c.key)}`} className="flex w-[68px] flex-none flex-col items-center gap-1" role="listitem" title={h !== null ? `${c.title}（${c.statusLabel}・${hoursLabel(h).long}待ち）` : c.title}>
                  <Avatar p={p} size={64} ring={RING[c.kind]} />
                  <span className={SHORT}>{shortTitle(c.title)}</span>
                  {/* 長く待っているものは赤で「5h」「3d」「1m」（ヶ月） */}
                  {h !== null
                    ? <span className="max-w-[68px] truncate text-[11px] font-semibold tabular-nums text-red-ink" aria-label={`${hoursLabel(h).long}待ち`}>{hoursLabel(h).short}</span>
                    : <span className="max-w-[68px] truncate text-[11px] text-ink-2">{c.statusLabel}</span>}
                </a>
              );
            })}
            {snap?.snoozed?.map((c) => {
              const p = profileOf(snap.agents, c.agent);
              // 伏せていても、届いてからの時間を出す（1時間未満は「<1h」）
              const h = Math.floor((Date.now() - c.createdAt) / 3600_000);
              const age = h < 1 ? { short: "<1h", long: "1時間未満" } : hoursLabel(h);
              return (
                <a key={c.key} href={`#/card/${encodeURIComponent(c.key)}`} className="flex w-[68px] flex-none flex-col items-center gap-1 opacity-40" role="listitem" title={`${c.title}（あとでに伏せている・${c.statusLabel}・${age.long}待ち）`}>
                  <Avatar p={p} size={64} ring="var(--color-line-2)" />
                  <span className={SHORT}>{shortTitle(c.title)}</span>
                  <span className="max-w-[68px] truncate text-[11px] tabular-nums text-mute" aria-label={`${age.long}待ち`}>{age.short}</span>
                </a>
              );
            })}
            {snap && snap.cards.length === 0 && !snap.snoozed?.length && roots.length === 0 && (
              <div className="flex items-center text-xs text-mute">判断待ちはありません</div>
            )}
          </div>
          {/* 右上は小さく: 検索と、稼働（色の丸＋数。何かおかしければ「!」） */}
          <div className="flex w-8 flex-none flex-col items-center gap-2 pt-1">
            <a href="#/search" aria-label="検索" className="flex size-8 items-center justify-center rounded-full text-ink-2 hover:bg-chip">
              <Icon name="search" size={17} />
            </a>
            {problems.length ? (
              <a href="#/settings?tab=vps" title={problems.join("・")} aria-label={`異常: ${problems.join("・")}`} className="flex size-6 items-center justify-center rounded-full bg-orange text-[12px] font-bold text-white no-underline">!</a>
            ) : (
              <span className="flex items-center gap-1 text-[11px] font-semibold tabular-nums text-ink-2" title={`${running} 稼働中`} aria-label={`${running} 稼働中`}>
                <span className="size-2 rounded-full bg-lime" />
                {running}
              </span>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {getAbout().ownerIsDefault && (
          <a href="#/settings?tab=general" className="mx-4 mb-3 block rounded-xl border border-line-2 px-3 py-2.5 text-[13px] text-ink-2 no-underline">
            はじめに、呼び名とエージェントの名前を設定しましょう ›
          </a>
        )}
        {snap?.devEnabled && !snap.bridgeConnected && (
          <div className="mx-4 mb-3 rounded-xl border border-line-2 px-3 py-2 text-xs text-orange-ink">bridge に未接続: 開発エージェントの承認依頼・セッションはまだここに出ません</div>
        )}
        {snap?.boardError && (
          <div className="mx-4 mb-3 rounded-xl border border-orange/40 bg-orange/10 px-3 py-2 text-xs text-orange-ink">
            カンバンを読めませんでした: {snap.boardError}
          </div>
        )}

        <SessionPanel snap={snap} />
        </div>
        {/* 広い画面: 右に判断待ちの一覧と最近のメモ */}
        {snap && <HomeAside snap={snap} />}
        </div>

        <Nav current="#/" />
      </div>
    </div>
  );
}
