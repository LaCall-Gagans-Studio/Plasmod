// プロジェクトとメモを長押し（PC は右クリック）したときに下から出るメニュー。タスクのメニューと同じ見た目。
// App に1つずつ置き、どの一覧からでも開く。
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import type { Memo, MemoSummary, Project, ProjectStatus } from "../shared/types";
import { memoRef } from "../shared/memo-ref";
import { memoSync } from "./memo-db";
import { json } from "./memo-light";
import { ConfirmDelete, DangerButton, Sheet, SheetCard, TileButton, TileLink, Tiles, Glyph } from "./sheet";
import { CopyRef, haptic, toast, useLongPress, writeClipboard } from "./touch";

/** 開いているメニューを1つ持つ部品 */
function menuStore<T>() {
  let current: T | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const fn of listeners) fn();
  };
  return {
    open: (v: T) => {
      current = v;
      emit();
    },
    close: () => {
      current = null;
      emit();
    },
    use: () =>
      useSyncExternalStore(
        (fn) => {
          listeners.add(fn);
          return () => void listeners.delete(fn);
        },
        () => current,
      ),
  };
}

/** Esc と画面の移動で閉じる */
function useCloseKeys(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    addEventListener("keydown", key);
    addEventListener("hashchange", close);
    return () => {
      removeEventListener("keydown", key);
      removeEventListener("hashchange", close);
    };
  }, [open, close]);
}

// ---- メモ ----
type MemoOpen = { m: Pick<MemoSummary, "id" | "title" | "project" | "archived">; onChanged?: () => void };
const memoMenu = menuStore<MemoOpen>();
export const openMemoMenu = memoMenu.open;

