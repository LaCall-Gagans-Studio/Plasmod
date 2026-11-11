// 設定の「接続」: Nous・MCP・Claude の状況と、状態が変わった記録。
// Nous はここからログインし直す（毎回 root のパスワード）。MCP のログインと追加は Hermes のダッシュボードで行う
import { ing } from "./dots";
import { useCallback, useEffect, useState } from "react";
import type { Connection, ConnectionState, ConnectionsView } from "../shared/types";
import { fetchRetry } from "./api";
import { ago } from "./ui";

const STATE: Record<ConnectionState, { label: string; text: string; dot: string }> = {
  ok: { label: "正常", text: "text-mute", dot: "var(--color-lime)" },
  soon: { label: "もうすぐ切れる", text: "text-orange-ink", dot: "var(--color-ring-orange)" },
  needs: { label: "つなぎ直しが必要", text: "text-red-ink", dot: "var(--color-red-ink)" },
  off: { label: "無効", text: "text-mute", dot: "var(--color-line-2)" },
  unknown: { label: "要確認", text: "text-orange-ink", dot: "var(--color-ring-orange)" },
};

/** 状態の丸。問題があるものは脈を打つ */
function Dot({ state, size = 9 }: { state: ConnectionState; size?: number }) {
  const bad = state === "needs" || state === "soon" || state === "unknown";
  return (
    <span className={`flex-none rounded-full ${bad ? "gh-pulse" : ""}`} style={{ width: size, height: size, background: STATE[state].dot, boxShadow: state === "off" ? undefined : `0 0 ${size}px ${STATE[state].dot}` }} aria-hidden="true" />
  );
}
const ORDER: ConnectionState[] = ["needs", "soon", "unknown", "ok", "off"];

const dateTime = (ms: number) =>
  new Date(ms).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

type Login = { url: string; code: string | null };

