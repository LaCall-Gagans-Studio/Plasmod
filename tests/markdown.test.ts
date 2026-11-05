import { describe, expect, test } from "bun:test";
import { parseBlocks, parseChoices, splitLinks, splitRow } from "../src/web/markdown";

describe("返事の Markdown（表・コード）", () => {
  test("表を取り出す。前後の文章は残る", () => {
    const b = parseBlocks("今月の集計です\n\n| 項目 | 金額 |\n|:--|--:|\n| 交通費 | 1,200 |\n| 宿 | 8,000 |\n\n以上");
    expect(b.map((x) => x.type)).toEqual(["text", "table", "text"]);
    const t = b[1];
    if (t.type !== "table") throw new Error("table");
    expect(t.head).toEqual(["項目", "金額"]);
    expect(t.align).toEqual(["left", "right"]);
    expect(t.rows).toEqual([["交通費", "1,200"], ["宿", "8,000"]]);
  });

  test("外側の | が無い表、足りないセル、エスケープした |", () => {
    const b = parseBlocks("a | b | c\n--- | --- | ---\n1 | 2\nx \\| y | 3 | 4");
    const t = b[0];
    if (t.type !== "table") throw new Error("table");
    expect(t.rows).toEqual([["1", "2", ""], ["x | y", "3", "4"]]);
    expect(splitRow("| a | b |")).toEqual(["a", "b"]);
  });

  test("表でないもの（区切り行が無い・列が1つ）は文章のまま", () => {
    expect(parseBlocks("a | b\nc | d").map((x) => x.type)).toEqual(["text"]);
    expect(parseBlocks("| a |\n|---|\n| 1 |").map((x) => x.type)).toEqual(["text"]);
    expect(parseBlocks("ls | grep x").map((x) => x.type)).toEqual(["text"]);
  });

  test("コードの囲み。閉じていなければ文章のまま", () => {
    const b = parseBlocks("実行:\n```bash\nls -la\n```\nおわり");
    expect(b).toEqual([{ type: "text", text: "実行:" }, { type: "code", lang: "bash", text: "ls -la" }, { type: "text", text: "おわり" }]);
    expect(parseBlocks("```\n閉じない").map((x) => x.type)).toEqual(["text"]);
  });
});

describe("リンク", () => {
  test("むき出しの URL。後ろの句読点・閉じ括弧は含めない", () => {
    expect(splitLinks("PR です: https://github.com/a/b/pull/49。確認して")).toEqual([
      { text: "PR です: " },
      { text: "https://github.com/a/b/pull/49", href: "https://github.com/a/b/pull/49" },
      { text: "。確認して" },
    ]);
    expect(splitLinks("（https://example.com/x）")).toEqual([{ text: "（" }, { text: "https://example.com/x", href: "https://example.com/x" }, { text: "）" }]);
    expect(splitLinks("see https://example.com/a.")).toEqual([{ text: "see " }, { text: "https://example.com/a", href: "https://example.com/a" }, { text: "." }]);
  });

  test("括弧を含む URL と、[名前](URL) の形", () => {
    expect(splitLinks("https://ja.wikipedia.org/wiki/X_(y)")[0].href).toBe("https://ja.wikipedia.org/wiki/X_(y)");
    expect(splitLinks("[PR #49](https://github.com/a/b/pull/49) を見て")).toEqual([
      { text: "PR #49", href: "https://github.com/a/b/pull/49" },
      { text: " を見て" },
    ]);
  });

  test("http(s) 以外はリンクにしない", () => {
    expect(splitLinks("javascript:alert(1) と [x](javascript:alert(1))").every((p) => !p.href)).toBe(true);
  });
});

describe("見出し・箇条書き・選択肢", () => {
  test("見出しと箇条書き（入れ子・番号・チェック・続きの行）", () => {
    const b = parseBlocks("## 候補\n- 宿 A\n  - 朝食つき\n  続きの行\n- [x] 予約した\n\n1. 一つ目\n2. 二つ目\n本文");
    expect(b).toEqual([
      { type: "heading", level: 2, text: "候補" },
      { type: "list", ordered: false, start: 1, items: [{ text: "宿 A", depth: 0 }, { text: "朝食つき\n続きの行", depth: 1 }, { text: "予約した", depth: 0, checked: true }] },
      { type: "list", ordered: true, start: 1, items: [{ text: "一つ目", depth: 0 }, { text: "二つ目", depth: 0 }] },
      { type: "text", text: "本文" },
    ]);
  });

  test("# の後に空白が無いもの（#123）は見出しにしない", () => {
    expect(parseBlocks("#123 を見て").map((x) => x.type)).toEqual(["text"]);
  });

  test("```choices は選択肢、multi で複数選択。中身が空ならコードのまま", () => {
    expect(parseBlocks("どれにする？\n```choices\n- A 案 — 速い\n- B 案 -- 安い\n- C 案\n- A 案\n```")).toEqual([
      { type: "text", text: "どれにする？" },
      { type: "choices", multi: false, options: [{ label: "A 案", description: "速い" }, { label: "B 案", description: "安い" }, { label: "C 案" }] },
    ]);
    expect(parseBlocks("```choices multi\n- x\n- y\n```")[0]).toMatchObject({ type: "choices", multi: true });
    expect(parseBlocks("```choices\n\n```")[0]).toMatchObject({ type: "code", lang: "choices" });
    expect(parseChoices("1. one\n2) two")).toEqual([{ label: "one" }, { label: "two" }]);
  });
});
