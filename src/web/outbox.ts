// 送信中・送れなかった発言（楽観的表示）と、共有メニューから取り込んだ添付の置き場。
// 送信したらすぐ吹き出しを出し、サーバーが受け取ったら「送った」、失敗したら「送れなかった」と再送を出す。
import { useSyncExternalStore } from "react";
import type { SessionView } from "../shared/types";
import { type Progress, upload } from "./upload";
import { trackReply } from "./perf";

export interface Outgoing {
  key: string;
  agent: string;
  /** 新しいセッションの最初の発言は null。送れたらセッションの ID が入る */
  sid: string | null;
  text: string;
  files: File[];
  at: number;
  status: "sending" | "failed" | "sent";
  error?: string;
  /** 添付を送った割合（0〜1）。添付があるときだけ */
  progress?: number;
}

let items: Outgoing[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  items = [...items];
  for (const fn of listeners) fn();
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const patch = (key: string, p: Partial<Outgoing>) => {
  const o = items.find((x) => x.key === key);
  if (o) Object.assign(o, p);
  emit();
};

/** 送ったあと、画面に載るまでの間だけ残す時間（ms）。これを過ぎたら履歴に載っているはずなので出さない */
export const SENT_GRACE_MS = 30_000;

export async function postMessage(agent: string, id: string | null, text: string, files: File[], onProgress: Progress = () => {}): Promise<string> {
  let r: Response;
  if (files.length) {
    const fd = new FormData();
    fd.append("text", text);
    if (id) fd.append("id", id);
    for (const f of files) fd.append("files", f);
    // 添付は XHR で送って進み具合を出す
    const u = await upload(`/api/sessions/${agent}/send`, fd, onProgress);
    const b = u.json as { ok?: boolean; id?: string; error?: string };
    if (!u.ok || !b.ok || !b.id) throw new Error(b.error ?? `HTTP ${u.status}`);
    return b.id;
  } else {
    r = await fetch(`/api/sessions/${agent}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, text }),
    });
  }
  const body = (await r.json().catch(() => ({}))) as { ok?: boolean; id?: string; error?: string };
  if (!r.ok || !body.ok || !body.id) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body.id;
}

async function deliver(o: Outgoing): Promise<string | null> {
  patch(o.key, { status: "sending", error: undefined, ...(o.files.length ? { progress: 0 } : {}) });
  try {
    const sid = await postMessage(o.agent, o.sid, o.text, o.files, (p) => patch(o.key, { progress: p }));
    patch(o.key, { status: "sent", sid, at: Date.now() });
    return sid;
  } catch (e) {
    patch(o.key, { status: "failed", error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** 吹き出しを先に出して、裏で送る。送れたらセッションの ID、失敗したら null */
export function submit(agent: string, sid: string | null, text: string, files: File[]): Promise<string | null> {
  const now = Date.now();
  items = items.filter((x) => !(x.status === "sent" && now - x.at > SENT_GRACE_MS));
  const o: Outgoing = { key: `o${now}-${Math.random().toString(36).slice(2, 8)}`, agent, sid, text, files, at: now, status: "sending" };
  items.push(o);
  emit();
  const sent = trackReply(agent, sid, text);
  return deliver(o).then((got) => (sent(got), got));
}

export function retry(key: string): Promise<string | null> {
  const o = items.find((x) => x.key === key);
  return o ? deliver(o) : Promise.resolve(null);
}

export function discard(key: string) {
  items = items.filter((x) => x.key !== key);
  emit();
}

const snapshot = () => items;

/** このエージェント・セッション（sid が null なら「新しいセッション」）の送信中の発言 */
export function useOutgoing(agent: string, sid: string | null): Outgoing[] {
  const all = useSyncExternalStore(subscribe, snapshot);
  return all.filter((o) => o.agent === agent && o.sid === sid);
}

/** 履歴にもう載っている（= 吹き出しを二重に出さなくてよい）か */
/**
 * 履歴に載ったら、送信中の吹き出しは消す（二重に出さない）。
 * bridge は送った発言を先に記録してから返事をするので、「送っています…」の間に履歴に載ることがある。
 * そのときも、送り始めより後に記録された同じ発言があれば載ったとみなす。
 */
export function isDelivered(o: Outgoing, view: SessionView | null, now = Date.now()): boolean {
  if (o.status === "failed") return false;
  if (o.status === "sent" && now - o.at > SENT_GRACE_MS) return true;
  if (!view) return false;
  const t = o.text.trim();
  // 送信中は、送り始めの少し前より新しい記録だけを見る（前に同じ文を送っていても取り違えない）
  const since = o.at - (o.status === "sent" ? 120_000 : 10_000);
  if (view.kind === "terminal") return !!view.messages?.some((m) => m.author === "owner" && m.content.trim() === t && m.at >= since);
  // Hermes の履歴には時刻が無いことがあるので、送信中は最後の自分の発言だけを見る
  if (o.status === "sending") return view.messages.findLast((m) => m.role === "user" && !m.notice)?.text.trim().startsWith(t) ?? false;
  return view.messages.some((m) => m.role === "user" && !m.notice && m.text.trim().startsWith(t));
}

// ---- 共有メニューから取り込んだ添付（チャットの入力欄が受け取る） ----
let shared: { files: File[]; text: string; version: number } = { files: [], text: "", version: 0 };
const sharedListeners = new Set<() => void>();

export function offerShared(files: File[], text: string) {
  shared = { files: [...shared.files, ...files], text: [shared.text, text].filter(Boolean).join("\n"), version: shared.version + 1 };
  for (const fn of sharedListeners) fn();
}

/** 入力欄が取り込む。取り込んだ分は空にする */
export function takeShared(): { files: File[]; text: string } {
  const r = { files: shared.files, text: shared.text };
  shared = { files: [], text: "", version: shared.version };
  return r;
}

export function useSharedVersion(): number {
  return useSyncExternalStore(
    (fn) => {
      sharedListeners.add(fn);
      return () => void sharedListeners.delete(fn);
    },
    () => shared.version,
  );
}

export const imageUrl = (f: File) => (/^image\/(png|jpeg|gif|webp)$/.test(f.type) ? URL.createObjectURL(f) : null);
