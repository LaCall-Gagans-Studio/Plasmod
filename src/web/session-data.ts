// セッションのデータ: 一覧・会話・未読・クレジット・覚えておく値
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChatMessage, HermesMessage, HistoryCursor, NousCredits, OlderPage, SessionInfo, SessionView, Snapshot } from "../shared/types";
import { checkReply } from "./perf";
import { profileOf } from "./ui";

interface AgentEntry {
  id: string;
  available: boolean;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const body = (await r.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!r.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

export function useAgents() {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  useEffect(() => {
    getJson<{ agents: AgentEntry[] }>("/api/sessions").then((b) => setAgents(b.agents)).catch(() => setAgents([]));
  }, []);
  return agents;
}

/** セッションの一覧から cron の回を省くか（既定はオン）。端末に覚え、開いている一覧すべてに効かせる */
const HIDE_CRON = "gh-hide-cron";

const hideCronListeners = new Set<() => void>();

export function useHideCron(): [boolean, (v: boolean) => void] {
  const hide = useSyncExternalStore(
    (fn) => (hideCronListeners.add(fn), () => void hideCronListeners.delete(fn)),
    () => recall(HIDE_CRON) !== "0",
  );
  const set = (v: boolean) => {
    remember(HIDE_CRON, v ? null : "0");
    for (const fn of hideCronListeners) fn();
  };
  return [hide, set];
}

const visible = (list: SessionInfo[], hideCron: boolean) => (hideCron ? list.filter((s) => !s.cron) : list);

// 開いたことのある一覧・会話は覚えておき、戻ったときはすぐ出して裏で新しくする
const sessionsCache = new Map<string, SessionInfo[]>();
const viewCache = new Map<string, SessionView>();

export function useSessions(agent: string | null, refreshKey = 0) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(() => (agent ? sessionsCache.get(agent) ?? null : null));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!agent) return;
    let alive = true;
    const load = () =>
      getJson<{ sessions: SessionInfo[] }>(`/api/sessions/${agent}`)
        .then((b) => {
          if (!alive) return;
          sessionsCache.set(agent, b.sessions);
          setSessions(b.sessions);
          setError(null);
        })
        .catch((e) => alive && setError(String(e.message ?? e)));
    setSessions(sessionsCache.get(agent) ?? null);
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [agent, refreshKey]);
  const [hideCron] = useHideCron();
  return { sessions: sessions && visible(sessions, hideCron), error };
}

