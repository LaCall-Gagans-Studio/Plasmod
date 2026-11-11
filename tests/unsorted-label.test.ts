import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { TaskStore } from "../src/server/tasks";

describe("未仕訳の表示", () => {
  test("プロジェクトやタグを外したときの記録は「なし」ではなく「未仕訳」", () => {
    const tasks = new TaskStore(new Database(":memory:"), "TASK");
    const t = tasks.create({ title: "x", project: "仕事", tags: ["a"] }, "test");
    tasks.update(t.id, { project: null, tags: [] }, "test");
    const text = tasks.events(t.id).map((e) => e.text).join("\n");
    expect(text).toContain("プロジェクト → 未仕訳");
    expect(text).toContain("タグ → 未仕訳");
  });
});
