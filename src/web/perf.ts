// 速さを測ってサーバーに残す（v2.0 の基準値）。測れなくても画面には何も影響させない。
import type { ChatMessage, HermesMessage, PerfName, SessionView } from "../shared/types";

const via = () => (/; wv\)/.test(navigator.userAgent) ? "apk" : "browser");

function send(name: PerfName, ms: number) {
  void fetch("/api/perf", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, via: via(), ms }), keepalive: true }).catch(() => {});
}

/**
 * 起動の内訳（ms）。足すと全体になる。
 * entry＝APK の入口の画面（Tailscale の疎通を含む）、doc＝画面の HTML が届くまで、script＝スクリプトを読んで動かすまで、data＝最初のデータが届くまで
 */
export function startupStages(t: { launch: number; origin: number; responseEnd: number; contentLoaded: number; now: number }): { name: PerfName; ms: number }[] {
  const doc = Math.max(0, t.responseEnd);
  const script = Math.max(doc, t.contentLoaded);
  return [
    ...(t.launch ? [{ name: "startup_entry" as const, ms: Math.max(0, t.origin - t.launch) }] : []),
    { name: "startup_doc", ms: doc },
    { name: "startup_script", ms: script - doc },
    { name: "startup_data", ms: Math.max(0, t.now - script) },
  ];
}

let started = false;
/** 最初のデータが届いて操作できるようになったとき。APK は入口の画面の時刻（?launch=）から数える */
export function reportStartup(now = Date.now()) {
  if (started) return;
  started = true;
  const q = new URLSearchParams(location.search);
  const launch = Number(q.get("launch"));
  if (launch) {
    q.delete("launch");
    const rest = q.toString();
    history.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
  }
  send("startup", launch ? now - launch : performance.now());
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (nav) {
    for (const s of startupStages({ launch, origin: performance.timeOrigin, responseEnd: nav.responseEnd, contentLoaded: nav.domContentLoadedEventEnd, now: performance.now() })) send(s.name, s.ms);
  }
}

/** 返事が来ているか: 送った発言より後に、エージェントの文がある */
export function replySeen(view: SessionView, text: string): boolean {
  const t = text.trim();
  if (view.kind === "chat") {
    const ms: HermesMessage[] = view.messages;
    const i = ms.findLastIndex((m) => m.role === "user" && m.text.trim().startsWith(t));
    return i >= 0 && ms.slice(i + 1).some((m) => m.role === "assistant" && m.text.trim() !== "");
  }
  const ms: ChatMessage[] = view.messages ?? [];
  const i = ms.findLastIndex((m) => m.author === "owner" && m.content.trim() === t);
  return i >= 0 && ms.slice(i + 1).some((m) => m.author !== "owner" && m.author !== "system" && m.content.trim() !== "");
}

interface Waiting {
  name: PerfName;
  agent: string;
  sid: string | null;
  text: string;
  at: number;
}
let waiting: Waiting[] = [];
const GIVE_UP_MS = 15 * 60_000;

/** 送り始め。戻り値でセッションの番号を教えてもらう（新しいセッションは送るまで番号が無い） */
export function trackReply(agent: string, sid: string | null, text: string, now = Date.now()): (sid: string | null) => void {
  const w: Waiting = { name: sid ? "session_reply" : "session_new", agent, sid, text, at: now };
  waiting.push(w);
  return (got) => {
    if (got) w.sid = got;
    else waiting = waiting.filter((x) => x !== w);
  };
}

/** 画面が会話を読むたびに呼ぶ */
export function checkReply(agent: string, sid: string, view: SessionView, now = Date.now()) {
  waiting = waiting.filter((w) => now - w.at < GIVE_UP_MS);
  for (const w of waiting.filter((x) => x.agent === agent && x.sid === sid)) {
    if (!replySeen(view, w.text)) continue;
    send(w.name, now - w.at);
    waiting = waiting.filter((x) => x !== w);
  }
}