export function useView(agent: string | null, id: string | null, ms = 2000) {
  const cacheKey = `${agent}:${id}`;
  const [view, setView] = useState<SessionView | null>(() => viewCache.get(cacheKey) ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setView(viewCache.get(cacheKey) ?? null);
    if (!agent || !id) return;
    let alive = true;
    const load = () =>
      getJson<{ view: SessionView }>(`/api/sessions/${agent}/${encodeURIComponent(id)}`)
        .then((b) => {
          if (!alive) return;
          viewCache.set(cacheKey, b.view);
          setView(b.view);
          setError(null);
          checkReply(agent, id, b.view);
        })
        .catch((e) => alive && setError(String(e.message ?? e)));
    void load();
    const t = setInterval(load, ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [agent, id, ms, cacheKey]);
  return { view, error };
}

/** Nous のクレジット。Hermes の「You've used $X of your $Y cap」と同じもの */
export function useCredits(enabled: boolean) {
  const [credits, setCredits] = useState<NousCredits | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => getJson<NousCredits>("/api/system/credits").then((c) => alive && setCredits(c)).catch(() => {});
    void load();
    const t = setInterval(load, 300_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [enabled]);
  return enabled ? credits : null;
}

export const usd = (n: number) => `$${n.toFixed(2)}`;

/** 使った額と月の枠（無ければ null） */
export function creditsUsed(c: NousCredits): { used: number; cap: number; ratio: number } | null {
  if (c.monthly === null || c.monthly <= 0 || c.subscriptionRemaining === null) return null;
  const used = Math.min(c.monthly, Math.max(0, c.monthly - c.subscriptionRemaining));
  return { used, cap: c.monthly, ratio: used / c.monthly };
}

/** 上にスクロールして読み込んだ前の会話 */
export interface OlderState {
  items: (ChatMessage | HermesMessage)[];
  cursor: HistoryCursor | null;
  loading: boolean;
  error: string | null;
  load: () => void;
}

/** 前の会話を、上の端に来たら読み込む。セッションを切り替えたら空に戻す */
export function useOlder(agent: string, id: string | null, view: SessionView | null): OlderState {
  const [items, setItems] = useState<(ChatMessage | HermesMessage)[]>([]);
  const [cursor, setCursor] = useState<HistoryCursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    setItems([]);
    setCursor(null);
    setError(null);
  }, [agent, id]);
  // 最初の目印は、最新の画面（view）から
  const start = cursor ?? view?.cursor ?? null;
  const load = useCallback(() => {
    if (!id || !start?.more || busy.current) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ before: start.before, ...(start.offset !== undefined ? { offset: String(start.offset) } : {}) });
    getJson<OlderPage>(`/api/sessions/${agent}/${encodeURIComponent(id)}/older?${q}`)
      .then((p) => {
        setItems((x) => [...p.messages, ...x]);
        setCursor(p.cursor);
      })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => {
        busy.current = false;
        setLoading(false);
      });
  }, [agent, id, start?.before, start?.offset, start?.more]);
  return { items, cursor: start, loading, error, load };
}

export const NAME = (snap: Snapshot | null, id: string) => (snap ? profileOf(snap.agents, id).name : id);

/** 最後に開いていたエージェントとセッション（トップに戻ったときに同じものを出す）。保存できない環境では覚えないだけ */
export const LAST_AGENT = "gh-last-agent";

export const lastSessionKey = (agent: string) => `gh-last-session:${agent}`;

export function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function remember(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* 覚えられないだけ */
  }
}

/** ホームの中央に置く小さい版 */
const CHAT_SEEN = "gh-chat-seen";

/** エージェントごとに、チャットを最後に見た時刻（ms）。この端末だけで覚える */
function seenMap(): Record<string, number> {
  try {
    const v = JSON.parse(recall(CHAT_SEEN) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** このエージェントのチャットを at の時点まで見た、と覚える */
export function markChatSeen(agent: string, at: number) {
  const m = seenMap();
  if ((m[agent] ?? 0) >= at) return;
  m[agent] = at;
  remember(CHAT_SEEN, JSON.stringify(m));
}

/**
 * エージェントごとの未読。いちばん新しいセッションの動きが、最後に見た時刻より新しければ未読。
 * 開いているエージェント（active）は見ているので、読むたびに既読にする。初めて見るエージェントは今の状態を既読にする
 */
export function useChatUnread(agents: AgentEntry[], active: string | null): Set<string> {
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [hideCron] = useHideCron();
  const ids = agents.filter((a) => a.available).map((a) => a.id).join(",");
  useEffect(() => {
    if (!ids) return;
    let alive = true;
    const load = async () => {
      const latest = await Promise.all(
        ids.split(",").map((id) =>
          getJson<{ sessions: SessionInfo[] }>(`/api/sessions/${id}`)
            .then((b) => [id, Math.max(0, ...visible(b.sessions, hideCron).map((s) => s.last))] as const)
            .catch(() => [id, 0] as const),
        ),
      );
      if (!alive) return;
      const seen = seenMap();
      const out = new Set<string>();
      for (const [id, last] of latest) {
        if (!last) continue;
        if (id === active || seen[id] === undefined) markChatSeen(id, last);
        else if (last > seen[id]) out.add(id);
      }
      setUnread(out);
    };
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [ids, active, hideCron]);
  return unread;
}

export const CHAT_TEAM = "gh-chat-team";

