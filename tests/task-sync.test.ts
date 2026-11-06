import { describe, expect, test } from "bun:test";
import { Store } from "../src/server/store";
import { closingRefs, TaskSync } from "../src/server/task-sync";
import { TaskStore } from "../src/server/tasks";

const fresh = () => new TaskStore(new Store(":memory:").db);

describe("PR のマージでタスクを完了にする", () => {
  test("Closes / Fixes / Resolves だけ拾う（Refs は閉じない）", () => {
    expect(closingRefs("Closes TASK-12\nfixes: task-3 と Refs TASK-9、Resolved TASK-7", "TASK")).toEqual(["TASK-12", "TASK-3", "TASK-7"]);
    expect(closingRefs("P-TASK-4 close TASK", "TASK")).toEqual([]);
  });

  test("TaskSync: マージされた PR の Closes で完了にする", async () => {
    const s = fresh();
    const t = s.create({ title: "a" }, "app");
    const seen: string[] = [];
    const github = {
      get: async (path: string) => {
        seen.push(decodeURIComponent(path));
        return { items: [{ title: "直す", body: `Closes ${t.ref}`, number: 70, html_url: "https://github.com/o/r/pull/70", repository_url: "https://api.github.com/repos/o/r" }] };
      },
    };
    const sync = new TaskSync(s, github, { owner: "o", teamKey: "TASK", closeByPr: true });
    await sync.runAll(10_000_000);
    expect(seen[0]).toContain("is:pr is:merged org:o merged:>=");
    expect(s.get(t.id)!.status).toBe("done");
    expect(s.events(t.id)[0].text).toContain("PR r#70 がマージされた");
    expect(sync.prStatus).toMatchObject({ ok: true, counts: { closed: 1 } });
  });

  test("失敗は状態に残し、止まらない", async () => {
    const sync = new TaskSync(fresh(), { get: async () => { throw new Error("GitHub: 認証"); } }, { owner: "o", teamKey: "TASK", closeByPr: true });
    await sync.runAll();
    expect(sync.prStatus).toMatchObject({ ok: false, error: "GitHub: 認証" });
  });
});
