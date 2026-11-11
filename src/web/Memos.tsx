// メモ（TASK-174）。Obsidian に寄せた見た目: 一覧は静かな行の並び（広い画面では左にプロジェクトとタグ）、
// 1件は開いたらそのまま書ける（ライブプレビュー・自動保存）。題は大きく、プロジェクトとタグはプロパティ欄に。
import { useEffect, useState } from "react";
import { memoRef } from "../shared/memo-ref";
import type { MemoList, MemoSummary } from "../shared/types";
import { PjTabs } from "./pjtabs";
import { Icon, Nav, RAIL, ago } from "./ui";
import { json, FolderIcon, TagIcon } from "./memo-light";
import { Skeleton } from "./loading";
import { MemoLink } from "./pjmenus";
import { localMemoList, memoList, SyncBadge, useMemoSyncStatus } from "./memo-db";
import { CopyRef } from "./touch";

/** #/memos?project=..&tag=..&archived=1 の絞り込み */
export function hashQuery(): URLSearchParams {
  return new URLSearchParams(location.hash.split("?")[1] ?? "");
}

export function listHref(q: URLSearchParams) {
  const s = q.toString();
  return s ? `#/memos?${s}` : "#/memos";
}

/** 更新日で区切る見出し */
function bucket(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (ms >= today.getTime()) return "今日";
  if (ms >= today.getTime() - day) return "昨日";
  if (ms >= today.getTime() - 6 * day) return "この1週間";
  if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth()) return "今月";
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

