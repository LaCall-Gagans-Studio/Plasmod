// メモの編集画面
import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Memo, MemoEvent, MemoList, MemoSummary } from "../shared/types";
import { insertAtCursor } from "./live-preview";
import { MicButton } from "./speech";
import { Icon, ago } from "./ui";
import { json, FolderIcon, TagIcon, TagField, BodyEditor } from "./memo-fields";
import { hashQuery, listHref } from "./Memos";
import { Skeleton } from "./loading";
import { memoList, memoSync } from "./memo-db";
import { toast } from "./touch";
import { devAgentName, ownerName } from "./identity";

/** 広い画面（lg 以上）でメモの左に出す一覧。同じプロジェクトのメモに切り替えられる（「すべて」にも） */
function MemoSidePane({ current, project }: { current: number | null; project: string | null }) {
  const [scope, setScope] = useState<"project" | "all">("project");
  const [q, setQ] = useState("");
  const [list, setList] = useState<MemoSummary[] | null>(null);
  const useProject = scope === "project" && !!project;
  useEffect(() => {
    const p = new URLSearchParams();
    if (useProject) p.set("project", project!);
    if (q.trim()) p.set("q", q.trim());
    const t = setTimeout(() => {
      fetch(`/api/memos?${p}`)
        .then((r) => json<MemoList>(r))
        .then((l) => setList(l.memos))
        .catch(() => setList([]));
    }, q ? 200 : 0);
    return () => clearTimeout(t);
  }, [useProject, project, q, current]);
  return (
    <aside className="hidden w-[300px] flex-none flex-col border-r border-line bg-panel-2 lg:flex 2xl:w-[340px]" aria-label="メモの一覧">
      <div className="flex items-center gap-2 px-3 pb-2 pt-[max(env(safe-area-inset-top),14px)]">
        <a href="#/memos" className="flex-1 truncate text-[13px] font-bold text-ink no-underline">{useProject ? project : "すべてのメモ"}</a>
        {project && (
          <button onClick={() => setScope(scope === "project" ? "all" : "project")} className="flex-none rounded-full border border-line px-2 py-0.5 text-[11px] text-mute hover:text-ink">
            {scope === "project" ? "すべて" : project}
          </button>
        )}
        <a href={project ? `#/memo/new?${new URLSearchParams({ project })}` : "#/memo/new"} aria-label="新しいメモ" className="flex size-7 flex-none items-center justify-center rounded-full bg-ink text-paper no-underline">
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </a>
      </div>
      <div className="px-3 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-md bg-chip px-2.5 text-mute">
          <Icon name="search" size={13} />
          <span className="sr-only">メモを探す</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="探す" className="w-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-mute" />
        </label>
      </div>
      <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto px-1.5 pb-4">
        {list?.length === 0 && <li className="px-2 py-2 text-[12.5px] text-mute">ありません</li>}
        {list?.map((m) => (
          <li key={m.id}>
            <a
              href={`#/memo/${m.id}`}
              aria-current={m.id === current ? "page" : undefined}
              className={`flex flex-col rounded-md px-2.5 py-2 no-underline ${m.id === current ? "bg-chip text-ink" : "text-ink-2 hover:bg-chip/60"}`}
            >
              <span className="truncate text-[13px] font-semibold">{m.title}</span>
              <span className="flex items-center gap-2 text-[11px] text-mute">
                <span className="min-w-0 flex-1 truncate">{m.excerpt !== m.title ? m.excerpt : ""}</span>
                <span className="flex-none tabular-nums">{ago(m.updatedAt)}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}

type Draft = { title: string; body: string; project: string; tags: string[] };

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error" | "conflict" | "local";

const SAVE_LABEL: Record<SaveState, string> = { local: "端末に保存（同期待ち）", idle: "", dirty: "編集中", saving: "保存中…", saved: "保存済み", error: "保存できませんでした", conflict: "ほかで書き換えられました" };

const memoDate = (ms: number) => new Date(ms).toLocaleString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function MemoPage({ id: initialId }: { id: number | "new" }) {
  // 新規は、最初に保存した時点で番号が付く（画面は作り直さずに続けて書ける）
  const [id, setId] = useState<number | null>(initialId === "new" ? null : initialId);
  const [memo, setMemo] = useState<Memo | null>(null);
  const [draft, setDraft] = useState<Draft | null>(() => {
    if (initialId !== "new") return null;
    const p = hashQuery();
    const link = p.get("link");
    return { title: "", body: link && /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(link) ? `関連: [[${link}]]\n\n` : "", project: p.get("project") ?? "", tags: p.get("tag") ? [p.get("tag")!] : [] };
  });
  const [save, setSave] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [versions, setVersions] = useState<MemoEvent[] | null>(null);
  const [known, setKnown] = useState<MemoList | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // 保存は1つずつ。書いている間は 0.8 秒止まったら保存する
  const latest = useRef<Draft | null>(draft);
  const [editorKey, setEditorKey] = useState(0);
  const idRef = useRef<number | null>(id);
  const inflight = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedJson = useRef<string>(JSON.stringify(draft));

  const show = useCallback((m: Memo) => {
    setMemo(m);
    const d = { title: m.title, body: m.body, project: m.project ?? "", tags: m.tags };
    latest.current = d;
    savedJson.current = JSON.stringify(d);
    setDraft(d);
  }, []);

  // 端末の写しをすぐ出す。つながっていて送っていない変更が無ければ、サーバーの版にする
  useEffect(() => {
    if (initialId === "new") return;
    let alive = true;
    void (async () => {
      const local = await memoSync.get(initialId).catch(() => undefined);
      if (alive && local) {
        show(local);
        if (await memoSync.isPending(initialId)) setSave("local");
      }
      try {
        const m = await json<Memo>(await fetch(`/api/memos/${initialId}`));
        if (alive && (await memoSync.adopt(m)) && JSON.stringify(latest.current) === savedJson.current) show(m);
      } catch (e) {
        if (alive && !local) setError(String(e instanceof Error ? e.message : e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [initialId, show]);

  useEffect(() => {
    memoList(new URLSearchParams()).then(setKnown).catch(() => {});
  }, []);

  // 同期の知らせ: 新しいメモに番号が付いた・両方で変えていた
  useEffect(
    () =>
      memoSync.onEvent((e) => {
        if (e.type === "remap" && e.from === idRef.current) {
          idRef.current = e.to;
          setId(e.to);
          // hashchange を起こさずに URL だけ変える（エディタを作り直さない）
          history.replaceState(null, "", `#/memo/${e.to}`);
        } else if (e.type === "conflict" && e.id === idRef.current) {
          toast("ほかでも変更があったので、こちらの内容はコピーとして残した");
          void memoSync.get(e.id).then((m) => {
            if (!m) return;
            show(m);
            setEditorKey((k) => k + 1);
            setSave("saved");
          });
        }
      }),
    [show],
  );

  // 送り終えたら「保存済み」に
  useEffect(
    () =>
      memoSync.subscribe(() => {
        if (memoSync.status.syncing || idRef.current === null) return;
        void memoSync.isPending(idRef.current).then((p) => {
          if (!p) setSave((s) => (s === "local" ? "saved" : s));
        });
      }),
    [],
  );

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (inflight.current) await inflight.current;
    const d = latest.current;
    if (!d) return;
    const snapshot = JSON.stringify(d);
    if (snapshot === savedJson.current) return setSave((s) => (s === "dirty" ? "saved" : s));
    if (idRef.current === null && !d.title.trim() && !d.body.trim()) return setSave("idle");
    setSave("saving");
    const run = (async () => {
      try {
        // まず端末に残す。サーバーへは同期で送る（電波が無くても失われない）
        const m = await memoSync.save(idRef.current, { title: d.title, body: d.body, project: d.project.trim() || null, tags: d.tags });
        if (idRef.current === null) {
          idRef.current = m.id;
          setId(m.id);
          history.replaceState(null, "", `#/memo/${m.id}`);
        }
        savedJson.current = snapshot;
        setMemo(m);
        setSave(JSON.stringify(latest.current) === snapshot ? "local" : "dirty");
        setError(null);
        void memoSync.run();
      } catch (e) {
        setSave("error");
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    inflight.current = run;
    await run;
    inflight.current = null;
  }, []);

  const change = (patch: Partial<Draft>) => {
    if (!latest.current || memo?.archivedAt) return;
    latest.current = { ...latest.current, ...patch };
    setDraft(latest.current);
    if (save === "conflict") return;
    setSave("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 800);
  };

  // 画面を離れるとき・アプリを裏に回すときは、待たずに保存する
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && void flush();
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      void flush();
    };
  }, [flush]);

  const setArchived = async (archived: boolean) => {
    if (idRef.current === null) return;
    await flush();
    await memoSync.run();
    if (idRef.current < 0 || memoSync.status.offline) return void toast("アーカイブは、つながっているときにできる", "error");
    try {
      const m = await json<Memo>(await fetch(`/api/memos/${idRef.current}/${archived ? "archive" : "restore"}`, { method: "POST" }));
      await memoSync.adopt(m);
      setMemo(m);
      setMenu(false);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const showHistory = async () => {
    setMenu(false);
    if (idRef.current === null) return;
    try {
      setVersions(await json<MemoEvent[]>(await fetch(`/api/memos/${idRef.current}/history`)));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const back = () => {
    void flush();
    if (window.history.length > 1) window.history.back();
    else location.hash = "#/memos";
  };

  const KIND: Record<MemoEvent["kind"], string> = { create: "作成", edit: "編集", archive: "アーカイブ", restore: "戻した" };
  const who = (a: string) => (a === "app" ? ownerName() : a === "dev" ? devAgentName() : a.startsWith("hermes/") ? a.slice("hermes/".length) : a);
  const archived = !!memo?.archivedAt;
  const crumbs = draft?.project?.trim();

  return (
    <div className="flex h-full bg-ground">
      <MemoSidePane current={id} project={draft?.project?.trim() || null} />
      <div className="mx-auto flex h-full w-full max-w-[820px] min-w-0 flex-col">
        {/* 上: 戻る・場所・保存の状態・メニュー */}
        <div className="flex items-center gap-1 px-2 pb-1 pt-[max(env(safe-area-inset-top),10px)]">
          <button onClick={back} aria-label="戻る" className="flex size-11 flex-none items-center justify-center text-ink-2">
            <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px] text-mute">
            <a href="#/memos" className="text-mute no-underline hover:text-ink">メモ</a>
            {crumbs && (
              <>
                <span aria-hidden="true">/</span>
                <a href={listHref(new URLSearchParams({ project: crumbs }))} className="truncate text-mute no-underline hover:text-ink">{crumbs}</a>
              </>
            )}
          </div>
          <span className={`flex-none px-1 text-[11.5px] ${save === "error" || save === "conflict" ? "text-orange-ink" : "text-mute"}`} role="status" aria-live="polite">
            {SAVE_LABEL[save]}
          </span>
          <div className="relative flex-none">
            <button onClick={() => setMenu((x) => !x)} disabled={id === null} aria-label="メニュー" aria-expanded={menu} className="flex size-11 items-center justify-center text-ink-2 disabled:opacity-30">
              <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
            </button>
            {menu && (
              <>
                <button className="fixed inset-0 z-10 cursor-default" aria-label="メニューを閉じる" onClick={() => setMenu(false)} />
                <div className="absolute right-1 top-11 z-20 w-48 overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-xl" role="menu">
                  <button role="menuitem" onClick={showHistory} className="block w-full px-4 py-2.5 text-left text-[13.5px] hover:bg-chip">履歴を見る</button>
                  <button role="menuitem" onClick={() => void setArchived(!archived)} className="block w-full px-4 py-2.5 text-left text-[13.5px] hover:bg-chip">
                    {archived ? "アーカイブから戻す" : "アーカイブする"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-5 [overflow-wrap:anywhere] md:px-12">
          {error && (
            <div className="mb-3 flex items-center gap-2 rounded-lg bg-orange-soft px-3 py-2 text-xs text-orange-ink" role="alert">
              <span className="min-w-0 flex-1">{error}</span>
              {save === "conflict" && <button onClick={() => location.reload()} className="flex-none font-semibold underline">開き直す</button>}
            </div>
          )}
          {archived && <div className="mb-3 rounded-lg bg-chip px-3 py-2 text-xs text-ink-2">アーカイブ済み。読むだけです（メニューから戻せます）</div>}
          {!draft && !error && <Skeleton />}

          {draft && (
            <>
              <textarea
                value={draft.title}
                onChange={(e) => change({ title: e.target.value.replace(/\n/g, "") })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    viewRef.current?.focus();
                  }
                }}
                readOnly={archived}
                rows={1}
                placeholder="無題"
                aria-label="題"
                ref={(el) => {
                  if (el) {
                    el.style.height = "auto";
                    el.style.height = `${el.scrollHeight}px`;
                  }
                }}
                className="mt-3 block w-full resize-none overflow-hidden bg-transparent text-[22px] font-bold leading-tight tracking-tight text-ink outline-none placeholder:text-line-2"
              />

              {/* プロパティ */}
              <div className="mt-3 flex flex-col gap-0.5 border-b border-line pb-3 text-[13px]">
                <div className="flex items-center gap-3 rounded-md">
                  <span className="flex w-28 flex-none items-center gap-2 text-mute"><FolderIcon />プロジェクト</span>
                  <input
                    value={draft.project}
                    list="memo-projects"
                    onChange={(e) => change({ project: e.target.value })}
                    readOnly={archived}
                    placeholder="なし"
                    aria-label="プロジェクト"
                    className="min-h-8 min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-mute"
                  />
                  <datalist id="memo-projects">
                    {known?.projects.map((p) => <option key={p.name} value={p.name} />)}
                  </datalist>
                </div>
                <div className="flex items-start gap-3">
                  <span className="flex min-h-8 w-28 flex-none items-center gap-2 text-mute"><TagIcon />タグ</span>
                  <TagField tags={draft.tags} onChange={(tags) => !archived && change({ tags })} suggestions={known?.tags.map((t) => t.name) ?? []} />
                </div>
              </div>

              {memo && (
                <div className="pt-2 text-[11.5px] text-mute">
                  作成 {memoDate(memo.createdAt)} · 更新 {memoDate(memo.updatedAt)}
                </div>
              )}

              <div className="pt-4">
                <BodyEditor
                  key={`${initialId}:${archived}:${editorKey}`}
                  initial={draft.body}
                  onChange={(body) => change({ body })}
                  viewRef={viewRef}
                  autoFocus={initialId === "new"}
                  readOnly={archived}
                  makeTask={async (title) => {
                    // このメモのプロジェクト・タグを付けたタスクを作り、本文にも [[番号]] を書く（書くのはエディタ）
                    const d = latest.current;
                    try {
                      const t = await json<{ id: number; ref: string | null }>(
                        await fetch("/api/apptasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, project: d?.project.trim() || null, tags: d?.tags ?? [], body: idRef.current ? `メモ #${idRef.current} から` : "" }) }),
                      );
                      return t.ref;
                    } catch (e) {
                      setError(`タスクにできませんでした: ${e instanceof Error ? e.message : String(e)}`);
                      return null;
                    }
                  }}
                />
              </div>
            </>
          )}
        </div>

        {/* 音声入力（カーソルの位置に入れる） */}
        {draft && !archived && (
          <div className="pointer-events-none fixed bottom-[max(env(safe-area-inset-bottom),20px)] right-5 z-10">
            <div className="pointer-events-auto rounded-full bg-panel shadow-lg">
              <MicButton onText={(t) => (viewRef.current ? insertAtCursor(viewRef.current, t) : change({ body: `${draft.body}${t}` }))} size={52} />
            </div>
          </div>
        )}
      </div>

      {/* 履歴（下からのシート） */}
      {versions && (
        <div className="fixed inset-0 z-30 flex flex-col justify-end bg-black/40" onClick={() => setVersions(null)}>
          <div className={`mx-auto w-full max-w-[720px] max-h-[75vh] overflow-y-auto rounded-t-2xl bg-panel px-4 pb-[max(env(safe-area-inset-bottom),20px)] pt-3`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="履歴">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line-2" />
            <div className="flex items-center pb-2">
              <div className="flex-1 text-[15px] font-bold">履歴</div>
              <button onClick={() => setVersions(null)} aria-label="閉じる" className="flex size-10 items-center justify-center"><Icon name="close" size={18} /></button>
            </div>
            <ol className="m-0 flex list-none flex-col p-0">
              {versions.map((e) => (
                <li key={e.id} className="border-t border-line py-2.5">
                  <details>
                    <summary className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
                      <span className="font-semibold text-ink">{KIND[e.kind]}</span>
                      <span>{who(e.author)}</span>
                      <span className="ml-auto text-[11.5px] tabular-nums text-mute">{new Date(e.at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                    </summary>
                    <div className="pt-2 text-[11.5px] text-mute">{[e.project, ...e.tags.map((t) => `#${t}`)].filter(Boolean).join(" ")}</div>
                    <div className="pt-1 text-sm font-bold">{e.title}</div>
                    <pre className="m-0 whitespace-pre-wrap pt-1 font-sans text-xs leading-relaxed text-ink-2">{e.body}</pre>
                  </details>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
