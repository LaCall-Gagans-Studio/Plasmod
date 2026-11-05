// 音声メモの専用画面（v2.0 C2）。真ん中の大きなマイクを押している間、止まらずに聞き続ける。
// スマホを机に置いて話し続けられるように、画面は消さない。話した分は端末に残してからサーバーへ送る。
import { useEffect, useRef, useState } from "react";
import type { Memo } from "../shared/types";
import { createDictation, type Dictation, type DictationState, keepAwake } from "./dictation";
import { haptic, toast } from "./touch";
import { type VoiceApi, VoiceDraft } from "./voice-draft";

const SAVE_EVERY_MS = 3000;

async function memoJson(res: Response): Promise<{ id: number; updatedAt: number }> {
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  const m = (await res.json()) as Memo;
  return { id: m.id, updatedAt: m.updatedAt };
}

const api: VoiceApi = {
  create: async (title, body) => memoJson(await fetch("/api/memos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, body, tags: ["音声"] }) })),
  update: async (id, body, baseUpdatedAt) => memoJson(await fetch(`/api/memos/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body, baseUpdatedAt }) })),
};

const stampTitle = () => `音声メモ ${new Date().toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function VoiceMemo() {
  const draft = useRef<VoiceDraft | null>(null);
  draft.current ??= new VoiceDraft(api, localStorage, stampTitle());
  const d = draft.current;
  const [body, setBody] = useState(d.state.body);
  const [partial, setPartial] = useState("");
  const [state, setState] = useState<DictationState>("off");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<"saved" | "saving" | "pending">(d.dirty ? "pending" : "saved");
  const [elapsed, setElapsed] = useState(0);
  const rec = useRef<Dictation | null>(null);
  const wantOn = useRef(false);
  const startedAt = useRef(0);
  const release = useRef<() => void>(() => {});
  const bottom = useRef<HTMLDivElement>(null);

  const save = async () => {
    if (!d.dirty) return true;
    setSaved("saving");
    const ok = await d.save();
    setSaved(ok ? "saved" : "pending");
    return ok;
  };

  useEffect(() => {
    rec.current = createDictation({
      onPartial: setPartial,
      onFinal: (t) => {
        d.append(t);
        setBody(d.state.body);
        setPartial("");
        setSaved("pending");
      },
      onState: (s) => {
        setState(s);
        if (s === "off") wantOn.current = false;
      },
      onError: (m) => {
        wantOn.current = false;
        release.current();
        setState("off");
        setError(m);
        haptic("error");
      },
    });
    const t = setInterval(() => {
      void save();
      if (wantOn.current) setElapsed(Date.now() - startedAt.current);
    }, SAVE_EVERY_MS);
    return () => {
      clearInterval(t);
      rec.current?.stop();
      release.current();
      void d.save();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [body, partial]);

  const toggle = async () => {
    haptic("tap");
    if (wantOn.current) {
      wantOn.current = false;
      rec.current?.stop();
      release.current();
      setState("off");
      void save();
      return;
    }
    setError(null);
    wantOn.current = true;
    startedAt.current = Date.now() - elapsed;
    rec.current?.start();
    release.current = await keepAwake();
  };

  const finish = async () => {
    wantOn.current = false;
    rec.current?.stop();
    release.current();
    const ok = await save();
    if (!ok) return toast("まだ送れていない。つながったらまた押してください（端末には残っています）", "error");
    const id = d.state.memoId;
    d.finish();
    location.hash = id ? `#/memo/${id}` : "#/memos";
  };

  const on = wantOn.current && state !== "off";
  const status = error ?? (state === "retrying" ? "つなぎ直しています…" : on ? "聞いています" : body ? "止めています" : "押すと聞き始めます");

  return (
    <div className="mx-auto flex h-full max-w-[640px] flex-col px-4 pb-[max(env(safe-area-inset-bottom),18px)] pt-[max(env(safe-area-inset-top),12px)]">
      <header className="flex items-center justify-between text-[12.5px] text-mute">
        <a href="#/memos" className="min-h-9 py-2 text-mute no-underline">‹ メモ</a>
        <span aria-live="polite">{saved === "saved" ? (d.state.memoId ? "保存済み" : "") : saved === "saving" ? "保存中…" : "端末に保存（送信待ち）"}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap py-3 text-[15px] leading-7 text-ink">
        {body}
        {partial && <span className="text-mute">{body ? "\n" : ""}{partial}</span>}
        <div ref={bottom} />
      </div>
      <div className="flex flex-col items-center gap-3 pb-2 pt-3">
        <div className={`text-[13px] ${error ? "text-orange-ink" : "text-mute"}`} role="status">{status}{on ? ` · ${clock(elapsed)}` : ""}</div>
        <button
          onClick={() => void toggle()}
          aria-pressed={on}
          aria-label={on ? "音声入力を止める" : "音声入力を始める"}
          className={`flex size-36 items-center justify-center rounded-full ${on ? "gh-listening bg-orange text-white" : "bg-ink text-ground"}`}
        >
          <svg width={56} height={56} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        </button>
        <button onClick={() => void finish()} disabled={!body} className="min-h-11 rounded-full border border-line-2 px-6 text-[14px] font-semibold text-ink-2 disabled:opacity-40">
          終えてメモを開く
        </button>
      </div>
    </div>
  );
}