/** メモの1行。子があれば右に数を出し、押すと下に開く */
function MemoNode({ m, kids, onChanged, depth = 0 }: { m: MemoSummary; kids: Map<number, MemoSummary[]>; onChanged: () => void; depth?: number }) {
  const [open, setOpen] = useState(false);
  const children = kids.get(m.id) ?? [];
  return (
    <>
      <div className="flex items-start" style={depth ? { paddingLeft: Math.min(depth, 4) * 16 } : undefined}>
        <MemoLink m={m} onChanged={onChanged} className="mx-2 flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg px-3 py-2.5 text-ink no-underline hover:bg-chip/70 active:bg-chip">
          <span className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{m.title}</span>
            {memoRef(m.id) && <CopyRef text={memoRef(m.id)!} className="flex-none font-mono text-[10.5px] text-mute" />}
            <span className="flex-none text-[11px] tabular-nums text-mute">{ago(m.updatedAt)}</span>
          </span>
          {m.excerpt && m.excerpt !== m.title && <span className="line-clamp-2 text-[12px] leading-relaxed text-mute">{m.excerpt}</span>}
          {(m.project || m.tags.length > 0) && (
            <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 pt-0.5 text-[11.5px] text-mute">
              {m.project && (
                <span className="flex items-center gap-1"><FolderIcon size={12} />{m.project}</span>
              )}
              {m.tags.map((t) => <span key={t} className="text-blue">#{t}</span>)}
            </span>
          )}
        </MemoLink>
        {children.length > 0 && (
          <button onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`子のメモ ${children.length} 件を${open ? "たたむ" : "開く"}`} className="mr-2 mt-1 flex min-h-10 min-w-10 flex-none items-center justify-center gap-0.5 rounded-lg text-[12px] font-semibold tabular-nums text-ink-2 hover:bg-chip">
            {children.length}<span aria-hidden="true">{open ? "▴" : "▾"}</span>
          </button>
        )}
      </div>
      {open && children.map((c) => <MemoNode key={c.id} m={c} kids={kids} onChanged={onChanged} depth={depth + 1} />)}
    </>
  );
}

function groupByDate(memos: MemoSummary[]): [string, MemoSummary[]][] {
  const out: [string, MemoSummary[]][] = [];
  for (const m of memos) {
    const b = bucket(m.updatedAt);
    if (out.length && out[out.length - 1][0] === b) out[out.length - 1][1].push(m);
    else out.push([b, [m]]);
  }
  return out;
}

/** 左（広い画面）・上（スマホ）のプロジェクトとタグ */
function Facets({ list, project, tag, toggle, vertical }: { list: MemoList; project: string | null; tag: string | null; toggle: (k: string, v: string | null) => void; vertical: boolean }) {
  const item = (on: boolean) =>
    vertical
      ? `flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${on ? "bg-chip font-semibold text-ink" : "text-ink-2 hover:bg-chip/60"}`
      : `flex flex-none items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] ${on ? "bg-ink font-semibold text-paper" : "bg-chip text-ink-2"}`;
  const count = (n: number) => <span className={`ml-auto pl-2 text-[11px] tabular-nums ${vertical ? "text-mute" : "opacity-60"}`}>{n}</span>;
  return (
    <div className={vertical ? "flex flex-col gap-5" : "flex flex-col gap-2"}>
      <div className={vertical ? "flex flex-col gap-0.5" : "flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none]"} role="group" aria-label="プロジェクト">
        {vertical && <div className="px-2 pb-1 text-[11px] font-semibold tracking-wide text-mute">プロジェクト</div>}
        <button className={item(project === null)} onClick={() => toggle("project", null)}>
          {vertical && <Icon name="memo" size={14} />}すべて
        </button>
        {list.projects.map((p) => (
          <button key={p.name} className={item(project === p.name)} onClick={() => toggle("project", p.name)}>
            <FolderIcon />
            <span className="truncate">{p.name}</span>
            {count(p.count)}
          </button>
        ))}
        {(list.projects.length > 0 || project === "") && (
          <button className={item(project === "")} onClick={() => toggle("project", "")}>
            {vertical && <span className="w-[14px]" />}
            なし
          </button>
        )}
      </div>
      {(list.tags.length > 0 || tag) && (
        <div className={vertical ? "flex flex-col gap-0.5" : "flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none]"} role="group" aria-label="タグ">
          {vertical && <div className="px-2 pb-1 text-[11px] font-semibold tracking-wide text-mute">タグ</div>}
          {tag && !list.tags.some((t) => t.name === tag) && (
            <button className={item(true)} onClick={() => toggle("tag", tag)}>
              #{tag}
            </button>
          )}
          {list.tags.map((t) => (
            <button key={t.name} className={vertical ? item(tag === t.name) : `flex flex-none items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] ${tag === t.name ? "border-ink text-ink" : "border-line text-mute"}`} onClick={() => toggle("tag", t.name)}>
              {vertical && <TagIcon />}
              <span className="truncate">{vertical ? t.name : `#${t.name}`}</span>
              {vertical && count(t.count)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function MemoListPage() {
  const sync = useMemoSyncStatus();
  const params = hashQuery();
  const project = params.get("project");
  const tag = params.get("tag");
  const archived = params.get("archived") === "1";
  const [q, setQ] = useState("");
  const [list, setList] = useState<MemoList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bump, setBump] = useState(0);

  useEffect(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (project !== null) p.set("project", project);
    if (tag) p.set("tag", tag);
    if (archived) p.set("archived", "1");
    const t = setTimeout(
      () => {
        // 端末の写しをすぐ出して、サーバーの一覧で置き換える。語を探すときは本文を読むので、先出しはしない（つながらなければ memoList が端末で探す）
        if (!q.trim()) void localMemoList(p).then((l) => l.memos.length && setList((cur) => cur ?? l)).catch(() => {});
        memoList(p)
          .then((l) => {
            setList(l);
            setError(null);
          })
          .catch((e) => setError(String(e instanceof Error ? e.message : e)));
      },
      q ? 200 : 0,
    );
    return () => clearTimeout(t);
  }, [q, project, tag, archived, sync.pending, bump]);

  const toggle = (key: string, value: string | null) => {
    const p = hashQuery();
    if (value === null || p.get(key) === value) p.delete(key);
    else p.set(key, value);
    location.hash = listHref(p);
  };

  // 新規は、いま絞っているプロジェクト・タグを最初から付けておく
  const newHref = (() => {
    const p = new URLSearchParams();
    if (project) p.set("project", project);
    if (tag) p.set("tag", tag);
    const s = p.toString();
    return s ? `#/memo/new?${s}` : "#/memo/new";
  })();

  // 親が一覧にあるメモは親の下にたたむ。探しているときは全部そのまま並べる
  const kids = new Map<number, MemoSummary[]>();
  const shown = new Set(list?.memos.map((m) => m.id));
  for (const m of list?.memos ?? []) if (!q.trim() && m.parentId && shown.has(m.parentId)) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m]);
  const tops = (list?.memos ?? []).filter((m) => q.trim() || !m.parentId || !shown.has(m.parentId));

  const heading = archived ? "アーカイブ" : project === "" ? "プロジェクトなし" : project ?? (tag ? `#${tag}` : "すべてのメモ");

  return (
    <div className={`h-full ${RAIL}`}>
      <div className="mx-auto flex h-full w-full max-w-[520px] flex-col md:max-w-none 2xl:max-w-[1760px]">
        <div className="flex min-h-0 flex-1">
          {/* 広い画面: 左にプロジェクトとタグ */}
          {list && (
            <aside className="hidden w-[220px] flex-none overflow-y-auto border-r border-line px-3 pb-6 pt-[max(env(safe-area-inset-top),22px)] md:block">
              <div className="px-2 pb-4 text-[13px] font-bold text-ink">メモ</div>
              <Facets list={list} project={project} tag={tag} toggle={toggle} vertical />
              <button onClick={() => toggle("archived", archived ? null : "1")} className={`mt-5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${archived ? "bg-chip font-semibold" : "text-mute hover:bg-chip/60"}`}>
                アーカイブ
              </button>
            </aside>
          )}

          <main className="flex min-w-0 flex-1 flex-col">
            <PjTabs current="memos" onPlus={() => (location.hash = newHref)} plusLabel="新しいメモ" />
            <div className="flex justify-end px-4 empty:hidden"><SyncBadge /></div>
            <a href="#/memo/voice" aria-label="音声でメモする" className="mx-4 mb-1 flex min-h-11 items-center justify-center gap-2 rounded-full border border-line-2 text-[13.5px] font-semibold text-ink-2 no-underline">
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
              音声でメモする
            </a>
            {heading !== "すべてのメモ" && <div className="truncate px-5 pb-1 text-[12.5px] font-semibold text-ink-2">{heading}</div>}
            <div className="px-4 pb-2">
              <label className="relative flex h-9 items-center gap-2 rounded-lg bg-chip px-3 text-mute">
                <Icon name="search" size={15} />
                <span className="sr-only">メモを探す</span>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="探す" className="w-full min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-mute" />
              </label>
            </div>
            {list && (list.projects.length > 0 || list.tags.length > 0 || project !== null || tag) && (
              <div className="pb-1 md:hidden">
                <Facets list={list} project={project} tag={tag} toggle={toggle} vertical={false} />
              </div>
            )}

            <div className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-6">
              {error && <div className="mx-4 mt-2 rounded-lg bg-orange-soft px-3 py-2 text-xs text-orange-ink" role="alert">{error}</div>}
              {!list && !error && <Skeleton />}
              {list?.memos.length === 0 && (
                <div className="flex flex-col items-center gap-3 px-6 pt-16 text-center">
                  <div className="text-mute"><Icon name="memo" size={32} /></div>
                  <div className="text-sm text-mute">{archived && sync.offline ? "アーカイブしたメモは、つながっているときに見られます" : q || project !== null || tag ? "当てはまるメモはありません" : archived ? "アーカイブしたメモはありません" : "まだメモがありません"}</div>
                  {!q && !archived && <a href={newHref} className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-paper no-underline">書きはじめる</a>}
                </div>
              )}
              {list &&
                groupByDate(tops).map(([label, items]) => (
                  <section key={label} className="pt-3">
                    <div className="px-5 pb-1 text-[11px] font-semibold tracking-wide text-mute">{label}</div>
                    <ul className="m-0 list-none p-0 lg:grid lg:grid-cols-2 2xl:grid-cols-3">
                      {items.map((m) => (
                        <li key={m.id}>
                          <MemoNode m={m} kids={kids} onChanged={() => setBump((x) => x + 1)} />
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              <div className="pt-6 text-center md:hidden">
                <button onClick={() => toggle("archived", archived ? null : "1")} className="text-xs text-mute underline underline-offset-2">
                  {archived ? "アーカイブしていないメモに戻る" : "アーカイブを見る"}
                </button>
              </div>
            </div>
          </main>
        </div>
        <Nav current="#/pj" />
      </div>
    </div>
  );
}
