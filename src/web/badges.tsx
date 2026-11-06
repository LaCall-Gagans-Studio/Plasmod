// 番号のバッジ。画面に出た TASK-123 をまとめて引いて、状態とリンクを付ける
import { useEffect, useState } from "react";
import type { TaskBadge } from "../shared/types";
import { CopyRef } from "./touch";

const ISSUE_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g;

export function refsIn(...texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts)
    for (const m of (t ?? "").matchAll(ISSUE_RE)) if (!(t ?? "").slice(Math.max(0, (m.index ?? 0) - 2), m.index).endsWith("P-")) out.add(m[0]);
  return [...out];
}

const cache = new Map<string, TaskBadge | null>();
let pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function request(ids: string[]) {
  for (const id of ids) if (!cache.has(id)) pending.add(id);
  if (!pending.size || timer) return;
  timer = setTimeout(async () => {
    const batch = [...pending];
    pending = new Set();
    timer = null;
    try {
      const r = await fetch(`/api/apptasks-badges?ids=${encodeURIComponent(batch.join(","))}`);
      const b = (await r.json()) as { issues: Record<string, TaskBadge | null> };
      for (const id of batch) cache.set(id, b.issues?.[id] ?? null);
    } catch {
      for (const id of batch) cache.set(id, null);
    }
    for (const fn of listeners) fn();
  }, 50);
}

export function useTaskBadges(ids: string[]): Record<string, TaskBadge | null | undefined> {
  const [, bump] = useState(0);
  const key = ids.join(",");
  useEffect(() => {
    const fn = () => bump((x) => x + 1);
    listeners.add(fn);
    request(ids);
    return () => void listeners.delete(fn);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return Object.fromEntries(ids.map((i) => [i, cache.get(i)]));
}

/** 1件を Promise で引く（エディタの中の [[TASK-123]] の表示用）。キャッシュは画面と共通 */
export function lookupIssue(id: string): Promise<TaskBadge | null> {
  if (cache.has(id)) return Promise.resolve(cache.get(id) ?? null);
  return new Promise((resolve) => {
    const fn = () => {
      if (!cache.has(id)) return;
      listeners.delete(fn);
      resolve(cache.get(id) ?? null);
    };
    listeners.add(fn);
    request([id]);
  });
}

export function rememberIssue(issue: TaskBadge) {
  cache.set(issue.id, issue);
  for (const fn of listeners) fn();
}

const STATE_CLS: Record<string, string> = {
  completed: "bg-lime-soft text-lime-ink",
  started: "bg-yellow-soft text-yellow-ink",
  canceled: "bg-line text-mute line-through",
};

export function TaskBadges({ ids, small = false }: { ids: string[]; small?: boolean }) {
  const issues = useTaskBadges(ids);
  if (!ids.length) return null;
  return (
    <>
      {ids.map((id) => {
        const i = issues[id];
        const cls = `rounded-md px-1.5 py-0.5 font-mono ${small ? "text-[10px]" : "text-[10.5px]"} ${i ? STATE_CLS[i.stateType] ?? "bg-blue-soft text-blue" : "bg-blue-soft text-blue"}`;
        return i ? (
          <a key={id} href={i.url} {...(i.url.startsWith("#") ? {} : { target: "_blank", rel: "noreferrer" })} className={cls} title={i.title}>
            <CopyRef text={id}>{id} · {i.state}</CopyRef>
          </a>
        ) : (
          <CopyRef key={id} text={id} className={cls} />
        );
      })}
    </>
  );
}
