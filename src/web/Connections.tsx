// 設定の「接続」: Nous・MCP・Claude の状況と、状態が変わった記録。
// Nous はここからログインし直す（毎回 root のパスワード）。MCP のログインと追加は Hermes のダッシュボードで行う
import { useCallback, useEffect, useState } from "react";
import type { Connection, ConnectionState, ConnectionsView } from "../shared/types";
import { ago } from "./ui";

const STATE: Record<ConnectionState, { label: string; tone: string }> = {
  ok: { label: "正常", tone: "bg-lime-soft text-lime-ink" },
  soon: { label: "もうすぐ切れる", tone: "bg-orange-soft text-orange-ink" },
  needs: { label: "つなぎ直しが必要", tone: "bg-red-soft text-red-ink" },
  off: { label: "無効", tone: "bg-chip text-mute" },
  unknown: { label: "要確認", tone: "bg-orange-soft text-orange-ink" },
};
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
  const button = "min-h-9 rounded-lg border border-line px-3 text-[12px] disabled:opacity-50";
  if (login) {
    return (
      <div className="mt-2 rounded-lg bg-chip px-3 py-2 text-[12px]">
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
        className="min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-paper px-2.5 text-[14px]"
      />
      <button type="submit" disabled={busy || !secret} className={button}>
        {busy ? "実行中…" : mode === "reconnect" ? "つなぎ直す" : off ? "有効にする" : "無効にする"}
      </button>
      <button type="button" disabled={busy} className={button} onClick={() => setMode(null)}>
        やめる
      </button>
      {error ? <div className="w-full text-[12px] text-red-ink">{error}</div> : null}
    </form>
  );
}

function Row({ c, onChanged }: { c: Connection; onChanged: () => void }) {
  const s = STATE[c.state];
  const facts = [
    c.lastRefreshAt ? `最後の更新 ${ago(c.lastRefreshAt)}` : null,
    // 短い期限（MCP のアクセストークンなど）は見ても意味がないので、Claude だけ出す
    c.kind === "claude" && c.expiresAt ? `期限 ${dateTime(c.expiresAt)}` : null,
  ].filter(Boolean);
  // Claude は段3。期限の前に先回りできるよう、正常な行からもつなぎ直せる
  const manageable = c.kind !== "claude";
  // 正常なものは畳んでおく（押すと開く）。直したいものは最初から開いている
  const [open, setOpen] = useState(false);
  const shown = manageable && (open || c.state !== "ok");
  return (
    <li className="border-b border-line px-3.5 py-2.5 last:border-b-0">
      <div
        className={`flex min-h-7 items-center gap-3 ${manageable && c.state === "ok" ? "cursor-pointer" : ""}`}
        onClick={manageable && c.state === "ok" ? () => setOpen((v) => !v) : undefined}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px]">{c.name}</div>
          {c.reason || facts.length ? (
            <div className="mt-0.5 text-[11px] text-mute">{[c.reason, ...facts].filter(Boolean).join("・")}</div>
          ) : null}
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${s.tone}`}>{s.label}</span>
      </div>
      {shown ? <Manage c={c} onChanged={onChanged} /> : null}
    </li>
  );
}

function Group({ title, items, onChanged }: { title: string; items: Connection[]; onChanged: () => void }) {
  if (!items.length) return null;
  const sorted = [...items].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.name.localeCompare(b.name));
  return (
    <section>
      <h2 className="m-0 mb-1.5 text-[12px] font-semibold text-mute">{title}</h2>
      <ul className="m-0 list-none overflow-hidden rounded-xl border border-line bg-panel p-0">
        {sorted.map((c) => (
          <Row key={c.id} c={c} onChanged={onChanged} />
        ))}
      </ul>
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
      const r = await fetch(`/api/system/connections${force ? "?force=1" : ""}`);
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
  return (
    <div className="flex flex-col gap-4 px-4 pb-6 pt-2.5">
      <div className={`rounded-xl px-3.5 py-2.5 text-[13px] ${bad ? "bg-orange-soft text-orange-ink" : "bg-lime-soft text-lime-ink"}`}>
        {bad ? `⚠ 確認したい接続 ${bad} 件` : "すべて正常です"}
        <div className="mt-0.5 flex items-center justify-between text-[11px] opacity-80">
          <span>確認 {ago(view.at)}</span>
          <button type="button" disabled={busy} onClick={() => void load(true)} className="min-h-8 rounded-lg px-2 underline disabled:opacity-50">
            {busy ? "確認中…" : "今すぐ確認"}
          </button>
        </div>
      </div>
      {error ? <div className="text-[12px] text-red-ink">{error}</div> : null}
      {view.errors.map((e) => (
        <div key={e} className="rounded-xl bg-orange-soft px-3.5 py-2 text-[12px] text-orange-ink">
          取得できなかったもの: {e}
        </div>
      ))}
      <Group title="ログイン" items={main} onChanged={() => void load(true)} />
      {profiles.map((p) => (
        <Group key={p} title={`MCP（${p}）`} items={view.connections.filter((c) => c.kind === "mcp" && c.profile === p)} onChanged={() => void load(true)} />
      ))}
      {addUrl ? (
        <a href={addUrl} target="_blank" rel="noreferrer" className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-line bg-panel px-3.5 py-2.5 text-[14px] text-ink no-underline">
          <span className="flex min-w-0 flex-col">
            <span>MCP を追加したい場合は</span>
            <span className="mt-0.5 text-[11px] text-mute">Hermes のダッシュボードで追加できます。追加すると、ここに自動で並びます</span>
          </span>
          <span aria-hidden="true" className="shrink-0 text-mute">
            ↗
          </span>
        </a>
      ) : null}
      {view.events.length ? (
        <section>
          <h2 className="m-0 mb-1.5 text-[12px] font-semibold text-mute">変化の記録</h2>
          <ul className="m-0 list-none overflow-hidden rounded-xl border border-line bg-panel p-0">
            {view.events.map((e) => (
              <li key={e.id} className="border-b border-line px-3.5 py-2 text-[12px] last:border-b-0">
                <span>{e.name}</span>
                <span className="text-mute">
                  {" "}
                  → {STATE[e.toState].label}・{dateTime(e.at)}
                  {e.reason ? `・${e.reason}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
