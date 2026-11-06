import { describe, expect, test } from "bun:test";
import type { SessionView } from "../src/shared/types";
import { isDelivered, type Outgoing, SENT_GRACE_MS } from "../src/web/outbox";

const out = (p: Partial<Outgoing> = {}): Outgoing => ({ key: "k", agent: "dev", sid: "42", text: "進めて", files: [], at: 1_000_000, status: "sent", ...p });
const terminal = (content: string, at: number): SessionView => ({
  kind: "terminal", text: "", alive: true, working: false,
  messages: [{ id: "1", author: "owner", content, attachments: [], at }],
});

describe("送信中の吹き出し（二重表示の判定）", () => {
  // ChatMessage.at はミリ秒（sessions.ts の toChat で直している）
  test("失敗は常に出し続ける。送信中でも、送り始めより後に同じ発言が記録されたら引っ込める", () => {
    expect(isDelivered(out({ status: "failed" }), terminal("進めて", 1_000_500))).toBe(false);
    expect(isDelivered(out({ status: "sending" }), terminal("進めて", 1_000_500))).toBe(true);
    expect(isDelivered(out({ status: "sending" }), terminal("別の話", 1_000_500))).toBe(false);
    // 前に同じ文を送っていても、それでは引っ込めない
    expect(isDelivered(out({ status: "sending" }), terminal("進めて", 900_000))).toBe(false);
  });

  test("開発くん: 履歴に同じ発言が載ったら引っ込める。載るまでは出す", () => {
    expect(isDelivered(out(), terminal("別の話", 1_000_500), 1_005_000)).toBe(false);
    expect(isDelivered(out(), terminal("進めて", 1_000_500), 1_005_000)).toBe(true);
    expect(isDelivered(out(), null, 1_005_000)).toBe(false);
  });

  test("古い同文の発言では引っ込めない", () => {
    expect(isDelivered(out({ at: 10_000_000 }), terminal("進めて", 100_000), 10_005_000)).toBe(false);
  });

  test("Hermes: 添付のパスが後ろに付いても一致する。送信中は最後の自分の発言だけを見る", () => {
    const v: SessionView = { kind: "chat", alive: true, working: false, messages: [{ role: "user", text: "進めて\n\n[添付ファイル]\n/x/a.pdf" }] };
    expect(isDelivered(out({ agent: "default" }), v, 1_005_000)).toBe(true);
    expect(isDelivered(out({ agent: "default", status: "sending" }), v, 1_005_000)).toBe(true);
    const older: SessionView = { ...v, messages: [{ role: "user", text: "進めて" }, { role: "assistant", text: "了解" }, { role: "user", text: "別の話" }] };
    expect(isDelivered(out({ agent: "default", status: "sending" }), older, 1_005_000)).toBe(false);
  });

  test("いつまでも載らなくても、猶予を過ぎたら出さない（出しっぱなしを防ぐ）", () => {
    expect(isDelivered(out(), null, 1_000_000 + SENT_GRACE_MS + 1)).toBe(true);
  });
});
