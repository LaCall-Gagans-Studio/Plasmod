// 待っている言葉の「…」を、一点ずつ現れる3つの点にする。動きを減らす設定では止まった「…」
import type { ReactNode } from "react";

export function Dots() {
  return (
    <span className="pl-dots" aria-hidden="true">
      <i>.</i>
      <i>.</i>
      <i>.</i>
    </span>
  );
}

/** 「保存しています…」のような言葉なら、最後の「…」（か ...）を動く点にする。ほかはそのまま */
export function ing(text: string): ReactNode {
  const m = text.match(/^(.*?)(…|\.\.\.)$/s);
  if (!m) return text;
  return (
    <>
      {m[1]}
      <Dots />
      <span className="sr-only">…</span>
    </>
  );
}

/** 考え中・作業中の小さなアメーバ（行の頭に置く。文字と同じ高さ） */
export function MiniAmoeba({ className = "" }: { className?: string }) {
  return (
    <span className={`pl-mini ${className}`} aria-hidden="true">
      <span className="pl-mini-body" />
      <span className="pl-mini-arm" />
      <span className="pl-mini-eye" />
    </span>
  );
}
