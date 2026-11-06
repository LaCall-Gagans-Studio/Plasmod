import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { config } from "../src/server/config";
import { Hub } from "../src/server/hub";
import { FixtureSource } from "../src/server/kanban";
import { MemoStore } from "../src/server/memos";
import { Store } from "../src/server/store";
import { TaskStore } from "../src/server/tasks";
import { buildLivePreview, focusEffect, memoExtensions } from "../src/web/live-preview";

const widgets = (s: EditorState) => {
  const out: string[] = [];
  buildLivePreview(s).between(0, s.doc.length, (from, to, d) => {
    const w = (d.spec as { widget?: { constructor: { name: string } } }).widget;
    if (w) out.push(`${w.constructor.name}:${s.doc.sliceString(from, to)}`);
  });
  return out;
};

describe("メモとタスクのつながり（エディタ）", () => {
  const DOC = "- [ ] 牛乳を買う\n関連 [[TASK-5]] を見る";
  test("[[TASK-5]] はカーソルの無い行でチップに。カーソルがあれば文字のまま", () => {
    const s = EditorState.create({ doc: DOC, extensions: memoExtensions(() => {}, "") });
    expect(widgets(s)).toContain("TaskRefWidget:[[TASK-5]]");
    const on = s.update({ effects: focusEffect.of(true), selection: EditorSelection.cursor(DOC.indexOf("[[") + 2) }).state;
    expect(widgets(on).some((w) => w.startsWith("TaskRefWidget"))).toBe(false);
  });

  test("チェックの行にカーソルがあると「タスクにする」。タスクにする関数が無い・もう番号がある行には出さない", () => {
    const mk = async () => "TASK-9";
    const s = EditorState.create({ doc: DOC, extensions: memoExtensions(() => {}, "", mk) });
    const on = s.update({ effects: focusEffect.of(true), selection: EditorSelection.cursor(3) }).state;
    expect(widgets(on)).toContain("TaskifyWidget:");
    const none = EditorState.create({ doc: DOC, extensions: memoExtensions(() => {}, "") }).update({ effects: focusEffect.of(true), selection: EditorSelection.cursor(3) }).state;
    expect(widgets(none).some((w) => w.startsWith("TaskifyWidget"))).toBe(false);
    const done = EditorState.create({ doc: "- [ ] 牛乳 [[TASK-9]]", extensions: memoExtensions(() => {}, "", mk) }).update({ effects: focusEffect.of(true), selection: EditorSelection.cursor(3) }).state;
    expect(widgets(done).some((w) => w.startsWith("TaskifyWidget"))).toBe(false);
  });
});

describe("タスクに触れているメモ（API）", () => {
  test("本文に [[番号]] があるメモだけが出る（TASK-1 と TASK-12 を取り違えない）", async () => {
    const store = new Store(":memory:");
    const memos = new MemoStore(store.db);
    const tasks = new TaskStore(store.db);
    const hub = new Hub({ ...config, devNoAuth: true }, new FixtureSource(join(import.meta.dir, "../fixtures/board.json")), store, null, null);
    const app = createApp({ ...config, devNoAuth: true }, hub, store, ".", { memos, tasks });
    const t = tasks.create({ title: "x" }, "app");
    for (let i = 0; i < 11; i++) tasks.create({ title: `y${i}` }, "app");
    memos.create({ title: "触れている", body: `進め方は [[${t.ref}]] を見る` }, "app");
    memos.create({ title: "別", body: "[[TASK-12]]" }, "app");
    const d = await (await app.request(`/api/apptasks/${t.id}`)).json();
    expect(t.ref).toBe("TASK-1");
    expect(d.memos.map((m: { title: string }) => m.title)).toEqual(["触れている"]);
  });
});
