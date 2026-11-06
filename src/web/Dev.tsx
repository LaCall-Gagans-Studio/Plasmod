import { useEffect, useState } from "react";
import type { DevPr, DevSnapshot } from "../shared/types";
import { TaskBadges } from "./badges";
import { MicButton } from "./speech";
import { Page, ago } from "./ui";

/** 開発（Dev とウォッチングをまとめたもの）の上の切り替え: PR｜カンバン */
export function DevTabs({ current }: { current: "pr" | "kanban" }) {
  return (
    <div className="flex gap-1.5 px-4 pt-1.5" role="tablist" aria-label="開発">
      {([["pr", "PR", "#/dev"], ["kanban", "カンバン", "#/watching"]] as const).map(([id, label, href]) => (
        <a key={id} href={href} role="tab" aria-selected={current === id} className={`flex min-h-9 flex-none items-center rounded-full px-3.5 text-xs no-underline ${current === id ? "bg-ink font-bold text-paper" : "border border-line-2 text-ink-2"}`}>
          {label}
        </a>
      ))}
    </div>
  );
}

const CHECK = {
  success: { label: (p: DevPr) => `✓ ${p.checks.passed} passed`, cls: "bg-lime-soft text-lime-ink" },
  failure: { label: (p: DevPr) => `✕ ${p.checks.failed} failed`, cls: "bg-red-soft text-red-ink" },
  pending: { label: (p: DevPr) => `… ${p.checks.pending} running`, cls: "bg-yellow-soft text-yellow-ink" },
  none: { label: () => "チェックなし", cls: "bg-line text-ink-2" },
} as const;

const key = (p: DevPr) => `${p.repo}#${p.number}`;

