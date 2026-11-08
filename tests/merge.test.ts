import { describe, expect, test } from "bun:test";
import { GitHub } from "../src/server/dev";
import { MergeDesk, MergeError } from "../src/server/merge";
import { MemoSpool } from "../src/server/memo-spool";
import { MemoStore } from "../src/server/memos";
import { Store } from "../src/server/store";
import { TaskStore } from "../src/server/tasks";
import type { DevPr } from "../src/shared/types";

const HEAD = "a".repeat(40);
const pr = (extra: Partial<DevPr> = {}): DevPr => ({
  repo: "org/app", number: 7, title: "直す", url: "https://github.com/org/app/pull/7", sha: HEAD, author: "bot", draft: false, updatedAt: 0,
  additions: 1, deletions: 0, files: 1, summary: "", refs: [], checks: { state: "success", passed: 1, failed: 0, pending: 0 }, previewUrl: null, ...extra,
});

type Call = { method: string; path: string; body?: unknown };
function fakeGh(state: { head?: string; checks?: readonly unknown[]; mergeable?: boolean | null; mergeStatus?: number } = {}, calls: Call[] = []) {
  return new GitHub("tok", (async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace("https://api.github.com", "");
    const method = init.method ?? "GET";
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "PUT" && path === "/repos/org/app/pulls/7/merge") {
      const st = state.mergeStatus ?? 200;
      return Response.json(st === 200 ? { merged: true, sha: "b".repeat(40) } : { message: "Base branch was modified" }, { status: st });
    }
    if (path === "/repos/org/app/pulls/7") return Response.json({ state: "open", merged: false, draft: false, mergeable: state.mergeable ?? true, head: { sha: state.head ?? HEAD } });
    if (path.includes("/check-runs")) return Response.json({ check_runs: state.checks ?? [{ status: "completed", conclusion: "success" }] });
    if (path.endsWith("/status")) return Response.json({ statuses: [] });
    return new Response("nf", { status: 404 });
  }) as unknown as typeof fetch);
}

function setup(prs: DevPr[] = [pr()], gh: GitHub | null = fakeGh()) {
  const store = new Store(":memory:");
  const tasks = new TaskStore(store.db);
  tasks.syncPrs(prs, true, 1000);
  const desk = new MergeDesk(store.db, () => prs, tasks, gh, "squash");
  return { store, tasks, desk, task: () => tasks.bySource("github", "org/app#7")! };
}

describe("マージの承認", () => {
  test("依頼: 開いている PR だけ。下書き・違う commit は断る。同じ PR の古い依頼は置き換える", () => {
    const { desk, task } = setup([pr(), { ...pr({ number: 8, draft: true }) }]);
    const seen: string[] = [];
    desk.onRequest = (r) => seen.push(`${r.repo}#${r.number}`);
    expect(() => desk.request({ pr: "org/app#99" }, "dev")).toThrow(MergeError);
    expect(() => desk.request({ pr: "org/app#8" }, "dev")).toThrow("下書き");
    expect(() => desk.request({ pr: "org/app#7", sha: "bbbbbbb" }, "dev")).toThrow("違う commit");
    expect(() => desk.request({ pr: "org app#7" }, "dev")).toThrow("形");
    const r1 = desk.request({ pr: "org/app#7", sha: HEAD.slice(0, 7), note: "CI 通った" }, "dev", 2000);
    expect(r1).toMatchObject({ status: "pending", sha: HEAD, by: "dev", note: "CI 通った" });
    expect(task().status).toBe("inbox");
    desk.request({ pr: "org/app#7" }, "dev", 3000);
    expect(desk.pending()).toHaveLength(1);
    expect(desk.latest("org/app", 7)!.createdAt).toBe(3000);
    expect(seen).toEqual(["org/app#7", "org/app#7"]);
  });

  test("承認: 読み直して同じ commit・CI が通っていればマージし、タスクを済みにする", async () => {
    const calls: Call[] = [];
    const { desk, task } = setup([pr()], fakeGh({}, calls));
    desk.request({ pr: "org/app#7" }, "dev", 2000);
    const r = await desk.approve("org/app", 7, HEAD.slice(0, 7), "owner@github", 3000);
    expect(r.status).toBe("merged");
    expect(r.result).toContain("owner@github");
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ sha: HEAD, merge_method: "squash" });
    expect(task().status).toBe("done");
    expect(desk.pending()).toHaveLength(0);
  });

  test("承認の後に push された・CI が落ちている・走っている・コンフリクトなら、マージしない", async () => {
    for (const [state, msg] of [
      [{ head: "c".repeat(40) }, "新しい commit"],
      [{ checks: [{ status: "completed", conclusion: "failure" }] }, "CI が落ちている"],
      [{ checks: [{ status: "in_progress" }] }, "まだ走っている"],
      [{ mergeable: false }, "コンフリクト"],
    ] as const) {
      const calls: Call[] = [];
      const { desk } = setup([pr()], fakeGh(state, calls));
      desk.request({ pr: "org/app#7" }, "dev");
      await expect(desk.approve("org/app", 7, HEAD, "owner")).rejects.toThrow(msg);
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
      expect(desk.pending()).toHaveLength(1);
    }
  });

  test("GitHub に断られたら失敗として残す。トークンが無ければ承認できない", async () => {
    const { desk } = setup([pr()], fakeGh({ mergeStatus: 409 }));
    desk.request({ pr: "org/app#7" }, "dev");
    await expect(desk.approve("org/app", 7, HEAD, "owner")).rejects.toThrow("Base branch was modified");
    expect(desk.latest("org/app", 7)!.status).toBe("failed");
    const none = setup([pr()], null);
    expect(none.desk.enabled).toBe(false);
    await expect(none.desk.approve("org/app", 7, HEAD, "owner")).rejects.toThrow("PLASMOD_GITHUB_MERGE_TOKEN");
  });

  test("依頼なしでオーナーが押したときも記録する。差し戻しで依頼を閉じる", async () => {
    const { desk } = setup();
    const r = await desk.approve("org/app", 7, HEAD, "owner");
    expect(r).toMatchObject({ status: "merged", by: "owner" });
    const b = setup();
    b.desk.request({ pr: "org/app#7" }, "dev");
    expect(b.desk.reject("org/app", 7, "owner", "差し戻し: テスト")).toBe(1);
    expect(b.desk.latest("org/app", 7)!.status).toBe("rejected");
  });

  test("エージェントは受け渡しのフォルダから頼める", () => {
    const { store, desk } = setup();
    const spool = new MemoSpool(new MemoStore(store.db), "/nonexistent", new Map(), null, () => {}, null, desk);
    const r = spool.run("merge.request", { pr: "org/app#7", note: "お願い" }, "dev") as { enabled: boolean; request: { status: string; by: string } };
    expect(r.enabled).toBe(true);
    expect(r.request).toMatchObject({ status: "pending", by: "dev" });
    expect((spool.run("merge.status", { pr: "org/app#7" }, "dev") as { request: { status: string } }).request.status).toBe("pending");
  });
});
