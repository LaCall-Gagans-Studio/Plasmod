import { describe, expect, test } from "bun:test";
import { continueList } from "../src/web/list-continue";

const at = (s: string, i = s.length) => continueList(s, i, i);

describe("continueList", () => {
  test("箇条書きは次の項目を始める", () => {
    expect(at("- りんご")).toEqual({ value: "- りんご\n- ", caret: 8 });
    expect(at("  * a")?.value).toBe("  * a\n  * ");
  });
  test("番号付きは次の番号を補う", () => {
    expect(at("1. a")?.value).toBe("1. a\n2. ");
    expect(at("9) a")?.value).toBe("9) a\n10) ");
  });
  test("空の項目で Enter するとリストを終える", () => {
    expect(at("- a\n- ")).toEqual({ value: "- a\n", caret: 4 });
    expect(at("1. ")).toEqual({ value: "", caret: 0 });
  });
  test("途中で Enter すると後ろの文字が次の項目に移る", () => {
    expect(continueList("- abcd", 4, 4)).toEqual({ value: "- ab\n- cd", caret: 7 });
  });
  test("リスト以外・範囲選択・印の左は何もしない", () => {
    expect(at("hello")).toBeNull();
    expect(at("-a")).toBeNull();
    expect(continueList("- a", 0, 3)).toBeNull();
    expect(continueList("- a", 1, 1)).toBeNull();
  });
});
