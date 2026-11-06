import { describe, expect, test } from "bun:test";
import { EN } from "../src/web/i18n-en";
import { translate } from "../src/web/i18n";

describe("言語", () => {
  test("辞書の値は空でない", () => {
    for (const [k, v] of Object.entries(EN)) expect(`${k}=${v.trim() ? "ok" : "空"}`).toBe(`${k}=ok`);
  });
  test("日本語はそのまま、英語は辞書から、辞書に無ければ日本語のまま", () => {
    expect(translate("チャット", "ja")).toBe("チャット");
    expect(translate("チャット", "en")).toBe("Chat");
    expect(translate("辞書に無い文言", "en")).toBe("辞書に無い文言");
  });
});
