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
  // 保存の状況。「保存中」「保存した」「失敗」を編集欄に出す（保存できたのかわからない、を無くす）
  const [save, setSave] = useState<{ state: "idle" | "saving" | "saved" | "error"; text?: string }>({ state: "idle" });
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const done = (state: "saved" | "error", text?: string) => {
    setSave({ state, text });
    if (savedTimer.current) clearTimeout(savedTimer.current);
    if (state === "saved") savedTimer.current = setTimeout(() => setSave({ state: "idle" }), 2500);
  };
  const patch = (id: string, body: Record<string, unknown>) => {
    const at = ++edits.current;
    setSave({ state: "saving" });
    // 返事を待たずに、画面にはすぐ反映する。失敗したらサーバーの値に戻す
    setAgents((cur) => cur && cur.map((a) => (a.id === id ? { ...a, ...Object.fromEntries(Object.entries(body).filter(([k, v]) => ["name", "role", "color", "team", "hidden"].includes(k) && v !== undefined).map(([k, v]) => [k, typeof v === "string" && (k === "name" || k === "role") ? v.trim() : v])) } : a)));
    return fetch(`/api/agents-settings/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => {
        await take(r, at);
        done("saved");
        // 名前は Hermes への反映をサーバーが裏でやる。少しあとに結果（nameSync）を取り直す
        if (body.name !== undefined) setTimeout(() => void fetch("/api/agents-settings").then((x) => take(x, edits.current)).catch(() => {}), 2500);
      })
      .catch((e) => {
        fail(e);
        done("error", String(e instanceof Error ? e.message : e));
        void fetch("/api/agents-settings").then((x) => take(x, edits.current)).catch(() => {});
      });
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
  return { agents, error, patch, upload, teams, loadTeams, scan, rediscover, syncName, save };
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
  const base = "text-[11px] leading-relaxed";
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

/** 色の見本。最後の「好きな色」は自由に選ぶ */
export const SWATCHES = ["#8FB8FF", "#7FD8C6", "#9BD57F", "#F2C98A", "#E8A27C", "#F29CB7", "#C7A6F2", "#E86A5E", "#4A6CF7", "#2B2B30"];

/** 編集欄の見出しとひとかたまり */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-semibold tracking-wide text-mute">{label}</span>
        {hint && <span className="text-[10.5px] text-mute/80">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** プロフィールの編集: 顔・名前・役割・チーム・色・隠す */
export function ProfileEditor({ a, patch, upload, teams, syncName, save }: { save?: { state: "idle" | "saving" | "saved" | "error"; text?: string }; teams: Team[]; a: ManagedAgent; patch: (id: string, body: Record<string, unknown>) => Promise<unknown>; upload: (id: string, f: File | undefined) => void; syncName?: (id: string, force?: boolean) => Promise<unknown> }) {
  const input = "min-h-11 w-full min-w-0 rounded-xl border border-line-2 bg-panel-2 px-3 text-[14px] text-ink outline-none transition-colors placeholder:text-mute/60 focus:border-ink focus:bg-panel";
  const color = /^#[0-9a-f]{6}$/i.test(a.color) ? a.color.toLowerCase() : "#2f6fdb";
  const custom = !SWATCHES.some((c) => c.toLowerCase() === color);
  const team = teamOfProfile(a, teams);
  const commit = (el: HTMLInputElement, cur: string, key: "name" | "role") => {
    const v = el.value.trim();
    if (key === "name" && !v) el.value = cur;
    else if (v !== cur) void patch(a.id, { [key]: v });
  };
  return (
    <div className="flex flex-col gap-4 rounded-xl bg-panel-2 p-3.5">
      <div className="flex items-center gap-3.5">
        <label className="group relative flex-none cursor-pointer" title="顔の画像を変える">
          <Avatar p={a} size={64} />
          <span className="absolute -bottom-0.5 -right-0.5 flex size-6 items-center justify-center rounded-full border border-line-2 bg-panel text-[12px] text-ink-2 shadow-sm group-hover:bg-chip" aria-hidden="true">✎</span>
          <input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`${a.name}の顔の画像`} className="sr-only" onChange={(e) => upload(a.id, e.target.files?.[0])} />
        </label>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[15px] font-bold text-ink">{a.name}</span>
          <span className="text-[11px] text-mute">顔をタップで画像を変える（PNG・JPEG・WebP、2MBまで）</span>
        </div>
      </div>

      <Field label="名前">
        <input key={`n:${a.name}`} defaultValue={a.name} maxLength={40} onBlur={(e) => commit(e.target, a.name, "name")} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} aria-label={`${a.id} の名前`} className={input} />
        {a.runtime !== "claude-code" && syncName && <NameSyncNote a={a} syncName={syncName} />}
      </Field>

      <Field label="役割" hint="カードの上に出る短い肩書き">
        <input key={`r:${a.role ?? ""}`} defaultValue={a.role ?? ""} maxLength={40} placeholder="例: WINGMAN" onBlur={(e) => commit(e.target, a.role ?? "", "role")} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} aria-label={`${a.name}の役割`} className={input} />
      </Field>

      {teams.length > 1 && (
        <Field label="チーム" hint={team.delegable ? "仕事を任せられる" : "仕事の任せ先には出ない"}>
          <div role="radiogroup" aria-label={`${a.name}のチーム`} className="flex flex-wrap gap-1.5">
            {teams.map((t) => {
              const on = t.id === team.id;
              return (
                <button
                  key={t.id}
                  role="radio"
                  aria-checked={on}
                  onClick={() => !on && void patch(a.id, { team: t.id })}
                  className={`flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold transition-colors ${on ? "border-ink bg-ink text-paper" : "border-line-2 bg-panel text-ink-2 hover:bg-chip"}`}
                >
                  <span className="size-2.5 flex-none rounded-full" style={{ background: t.color }} />
                  {t.name}
                </button>
              );
            })}
          </div>
        </Field>
      )}

      <Field label="色" hint="カードとアイコンの色">
        <div role="radiogroup" aria-label={`${a.name}の色`} className="flex flex-wrap items-center gap-2">
          {SWATCHES.map((c) => {
            const on = c.toLowerCase() === color;
            return (
              <button key={c} role="radio" aria-checked={on} aria-label={c} onClick={() => !on && void patch(a.id, { color: c })} className="flex size-8 flex-none items-center justify-center rounded-full transition-transform hover:scale-105" style={{ background: c, boxShadow: on ? `0 0 0 2px var(--color-panel-2), 0 0 0 4px ${c}` : "inset 0 0 0 1px rgba(0,0,0,0.12)" }}>
                {on && <span className="text-[13px] font-black" style={{ color: inkOn(c) }}>✓</span>}
              </button>
            );
          })}
          <label
            className="relative flex size-8 flex-none cursor-pointer items-center justify-center overflow-hidden rounded-full transition-transform hover:scale-105"
            style={{ background: custom ? color : "conic-gradient(#f66, #fc6, #9d6, #6dc, #69f, #c6f, #f66)", boxShadow: custom ? `0 0 0 2px var(--color-panel-2), 0 0 0 4px ${color}` : "inset 0 0 0 1px rgba(0,0,0,0.12)" }}
            title="好きな色"
          >
            {custom ? <span className="text-[13px] font-black" style={{ color: inkOn(color) }}>✓</span> : <span className="text-[15px] font-bold text-white drop-shadow">＋</span>}
            <input type="color" value={color} onChange={(e) => e.target.value.toLowerCase() !== color && void patch(a.id, { color: e.target.value })} aria-label={`${a.name}の好きな色`} className="absolute inset-0 size-full cursor-pointer opacity-0" />
          </label>
        </div>
      </Field>

      <button role="switch" aria-checked={!!a.hidden} onClick={() => void patch(a.id, { hidden: !a.hidden })} className="flex min-h-11 items-center gap-3 border-t border-line pt-3 text-left">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px] text-ink">ベンチに下げる</span>
          <span className="text-[11px] text-mute">チャットやタブから隠す。あとで戻せる</span>
        </span>
        <span className={`relative h-6 w-10 flex-none rounded-full transition-colors ${a.hidden ? "bg-ink" : "bg-line-2"}`}>
          <span className={`absolute top-0.5 size-5 rounded-full bg-paper shadow-sm transition-transform ${a.hidden ? "translate-x-[18px]" : "translate-x-0.5"}`} />
        </span>
      </button>
      {save && save.state !== "idle" && (
        <span role="status" className={`pointer-events-none sticky bottom-3 z-10 self-center rounded-full px-3.5 py-1.5 text-[12px] font-semibold shadow-md ${save.state === "error" ? "bg-red-soft text-red-ink" : save.state === "saved" ? "bg-ink text-paper" : "bg-chip text-ink-2"}`}>
          {save.state === "saving" ? "保存中…" : save.state === "saved" ? "✓ 保存した" : `保存できなかった: ${save.text ?? ""}`}
        </span>
      )}
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
