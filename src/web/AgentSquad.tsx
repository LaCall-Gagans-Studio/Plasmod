// 設定のエージェント: サッカーの選手紹介のようなカード。開くと名前・顔・役割・色を変えられて、モデルと中身も見られる。
import { useEffect, useState, type ReactNode } from "react";
import { type AgentInfo, type AgentProfile, DEFAULT_TEAM, type Team, teamOfProfile } from "../shared/types";
import { Avatar } from "./ui";

export type ManagedAgent = AgentProfile & { hidden?: boolean };

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
  const take = async (r: Response) => {
    const b = (await r.json().catch(() => ({}))) as { agents?: ManagedAgent[]; error?: string };
    if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
    if (b.agents) setAgents(b.agents);
    setError(null);
  };
  const fail = (e: unknown) => setError(String(e instanceof Error ? e.message : e));
  const [teams, setTeams] = useState<Team[]>([]);
  const loadTeams = () => fetch("/api/teams").then((r) => r.json()).then((b: { teams: Team[]; agents: ManagedAgent[] }) => {
    setTeams(b.teams);
    if (b.agents.length) setAgents(b.agents);
  }).catch(fail);
  useEffect(() => {
    fetch("/api/agents-settings").then(take).catch(fail);
    void loadTeams();
  }, []);
  const patch = (id: string, body: Record<string, unknown>) =>
    fetch(`/api/agents-settings/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(take).catch(fail);
  const upload = (id: string, f: File | undefined) => {
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    void fetch(`/api/agents-settings/${id}/avatar`, { method: "POST", body: fd }).then(take).catch(fail);
  };
  return { agents, error, patch, upload, teams, loadTeams };
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

/** プロフィールの編集: 顔・名前・役割・色・隠す */
export function ProfileEditor({ a, patch, upload, teams }: { teams: Team[]; a: ManagedAgent; patch: (id: string, body: Record<string, unknown>) => Promise<unknown>; upload: (id: string, f: File | undefined) => void }) {
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

/** チームの設定: 名前・色・レポートの出し方・任せ先に出すか。最初のチームは消せない */
export function TeamsEditor({ teams, onChange }: { teams: Team[]; onChange: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const call = async (url: string, method: string, body?: unknown) => {
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const b = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) setError(b.error ?? `HTTP ${r.status}`);
    else setError(null);
    onChange();
    return r.ok;
  };
  const patch = (t: Team, body: Partial<Team>) => call(`/api/teams/${t.id}`, "PATCH", body);
  const add = async () => {
    if (name.trim() && (await call("/api/teams", "POST", { name: name.trim() }))) setName("");
  };
  return (
    <section aria-label="チーム" className="flex flex-col gap-2 rounded-2xl border border-line bg-panel p-3 text-[13px] lg:col-span-2">
      <div className="text-[12px] font-semibold text-mute">チーム</div>
      {error && <div className="text-[12px] text-orange-ink" role="alert">{error}</div>}
      {teams.map((t) => (
        <div key={t.id} className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
          <input type="color" defaultValue={t.color} onBlur={(e) => e.target.value !== t.color && void patch(t, { color: e.target.value })} aria-label={`${t.name}の色`} className="size-8 flex-none cursor-pointer rounded-lg border border-line-2 bg-transparent p-0.5" />
          <input key={`n:${t.name}`} defaultValue={t.name} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== t.name && void patch(t, { name: e.target.value })} aria-label={`${t.name}の名前`} className="min-h-9 min-w-0 flex-1 basis-24 rounded-lg bg-transparent px-1.5 font-bold outline-none hover:bg-chip focus:bg-chip" />
          <select value={t.cadence} onChange={(e) => void patch(t, { cadence: e.target.value as Team["cadence"] })} aria-label={`${t.name}の報告の出し方`} className="min-h-9 flex-none rounded-lg border border-line-2 bg-transparent px-1.5 text-[12px]">
            <option value="daily">毎日の報告</option>
            <option value="weekly">週の報告</option>
          </select>
          <label className="flex min-h-9 flex-none items-center gap-1.5 text-[12px] text-ink-2">
            <input type="checkbox" checked={t.delegable} onChange={(e) => void patch(t, { delegable: e.target.checked })} />
            任せ先に出す
          </label>
          <label className="flex min-h-9 flex-none items-center gap-1.5 text-[12px] text-ink-2">
            <input type="checkbox" checked={t.viaHub} onChange={(e) => void patch(t, { viaHub: e.target.checked })} />
            ハブの下
          </label>
          {t.id !== DEFAULT_TEAM && (
            <button onClick={() => confirm(`「${t.name}」を消しますか？（メンバーは最初のチームに移ります）`) && void call(`/api/teams/${t.id}`, "DELETE")} aria-label={`${t.name}を消す`} className="flex size-9 flex-none items-center justify-center rounded-full text-mute hover:text-red-ink">
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          )}
        </div>
      ))}
      <label className="flex h-10 items-center gap-2 rounded-xl border border-dashed border-line-2 px-3 text-mute">
        <span aria-hidden="true">＋</span>
        <span className="sr-only">チームを足す</span>
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void add()} placeholder="チームを足す（Enter）" className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-mute" />
      </label>
    </section>
  );
}
