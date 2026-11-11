// 設定のエージェント: サッカーの選手紹介のようなカード。開くと名前・顔・役割・色を変えられて、モデルと中身も見られる。
import { IconButton, useConfirm } from "./sheet";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { type AgentInfo, type AgentProfile, DEFAULT_TEAM, type NameSync, type Team, teamOfProfile } from "../shared/types";
import { fetchRetry } from "./api";
import { Avatar } from "./ui";

export type ManagedAgent = AgentProfile & { hidden?: boolean; nameSync?: NameSync };

/** 色の明るさから、上に載せる文字の色を決める（WCAG の相対輝度） */
export function inkOn(color: string): "#17171a" | "#ffffff" {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return "#ffffff";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // 白と黒で、コントラストが高いほう
  return 1.05 / (L + 0.05) >= (L + 0.05) / (0.0091 + 0.05) ? "#ffffff" : "#17171a";
}

export function useAgentSettings() {
  const [agents, setAgents] = useState<ManagedAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 変更（PATCH）の回数。読み込み（GET）の途中で変更したら、遅れて届いた古い一覧で上書きしない（#29）
  const edits = useRef(0);
  const take = async (r: Response, at = edits.current) => {
    const b = (await r.json().catch(() => ({}))) as { agents?: ManagedAgent[]; error?: string };
    if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
    if (b.agents && at === edits.current) setAgents(b.agents);
    setError(null);
  };
  const fail = (e: unknown) => setError(String(e instanceof Error ? e.message : e));
  const [teams, setTeams] = useState<Team[]>([]);
  const loadTeams = () => {
    const at = edits.current;
    return fetchRetry("/api/teams").then((r) => r.json()).then((b: { teams: Team[]; agents: ManagedAgent[] }) => {
      setTeams(b.teams);
      if (b.agents.length && at === edits.current) setAgents(b.agents);
    }).catch(fail);
  };
  useEffect(() => {
    const at = edits.current;
    fetchRetry("/api/agents-settings").then((r) => take(r, at)).catch(fail);
    void loadTeams();
  }, []);
  const patch = (id: string, body: Record<string, unknown>) => {
    const at = ++edits.current;
    return fetch(`/api/agents-settings/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => take(r, at)).catch(fail);
  };
  const upload = (id: string, f: File | undefined) => {
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    const at = ++edits.current;
    void fetch(`/api/agents-settings/${encodeURIComponent(id)}/avatar`, { method: "POST", body: fd }).then((r) => take(r, at)).catch(fail);
  };
  // Hermes で足したエージェントを再起動なしで探し直す（#35）。失敗しても今の一覧はそのまま
  const [scan, setScan] = useState<{ state: "idle" | "busy" | "done" | "error"; text?: string }>({ state: "idle" });
  const rediscover = async (): Promise<boolean> => {
    if (scan.state === "busy") return false;
    setScan({ state: "busy" });
    const at = ++edits.current;
    try {
      const r = await fetch("/api/agents-settings/rediscover", { method: "POST" });
      const b = (await r.json().catch(() => ({}))) as { agents?: ManagedAgent[]; added?: string[]; error?: string };
      if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
      if (b.agents && at === edits.current) setAgents(b.agents);
      const n = b.added?.length ?? 0;
      setScan({ state: "done", text: n ? `${n} 人見つかった（${b.added!.join("、")}）。既定の「実働」チームに入れた` : "新しいエージェントは見つからなかった（変更なし）" });
      void loadTeams();
      return true;
    } catch (e) {
      setScan({ state: "error", text: `探せなかった: ${e instanceof Error ? e.message : e}。今の一覧はそのまま。もう一度押せる` });
      return false;
    }
  };
  // Hermes の表示名への反映をやり直す（失敗の再試行・競合から上書きを選んだとき）
  const syncName = (id: string, force = false) => {
    const at = ++edits.current;
    return fetch(`/api/agents-settings/${encodeURIComponent(id)}/sync-name`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force }) }).then((r) => take(r, at)).catch(fail);
  };
  return { agents, error, patch, upload, teams, loadTeams, scan, rediscover, syncName };
}

/** 選手カードの表の面 */
export function PlayerCard({ a, info, no, open, onToggle, teamName }: { teamName: string; a: ManagedAgent; info: AgentInfo | undefined; no: number; open: boolean; onToggle: () => void }) {
  const color = /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : "#2f6fdb";
  const ink = inkOn(color);
  const stat = (label: string, value: string) => (
    <div className="flex min-w-0 flex-1 flex-col px-3 py-2">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] opacity-70">{label}</span>
      <span className="truncate text-[12.5px] font-bold">{value}</span>
    </div>
  );
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      className={`relative block w-full overflow-hidden text-left ${a.hidden ? "opacity-50 grayscale" : ""}`}
      style={{ background: `linear-gradient(120deg, ${color} 0%, ${color} 46%, color-mix(in srgb, ${color} 62%, #000) 100%)`, color: ink }}
    >
      {/* 背番号 */}
      <span aria-hidden="true" className="pointer-events-none absolute -right-1 -top-5 select-none text-[118px] font-black italic leading-none tracking-tighter opacity-20 tabular-nums">{String(no).padStart(2, "0")}</span>
      {/* 斜めの帯 */}
      <span aria-hidden="true" className="pointer-events-none absolute -left-10 top-0 h-full w-24 -skew-x-12" style={{ background: ink, opacity: 0.08 }} />
      <span className="relative flex items-center gap-3.5 px-4 pb-3 pt-4">
        <span className="flex-none rounded-full p-[3px]" style={{ background: ink }}>
          <Avatar p={a} size={84} />
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-[11px] font-bold uppercase tracking-[0.14em] opacity-80">{a.role || teamName.toUpperCase()}</span>
          <span className="truncate text-[28px] font-black italic leading-none tracking-tight">{a.name}</span>
          <span className="text-[11.5px] font-semibold opacity-80">{a.hidden ? "ベンチ（隠している）" : `${teamName}チーム`}</span>
        </span>
      </span>
      <span className="relative flex divide-x divide-current/20" style={{ background: "rgba(0,0,0,0.14)" }}>
        {stat("モデル", info?.model || "—")}
        <span className="flex w-24 flex-none">{stat("スキル", info ? String(info.skills.length) : "—")}</span>
        <span className="flex w-12 flex-none items-center justify-center text-[15px] font-bold" aria-hidden="true">{open ? "▴" : "▾"}</span>
      </span>
    </button>
  );
}

/** 名前を Hermes の表示名に写した結果（#36）。Hermes のエージェントだけ。役割・人格・モデルは写さない */
function NameSyncNote({ a, syncName }: { a: ManagedAgent; syncName: (id: string, force?: boolean) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const run = (force: boolean) => {
    setBusy(true);
    void syncName(a.id, force).finally(() => setBusy(false));
  };
  const s = a.nameSync;
  const btn = "ml-1.5 rounded-md border border-line-2 px-2 py-0.5 text-[11px] font-semibold text-ink-2 disabled:opacity-50";
  const base = "pl-[3.75rem] text-[11px] leading-relaxed";
  if (!s)
    return <div className={`${base} text-mute`}>名前を変えると、Hermes の表示名にも反映される。内部の ID・人格（SOUL）・モデル・権限・役割は変わらない</div>;
  if (s.state === "synced")
    return <div className={`${base} text-mute`}>Hermes の表示名にも反映済み（「{s.synced}」）。内部の ID・人格・モデル・権限・役割は変わっていない</div>;
  if (s.state === "conflict")
    return (
      <div className={`${base} text-orange-ink`} role="alert">
        Hermes 側の表示名は「{s.current || "（空）"}」で、Plasmod の名前と違う。Hermes 側を直した可能性があるので、上書きしていない
        <button disabled={busy} onClick={() => confirm(`Hermes の表示名「${s.current}」を「${a.name}」で上書きしますか？`) && run(true)} className={btn}>{busy ? "…" : "Plasmod の名前で上書き"}</button>
      </div>
    );
  return (
    <div className={`${base} text-orange-ink`} role="alert">
      Hermes に反映できなかった（Plasmod の名前は保存済み）: {s.error}
      <button disabled={busy} onClick={() => run(false)} className={btn}>{busy ? "…" : "再試行"}</button>
    </div>
  );
}

/** プロフィールの編集: 顔・名前・役割・色・隠す */
export function ProfileEditor({ a, patch, upload, teams, syncName }: { teams: Team[]; a: ManagedAgent; patch: (id: string, body: Record<string, unknown>) => Promise<unknown>; upload: (id: string, f: File | undefined) => void; syncName?: (id: string, force?: boolean) => Promise<unknown> }) {
  const row = (label: string, control: ReactNode) => (
    <label className="flex items-center gap-3">
      <span className="w-12 flex-none text-[11.5px] text-mute">{label}</span>
      {control}
    </label>
  );
  const input = "min-h-9 min-w-0 flex-1 rounded-lg border border-line-2 bg-transparent px-2.5 text-[13px] outline-none";
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] text-mute">プロフィール</div>
      {row(
        "顔",
        <span className="flex min-h-9 flex-1 cursor-pointer items-center rounded-lg border border-line-2 px-2.5 text-[12.5px] text-ink-2">
          画像を選ぶ（PNG・JPEG・WebP）
          <input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`${a.name}の顔の画像`} className="sr-only" onChange={(e) => upload(a.id, e.target.files?.[0])} />
        </span>,
      )}
      {row(
        "名前",
        <input key={`n:${a.name}`} defaultValue={a.name} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== a.name && void patch(a.id, { name: e.target.value })} aria-label={`${a.id} の名前`} className={input} />,
      )}
      {a.runtime !== "claude-code" && syncName && <NameSyncNote a={a} syncName={syncName} />}
      {row(
        "役割",
        <input key={`r:${a.role ?? ""}`} defaultValue={a.role ?? ""} placeholder="例: WINGMAN" onBlur={(e) => e.target.value.trim() !== (a.role ?? "") && void patch(a.id, { role: e.target.value })} aria-label={`${a.name}の役割`} className={input} />,
      )}
      {teams.length > 1 && row(
        "チーム",
        <select value={teamOfProfile(a, teams).id} onChange={(e) => void patch(a.id, { team: e.target.value })} className={input}>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>,
      )}
      <div className="flex items-center gap-3">
        <label className="flex flex-1 items-center gap-3">
          <span className="w-12 flex-none text-[11.5px] text-mute">色</span>
          <input type="color" defaultValue={a.color.startsWith("#") ? a.color : "#888888"} onBlur={(e) => e.target.value !== a.color && void patch(a.id, { color: e.target.value })} aria-label={`${a.name}の色`} className="size-9 flex-none cursor-pointer rounded-lg border border-line-2 bg-transparent p-1" />
        </label>
        <button onClick={() => void patch(a.id, { hidden: !a.hidden })} className="min-h-9 flex-none rounded-lg border border-line-2 px-3 text-[12px] text-ink-2">{a.hidden ? "ベンチから出す" : "隠す"}</button>
      </div>
    </div>
  );
}

