import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SearchIndex } from "../src/server/search";
import { SessionIndexer, type TranscriptSource } from "../src/server/session-index";
import type { SessionInfo } from "../src/shared/types";
import type { SessionMark } from "../src/server/store";

const info = (p: Partial<SessionInfo> & { id: string; last: number }): SessionInfo => ({ agent: "default", title: "題名", alive: false, working: false, ...p });

function setup() {
  const search = new SearchIndex(new Database(":memory:"));
  const lists: Record<string, SessionInfo[]> = { default: [], dev: [] };
  const texts: Record<string, string> = {};
  const reads: string[] = [];
  const marks: Record<string, SessionMark[]> = {};
  const source: TranscriptSource = {
    agents: () => [{ id: "default", available: true }, { id: "dev", available: true }, { id: "gone", available: false }],
    list: async (a) => lists[a],
    transcript: async (a, id) => {
      reads.push(`${a}/${id}`);
      if (texts[id] === undefined) throw new Error("読めない");
      return texts[id];
    },
  };
  return { search, lists, texts, reads, marks, ix: new SessionIndexer(source, search, (a) => marks[a] ?? [], 0) };
}

describe("会話の索引", () => {
  test("発言が検索に出る。新しい発言が無ければ読み直さない。増えたら入れ直す", async () => {
    const { search, lists, texts, reads, ix } = setup();
    lists.default = [info({ id: "s1", last: 10, title: "請求の相談" })];
    lists.dev = [info({ agent: "dev", id: "42", last: 20 })];
    texts.s1 = "東京の見積もりについて";
    texts["42"] = "ビルドが落ちた";
    expect(await ix.run()).toBe(2);
    expect(search.search("見積もり")).toMatchObject([{ kind: "session", ref: "default/s1", title: "請求の相談" }]);
    expect(search.search("ビルド")[0].ref).toBe("dev/42");

    reads.length = 0;
    expect(await ix.run()).toBe(0);
    expect(reads).toEqual([]);

    lists.default = [info({ id: "s1", last: 30, title: "請求の相談" })];
    texts.s1 = "東京の見積もりについて\n大阪の請求書も";
    await ix.run();
    expect(reads).toEqual(["default/s1"]);
    expect(search.search("大阪")).toHaveLength(1);
    expect(search.search("見積もり")).toHaveLength(1); // 1セッション1件のまま
  });

  test("cron の回は入れない。一覧から削除したものは外す", async () => {
    const { search, lists, texts, marks, ix } = setup();
    lists.default = [info({ id: "c", last: 1, cron: true }), info({ id: "h", last: 1 })];
    texts.c = "定期報告の本文";
    texts.h = "消す予定の会話";
    await ix.run();
    expect(search.search("定期報告")).toEqual([]);
    expect(search.search("消す予定")).toHaveLength(1);
    marks.default = [{ id: "h", hidden_at: 5 } as unknown as SessionMark];
    await ix.run();
    expect(search.search("消す予定")).toEqual([]);
  });

  test("読めないセッションがあっても他は進み、次の周でまた試す", async () => {
    const { search, lists, texts, reads, ix } = setup();
    lists.default = [info({ id: "bad", last: 1 }), info({ id: "ok", last: 1 })];
    texts.ok = "読める会話";
    await ix.run();
    expect(search.search("読める会話")).toHaveLength(1);
    reads.length = 0;
    texts.bad = "直った会話";
    await ix.run();
    expect(reads).toEqual(["default/bad"]);
    expect(search.search("直った会話")).toHaveLength(1);
  });
});
