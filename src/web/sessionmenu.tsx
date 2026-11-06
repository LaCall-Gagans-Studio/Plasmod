// セッションを長押し（PC は右クリック）したときに下から出るメニュー: 開く・ピン留め・題名を変える・題名のコピー・削除。
// 題名の変更と削除はアプリの中だけ（Hermes の題名・記録はそのまま）。App に1つだけ置き、どの一覧からでも openSessionMenu で開く。
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type AgentProfile, capsOfAgent, type SessionInfo } from "../shared/types";
import { ConfirmDelete, DangerButton, Sheet, SheetCard, TileButton, TileLink, Tiles } from "./sheet";
import { haptic, useLongPress, writeClipboard } from "./touch";
import { Avatar, ago } from "./ui";

type Open = { s: SessionInfo; who?: AgentProfile; onChanged?: () => void } | null;
let current: Open = null;
const listeners = new Set<() => void>();
export function openSessionMenu(s: SessionInfo, onChanged?: () => void, who?: AgentProfile) {
  current = { s, who, onChanged };
  for (const fn of listeners) fn();
}
const close = () => {
  current = null;
  for (const fn of listeners) fn();
};
const useMenu = () =>
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => current,
  );

/** 一覧の1行。押すと onPick、長押し・右クリックでメニュー */
export function SessionRow({ s, who, onPick, onChanged, className, children, ...rest }: { s: SessionInfo; who?: AgentProfile; onPick: () => void; onChanged?: () => void; className: string; children: ReactNode } & React.AriaAttributes & { role?: string }) {
  const lp = useLongPress(() => openSessionMenu(s, onChanged, who));
  return (
    <button {...rest} {...lp} onClick={onPick} className={`select-none [-webkit-touch-callout:none] ${className}`}>
      {children}
    </button>
  );
}

/** ピンの印（一覧の題名の前に付ける） */
export function PinMark() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="currentColor" className="mr-1 inline-block flex-none align-[-1px] text-ink-2" aria-label="ピン留め">
      <path d="M15 3l6 6-3 1-4 4 1 5-2 2-4.5-4.5L4 22l-2-2 5.5-4.5L3 11l2-2 5 1 4-4z" />
    </svg>
  );
}

export function SessionMenu() {
  const m = useMenu();
  const [mode, setMode] = useState<"menu" | "rename" | "delete">("menu");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setMode("menu");
    setErr(null);
    setCopied(false);
    if (!m) return;
    setName(m.s.title);
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    addEventListener("keydown", key);
    addEventListener("hashchange", close);
    return () => {
      removeEventListener("keydown", key);
      removeEventListener("hashchange", close);
    };
  }, [m]);
  useEffect(() => {
    if (mode === "rename") input.current?.select();
  }, [mode]);
  if (!m) return null;
  const { s, who } = m;
  const original = s.originalTitle ?? s.title;

  const mark = async (body: { pinned?: boolean; hidden?: boolean; rename?: string | null }) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/sessions/${s.agent}/${encodeURIComponent(s.id)}/mark`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, title: original }),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
      // 開いているセッションを消したら、そのエージェントの新しいセッションへ
      if (body.hidden && location.hash === `#/session/${s.agent}/${encodeURIComponent(s.id)}`) location.hash = `#/session/${s.agent}/new`;
      m.onChanged?.();
      close();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const state = s.working ? { label: "作業中", dot: "bg-lime" } : s.alive ? { label: "待機", dot: "bg-mute" } : { label: "停止", dot: "bg-line-2" };
  return (
    <Sheet label={`「${s.title}」のメニュー`} onClose={close}>
      <SheetCard>
        {/* 誰との・何のセッションか */}
        <div className="flex items-start gap-3 px-4 pb-1 pt-3.5">
          {who && <Avatar p={who} size={40} />}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="line-clamp-2 text-[15.5px] font-semibold leading-snug">{s.title}</div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-mute">
              {who && <span className="font-semibold text-ink-2">{who.name}</span>}
              <span className="flex items-center gap-1"><span className={`size-1.5 rounded-full ${state.dot}`} />{state.label}</span>
              <span>{ago(s.last)}</span>
              {s.pinnedAt && <span className="rounded-full bg-lime-soft px-1.5 text-lime-ink">ピン留め</span>}
            </div>
            {s.originalTitle && <div className="truncate text-[11px] text-mute">元の題名: {s.originalTitle}</div>}
          </div>
        </div>
        {mode === "delete" ? (
          <ConfirmDelete
            text={`このセッションを一覧から削除します。${capsOfAgent(s.agent).historyName}は残ります。`}
            busy={busy}
            onCancel={() => setMode("menu")}
            onConfirm={() => void mark({ hidden: true })}
          />
        ) : mode === "rename" ? (
          <form
            className="flex flex-col gap-3 p-3.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && name.trim() !== s.title) void mark({ rename: name.trim() === original ? null : name.trim() });
              else setMode("menu");
            }}
          >
            <label className="flex flex-col gap-1.5 text-[12px] text-mute">
              新しい題名（このアプリの一覧だけ。{capsOfAgent(s.agent).titleOwner}は変わらない）
              <input
                ref={input}
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                className="h-11 rounded-2xl bg-chip/70 px-3.5 text-[15px] text-ink outline-none focus:bg-chip"
              />
            </label>
            <div className="flex gap-2">
              <button type="button" onClick={() => setMode("menu")} className="h-11 flex-1 rounded-2xl bg-chip/70 text-[14px] font-medium text-ink">キャンセル</button>
              <button type="submit" disabled={busy || !name.trim()} className="h-11 flex-1 rounded-2xl bg-ink text-[14px] font-semibold text-paper disabled:opacity-40">変える</button>
            </div>
            {s.originalTitle && (
              <button type="button" onClick={() => void mark({ rename: null })} disabled={busy} className="self-start text-[12.5px] text-ink-2 underline-offset-2 hover:underline disabled:opacity-40">
                元の題名に戻す
              </button>
            )}
          </form>
        ) : (
          <Tiles>
            <TileLink icon="open" label="開く" href={`#/session/${s.agent}/${encodeURIComponent(s.id)}`} />
            <TileButton icon="pin" label={s.pinnedAt ? "ピンを外す" : "ピン留め"} on={!!s.pinnedAt} disabled={busy} onClick={() => void mark({ pinned: !s.pinnedAt })} />
            <TileButton icon="rename" label="題名を変える" onClick={() => setMode("rename")} />
            <TileButton icon={copied ? "check" : "copy"} label={copied ? "コピーした" : "題名をコピー"} on={copied} onClick={() => void writeClipboard(s.title).then((ok) => { haptic(ok ? "success" : "error"); setCopied(ok); })} />
          </Tiles>
        )}
        {err && <div className="mx-3.5 mb-3 rounded-xl bg-orange-soft px-3 py-2 text-xs text-orange-ink" role="alert">{err}</div>}
      </SheetCard>
      {mode === "menu" && <DangerButton label="一覧から削除" onClick={() => setMode("delete")} />}
    </Sheet>
  );
}
