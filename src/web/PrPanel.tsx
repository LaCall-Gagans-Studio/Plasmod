// PR から来たタスクの中身: チェックの結果、マージ、開発エージェントへの依頼（差し戻し）。
// マージ用のトークンがあれば、ここで承認するとアプリがマージする（エージェントが頼んだ commit だけ）。
// 無ければ従来どおり、開発エージェントに頼み、依頼された側が承認を通して行う。
import { ing } from "./dots";
import { useEffect, useState } from "react";
import type { DevPr, DevSnapshot, MergeRequest } from "../shared/types";
import { MicButton } from "./speech";

const CHECK = {
  success: { label: (p: DevPr) => `✓ ${p.checks.passed} passed`, cls: "bg-lime-soft text-lime-ink" },
  failure: { label: (p: DevPr) => `✕ ${p.checks.failed} failed`, cls: "bg-red-soft text-red-ink" },
  pending: { label: (p: DevPr) => `… ${p.checks.pending} running`, cls: "bg-yellow-soft text-yellow-ink" },
  none: { label: () => "チェックなし", cls: "bg-line text-ink-2" },
} as const;

export function PrPanel({ url }: { url: string }) {
  const [pr, setPr] = useState<DevPr | null>(null);
  const [target, setTarget] = useState<{ agent: string; agents: { id: string; name: string }[] } | null>(null);
  const [mode, setMode] = useState<"merge" | "revise" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; session?: string; agent?: string } | null>(null);
  const [desk, setDesk] = useState<{ enabled: boolean; method: string; pending: MergeRequest[] } | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/dev").then((r) => r.json() as Promise<DevSnapshot>).then((s) => alive && setPr(s.prs.find((p) => p.url === url) ?? null)).catch(() => {});
    fetch("/api/dev-settings").then((r) => r.json()).then((t) => alive && setTarget(t)).catch(() => {});
    fetch("/api/dev/merge").then((r) => r.json()).then((d) => alive && setDesk(d)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [url]);

  if (!pr) return null;
  const name = target?.agents.find((a) => a.id === target.agent)?.name ?? "エージェント";
  const pick = (agent: string) => {
    setTarget((x) => (x ? { ...x, agent } : x));
    void fetch("/api/dev-settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent }) });
  };
  const send = async () => {
    if (!mode) return;
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/dev/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: mode, prs: [{ repo: pr.repo, number: pr.number }], note }) });
    const b = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; agent?: string; session?: string };
    setBusy(false);
    if (b.ok) {
      setMsg({ ok: true, text: mode === "merge" ? `${name}にマージを頼んだ。承認依頼のカードが来たら許可してね` : `${name}に差し戻しを送った`, agent: b.agent, session: b.session });
      setMode(null);
      setNote("");
    } else setMsg({ ok: false, text: b.error ?? `HTTP ${r.status}` });
  };
  const c = CHECK[pr.checks.state];
  const req = desk?.pending.find((r) => r.repo === pr.repo && r.number === pr.number) ?? null;
  const sha = req?.sha ?? pr.sha;
  const moved = !!req && !pr.sha.startsWith(req.sha);
  const blocked = pr.draft ? "下書き" : pr.checks.state === "failure" ? "CI が落ちている" : pr.checks.state === "pending" ? "CI がまだ走っている" : moved ? "頼まれた後に新しい commit がある" : null;
  const approve = async () => {
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/dev/merge/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: pr.repo, number: pr.number, sha }) });
    const b = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; request?: MergeRequest };
    setBusy(false);
    setConfirm(false);
    if (b.ok) setMsg({ ok: true, text: b.request?.result || "マージした" });
    else setMsg({ ok: false, text: r.status === 403 ? "Tailscale の入口から開いたときだけ承認できる" : (b.error ?? `HTTP ${r.status}`) });
  };
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
      <div className="flex flex-wrap gap-1.5 font-mono text-[10.5px]">
        <span className={`rounded-md px-1.5 py-0.5 ${c.cls}`}>{c.label(pr)}</span>
        <span className="rounded-md bg-line px-1.5 py-0.5 text-ink-2">+{pr.additions} −{pr.deletions} · {pr.files} files</span>
        {pr.draft && <span className="rounded-md bg-line px-1.5 py-0.5 text-ink-2">draft</span>}
        {pr.previewUrl && <a href={pr.previewUrl} target="_blank" rel="noreferrer" className="rounded-md bg-line px-1.5 py-0.5 text-ink-2">preview ↗</a>}
      </div>
      {req && (
        <div className="rounded-lg bg-lime-soft px-2.5 py-2 text-[12px] text-lime-ink">
          <b>{req.by}</b> がマージの承認を頼んでいる · <span className="font-mono">{req.sha.slice(0, 7)}</span>
          {req.note && <div className="mt-0.5 whitespace-pre-wrap text-ink-2">{req.note}</div>}
        </div>
      )}
      {desk?.enabled && confirm && (
        <div className="flex flex-col gap-2 rounded-xl border border-line-2 p-2.5 text-[12.5px]">
          <div>
            <span className="font-mono">{sha.slice(0, 7)}</span> を <b>{pr.repo.split("/")[1]}</b> の既定のブランチに {desk.method} でマージする
          </div>
          <div className="flex gap-2">
            <button disabled={busy} onClick={approve} className="min-h-11 flex-[2] rounded-full bg-lime text-sm font-bold text-on disabled:opacity-40">
              {busy ? ing("マージしています…") : "マージする"}
            </button>
            <button onClick={() => setConfirm(false)} className="min-h-11 flex-1 rounded-full border border-line-2 text-sm">やめる</button>
          </div>
        </div>
      )}
      {target && target.agents.length > 1 && (
        <label className="flex items-center gap-2 text-[12px] text-mute">
          依頼先
          <select value={target.agent} onChange={(e) => pick(e.target.value)} className="min-h-8 rounded-lg border border-line-2 bg-panel px-2 text-[12.5px] text-ink">
            {target.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      )}
      {mode && (
        <label className="flex items-start gap-2 rounded-xl border border-line-2 p-2">
          <span className="sr-only">{mode === "merge" ? "メモ" : "指摘"}</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={mode === "merge" ? "メモ（任意）" : "直してほしいこと"} className="flex-1 resize-none bg-transparent text-sm text-ink outline-none" />
          <MicButton onText={(t) => setNote((x) => x + t)} />
        </label>
      )}
      <div className="flex gap-2">
        {mode ? (
          <>
            <button disabled={busy || (mode === "revise" && !note.trim())} onClick={send} className="min-h-11 flex-[2] rounded-full bg-lime text-sm font-bold text-on disabled:opacity-40">
              {mode === "merge" ? `${name}にマージを頼む` : "差し戻す"}
            </button>
            <button onClick={() => setMode(null)} className="min-h-11 flex-1 rounded-full border border-line-2 text-sm">やめる</button>
          </>
        ) : (
          <>
            {desk?.enabled ? (
              <button disabled={!!blocked || confirm} onClick={() => setConfirm(true)} className="min-h-11 flex-[2] rounded-full bg-lime text-sm font-bold text-on disabled:opacity-40">
                {blocked ? `マージできない（${blocked}）` : "承認してマージ"}
              </button>
            ) : (
              <button onClick={() => setMode("merge")} className="min-h-11 flex-[2] rounded-full bg-lime text-sm font-bold text-on">マージする</button>
            )}
            <button onClick={() => setMode("revise")} className="min-h-11 flex-1 rounded-full border border-line-2 text-sm font-bold">差し戻す</button>
          </>
        )}
      </div>
      {msg && (
        <div className={`rounded-lg px-2.5 py-1.5 text-xs ${msg.ok ? "bg-lime-soft text-lime-ink" : "bg-orange/10 text-orange-ink"}`} role="status">
          {msg.text}
          {msg.session && <a href={`#/session/${msg.agent ?? target?.agent}/${msg.session}`} className="ml-2 underline">セッションを見る</a>}
        </div>
      )}
    </div>
  );
}
