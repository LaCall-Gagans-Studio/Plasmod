// 設定のエージェント: サッカーの選手紹介のようなカード。開くと名前・顔・役割・色を変えられて、モデルと中身も見られる。
import { useEffect, useState, type ReactNode } from "react";
import type { AgentInfo, AgentProfile } from "../shared/types";
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
  useEffect(() => {
    fetch("/api/agents-settings").then(take).catch(fail);
  }, []);
  const patch = (id: string, body: Record<string, unknown>) =>
    fetch(`/api/agents-settings/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(take).catch(fail);
  const upload = (id: string, f: File | undefined) => {
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    void fetch(`/api/agents-settings/${id}/avatar`, { method: "POST", body: fd }).then(take).catch(fail);
  };
  return { agents, error, patch, upload };
}

/** 選手カードの表の面 */
export function PlayerCard({ a, info, no, open, onToggle }: { a: ManagedAgent; info: AgentInfo | undefined; no: number; open: boolean; onToggle: () => void }) {
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
          <span className="truncate text-[11px] font-bold uppercase tracking-[0.14em] opacity-80">{a.role || (a.team === "watch" ? "WATCH" : "SQUAD")}</span>
          <span className="truncate text-[28px] font-black italic leading-none tracking-tight">{a.name}</span>
          <span className="text-[11.5px] font-semibold opacity-80">{a.hidden ? "ベンチ（隠している）" : a.team === "watch" ? "監察チーム" : "実働チーム"}</span>
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
export function ProfileEditor({ a, patch, upload }: { a: ManagedAgent; patch: (id: string, body: Record<string, unknown>) => Promise<unknown>; upload: (id: string, f: File | undefined) => void }) {
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