async function post(action: "reconnect" | "toggle", body: object): Promise<string> {
  const r = await fetch(`/api/root/connections/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const b = (await r.json().catch(() => ({}))) as { error?: string; id?: string };
  if (!r.ok || !b.id) throw new Error(b.error ?? `HTTP ${r.status}`);
  return b.id;
}

/** root の依頼が終わるのを待ち、出力を返す */
async function finished(id: string): Promise<{ status: string; stdout: string }> {
  for (let i = 0; i < 90; i++) {
    const r = await fetch(`/api/root/requests/${id}`);
    const b = (await r.json().catch(() => ({}))) as { status?: string; stdout?: string; error?: string };
    if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
    if (b.status && !["pending", "approved", "running"].includes(b.status)) return { status: b.status, stdout: b.stdout ?? "" };
    await new Promise((f) => setTimeout(f, 1000));
  }
  throw new Error("時間内に終わらなかった");
}

/** 出力の PLASMOD_RESULT の行を読む。無ければ失敗 */
export function loginResult(stdout: string): Login {
  const line = stdout.split("\n").find((l) => l.startsWith("PLASMOD_RESULT "));
  if (!line) throw new Error("ログイン先を取得できなかった");
  const r = JSON.parse(line.slice("PLASMOD_RESULT ".length)) as { ok?: boolean; error?: string; url?: string; code?: string | null };
  if (!r.ok || !r.url) throw new Error(r.error ?? "ログイン先を取得できなかった");
  return { url: r.url, code: r.code ?? null };
}

/** Hermes のダッシュボードの住所。Tailscale の入口から開いているときは、同じ機械の 443 番 */
export function dashboardUrl(host: string, profile?: string | null): string | null {
  if (!host.endsWith(".ts.net")) return null;
  return `https://${host}/${profile && profile !== "default" ? `?profile=${encodeURIComponent(profile)}` : ""}`;
}

function Manage({ c, onChanged }: { c: Connection; onChanged: () => void }) {
  const [mode, setMode] = useState<"reconnect" | "toggle" | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState<Login | null>(null);
  const off = c.state === "off";
  const target = { profile: c.profile ?? "default", name: c.name };
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "reconnect") {
        const id = await post("reconnect", { password: secret });
        setLogin(loginResult((await finished(id)).stdout));
      } else {
        const id = await post("toggle", { ...target, enable: off, password: secret });
        const done = await finished(id);
        if (done.status !== "done") throw new Error("切り替えに失敗した");
        setMode(null);
        onChanged();
      }
      setSecret("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const button = "min-h-9 rounded-full bg-chip/70 px-3.5 text-[12.5px] font-medium text-ink disabled:opacity-50";
  if (login) {
    return (
      <div className="mt-2 rounded-xl bg-chip/70 px-3 py-2 text-[12px]">
        {login.code ? (
          <div className="mb-1">
            コード <span className="select-all font-mono text-[14px] font-semibold">{login.code}</span>
          </div>
        ) : null}
        <a href={login.url} target="_blank" rel="noreferrer" className="underline">
          ログインを開く
        </a>
        <div className="mt-1 text-mute">ログインが終わったら「今すぐ確認」を押してください</div>
      </div>
    );
  }
  if (!mode) {
    const dash = dashboardUrl(location.hostname, c.profile);
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!off && c.canLogin && c.kind === "nous" ? (
          <button type="button" className={button} onClick={() => setMode("reconnect")}>
            つなぎ直す
          </button>
        ) : null}
        {!off && c.canLogin && c.kind === "mcp" && dash ? (
          <a href={dash} target="_blank" rel="noreferrer" className={`${button} inline-flex items-center gap-1 text-ink no-underline`}>
            ダッシュボードでつなぎ直す <span aria-hidden="true">↗</span>
          </a>
        ) : null}
        {c.kind === "mcp" ? (
          <button type="button" className={button} onClick={() => setMode("toggle")}>
            {off ? "有効にする" : "無効にする"}
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      <input
        type="password"
        autoComplete="off"
        aria-label="root のパスワード"
        placeholder="root のパスワード"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        className="min-h-9 min-w-0 flex-1 rounded-full bg-chip/70 px-3.5 text-[14px] outline-none focus:bg-chip"
      />
      <button type="submit" disabled={busy || !secret} className={button}>
        {busy ? ing("実行中…") : mode === "reconnect" ? "つなぎ直す" : off ? "有効にする" : "無効にする"}
      </button>
      <button type="button" disabled={busy} className={button} onClick={() => setMode(null)}>
        キャンセル
      </button>
      {error ? <div className="w-full text-[12px] text-red-ink">{error}</div> : null}
    </form>
  );
}

function Row({ c, onChanged }: { c: Connection; onChanged: () => void }) {
  const s = STATE[c.state];
  const facts = [
    c.lastRefreshAt ? `更新 ${ago(c.lastRefreshAt)}` : null,
    // 短い期限（MCP のアクセストークンなど）は見ても意味がないので、Claude だけ出す
    c.kind === "claude" && c.expiresAt ? `期限 ${dateTime(c.expiresAt)}` : null,
  ].filter(Boolean);
  // Claude は段3。期限の前に先回りできるよう、正常な行からもつなぎ直せる
  const manageable = c.kind !== "claude";
  // 正常なものは畳んでおく（押すと開く）。直したいものは最初から開いている
  const [open, setOpen] = useState(false);
  const healthy = c.state === "ok" || c.state === "off";
  const shown = manageable && (open || !healthy);
  return (
    <li className="px-3.5 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-line">
      <div
        className={`flex min-h-6 items-center gap-3 ${manageable && healthy ? "cursor-pointer" : ""}`}
        onClick={manageable && healthy ? () => setOpen((v) => !v) : undefined}
      >
        <Dot state={c.state} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium">{c.name}</div>
          {c.reason || facts.length ? <div className="mt-0.5 truncate text-[11.5px] text-mute">{[c.reason, ...facts].filter(Boolean).join(" · ")}</div> : null}
        </div>
        <span className={`shrink-0 text-[11.5px] ${s.text}`}>{s.label}</span>
      </div>
      {shown ? <div className="pl-[21px]"><Manage c={c} onChanged={onChanged} /></div> : null}
    </li>
  );
}

const sortBy = (items: Connection[]) => [...items].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.name.localeCompare(b.name));

function Group({ title, items, onChanged, fold }: { title: string; items: Connection[]; onChanged: () => void; fold?: boolean }) {
  const hasBad = items.some((c) => c.state === "needs" || c.state === "soon" || c.state === "unknown");
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const ok = items.filter((c) => c.state === "ok").length;
  const expanded = !fold || open || hasBad;
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel">
      <button type="button" onClick={fold ? () => setOpen((v) => !v) : undefined} aria-expanded={fold ? expanded : undefined} className={`flex min-h-11 w-full items-center gap-2 px-3.5 text-left ${fold ? "" : "cursor-default"}`}>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink-2">{title}</span>
        <span className="flex-none text-[11.5px] tabular-nums text-mute">{ok} / {items.length} 正常</span>
        {fold && (
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true" className={`flex-none text-mute transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}><path d="M9 6l6 6-6 6" /></svg>
        )}
      </button>
      {expanded && (
        <ul className="m-0 list-none border-t border-line p-0">
          {sortBy(items).map((c) => <Row key={c.id} c={c} onChanged={onChanged} />)}
        </ul>
      )}
    </section>
  );
}

