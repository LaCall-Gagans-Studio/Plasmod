// 聞き続ける音声入力（v2.0 C）。止めるまで続ける。認識が切れたらつなぎ直す。
// APK は Android の音声認識（SpeechBridge）、ブラウザは Web Speech API。
export type DictationState = "off" | "listening" | "retrying";

export interface DictationEvents {
  /** 途中の文（確定で置き換わる） */
  onPartial?: (text: string) => void;
  /** 確定した文 */
  onFinal: (text: string) => void;
  onState?: (s: DictationState) => void;
  onError?: (message: string) => void;
}

export interface Dictation {
  start(): void;
  stop(): void;
}

interface NativeSpeech {
  available(): boolean;
  start(): void;
  stop(): void;
  keepAwake(on: boolean): void;
}

interface WebRecognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}
type WebCtor = new () => WebRecognition;

const win = () => window as unknown as {
  HermesSpeechNative?: NativeSpeech;
  __hermesSpeech?: (e: { type: string; text?: string; error?: string }) => void;
  SpeechRecognition?: WebCtor;
  webkitSpeechRecognition?: WebCtor;
};

export const NOT_ALLOWED = "マイクが許可されていない";

export function dictationAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const w = win();
  if (w.HermesSpeechNative) return w.HermesSpeechNative.available();
  return !!(w.SpeechRecognition ?? w.webkitSpeechRecognition);
}

function nativeDictation(n: NativeSpeech, ev: DictationEvents): Dictation {
  return {
    start() {
      win().__hermesSpeech = (e) => {
        if (e.type === "partial") ev.onPartial?.(e.text ?? "");
        else if (e.type === "final") ev.onFinal(e.text ?? "");
        else if (e.type === "listening") ev.onState?.("listening");
        else if (e.type === "retry") ev.onState?.("retrying");
        else if (e.type === "end") ev.onState?.("off");
        else if (e.type === "error") ev.onError?.(e.error === "not-allowed" ? NOT_ALLOWED : `音声入力のエラー: ${e.error}`);
      };
      n.start();
    },
    stop() {
      n.stop();
    },
  };
}

/** Web Speech API は数十秒で切れるので、止められるまで掛け直す */
export function webDictation(Ctor: WebCtor, ev: DictationEvents, schedule: (fn: () => void, ms: number) => void = setTimeout): Dictation {
  let wanted = false;
  let rec: WebRecognition | null = null;
  let failures = 0;
  const begin = () => {
    if (!wanted) return;
    const r = new Ctor();
    r.lang = "ja-JP";
    r.interimResults = true;
    r.continuous = true;
    r.onresult = (e) => {
      failures = 0;
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          if (t.trim()) ev.onFinal(t);
        } else interim += t;
      }
      ev.onPartial?.(interim);
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        wanted = false;
        ev.onError?.(NOT_ALLOWED);
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        failures++;
        ev.onState?.("retrying");
      }
    };
    r.onend = () => {
      if (!wanted) return ev.onState?.("off");
      schedule(begin, failures ? Math.min(5000, 500 * 2 ** (failures - 1)) : 100);
    };
    rec = r;
    r.start();
    ev.onState?.("listening");
  };
  return {
    start() {
      wanted = true;
      failures = 0;
      begin();
    },
    stop() {
      wanted = false;
      rec?.stop();
    },
  };
}

export function createDictation(ev: DictationEvents): Dictation | null {
  const w = win();
  if (w.HermesSpeechNative) return nativeDictation(w.HermesSpeechNative, ev);
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? webDictation(Ctor, ev) : null;
}

/** 画面を消さない。APK は窓の設定、ブラウザは Wake Lock。解除の関数を返す */
export async function keepAwake(): Promise<() => void> {
  const w = win();
  if (w.HermesSpeechNative) {
    w.HermesSpeechNative.keepAwake(true);
    return () => w.HermesSpeechNative?.keepAwake(false);
  }
  try {
    const lock = await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request("screen");
    return () => void lock?.release();
  } catch {
    return () => {};
  }
}
