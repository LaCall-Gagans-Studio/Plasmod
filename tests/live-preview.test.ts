import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { buildLivePreview, focusEffect, memoExtensions } from "../src/web/live-preview";

const DOC = "# 見出し\n**太字** と `code`\n- 項目\n- [x] 済み\n[リンク](https://example.com)\n\n| a | b |\n|---|---|\n| 1 | 2 |";

/** 隠す範囲（中身が見えなくなる文字）と、行の class を集める */
function view(state: EditorState) {
  const hidden: string[] = [];
  const lines: string[] = [];
  const widgets: string[] = [];
  buildLivePreview(state).between(0, state.doc.length, (from, to, d) => {
    const spec = d.spec as { class?: string; widget?: { constructor: { name: string } } };
    if (spec.widget) widgets.push(`${spec.widget.constructor.name}:${state.doc.sliceString(from, to)}`);
    else if (from === to && spec.class) lines.push(`${state.doc.lineAt(from).number}:${spec.class}`);
    else if (!spec.class && from !== to) hidden.push(state.doc.sliceString(from, to));
  });
  return { hidden, lines, widgets };
}

const make = (cursor?: number) => {
  let s = EditorState.create({ doc: DOC, extensions: memoExtensions(() => {}, "") });
  if (cursor !== undefined) s = s.update({ effects: focusEffect.of(true), selection: EditorSelection.cursor(cursor) }).state;
  return s;
};

describe("ライブプレビュー", () => {
  test("フォーカスが無ければ、全部の行の記号を隠して整形する", () => {
    const v = view(make());
    expect(v.hidden).toEqual(expect.arrayContaining(["# ", "**", "`", "[", "](https://example.com)"]));
    expect(v.lines).toContain("1:cm-lp-h cm-lp-h1");
    expect(v.widgets).toEqual(expect.arrayContaining(["BulletWidget:-", "CheckWidget:- [x]", expect.stringMatching(/^TableWidget:\| a \| b \|/)]));
  });

  test("カーソルのある行だけ記号を見せる", () => {
    const v = view(make(2)); // 1行目（見出し）
    expect(v.hidden).not.toContain("# ");
    expect(v.hidden).toContain("**"); // 2行目はまだ隠れている
  });

  test("表の中にカーソルがあれば、表は Markdown のまま", () => {
    const s = make(DOC.indexOf("| 1"));
    const v = view(s);
    expect(v.widgets.some((w) => w.startsWith("TableWidget"))).toBe(false);
    expect(v.lines.filter((l) => l.endsWith("cm-lp-table-raw")).length).toBe(3);
  });
});
