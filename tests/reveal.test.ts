import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { kindOf, label, reveal, summarize, Revealed, RevealNote } from "../src/web/reveal";

const hiddenOf = (s: string) => reveal(s).filter((g) => g.kind === "hidden").map((g) => label(g.text));

describe("reveal", () => {
  test("ASCII と改行・タブはそのまま", () => {
    expect(reveal("echo hi\n\tls -l")).toEqual([{ kind: "text", text: "echo hi\n\tls -l" }]);
    expect(summarize("rm -rf /tmp/x\n")).toEqual({ hidden: 0, nonascii: 0 });
  });
  test("ゼロ幅・双方向制御・ESC・NUL・DEL・CR は札になる", () => {
    const s = "a​b‍c⁠d﻿e‮f‪g⁦h⁩i\x1bj\x00k\x7fl\rm";
    expect(hiddenOf(s)).toEqual([
      "U+200B", "U+200D", "U+2060", "U+FEFF", "U+202E", "U+202A", "U+2066", "U+2069", "U+001B", "U+0000", "U+007F", "U+000D",
    ]);
    expect(summarize(s).nonascii).toBe(0);
  });
  test("U+202A–202E と 2066–2069 はすべて hidden", () => {
    for (const c of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) expect(kindOf(String.fromCodePoint(c))).toBe("hidden");
  });
  test("空白に見える文字・C1・タグ文字・異体字選択子・フィラーも hidden", () => {
    for (const ch of [" ", "　", " ", "\u0085", " ", "ㅤ", "\u{E0041}", "️", "­", "᠎", "؜", "‎"]) expect(kindOf(ch)).toBe("hidden");
  });
  test("見える ASCII 以外は nonascii（似せ文字・日本語）", () => {
    expect(kindOf("а")).toBe("nonascii"); // キリル a
    expect(kindOf("ｒ")).toBe("nonascii"); // 全角
    const segs = reveal("rm -rf /tmp/сache あ");
    expect(segs.filter((g) => g.kind === "nonascii").map((g) => g.text)).toEqual(["с", "あ"]);
    expect(summarize("rm -rf /tmp/сache あ")).toEqual({ hidden: 0, nonascii: 2 });
  });
  test("サロゲートペア（絵文字）は 1 文字として数える", () => {
    expect(summarize("😀")).toEqual({ hidden: 0, nonascii: 1 });
  });
  test("描画: 札と警告が出て、隠れた文字そのものは出ない", () => {
    const html = renderToStaticMarkup(createElement(Revealed, { text: "ok‮evil" }));
    expect(html).toContain("‹U+202E›");
    expect(html).not.toContain("‮");
    const note = renderToStaticMarkup(createElement(RevealNote, { text: "a​b、с" }));
    expect(note).toContain("1 個");
    expect(renderToStaticMarkup(createElement(RevealNote, { text: "plain" }))).toBe("");
  });
});
