// 入力欄のマイク。APK は Android の音声認識、ブラウザは Web Speech API。使えない端末ではボタンを出さない。
import { useEffect, useRef, useState } from "react";
import { createDictation, type Dictation, dictationAvailable } from "./dictation";
import { haptic, toast } from "./touch";

/** 押すと聞き取りを始め、もう一度押すまで続ける。確定した文を onText に渡す */
export function MicButton({ onText, size = 40 }: { onText: (text: string) => void; size?: number }) {
  const [on, setOn] = useState(false);
  const rec = useRef<Dictation | null>(null);
  const text = useRef(onText);
  text.current = onText;
  useEffect(() => () => rec.current?.stop(), []);
  if (!dictationAvailable()) return null;

  const toggle = () => {
    haptic("tap");
    if (on) {
      rec.current?.stop();
      setOn(false);
      return;
    }
    rec.current ??= createDictation({
      onFinal: (t) => text.current(t),
      onState: (s) => s === "off" && setOn(false),
      onError: (m) => {
        toast(m, "error");
        setOn(false);
      },
    });
    setOn(true);
    rec.current?.start();
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={on ? "音声入力を止める" : "音声で入力"}
      aria-pressed={on}
      className={`flex flex-none items-center justify-center rounded-full border ${on ? "gh-listening border-orange bg-orange/20 text-orange-ink" : "border-line-2 text-ink"}`}
      style={{ width: size, height: size }}
    >
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </svg>
    </button>
  );
}
