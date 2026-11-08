// 許可リスト: アプリを開けるログインと、エージェントが切り替えられるモデル。書き換えは root の作業（毎回パスワード）
import { useEffect, useState } from "react";
import type { AgentProfile } from "../shared/types";
import { profileOf } from "./ui";

type Choice = { provider: string; model: string; label?: string; note?: string };
type Cur = { provider: string | null; model: string | null };
interface Data {
  logins: string[];
  me: string;
  rootd: boolean;
  models: Record<string, Choice[]>;
  current: Record<string, Cur>;
  error?: string;
}

const field = "min-h-9 min-w-0 rounded-lg border border-line-2 bg-transparent px-2.5 text-[12.5px] outline-none";

/** パスワードを聞いて root で書き換える。結果は root 作業の記録（#/root/ID）で見る */
function SaveBar({ kind, payload, dirty, onReset }: { kind: "logins" | "models"; payload: unknown; dirty: boolean; onReset: () => void }) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!dirty) return null;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/root/allowlist/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [kind]: payload, password: secret }),
      });
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; id?: string };
      if (!r.ok || !b.ok || !b.id) throw new Error(b.error ?? `HTTP ${r.status}`);
      location.hash = `#/root/${b.id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSecret("");
      setBusy(false);
    }
  };
  return (
    <form
      className="mt-3 flex flex-col gap-2 border-t border-line pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (secret && !busy) void save();
      }}
    >
      <p className="m-0 text-[11.5px] text-orange-ink">
        {kind === "logins" ? "root で /etc/plasmod/env を書き換え、数秒後にアプリを再起動する" : "root で /etc/plasmod-models.json を書き換える（再起動は要らない）"}
      </p>
      <div className="flex gap-2">
        <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} aria-label="パスワード" placeholder="パスワード" className={`${field} min-h-10 flex-1`} />
        <button type="button" onClick={onReset} className="min-h-10 rounded-full border border-line-2 px-3.5 text-[12.5px] text-mute">
          戻す
        </button>
        <button type="submit" disabled={busy || !secret} className="min-h-10 rounded-full bg-ink px-4 text-[12.5px] font-semibold text-ground disabled:opacity-40">
          {busy ? "保存しています…" : "保存"}
        </button>
      </div>
      {error && <div className="text-[12px] text-orange-ink">{error}</div>}
    </form>
  );
}

function X({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className="grid size-8 shrink-0 place-items-center rounded-full text-mute active:bg-chip">
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </button>
  );
}

function Logins({ initial, me }: { initial: string[]; me: string }) {
  const [list, setList] = useState(initial);
  const [add, setAdd] = useState("");
  const dirty = list.join(",") !== initial.join(",");
  const push = () => {
    const v = add.trim();
    if (v && !list.includes(v)) setList([...list, v]);
    setAdd("");
  };
  return (
    <div className="mx-4 mt-2 rounded-xl border border-line bg-panel px-3.5 py-3 text-[13px]">
      <div className="font-semibold">アプリを開けるログイン</div>
      <div className="mb-2 text-[11px] text-mute">Tailscale のログイン名（例 name@github）。ここに無い人は、tailnet に入っていても開けない</div>
      <ul className="m-0 flex list-none flex-col p-0">
        {list.map((l) => (
          <li key={l} className="flex min-h-9 items-center gap-2 border-b border-line last:border-b-0">
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{l}</span>
            {l === me ? <span className="text-[11px] text-mute">あなた</span> : <X onClick={() => setList(list.filter((x) => x !== l))} label={`${l} を外す`} />}
          </li>
        ))}
      </ul>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          push();
        }}
      >
        <input value={add} onChange={(e) => setAdd(e.target.value)} placeholder="name@github" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="加えるログイン" className={`${field} flex-1 font-mono`} />
        <button type="submit" disabled={!add.trim()} className="min-h-9 rounded-full border border-line-2 px-3.5 text-[12.5px] disabled:opacity-40">
          加える
        </button>
      </form>
      <SaveBar kind="logins" payload={list} dirty={dirty} onReset={() => setList(initial)} />
    </div>
  );
}

function Models({ initial, current, agents }: { initial: Record<string, Choice[]>; current: Record<string, Cur>; agents: AgentProfile[] }) {
  const [m, setM] = useState(initial);
  const dirty = JSON.stringify(m) !== JSON.stringify(initial);
  const profiles = Object.keys(m);
  const set = (p: string, i: number, k: keyof Choice, v: string) => setM({ ...m, [p]: m[p].map((c, j) => (j === i ? { ...c, [k]: v } : c)) });
  const changed = Object.fromEntries(profiles.filter((p) => JSON.stringify(m[p]) !== JSON.stringify(initial[p])).map((p) => [p, m[p].map(({ label, ...c }) => ({ ...c, ...(label?.trim() ? { label: label.trim() } : {}) }))]));
  return (
    <div className="mx-4 mt-3 rounded-xl border border-line bg-panel px-3.5 py-3 text-[13px]">
      <div className="font-semibold">切り替えられるモデル</div>
      <div className="mb-1 text-[11px] text-mute">エージェントの設定の「モデル」で選べるもの。プロバイダーとモデル名は Hermes の設定と同じ書き方</div>
      {!profiles.length && <div className="py-2 text-[12px] text-mute">エージェント（Hermes のプロファイル）が見つからない</div>}
      {profiles.map((p) => {
        const cur = current[p];
        const has = !!cur?.model && m[p].some((c) => c.model === cur.model && c.provider === (cur.provider ?? ""));
        return (
          <div key={p} className="border-b border-line py-2.5 last:border-b-0">
            <div className="flex items-baseline gap-2">
              <span className="font-semibold">{profileOf(agents, p).name}</span>
              <span className="min-w-0 truncate text-[11px] text-mute">いま: {cur?.model ? `${cur.provider ?? "?"} · ${cur.model}` : "不明"}</span>
            </div>
            {m[p].map((c, i) => (
              <div key={i} className="mt-1.5 grid grid-cols-[5.5rem_1fr_auto] items-center gap-1.5">
                <input value={c.provider} onChange={(e) => set(p, i, "provider", e.target.value)} placeholder="provider" aria-label="プロバイダー" autoCapitalize="off" spellCheck={false} className={`${field} font-mono`} />
                <input value={c.model} onChange={(e) => set(p, i, "model", e.target.value)} placeholder="model" aria-label="モデル" autoCapitalize="off" spellCheck={false} className={`${field} font-mono`} />
                <X onClick={() => setM({ ...m, [p]: m[p].filter((_, j) => j !== i) })} label="外す" />
                <input value={c.label ?? ""} onChange={(e) => set(p, i, "label", e.target.value)} placeholder="表示名（任意）" aria-label="表示名" className={`${field} col-span-2`} />
              </div>
            ))}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button type="button" onClick={() => setM({ ...m, [p]: [...m[p], { provider: "", model: "" }] })} className="min-h-8 rounded-full border border-line-2 px-3 text-[12px]">
                ＋ 行を足す
              </button>
              {cur?.model && cur.provider && !has && (
                <button type="button" onClick={() => setM({ ...m, [p]: [...m[p], { provider: cur.provider!, model: cur.model! }] })} className="min-h-8 rounded-full border border-line-2 px-3 text-[12px] text-mute">
                  ＋ いまのモデルを加える
                </button>
              )}
            </div>
          </div>
        );
      })}
      <SaveBar kind="models" payload={changed} dirty={dirty} onReset={() => setM(initial)} />
    </div>
  );
}

/** マージ用のトークン。値は送ったら画面にも記録にも残さない（あるかどうかだけ見せる） */
function MergeToken() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    fetch("/api/dev/merge").then((r) => r.json()).then((d: { enabled?: boolean }) => setEnabled(!!d.enabled)).catch(() => {});
  }, []);
  const save = async (clear: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/root/merge-token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: clear ? "" : token, password: secret }) });
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; exit_code?: number };
      if (!r.ok || !b.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
      setToken("");
      setMsg({ ok: true, text: clear ? "消した。数秒後にアプリが再起動する" : "入れた。数秒後にアプリが再起動する" });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSecret("");
      setBusy(false);
    }
  };
  return (
    <div className="mx-4 mt-3 rounded-xl border border-line bg-panel px-3.5 py-3 text-[13px]">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">マージ用のトークン</span>
        <span className={`text-[11px] ${enabled ? "text-lime-ink" : "text-mute"}`}>{enabled === null ? "" : enabled ? "設定済み" : "未設定"}</span>
      </div>
      <div className="mb-2 text-[11px] text-mute">エージェントが頼んだマージを、承認カードで許可するとアプリがマージする。GitHub の fine-grained token（Contents・Pull requests を Read and write、Checks・Commit statuses を Read）。値は保存後に表示しない</div>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim() && secret && !busy) void save(false);
        }}
      >
        <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" aria-label="トークン" spellCheck={false} className={`${field} min-h-10 font-mono`} />
        <div className="flex gap-2">
          <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} aria-label="パスワード" placeholder="root のパスワード" className={`${field} min-h-10 flex-1`} />
          <button type="submit" disabled={busy || !token.trim() || !secret} className="min-h-10 rounded-full bg-ink px-4 text-[12.5px] font-semibold text-ground disabled:opacity-40">
            {busy ? "…" : "入れる"}
          </button>
          {enabled && (
            <button type="button" disabled={busy || !secret} onClick={() => void save(true)} className="min-h-10 rounded-full border border-line-2 px-3 text-[12.5px] text-mute disabled:opacity-40">
              消す
            </button>
          )}
        </div>
      </form>
      {msg && <div className={`mt-2 text-[12px] ${msg.ok ? "text-lime-ink" : "text-orange-ink"}`}>{msg.text}</div>}
    </div>
  );
}

export function Allowlists({ agents }: { agents: AgentProfile[] }) {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/root/allowlists")
      .then(async (r) => {
        if (r.status === 403) throw new Error("Tailscale の入口から開いたときだけ見られる");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setD((await r.json()) as Data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  if (error) return <div className="mx-5 mt-2 text-[12px] text-mute">{error}</div>;
  if (!d) return <div className="mx-5 mt-2 text-[12px] text-mute">読み込んでいます…</div>;
  return (
    <>
      {!d.rootd && <div className="mx-5 mt-2 text-[12px] text-orange-ink">plasmod-rootd が使えないので、見るだけ（変えるには setup.sh の root 作業の部品が要る）</div>}
      <Logins initial={d.logins} me={d.me} />
      {d.error ? <div className="mx-5 mt-3 text-[12px] text-orange-ink">モデル: {d.error}</div> : <Models initial={d.models} current={d.current} agents={agents} />}
      {d.rootd && <MergeToken />}
    </>
  );
}