export function MemoMenu() {
  const o = memoMenu.use();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useCloseKeys(!!o, memoMenu.close);
  useEffect(() => {
    setErr(null);
    setCopied(false);
  }, [o]);
  if (!o) return null;
  const { m } = o;
  const ref = memoRef(m.id);
  const archive = async () => {
    setBusy(true);
    try {
      // 端末に残っている変更を先に送る（アーカイブのあとに古い版で上書きしない）
      await memoSync.run();
      if (memoSync.status.offline) throw new Error("アーカイブは、つながっているときにできる");
      const next = await json<Memo>(await fetch(`/api/memos/${m.id}/${m.archived ? "restore" : "archive"}`, { method: "POST" }));
      await memoSync.adopt(next);
      toast(m.archived ? "アーカイブから戻した" : "アーカイブした");
      o.onChanged?.();
      memoMenu.close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const child = new URLSearchParams({ parent: String(m.id), ...(m.project ? { project: m.project } : {}) });
  return (
    <Sheet label={`「${m.title}」のメニュー`} onClose={memoMenu.close}>
      <SheetCard>
        <div className="px-4 pb-1 pt-3.5">
          {ref && <div className="font-mono text-[11px] text-mute"><CopyRef text={ref} /></div>}
          <div className="line-clamp-2 text-[15.5px] font-semibold leading-snug">{m.title}</div>
        </div>
        <Tiles>
          <TileLink icon="open" label="開く" href={`#/memo/${m.id}`} />
          {ref && !m.archived && <TileLink icon="plus" label="子のメモ" href={`#/memo/new?${child}`} />}
          {ref && (
            <TileButton
              icon={copied ? "check" : "copy"}
              label={copied ? "コピーした" : "番号をコピー"}
              on={copied}
              onClick={() => {
                void writeClipboard(ref).then((ok) => {
                  haptic(ok ? "success" : "error");
                  setCopied(ok);
                });
              }}
            />
          )}
          {ref && <TileButton icon={m.archived ? "undo" : "archive"} label={m.archived ? "戻す" : "アーカイブ"} disabled={busy} onClick={() => void archive()} />}
        </Tiles>
        {err && <div className="mx-3.5 mb-3 rounded-xl bg-orange-soft px-3 py-2 text-xs text-orange-ink" role="alert">{err}</div>}
      </SheetCard>
    </Sheet>
  );
}

/** メモへのリンク。長押しでメニューが出る */
export function MemoLink({ m, onChanged, className = "", children }: { m: MemoOpen["m"]; onChanged?: () => void; className?: string; children: ReactNode }) {
  const press = useLongPress(() => openMemoMenu({ m, onChanged }));
  return (
    <a href={`#/memo/${m.id}`} {...press} className={`select-none [-webkit-touch-callout:none] ${className}`}>
      {children}
    </a>
  );
}

// ---- プロジェクト ----
type ProjectOpen = { p: Pick<Project, "id" | "name" | "status" | "openTasks" | "memos">; onChanged?: () => void };
const projectMenu = menuStore<ProjectOpen>();
export const openProjectMenu = projectMenu.open;

const STATUSES: [ProjectStatus, string][] = [["active", "進行中"], ["paused", "保留"], ["done", "完了"]];

export function ProjectMenu() {
  const o = projectMenu.use();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [name, setName] = useState<string | null>(null);
  useCloseKeys(!!o, projectMenu.close);
  useEffect(() => {
    setErr(null);
    setConfirm(false);
    setName(null);
  }, [o]);
  if (!o) return null;
  const { p } = o;
  const run = async (req: () => Promise<Response>) => {
    setBusy(true);
    try {
      await json(await req());
      o.onChanged?.();
      projectMenu.close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const patch = (body: Record<string, unknown>) => run(() => fetch(`/api/projects/${p.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const saveName = () => {
    const v = (name ?? "").trim();
    if (!v || v === p.name) return setName(null);
    void patch({ name: v });
  };
  const empty = p.openTasks === 0 && p.memos === 0;
  return (
    <Sheet label={`「${p.name}」のメニュー`} onClose={projectMenu.close}>
      <SheetCard>
        <div className="px-4 pb-1 pt-3.5">
          <div className="text-[11px] text-mute">プロジェクト ・ タスク {p.openTasks} ・ メモ {p.memos}</div>
          <div className="line-clamp-2 text-[15.5px] font-semibold leading-snug">{p.name}</div>
        </div>
        {confirm ? (
          <ConfirmDelete text="このプロジェクトを削除します。元に戻せません。完了したタスクなどが残っていると削除できません。" busy={busy} onCancel={() => setConfirm(false)} onConfirm={() => void run(() => fetch(`/api/projects/${p.id}`, { method: "DELETE" }))} />
        ) : name !== null ? (
          <div className="flex flex-col gap-2 p-3.5">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && saveName()}
              aria-label="プロジェクトの名前"
              className="h-11 rounded-2xl border border-line-2 bg-transparent px-3 text-[14px] text-ink outline-none"
            />
            <div className="flex gap-2">
              <button onClick={() => setName(null)} aria-label="やめる" title="やめる" className="flex h-11 flex-1 items-center justify-center rounded-2xl bg-chip/70 text-ink"><Glyph name="close" /></button>
              <button onClick={saveName} disabled={busy} aria-label="名前を変える" title="名前を変える" className="flex h-11 flex-1 items-center justify-center rounded-2xl bg-ink text-paper disabled:opacity-50"><Glyph name="check" /></button>
            </div>
          </div>
        ) : (
          <>
            <Tiles>
              <TileLink icon="open" label="開く" href={`#/pj/${p.id}`} />
              <TileLink icon="plus" label="メモを書く" href={`#/memo/new?${new URLSearchParams({ project: p.name })}`} />
              <TileButton icon="rename" label="名前を変える" onClick={() => setName(p.name)} />
            </Tiles>
            <div className="px-3.5 pb-3.5 pt-0.5">
              <div className="flex rounded-full bg-chip/70 p-0.5" role="group" aria-label="状態">
                {STATUSES.map(([s, label]) => (
                  <button key={s} aria-pressed={p.status === s} disabled={busy} onClick={() => p.status !== s && void patch({ status: s })} className={`h-8 min-w-0 flex-1 rounded-full text-[12.5px] ${p.status === s ? "bg-panel font-semibold text-ink shadow-sm" : "text-ink-2"}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
        {err && <div className="mx-3.5 mb-3 rounded-xl bg-orange-soft px-3 py-2 text-xs text-orange-ink" role="alert">{err}</div>}
      </SheetCard>
      {!confirm && name === null && empty && <DangerButton label="削除" onClick={() => setConfirm(true)} />}
    </Sheet>
  );
}
