import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import { applyMarks } from "../src/server/sessions";
import { Store } from "../src/server/store";
import type { SessionInfo } from "../src/shared/types";

const s = (id: string, last: number): SessionInfo => ({ agent: "default", id, title: `題 ${id}`, last, alive: true, working: false });

describe("セッションのピン留め・削除", () => {
  test("ピンは一番上（ピンした新しい順）、削除は一覧から外す、ほかは元の並び", () => {
    const store = new Store(":memory:");
    store.markSession("default", "c", { pinned: true, title: "題 c" });
    store.markSession("default", "b", { hidden: true });
    Bun.sleepSync(2);
    store.markSession("default", "d", { pinned: true });
    const out = applyMarks("default", [s("a", 5), s("b", 4), s("c", 3), s("d", 2), s("e", 1)], store.sessionMarks("default"));
    expect(out.map((x) => x.id)).toEqual(["d", "c", "a", "e"]);
    expect(out[0].pinnedAt).toBeNumber();
    expect(out[2].pinnedAt).toBeUndefined();
  });

  test("一覧（最新60件）から落ちたピンも、覚えておいた題名で出す", () => {
    const store = new Store(":memory:");
    store.markSession("default", "old", { pinned: true, title: "前の相談" });
    const out = applyMarks("default", [s("a", 5)], store.sessionMarks("default"));
    expect(out.map((x) => [x.id, x.title])).toEqual([["old", "前の相談"], ["a", "題 a"]]);
  });

  test("ピンを外す・削除するとピンも外れる・印が無くなれば行も消える", () => {
    const store = new Store(":memory:");
    store.markSession("default", "a", { pinned: true });
    store.markSession("default", "a", { hidden: true });
    expect(store.sessionMarks("default")).toMatchObject([{ id: "a", pinned_at: null }]);
    store.markSession("default", "a", { hidden: false });
    expect(store.sessionMarks("default")).toEqual([]);
    // エージェントごとに別
    store.markSession("dev", "a", { pinned: true });
    expect(store.sessionMarks("default")).toEqual([]);
  });

  test("API: mark で付けると一覧に効く", async () => {
    const store = new Store(":memory:");
    const sessions = { agents: () => [], list: async () => [s("a", 2), s("b", 1)] };
    const app = createApp({ devNoAuth: true } as never, { snapshot: () => ({}), subscribe: () => () => {} } as never, store, "/nonexistent", { sessions: sessions as never });
    const post = (id: string, body: unknown) => app.request(`/api/sessions/default/${id}/mark`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("b", { pinned: true, title: "題 b" })).status).toBe(200);
    expect((await post("a", {})).status).toBe(400);
    expect((await app.request("/api/sessions/BAD!/a/mark", { method: "POST", body: "{}" })).status).toBe(404);
    const list = (await (await app.request("/api/sessions/default")).json()) as { sessions: SessionInfo[] };
    expect(list.sessions.map((x) => x.id)).toEqual(["b", "a"]);
    await post("a", { hidden: true });
    const list2 = (await (await app.request("/api/sessions/default")).json()) as { sessions: SessionInfo[] };
    expect(list2.sessions.map((x) => x.id)).toEqual(["b"]);
  });

  test("題名の付け替え: 一覧はその題名、元の題名は originalTitle。null で元に戻し、印が無くなれば行も消える", () => {
    const store = new Store(":memory:");
    store.markSession("default", "a", { rename: "  請求書の相談  " });
    let out = applyMarks("default", [s("a", 2), s("b", 1)], store.sessionMarks("default"));
    expect(out[0]).toMatchObject({ id: "a", title: "請求書の相談", originalTitle: "題 a" });
    expect(out[1].originalTitle).toBeUndefined();
    // ピンして一覧から落ちても、付け替えた題名で出る
    store.markSession("default", "a", { pinned: true, title: "題 a" });
    out = applyMarks("default", [s("b", 1)], store.sessionMarks("default"));
    expect(out[0]).toMatchObject({ id: "a", title: "請求書の相談", originalTitle: "題 a" });
    store.markSession("default", "a", { rename: null, pinned: false });
    expect(store.sessionMarks("default")).toEqual([]);
  });

  test("API: rename だけでも受け付ける", async () => {
    const store = new Store(":memory:");
    const sessions = { agents: () => [], list: async () => [s("a", 2)] };
    const app = createApp({ devNoAuth: true } as never, { snapshot: () => ({}), subscribe: () => () => {} } as never, store, "/nonexistent", { sessions: sessions as never });
    const r = await app.request("/api/sessions/default/a/mark", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rename: "新しい名前" }) });
    expect(r.status).toBe(200);
    const list = (await (await app.request("/api/sessions/default")).json()) as { sessions: SessionInfo[] };
    expect(list.sessions[0].title).toBe("新しい名前");
  });
});