export function Connections() {
  const [view, setView] = useState<ConnectionsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (force: boolean) => {
    setBusy(true);
    try {
      const r = await fetchRetry(`/api/system/connections${force ? "?force=1" : ""}`);
      const b = await r.json();
      if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
      setView(b);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load(false);
  }, [load]);

  if (!view) return <div className="px-4 pt-3 text-sm text-mute">{error ?? "接続の状況を読み込み中…"}</div>;
  const bad = view.connections.filter((c) => c.state === "needs" || c.state === "soon" || c.state === "unknown").length;
  const main = view.connections.filter((c) => c.kind !== "mcp");
  const addUrl = dashboardUrl(location.hostname);
  const profiles = [...new Set(view.connections.filter((c) => c.kind === "mcp").map((c) => c.profile ?? ""))];
  const total = view.connections.filter((c) => c.state !== "off").length;
  return (
    <div className="flex flex-col gap-3 px-4 pb-6 pt-2.5">
      <div className="flex items-center gap-3.5 rounded-2xl bg-[#07080A] px-4 py-3.5 text-[#E8E8E2]">
        <span className={`size-3.5 flex-none rounded-full ${bad ? "gh-pulse" : ""}`} style={{ background: bad ? "#FF8A3D" : "#C8F25A", boxShadow: `0 0 16px ${bad ? "#FF8A3D" : "#C8F25A"}` }} aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[17px] font-bold leading-snug">{bad ? `確認したい接続が ${bad} 件` : "すべて正常です"}</span>
          <span className="font-mono text-[11px] opacity-60">{total} 接続 · 確認 {ago(view.at)}</span>
        </div>
        <button type="button" disabled={busy} onClick={() => void load(true)} aria-label="今すぐ確認" className="min-h-9 flex-none rounded-full border border-white/25 px-3 text-[12px] disabled:opacity-50">
          {busy ? ing("確認中…") : "今すぐ確認"}
        </button>
      </div>
      {error ? <div className="rounded-xl bg-orange-soft px-3.5 py-2 text-[12px] text-red-ink">{error}</div> : null}
      {view.errors.map((e) => (
        <div key={e} className="rounded-xl bg-orange-soft px-3.5 py-2 text-[12px] text-orange-ink">
          取得できなかったもの: {e}
        </div>
      ))}
      <Group title="ログイン" items={main} onChanged={() => void load(true)} />
      {profiles.map((p) => (
        <Group key={p} fold title={`MCP · ${p}`} items={view.connections.filter((c) => c.kind === "mcp" && c.profile === p)} onChanged={() => void load(true)} />
      ))}
      {addUrl ? (
        <a href={addUrl} target="_blank" rel="noreferrer" className="flex min-h-11 items-center justify-between gap-3 rounded-2xl border border-dashed border-line-2 px-3.5 py-2.5 text-[13px] text-ink no-underline">
          <span className="flex min-w-0 flex-col">
            <span>MCP を追加する</span>
            <span className="mt-0.5 text-[11.5px] text-mute">Hermes のダッシュボードで追加すると、ここに並びます</span>
          </span>
          <span aria-hidden="true" className="shrink-0 text-mute">↗</span>
        </a>
      ) : null}
      {view.events.length ? (
        <details className="group overflow-hidden rounded-2xl border border-line bg-panel">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3.5 text-[12.5px] font-semibold text-ink-2 [&::-webkit-details-marker]:hidden">
            <span className="flex-1">変化の記録</span>
            <span className="text-[11.5px] font-normal tabular-nums text-mute">{view.events.length}</span>
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true" className="text-mute transition-transform duration-200 group-open:rotate-90"><path d="M9 6l6 6-6 6" /></svg>
          </summary>
          <ul className="m-0 list-none border-t border-line p-0">
            {view.events.map((e) => (
              <li key={e.id} className="flex items-baseline gap-2.5 px-3.5 py-2 text-[12px] [&:not(:last-child)]:border-b [&:not(:last-child)]:border-line">
                <span className="relative top-[1px]"><Dot state={e.toState} size={7} /></span>
                <span className="min-w-0 flex-1">
                  {e.name} <span className="text-mute">→ {STATE[e.toState].label}{e.reason ? ` · ${e.reason}` : ""}</span>
                </span>
                <span className="flex-none font-mono text-[10.5px] text-mute">{dateTime(e.at)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
