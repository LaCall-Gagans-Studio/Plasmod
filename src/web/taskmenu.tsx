// タスクを長押し（PC は右クリック）したときに下から出るメニュー: 開く・Done・期日・番号のコピー・不要・削除。
// App に1つだけ置き、どの一覧からでも openTaskMenu で開く。
import { useEffect, useState, useSyncExternalStore } from "react";
import type { AppTask } from "../shared/types";
import { ConfirmDelete, DangerButton, Glyph, Sheet, SheetCard, TileButton, TileLink, Tiles } from "./sheet";
import { patchTask } from "./task-db";
import { CopyRef, haptic, writeClipboard } from "./touch";
import { localDay } from "../shared/time";

type Open = { t: AppTask; onChanged?: () => void } | null;
let current: Open = null;
const listeners = new Set<() => void>();
export function openTaskMenu(t: AppTask, onChanged?: () => void) {
  current = { t, onChanged };
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

export { useLongPress } from "./touch";

const dayAfter = (days: number) => localDay(Date.now() + days * 86_400_000);

export function TaskMenu() {
  const m = useMenu();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setConfirm(false);
    setErr(null);
    setCopied(false);
    if (!m) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    addEventListener("keydown", key);
    addEventListener("hashchange", close);
    return () => {
      removeEventListener("keydown", key);
      removeEventListener("hashchange", close);
    };
  }, [m]);
  if (!m) return null;
  const { t } = m;
  const done = t.status === "done";

  const run = async (req: () => Promise<Response>) => {
    setBusy(true);
    try {
      const r = await req();
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
      m.onChanged?.();
      close();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };
  const patch = (body: Record<string, unknown>) =>
    run(async () => {
      await patchTask(t.id, body);
      return new Response("{}");
    });
  const remove = () =>
    run(async () => {
      const r = await fetch(`/api/apptasks/${t.id}`, { method: "DELETE" });
      // 開いているタスクを消したら一覧へ
      if (r.ok && new RegExp(`^#/todo/${t.id}(\\?|$)`).test(location.hash)) location.hash = "#/todos";
      return r;
    });

  const DUES: [string, string | null][] = [["今日", dayAfter(0)], ["明日", dayAfter(1)], ["来週", dayAfter(7)], ["なし", null]];
  return (
    <Sheet label={`「${t.title}」のメニュー`} onClose={close}>
      <SheetCard>
        <div className="px-4 pb-1 pt-3.5">
          <div className="font-mono text-[11px] text-mute">{t.ref ? <CopyRef text={t.ref} /> : `#${t.id}`}</div>
          <div className="line-clamp-2 text-[15.5px] font-semibold leading-snug">{t.title}</div>
        </div>
        {confirm ? (
          <ConfirmDelete
            text={`このタスクを削除します。記録・タグ・つながりも消え、元に戻せません。${t.sourceKey ? "見回りが同じ元からまた登録することはありません。" : ""}`}
            busy={busy}
            onCancel={() => setConfirm(false)}
            onConfirm={() => void remove()}
          />
        ) : (
          <>
            <Tiles>
              <TileLink icon="open" label="開く" href={`#/todo/${t.id}`} />
              <TileButton icon={done ? "undo" : "check"} label={done ? "Todo に戻す" : "Done"} disabled={busy} onClick={() => void patch({ status: done ? "todo" : "done" })} />
              {t.ref && (
                <TileButton
                  icon={copied ? "check" : "copy"}
                  label={copied ? "コピーした" : "番号をコピー"}
                  on={copied}
                  onClick={() => {
                    void writeClipboard(t.ref!).then((ok) => {
                      haptic(ok ? "success" : "error");
                      setCopied(ok);
                    });
                  }}
                />
              )}
              {t.doneReason !== "unneeded" && <TileButton icon="skip" label="不要" disabled={busy} onClick={() => void patch({ status: "done", doneReason: "unneeded" })} />}
            </Tiles>
            <div className="flex items-center gap-2 px-3.5 pb-3.5 pt-0.5">
              <span className="flex flex-none items-center text-mute" title="期日"><Glyph name="calendar" size={18} /><span className="sr-only">期日</span></span>
              <div className="flex min-w-0 flex-1 rounded-full bg-chip/70 p-0.5" role="group" aria-label="期日">
                {DUES.map(([label, due]) => (
                  <button key={label} aria-pressed={t.due === due} disabled={busy} onClick={() => void patch({ due })} className={`h-8 min-w-0 flex-1 rounded-full text-[12.5px] ${t.due === due ? "bg-panel font-semibold text-ink shadow-sm" : "text-ink-2"}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
        {err && <div className="mx-3.5 mb-3 rounded-xl bg-orange-soft px-3 py-2 text-xs text-orange-ink" role="alert">{err}</div>}
      </SheetCard>
      {!confirm && <DangerButton label="削除" onClick={() => setConfirm(true)} />}
    </Sheet>
  );
}