function Toggle({ on, label, note, onChange }: { on: boolean; label: string; note: string; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)} className="flex min-h-11 w-full items-center gap-3 text-left">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] text-ink">{label}</span>
        <span className="text-[11.5px] text-mute">{note}</span>
      </span>
      <span className={`relative h-6 w-10 flex-none rounded-full transition-colors ${on ? "bg-ink" : "bg-line-2"}`}>
        <span className={`absolute top-0.5 size-5 rounded-full bg-paper shadow-sm transition-transform ${on ? "translate-x-[18px]" : "translate-x-0.5"}`} />
      </span>
    </button>
  );
}

/** チームの1行。普段は色・名前・メンバーの顔だけで、押すと設定が開く */
function TeamRow({ t, members, patch, remove }: { t: Team; members: ManagedAgent[]; patch: (b: Partial<Team>) => void; remove: () => void }) {
  const { ask, node: confirmNode } = useConfirm();
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-2xl border bg-panel" style={{ borderColor: `color-mix(in srgb, ${t.color} 45%, var(--color-line))` }}>
      <button onClick={() => setOpen((x) => !x)} aria-expanded={open} className="flex min-h-14 w-full items-center gap-3 px-3.5 py-2 text-left">
        <span className="size-3 flex-none rounded-full" style={{ background: t.color, boxShadow: `0 0 10px ${t.color}` }} aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[14.5px] font-bold">{t.name}</span>
          <span className="truncate text-[11.5px] text-mute">{t.delegable ? "任せ先" : "任せ先に出さない"}</span>
        </span>
        <span className="flex flex-none -space-x-2">
          {members.slice(0, 4).map((a) => <span key={a.id} className="rounded-full ring-2 ring-panel"><Avatar p={a} size={26} /></span>)}
          {members.length > 4 && <span className="flex size-[26px] items-center justify-center rounded-full bg-chip text-[10.5px] font-semibold text-ink-2 ring-2 ring-panel">+{members.length - 4}</span>}
          {members.length === 0 && <span className="text-[11.5px] text-mute">メンバーなし</span>}
        </span>
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true" className={`flex-none text-mute transition-transform duration-200 ${open ? "rotate-90" : ""}`}><path d="M9 6l6 6-6 6" /></svg>
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-line px-3.5 py-3">
          <div className="flex items-center gap-2">
            <label className="relative size-9 flex-none cursor-pointer overflow-hidden rounded-full" style={{ background: t.color }}>
              <span className="sr-only">{t.name}の色</span>
              <input type="color" defaultValue={t.color} onBlur={(e) => e.target.value !== t.color && patch({ color: e.target.value })} className="absolute inset-0 cursor-pointer opacity-0" />
            </label>
            <input key={`n:${t.name}`} defaultValue={t.name} maxLength={30} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== t.name && patch({ name: e.target.value })} aria-label={`${t.name}の名前`} className="min-h-10 min-w-0 flex-1 rounded-xl bg-chip/70 px-3 text-[14px] font-semibold outline-none focus:bg-chip" />
          </div>
          <Toggle on={t.delegable} label="仕事を任せられる" note="カードの「〇〇に任せる」に出す" onChange={(v) => patch({ delegable: v })} />
          {t.id !== DEFAULT_TEAM && (
            <IconButton name="trash" label="このチームを消す" onClick={() => ask(`「${t.name}」を消します。メンバーは最初のチームに移ります。`, remove)} tone="danger" className="mt-1 self-start" />
          )}
        </div>
      )}
      {confirmNode}
    </div>
  );
}

