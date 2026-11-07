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

describe("リリースノート", () => {
  test("今の版の名前を引ける。版の番号は新しい順", async () => {
    const { RELEASE_NOTES, versionName } = await import("../src/shared/release-notes");
    expect(versionName("2.0.0")).toBe("さらなる高みへ");
    expect(versionName("9.9.9")).toBe("");
    const nums = RELEASE_NOTES.map((n) => Number(n.version));
    expect(nums).toEqual([...nums].sort((a, b) => b - a));
    for (const n of RELEASE_NOTES) expect(n.items.length).toBeGreaterThan(0);
  });
});

describe("変更の記録", () => {
  test("CHANGELOG.md は、リリースノートから作ったものと同じ", async () => {
    const { renderChangelog } = await import("../src/shared/release-notes");
    expect(await Bun.file("CHANGELOG.md").text()).toBe(renderChangelog());
  });
  test("既定の言語は日本語", async () => {
    const { lang } = await import("../src/web/i18n");
    expect(lang).toBe("ja");
  });
});
