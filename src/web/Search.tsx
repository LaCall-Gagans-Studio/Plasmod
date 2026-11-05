import { useEffect, useState } from "react";
import type { SearchHit, Snapshot } from "../shared/types";
import { MicButton } from "./speech";
import { Page, ago } from "./ui";

const KIND: Record<SearchHit["kind"], string> = {
  task: "カンバン",
  card: "承認依頼",
  decision: "判断",
  report: "レポート",
  note: "カードのメモ",
  memo: "メモ",
  apptask: "タスク",
  session: "会話",
};

/** 会話の ref は「エージェント/セッション」 */
const sessionHash = (ref: string) => {
  const at = ref.indexOf("/");
  return `#/session/${ref.slice(0, at)}/${encodeURIComponent(ref.slice(at + 1))}`;
};

const PERIODS = [
  { days: 0, label: "全期間" },
  { days: 1, label: "今日" },
  { days: 7, label: "今週" },
  { days: 30, label: "今月" },
];

export function Search({ snap }: { snap: Snapshot | null }) {
  const [q, setQ] = useState(() => new URLSearchParams(location.hash.split("?")[1] ?? "").get("q") ?? "");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [days, setDays] = useState(0);
  const [agent, setAgent] = useState("");
  const [project, setProject] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  useEffect(() => {
    fetch("/api/projects?view=list")
      .then((r) => (r.ok ? r.json() : []))
      .then((l: { name: string }[]) => setProjects(Array.isArray(l) ? l.map((p) => p.name) : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const word = q.trim();
    if (!word) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ q: word, ...(days ? { days: String(days) } : {}), ...(agent ? { agent } : {}), ...(project ? { project } : {}) });
      fetch(`/api/search?${qs}`)
        .then((r) => (r.ok ? r.json() : []))
        .then(setHits)
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, days, agent, project]);

  // 今も出ているカードなら、カードを開く
  const liveKey = (h: SearchHit) => {
    if (!snap) return null;
    const key = h.kind === "task" ? `task:${h.ref}` : h.kind === "note" ? `note:${h.ref}` : h.kind === "card" ? h.ref : null;
    return key && snap.cards.some((c) => c.key === key) ? key : null;
  };

  return (
    <Page title="検索" current="#/search">
      <div className="flex items-center gap-2 px-4 pt-2">
        <label className="flex min-h-12 min-w-0 flex-1 items-center rounded-full border border-line-2 px-4">
          <span className="sr-only">検索する言葉</span>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="あのとき何に決めた？"
            className="w-full min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none"
          />
        </label>
        <MicButton onText={(t) => setQ((x) => (x ? `${x} ${t}` : t))} size={48} />
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 pt-2 text-[12px]">
        {PERIODS.map((p) => (
          <button key={p.days} onClick={() => setDays(p.days)} aria-pressed={days === p.days} className={`min-h-8 rounded-full border px-3 ${days === p.days ? "border-ink bg-ink text-ground" : "border-line-2 text-ink-2"}`}>
            {p.label}
          </button>
        ))}
        <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="エージェントで絞る" className="min-h-8 rounded-full border border-line-2 bg-transparent px-2 text-ink-2">
          <option value="">全員</option>
          {(snap?.agents ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="プロジェクトで絞る" className="min-h-8 max-w-40 rounded-full border border-line-2 bg-transparent px-2 text-ink-2">
          <option value="">全プロジェクト</option>
          {projects.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      <p className="px-5 pt-2 text-[11px] text-mute">メモ・タスク・会話・カンバン・承認依頼・判断（選んだ選択肢と返事）・レポート・カードのメモから探す</p>
      <div className="grid gap-2 px-4 pb-4 pt-2 lg:grid-cols-2 lg:items-start 2xl:grid-cols-3">
        {hits?.length === 0 && <div className="px-1 text-sm text-mute">見つかりませんでした</div>}
        {hits?.map((h) => {
          const id = `${h.kind}:${h.ref}`;
          const key = liveKey(h);
          return (
            <div key={id} className="rounded-xl border border-line bg-panel p-3">
              <button onClick={() => (h.kind === "session" ? (location.hash = sessionHash(h.ref)) : h.kind === "memo" ? (location.hash = `#/memo/${h.ref}`) : h.kind === "apptask" ? (location.hash = `#/todo/${h.ref}`) : key ? (location.hash = `#/card/${encodeURIComponent(key)}`) : setOpen(open === id ? null : id))} className="flex w-full flex-col items-start gap-1 text-left">
                <span className="flex w-full items-center gap-2 text-[11px] text-mute">
                  <span className="rounded bg-line px-1.5 py-0.5 text-ink-2">{KIND[h.kind]}</span>
                  {ago(h.at)}
                  {(key || h.kind === "memo" || h.kind === "apptask" || h.kind === "session") && <span className="ml-auto text-lime-ink">開く ›</span>}
                </span>
                <span className="text-sm font-bold text-ink">{h.title}</span>
                <span className={`whitespace-pre-wrap text-xs leading-relaxed text-ink-2 ${open === id ? "" : "line-clamp-2"}`}>{h.snippet}</span>
              </button>
            </div>
          );
        })}
      </div>
    </Page>
  );
}