/** チームの設定 */
export function TeamsEditor({ teams, agents, onChange }: { teams: Team[]; agents: ManagedAgent[]; onChange: () => void }) {
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const call = async (url: string, method: string, body?: unknown) => {
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const b = (await r.json().catch(() => ({}))) as { error?: string };
    setError(r.ok ? null : (b.error ?? `HTTP ${r.status}`));
    onChange();
    return r.ok;
  };
  const add = async () => {
    if (name.trim() && (await call("/api/teams", "POST", { name: name.trim() }))) {
      setName("");
      setAdding(false);
    }
  };
  return (
    <section aria-label="チーム" className="flex flex-col gap-2 lg:col-span-2">
      <div className="flex items-center px-1">
        <span className="text-[12px] font-semibold text-mute">チーム</span>
        <button onClick={() => setAdding((x) => !x)} aria-label="チームを足す" className="ml-auto flex size-8 items-center justify-center rounded-full text-ink-2 hover:bg-chip">
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>
      {error && <div className="rounded-xl bg-orange-soft px-3 py-2 text-[12px] text-orange-ink" role="alert">{error}</div>}
      {adding && (
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void add()} onBlur={() => !name.trim() && setAdding(false)} placeholder="新しいチームの名前（Enter）" aria-label="新しいチームの名前" className="min-h-11 rounded-2xl border border-line-2 bg-panel px-3.5 text-[14px] outline-none" />
      )}
      {teams.map((t) => (
        <TeamRow
          key={t.id}
          t={t}
          members={agents.filter((a) => teamOfProfile(a, teams).id === t.id)}
          patch={(b) => void call(`/api/teams/${t.id}`, "PATCH", b)}
          remove={() => void call(`/api/teams/${t.id}`, "DELETE")}
        />
      ))}
    </section>
  );
}
