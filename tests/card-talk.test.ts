import { describe, expect, test } from "bun:test";
import { talkText } from "../src/web/CardView";
import type { Card } from "../src/shared/types";

describe("この件について話す", () => {
  const card = { key: "apptask:3", kind: "reply", agent: "default", title: "田中商事 請求書の件", body: "10/31 払い", statusLabel: "返信の要否", createdAt: 1, options: [], source: "mail", url: "https://mail.google.com/x", appTaskId: 3 } as Card;
  test("最初のメッセージにカードの中身と、書いたコメントを入れる", () => {
    const t = talkText(card, "払っていい？");
    // 1行目がセッションの題名になるので、カードの題名を先頭に
    expect(t.split("\n")[0]).toBe("田中商事 請求書の件（相談）");
    expect(t).toContain("種類: 返信の要否");
    expect(t).toContain("元: mail");
    expect(t).toContain("リンク: https://mail.google.com/x");
    expect(t).toContain("タスク: #3（Plasmod）");
    expect(t).toContain("---\n10/31 払い\n---");
    expect(t).toContain("オーナーから: 払っていい？");
    expect(talkText(card, "")).toContain("意見をください");
  });
});
