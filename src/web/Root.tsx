// root 作業の承認（plasmod-rootd）。依頼の中身を全文見て、パスワードを入れたときだけ root が実行する。
// パスワードはこの端末のメモリに一瞬あるだけ（保存しない・URL にもログにも出さない）。照合は root 側。
import { useEffect, useRef, useState } from "react";
import { Page, ago } from "./ui";
import { Revealed, RevealNote } from "./reveal";

interface Summary {
  id: string;
  title: string;
  status: string;
  requester?: string;
  created_at: number;
  expires_at: number;
  digest: string;
}
interface Detail extends Summary {
  reason: string;
  timeout: number;
  script: string;
  script_sha256: string;
  files: { name: string; size: number; sha256: string; preview: string | null; preview_truncated: boolean }[];
  exit_code?: number;
  duration?: number;
  error?: string;
  stdout?: string;
  stderr?: string;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
}
interface LockInfo {
  failures: number;
  locked_until: number;
  max_failures: number;
}

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "承認待ち", cls: "bg-yellow-soft text-yellow-ink" },
  approved: { label: "実行待ち", cls: "bg-blue-soft text-blue" },
  running: { label: "実行中", cls: "bg-blue-soft text-blue" },
  done: { label: "完了", cls: "bg-lime-soft text-lime-ink" },
  failed: { label: "失敗", cls: "bg-red-soft text-red-ink" },
  timeout: { label: "タイムアウト", cls: "bg-red-soft text-red-ink" },
  rejected: { label: "却下", cls: "bg-line text-ink-2" },
  expired: { label: "失効", cls: "bg-line text-ink-2" },
  interrupted: { label: "中断", cls: "bg-red-soft text-red-ink" },
};
const LIVE = new Set(["pending", "approved", "running"]);

// 部品の依頼（plasmod-rootd がスクリプトを組み立てたもの）。題は「部品 名前: …」、下見と記録は添付
const isAction = (title: string) => title.startsWith("部品 ");
const ActionBadge = () => <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-bold text-ink-2">部品</span>;
const ACTION_FILES = new Set(["preview.txt", "action.json"]);

const Badge = ({ s }: { s: string }) => (
  <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${(STATUS[s] ?? STATUS.expired).cls}`}>{(STATUS[s] ?? { label: s }).label}</span>
);

async function json<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const r = await fetch(url, init);
  return { status: r.status, body: (await r.json().catch(() => ({}))) as T };
}

/** オーナーが自分でコマンドを打つ。root で実行するので毎回パスワード。エージェントはここを使えない */
function RunBox() {
  const [command, setCommand] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { status, body } = await json<{ ok?: boolean; error?: string; id?: string }>("/api/root/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, password: secret }),
      });
      if (status !== 200 || !body.ok || !body.id) throw new Error(body.error ?? `HTTP ${status}`);
      location.hash = `#/root/${body.id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSecret("");
      setBusy(false);
    }
  };
  return (
    <details className="rounded-xl border border-line px-3.5 py-2.5 text-[13px]">
      <summary className="min-h-7 cursor-pointer font-semibold">コマンドを実行する</summary>
      <form
        className="mt-2 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (command.trim() && secret && !busy) void run();
        }}
      >
        <p className="m-0 text-[11.5px] text-orange-ink">VPS の root で実行する。1回ごとにパスワードが要り、記録に残る。対話型のコマンドは使えない</p>
        <textarea
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          aria-label="実行するコマンド"
          rows={3}
          maxLength={8000}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="systemctl status plasmod"
          className="w-full rounded-lg border border-line-2 bg-transparent p-2.5 font-mono text-[12.5px] outline-none"
        />
        <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} aria-label="パスワード" placeholder="パスワード" className="min-h-10 rounded-lg border border-line-2 bg-transparent px-2.5 outline-none" />
        {error && <div className="text-orange-ink">{error}</div>}
        <button type="submit" disabled={busy || !command.trim() || !secret} className="min-h-10 rounded-full bg-ink font-semibold text-ground disabled:opacity-40">
          {busy ? "実行しています…" : "root で実行する"}
        </button>
      </form>
    </details>
  );
}

