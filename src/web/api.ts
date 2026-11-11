import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SnoozeKind, Snapshot } from "../shared/types";
import { reportSnapshotSplit, reportStartup } from "./perf";
import { type Progress, upload } from "./upload";

/**
 * 判断したカードは、サーバーの次の知らせを待たずにすぐ畳む（知らせが遅れたり、アプリが裏にいて
 * ストリームが切れていたりすると、判断済みのカードが残って押すと「判断済みか、無くなっている」になる）。
 * サーバーの一覧から消えたら覚えるのをやめる。念のため10分で忘れる
 */
const hidden = new Map<string, number>();
const hiddenListeners = new Set<() => void>();
let hiddenVersion = 0;
const HIDE_MS = 10 * 60_000;

export function hideCard(key: string) {
  hidden.set(key, Date.now());
  hiddenVersion++;
  for (const fn of hiddenListeners) fn();
}

/** 畳んだカードを除く。サーバーの一覧から消えたもの・古いものは忘れる */
export function withoutHidden(s: Snapshot, now = Date.now()): Snapshot {
  if (!hidden.size) return s;
  const live = new Set([...s.cards, ...(s.snoozed ?? [])].map((c) => c.key));
  for (const [k, at] of hidden) if (!live.has(k) || now - at > HIDE_MS) hidden.delete(k);
  if (!hidden.size) return s;
  return { ...s, cards: s.cards.filter((c) => !hidden.has(c.key)), snoozed: s.snoozed?.filter((c) => !hidden.has(c.key)) };
}

let refetchSnapshot: () => void = () => {};
/** 判断のあとなど、ストリームを待たずに今の一覧を取り直す */
export function refreshSnapshot() {
  refetchSnapshot();
}

const SNAP_KEY = "gh-last-snapshot";
function readLastSnapshot(): Snapshot | null {
  try {
    const s = localStorage.getItem(SNAP_KEY);
    return s ? (JSON.parse(s) as Snapshot) : null;
  } catch {
    return null;
  }
}
function saveLastSnapshot(s: Snapshot) {
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify(s));
  } catch {
    /* 覚えられないだけ */
  }
}

export function useSnapshot(): { snap: Snapshot | null; online: boolean } {
  // 前回の状態をすぐ出して、裏で新しくする（アプリが作り直されても読み込みを挟まない）
  const [raw, setRaw] = useState<Snapshot | null>(readLastSnapshot);
  const setSnap = (s: Snapshot) => {
    setRaw(s);
    saveLastSnapshot(s);
  };
  const [online, setOnline] = useState(false);
  const version = useSyncExternalStore(
    (fn) => {
      hiddenListeners.add(fn);
      return () => void hiddenListeners.delete(fn);
    },
    () => hiddenVersion,
  );
  useEffect(() => {
    // 最初の1枚が取れるまでは、短い間隔で取り直す（端末が戻った直後は通信がまだつながっていないことがある）
    let firstDone = false;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const load = (): Promise<void> => {
      const t0 = performance.now();
      return fetch("/api/snapshot", { cache: "no-store" })
        .then((r) => {
          if (!r.ok) return Promise.reject(new Error(`HTTP ${r.status}`));
          reportSnapshotSplit(performance.now() - t0, r.headers.get("Server-Timing"));
          return r.json();
        })
        .then((s) => {
          firstDone = true;
          setSnap(s);
          reportStartup(Date.now(), retries);
        })
        .catch(() => {
          if (firstDone || retryTimer) return;
          retries++;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            void load();
          }, Math.min(8000, 500 * 2 ** Math.min(retries, 5)));
        });
    };
    refetchSnapshot = () => void load();
    // 最初の1枚はすぐ取りに行き、以降はストリームで受ける
    void load();
    const noStream = new URLSearchParams(location.search).has("nostream"); // ヘッドレスでのスクショ確認用

    // ストリームは、インストールしたアプリ（PWA）で裏に回ったり回線が変わったりすると、エラーも出さずに黙って止まる
    // ことがある。サーバーは 25 秒ごとに ping を送るので、60 秒なにも来なければつなぎ直す
    let es: EventSource | null = null;
    let lastMsg = Date.now();
    const connect = () => {
      es?.close();
      if (noStream) return;
      lastMsg = Date.now();
      es = new EventSource("/api/stream");
      es.addEventListener("snapshot", (e) => {
        lastMsg = Date.now();
        firstDone = true;
        setSnap(JSON.parse((e as MessageEvent).data));
        reportStartup(Date.now(), retries);
        setOnline(true);
      });
      es.addEventListener("ping", () => {
        lastMsg = Date.now();
        setOnline(true);
      });
      es.onerror = () => setOnline(false);
    };
    connect();
    const visible = () => document.visibilityState === "visible";
    // アプリに戻ってきた・回線が戻ったら、取り直してつなぎ直す
    const wake = () => {
      if (!visible()) return;
      void load();
      if (Date.now() - lastMsg > 30_000 || es?.readyState !== EventSource.OPEN) connect();
    };
    document.addEventListener("visibilitychange", wake);
    addEventListener("online", wake);
    addEventListener("pageshow", wake);
    addEventListener("focus", wake);
    // 見ている間の見張り: 止まっていればつなぎ直す。念のため 1 分ごとに一覧も取り直す（ストリームが生きていても安い）
    let tick = 0;
    const timer = setInterval(() => {
      if (!visible()) return;
      if (!noStream && Date.now() - lastMsg > 60_000) {
        setOnline(false);
        connect();
      }
      if (++tick % 4 === 0) void load();
    }, 15_000);
    return () => {
      es?.close();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
      removeEventListener("online", wake);
      removeEventListener("pageshow", wake);
      removeEventListener("focus", wake);
    };
  }, []);
  const snap = useMemo(() => (raw ? withoutHidden(raw) : null), [raw, version]);
  return { snap, online };
}

/** 判断が通らなかったとき。status=404 はカードがもう無い（判断済み） */
export class ActFailed extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function act(key: string, option: string, text: string, files: File[] = [], onProgress: Progress = () => {}, snooze?: SnoozeKind): Promise<void> {
  if (files.length) {
    // 添付は XHR で送って進み具合を出す
    const fd = new FormData();
    fd.append("option", option);
    fd.append("text", text);
    if (snooze) fd.append("snooze", snooze);
    for (const f of files) fd.append("files", f);
    const u = await upload(`/api/cards/${encodeURIComponent(key)}/act`, fd, onProgress);
    if (!u.ok || !u.json.ok) throw new ActFailed(String(u.json.error ?? `HTTP ${u.status}`), u.status);
    return;
  }
  const res = await fetch(`/api/cards/${encodeURIComponent(key)}/act`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ option, text, ...(snooze ? { snooze } : {}) }) });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !body.ok) throw new ActFailed(body.error ?? `HTTP ${res.status}`, res.status);
}

export function markSeen(key: string) {
  void fetch(`/api/cards/${encodeURIComponent(key)}/seen`, { method: "POST" });
}

/** アプリの更新で一瞬切れたとき（502〜504・つながらない）は、少し待って取り直す */
export async function fetchRetry(url: string, tries = 4): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url);
      if (![502, 503, 504].includes(r.status) || i >= tries - 1) return r;
    } catch (e) {
      if (i >= tries - 1) throw e;
    }
    await new Promise((f) => setTimeout(f, 1200 * (i + 1)));
  }
}
