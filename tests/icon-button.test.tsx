import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IconButton } from "../src/web/sheet";

describe("アイコンのボタン", () => {
  test("文字は出さず、説明（aria-label と title）を必ず付ける", () => {
    const html = renderToStaticMarkup(<IconButton name="trash" label="消す" onClick={() => {}} />);
    expect(html).toContain('aria-label="消す"');
    expect(html).toContain('title="消す"');
    expect(html).toContain("<svg");
    expect(html.replace(/<[^>]+>/g, "")).toBe("");
  });

  test("href があればリンク。外へ開くものは noopener を付ける", () => {
    const html = renderToStaticMarkup(<IconButton name="external" label="開く" href="https://example.com" external />);
    expect(html.startsWith("<a ")).toBe(true);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(renderToStaticMarkup(<IconButton name="download" label="保存" href="/x" download />)).toContain("download");
  });
});