function RootList() {
  const [items, setItems] = useState<Summary[] | null>(null);
  const [lock, setLock] = useState<LockInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      json<{ ok?: boolean; error?: string; requests?: Summary[]; lock?: LockInfo }>("/api/root/requests")
        .then(({ body }) => {
          if (!alive) return;
          if (body.requests) {
            setItems(body.requests);
            setLock(body.lock ?? null);
            setError(null);
          } else setError(body.error ?? "読み込めなかった");
        })
        .catch(() => alive && setError("読み込めなかった"));
    void load();
    const t = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const locked = lock && lock.locked_until * 1000 > Date.now();
  return (
    <Page title="root 作業" current="#/settings" right={<a href="#/settings" className="text-[13px] text-mute">戻る</a>}>
      <div className="flex flex-col gap-3 px-4 pb-6 pt-2">
        <p className="m-0 text-xs text-mute">エージェントが頼んだ root の作業です。中身を全部読んで、パスワードを入れたときだけ実行されます。</p>
        <RunBox />
        {locked && <div className="rounded-xl border border-red-line bg-red-soft p-3 text-[13px] text-red-ink">パスワードを間違えすぎたため、{new Date(lock!.locked_until * 1000).toLocaleTimeString("ja-JP")} までロック中</div>}
        {error && <div className="text-[13px] text-red-ink">{error}</div>}
        {items?.length === 0 && <div className="text-[13px] text-mute">依頼はまだありません</div>}
        {items?.map((r) => (
          <a key={r.id} href={`#/root/${r.id}`} className="flex flex-col gap-1.5 rounded-xl border border-line bg-panel p-3 no-underline">
            <div className="flex items-center gap-2">
              <Badge s={r.status} />
              {isAction(r.title) && <ActionBadge />}
              <span className="text-[11px] text-mute">{r.requester} · {ago(r.created_at * 1000)}</span>
            </div>
            <div className="whitespace-pre-wrap break-all text-sm font-bold text-ink"><Revealed text={r.title} /></div>
          </a>
        ))}
      </div>
    </Page>
  );
}

function Out({ label, text, truncated }: { label: string; text?: string; truncated?: boolean }) {
  if (!text) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] text-mute">{label}{truncated ? "（長いので途中まで）" : ""}</div>
      <pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-chip p-2.5 font-mono text-[11.5px]"><Revealed text={text} /></pre>
    </div>
  );
}