export function Dev() {
  const [snap, setSnap] = useState<DevSnapshot | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"merge" | "revise" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; session?: string; agent?: string } | null>(null);
  // PR の依頼先（設定で選べる）
  const [target, setTarget] = useState<{ agent: string; agents: { id: string; name: string }[] } | null>(null);
  useEffect(() => {
    fetch("/api/dev-settings").then((r) => r.json()).then(setTarget).catch(() => {});
  }, []);
  const targetName = target?.agents.find((a) => a.id === target.agent)?.name ?? "エージェント";
  const pickTarget = (agent: string) => {
    setTarget((x) => (x ? { ...x, agent } : x));
    void fetch("/api/dev-settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent }) });
  };

  useEffect(() => {
    let alive = true;
    const load = () => fetch("/api/dev").then((r) => r.json()).then((s) => alive && setSnap(s)).catch(() => {});
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const toggle = (p: DevPr) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(key(p))) n.delete(key(p));
      else n.add(key(p));
      return n;
    });

  const send = async () => {
    if (!mode || !snap) return;
    setBusy(true);
    setMsg(null);
    const prs = snap.prs.filter((p) => sel.has(key(p))).map((p) => ({ repo: p.repo, number: p.number }));
    const r = await fetch("/api/dev/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: mode, prs, note }) });
    const b = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; agent?: string; session?: string };
    setBusy(false);
    if (b.ok) {
      setMsg({ ok: true, text: mode === "merge" ? `${targetName}にマージを頼んだ。承認依頼のカードが来たら許可してね` : `${targetName}に差し戻しを送った`, agent: b.agent, session: b.session });
      setSel(new Set());
      setMode(null);
      setNote("");
    } else setMsg({ ok: false, text: b.error ?? `HTTP ${r.status}` });
  };

  const repos = [...new Set((snap?.prs ?? []).map((p) => p.repo))];
  return (
    <Page title="開発" current="#/dev" right={<span className="font-mono text-[11px] text-mute">{snap?.fetchedAt ? `更新 ${ago(snap.fetchedAt)}` : ""}</span>}>
      <DevTabs current="pr" />
      {target && target.agents.length > 1 && (
        <label className="mx-4 mt-2 flex items-center gap-2 text-[12px] text-mute">
          マージ・差し戻しの依頼先
          <select value={target.agent} onChange={(e) => pickTarget(e.target.value)} className="min-h-8 rounded-lg border border-line-2 bg-panel px-2 text-[12.5px] text-ink">
            {target.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      )}
      {snap?.error && <div className="mx-4 mt-2 rounded-xl bg-orange/10 px-3 py-2 text-xs text-orange-ink">{snap.error}</div>}
      <div className="flex flex-col gap-3.5 px-4 pb-4 pt-1.5">
        {snap && snap.prs.length === 0 && !snap.error && <div className="text-sm text-mute">開いている PR はありません</div>}
        {repos.map((repo) => {
          const prs = snap!.prs.filter((p) => p.repo === repo);
          return (
            <section key={repo} className="grid gap-2 lg:grid-cols-2 lg:items-start 2xl:grid-cols-3" aria-label={repo}>
              <div className="flex font-mono text-xs text-mute lg:col-span-full"><span>{repo.split("/")[1]}</span><span className="ml-auto">PR {prs.length}</span></div>
              {prs.map((p) => {
                const on = sel.has(key(p));
                const c = CHECK[p.checks.state];
                return (
                  <div key={key(p)} className={`flex gap-3 rounded-xl border bg-panel p-3 ${on ? "border-lime-line" : "border-line"}`}>
                    <label className="flex flex-none pt-0.5">
                      <span className="sr-only">{p.title} を選ぶ</span>
                      <input type="checkbox" checked={on} onChange={() => toggle(p)} className="size-[22px] accent-lime" />
                    </label>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <a href={p.url} target="_blank" rel="noreferrer" className="text-sm font-bold leading-snug">
                        #{p.number} {p.title}{p.draft && <span className="ml-1.5 text-[11px] font-normal text-mute">draft</span>}
                      </a>
                      {p.summary && <div className="text-xs leading-relaxed text-ink-2">{p.summary}</div>}
                      <div className="flex flex-wrap gap-1.5 font-mono text-[10.5px]">
                        <span className={`rounded-md px-1.5 py-0.5 ${c.cls}`}>{c.label(p)}</span>
                        <span className="rounded-md bg-line px-1.5 py-0.5 text-ink-2">+{p.additions} −{p.deletions} · {p.files} files</span>
                        <TaskBadges ids={p.refs.filter((l) => !l.startsWith("P-"))} />
                        {p.previewUrl && <a href={p.previewUrl} target="_blank" rel="noreferrer" className="rounded-md bg-line px-1.5 py-0.5 text-ink-2">preview ↗</a>}
                        <span className="px-1 py-0.5 text-mute">{p.author} · {ago(p.updatedAt)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>

      <div className="sticky bottom-0 flex flex-col gap-2 bg-ground/95 px-4 pb-3 pt-2 lg:mx-auto lg:w-full lg:max-w-[760px]">
        {msg && (
          <div className={`rounded-xl px-3 py-2 text-xs ${msg.ok ? "bg-lime-soft text-lime-ink" : "bg-orange/10 text-orange-ink"}`} role="status">
            {msg.text}
            {msg.session && <a href={`#/session/${msg.agent ?? target?.agent}/${msg.session}`} className="ml-2 underline">セッションを見る</a>}
          </div>
        )}
        {mode && (
          <label className="flex items-start gap-2 rounded-2xl border border-line-2 p-3">
            <span className="sr-only">{mode === "merge" ? "メモ" : "指摘"}</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={mode === "merge" ? "メモ（任意）" : "直してほしいこと"} className="flex-1 resize-none bg-transparent text-sm text-ink outline-none" />
            <MicButton onText={(t) => setNote((x) => x + t)} />
          </label>
        )}
        {sel.size > 0 && (
          <div className="flex gap-2">
            {mode ? (
              <>
                <button disabled={busy || (mode === "revise" && !note.trim())} onClick={send} className="min-h-12 flex-[2] rounded-full bg-lime text-sm font-bold text-on disabled:opacity-40">
                  {mode === "merge" ? `${sel.size}件のマージを${targetName}に頼む` : `${sel.size}件を差し戻す`}
                </button>
                <button onClick={() => setMode(null)} className="min-h-12 flex-1 rounded-full border border-line-2 text-sm">やめる</button>
              </>
            ) : (
              <>
                <button onClick={() => setMode("merge")} className="min-h-12 flex-[2] rounded-full bg-lime text-sm font-bold text-on">{sel.size}件をまとめてマージ</button>
                <button onClick={() => setMode("revise")} className="min-h-12 flex-1 rounded-full border border-line-2 text-sm font-bold">差し戻す</button>
              </>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}
