// 承認画面で、文字を隠して中身をごまかせないようにする。
// 見えない文字・制御文字（ゼロ幅、双方向制御 U+202A–202E / 2066–2069、ESC など）は U+XXXX の札にして赤で、
// ASCII 以外の見える文字（全角・キリル文字の似せ文字など）はそのまま黄色の印をつけて表示する。
import type { ReactNode } from "react";

export type Seg = { kind: "text" | "hidden" | "nonascii"; text: string };

// 制御・書式・行/段落区切り・空白類（NBSP など）・私用/未割当/サロゲート・タグ文字・異体字選択子、
// 見た目が空白になる文字（ハングルのフィラー等）
const INVISIBLE = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\p{Co}\p{Cn}\p{Cs}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}͏ᅟᅠ឴឵᠋-᠏ㅤﾠ⠀]$/u;

export function kindOf(ch: string): Seg["kind"] {
  const c = ch.codePointAt(0)!;
  if (c === 0x0a || c === 0x09) return "text";
  if (c >= 0x20 && c <= 0x7e) return "text";
  if (c > 0x7e && !INVISIBLE.test(ch)) return "nonascii";
  return "hidden"; // 0x00–0x1f（\n \t 以外）・0x7f・不可視
}

export const label = (ch: string) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

/** 同じ種類が続く部分をまとめた区間にする。hidden は 1 文字ずつ（札の text に文字そのもの） */
export function reveal(s: string): Seg[] {
  const out: Seg[] = [];
  for (const ch of s) {
    const k = kindOf(ch);
    const last = out[out.length - 1];
    if (k !== "hidden" && last && last.kind === k) last.text += ch;
    else out.push({ kind: k, text: ch });
  }
  return out;
}

export function summarize(s: string): { hidden: number; nonascii: number } {
  let hidden = 0;
  let nonascii = 0;
  for (const ch of s) {
    const k = kindOf(ch);
    if (k === "hidden") hidden++;
    else if (k === "nonascii") nonascii++;
  }
  return { hidden, nonascii };
}

/** 本文の描画。折り返しは親の whitespace-pre-wrap break-all に任せる */
export function Revealed({ text }: { text: string }): ReactNode {
  return reveal(text).map((g, i) => {
    if (g.kind === "text") return g.text;
    if (g.kind === "nonascii")
      return (
        <mark key={i} data-kind="nonascii" className="rounded-sm bg-yellow-soft text-yellow-ink underline decoration-wavy">
          {g.text}
        </mark>
      );
    return (
      <mark key={i} data-kind="hidden" title={label(g.text)} className="mx-px rounded-sm bg-red-soft px-0.5 font-bold text-red-ink">
        ‹{label(g.text)}›
      </mark>
    );
  });
}

/** 「隠れた文字がある」「ASCII 以外がある」の警告。無ければ何も出さない */
export function RevealNote({ text }: { text: string }) {
  const { hidden, nonascii } = summarize(text);
  if (!hidden && !nonascii) return null;
  return (
    <div role="alert" className="rounded-lg border border-red-line bg-red-soft px-2.5 py-1.5 text-[11.5px] text-red-ink">
      {hidden > 0 && <>見えない文字・制御文字が {hidden} 個あります（赤い ‹U+XXXX›）。</>}
      {nonascii > 0 && <>ASCII 以外の文字が {nonascii} 個あります（黄色の波線）。似た形の別の文字でないか確かめてください。</>}
    </div>
  );
}