function RootDetail({ id }: { id: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const alive = useRef(true);

  const load = () =>
    json<Detail & { ok?: boolean; error?: string }>(`/api/root/requests/${id}`)
      .then(({ body }) => {
        if (!alive.current) return;
        if (body.ok === false || !body.script) setError(body.error ?? "読み込めなかった");
        else {
          setD(body);
          setError(null);
        }
      })
      .catch(() => alive.current && setError("読み込めなかった"));

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [id]);
  // 実行中は結果が出るまで見に行く
  useEffect(() => {
    if (!d || !LIVE.has(d.status)) return;
    const t = setInterval(load, d.status === "pending" ? 8000 : 2000);
    return () => clearInterval(t);
  }, [d?.status]);

  const approve = async () => {
    if (!d || !pw) return;
    setBusy(true);
    setMsg(null);
    const secret = pw;
    setPw(""); // 送ったらすぐ消す
    try {
      const { status, body } = await json<{ ok?: boolean; error?: string }>(`/api/root/requests/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ digest: d.digest, password: secret }),
      });
      if (body.ok) setMsg({ ok: true, text: "承認した。実行しています" });
      else setMsg({ ok: false, text: body.error ?? `HTTP ${status}` });
      void load();
    } catch {
      setMsg({ ok: false, text: "送れなかった" });
    } finally {
      setBusy(false);
    }
  };
  const undo = async () => {
    if (!d || !pw) return;
    setBusy(true);
    setMsg(null);
    const secret = pw;
    setPw("");
    try {
      const { status, body } = await json<{ ok?: boolean; error?: string; id?: string }>(`/api/root/requests/${id}/undo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: secret }),
      });
      if (body.ok && body.id) location.hash = `#/root/${body.id}`;
      else setMsg({ ok: false, text: body.error ?? `HTTP ${status}` });
    } catch {
      setMsg({ ok: false, text: "送れなかった" });
    } finally {
      setBusy(false);
    }
  };
  const reject = async () => {
    if (!confirm("この依頼を却下しますか？")) return;
    const { body } = await json<{ ok?: boolean; error?: string }>(`/api/root/requests/${id}/reject`, { method: "POST" });
    if (!body.ok) setMsg({ ok: false, text: body.error ?? "却下できなかった" });
    void load();
  };

  const preview = d?.files.find((f) => f.name === "preview.txt")?.preview;
  const action = d && isAction(d.title) && d.files.some((f) => f.name === "action.json") && typeof preview === "string" ? { preview } : null;
  const files = d ? (action ? d.files.filter((f) => !ACTION_FILES.has(f.name)) : d.files) : [];

  return (
    <Page title="root 作業" current="#/settings" right={<a href="#/root" className="text-[13px] text-mute">一覧</a>}>
      <div className="flex flex-col gap-3 px-4 pb-8 pt-2">
        {error && <div className="text-[13px] text-red-ink">{error}</div>}
        {d && (
          <>
            <div className="flex items-center gap-2">
              <Badge s={d.status} />
              {action && <ActionBadge />}
              <span className="text-[11px] text-mute">{d.requester} · {ago(d.created_at * 1000)} · {new Date(d.expires_at * 1000).toLocaleString("ja-JP")} に失効</span>
            </div>
            <h2 className="m-0 whitespace-pre-wrap break-all text-base font-bold"><Revealed text={d.title} /></h2>
            {d.reason && (
              <>
                <p className="m-0 whitespace-pre-wrap break-all text-[13px] text-ink-2"><Revealed text={d.reason} /></p>
                <RevealNote text={d.reason} />
              </>
            )}

            {action && (
              <div>
                <div className="mb-1 text-[11px] text-mute">変わること（plasmod-rootd が今の状態から作った下見。この内容も承認の指紋に入っている）</div>
                <pre className="m-0 max-h-[26rem] overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line-2 bg-panel p-2.5 font-mono text-[12.5px]"><Revealed text={action.preview} /></pre>
              </div>
            )}
            {action ? (
              <details className="rounded-lg border border-line bg-panel p-2.5">
                <summary className="cursor-pointer text-[13px]">組み立てられたスクリプト（控え → 変更 → 差分 → 確かめ。bash / root / タイムアウト {d.timeout} 秒）</summary>
                <pre className="mb-0 mt-2 max-h-[26rem] overflow-auto whitespace-pre-wrap break-all font-mono text-[11.5px]"><Revealed text={d.script} /></pre>
                <div className="mt-1"><RevealNote text={d.script} /></div>
              </details>
            ) : (
              <div>
                <div className="mb-1 text-[11px] text-mute">実行されるスクリプトの全文（bash / root / タイムアウト {d.timeout} 秒）</div>
                <pre className="m-0 max-h-[26rem] overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-panel p-2.5 font-mono text-[11.5px]"><Revealed text={d.script} /></pre>
                <div className="mt-1"><RevealNote text={d.script} /></div>
              </div>
            )}
            {files.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="text-[11px] text-mute">添付（実行時は $PLASMOD_ROOTD_FILES に置かれる）</div>
                {files.map((f) => (
                  <details key={f.name} className="rounded-lg border border-line bg-panel p-2.5">
                    <summary className="cursor-pointer break-all text-[13px]"><Revealed text={f.name} /> <span className="text-mute">{f.size.toLocaleString()} bytes</span></summary>
                    <div className="mt-1 break-all font-mono text-[10.5px] text-mute">sha256 {f.sha256}</div>
                    {f.preview !== null ? (
                      <>
                        <RevealNote text={f.name + f.preview} />
                        <pre className="mb-0 mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono text-[11.5px]"><Revealed text={f.preview} />{f.preview_truncated ? "\n…（以降は省略）" : ""}</pre>
                      </>
                    ) : (
                      <div className="mt-2 text-[11px] text-mute">バイナリのため中身は表示しない</div>
                    )}
                  </details>
                ))}
              </div>
            )}
            <div className="break-all font-mono text-[10.5px] text-mute">承認する内容の指紋（SHA-256）{d.digest}</div>

            {d.status === "pending" && (
              <form
                className="flex flex-col gap-2 rounded-xl border border-line-2 bg-panel p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void approve();
                }}
              >
                <label className="text-[13px] font-bold" htmlFor="rootpw">パスワードを入れて承認すると、上の内容がそのまま root で実行されます</label>
                <input
                  id="rootpw"
                  type="password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  className="rounded-lg border border-line-2 bg-ground px-3 py-2 text-[15px]"
                  placeholder="パスワード"
                />
                <div className="flex gap-2">
                  <button type="submit" disabled={busy || !pw} className="flex-1 rounded-lg bg-ink px-3 py-2.5 text-sm font-bold text-paper disabled:opacity-40">承認して実行</button>
                  <button type="button" onClick={() => void reject()} disabled={busy} className="rounded-lg border border-line-2 px-4 py-2.5 text-sm">却下</button>
                </div>
              </form>
            )}
            {msg && <div className={`text-[13px] ${msg.ok ? "text-lime-ink" : "text-red-ink"}`}>{msg.text}</div>}

            {!LIVE.has(d.status) && d.status !== "rejected" && d.status !== "expired" && (
              <div className="flex flex-col gap-2">
                <div className="text-[13px]">終了コード {d.exit_code ?? "—"}{d.duration !== undefined ? ` · ${d.duration} 秒` : ""}</div>
                {d.error && <div className="text-[13px] text-red-ink">{d.error}</div>}
                <Out label="標準出力" text={d.stdout} truncated={d.stdout_truncated} />
                <Out label="標準エラー" text={d.stderr} truncated={d.stderr_truncated} />
              </div>
            )}

            {action && d.status === "done" && (
              <div className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-3">
                {!undoOpen ? (
                  <button type="button" onClick={() => setUndoOpen(true)} className="self-start rounded-lg border border-line-2 px-4 py-2 text-sm">元に戻す</button>
                ) : (
                  <form
                    className="flex flex-col gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void undo();
                    }}
                  >
                    <label className="text-[13px] font-bold" htmlFor="undopw">実行の前に取った控えに戻します。戻す前にも控えを取るので、あとで戻し直せます</label>
                    <input
                      id="undopw"
                      type="password"
                      value={pw}
                      onChange={(e) => setPw(e.target.value)}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      className="rounded-lg border border-line-2 bg-ground px-3 py-2 text-[15px]"
                      placeholder="パスワード"
                    />
                    <div className="flex gap-2">
                      <button type="submit" disabled={busy || !pw} className="flex-1 rounded-lg bg-ink px-3 py-2.5 text-sm font-bold text-paper disabled:opacity-40">元に戻す</button>
                      <button type="button" onClick={() => setUndoOpen(false)} disabled={busy} className="rounded-lg border border-line-2 px-4 py-2.5 text-sm">やめる</button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Page>
  );
}

export function Root({ id }: { id: string | null }) {
  return id ? <RootDetail id={id} /> : <RootList />;
}
