import { describe, expect, test } from "bun:test";
import { checksState, DevService, devRequestText, GitHub, taskRefs, summarize } from "../src/server/dev";

const fakeGitHub = (routes: Record<string, unknown>, seen: string[] = []) =>
  new GitHub("tok", (async (url: string, init: RequestInit) => {
    const path = String(url).replace("https://api.github.com", "");
    seen.push(path);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const hit = Object.entries(routes).find(([k]) => path.startsWith(k));
    return hit ? Response.json(hit[1]) : new Response("nf", { status: 404 });
  }) as unknown as typeof fetch);

describe("Dev", () => {
  test("要約: 「変更点」の最初の2行。無ければ本文の頭", () => {
    expect(summarize("前置き\n## 変更点\n- **再試行**を直した\n- テストを足した\n- 3行目\n## 確認したこと\nx")).toBe("再試行を直した / テストを足した");
    expect(summarize("ただの本文")).toBe("ただの本文");
    expect(summarize(null)).toBe("");
  });

  test("タスク番号の参照", () => {
    expect(taskRefs("TASK-68 の修正", "Closes TASK-68, see P-TASK-4", "owner/task-1")).toEqual(["TASK-68", "P-TASK-4"]);
  });

  test("チェックの集計", () => {
    expect(checksState([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }], null)).toEqual({ state: "success", passed: 2, failed: 0, pending: 0 });
    expect(checksState([{ status: "in_progress" }], { statuses: [{ state: "success" }] }).state).toBe("pending");
    expect(checksState([{ status: "completed", conclusion: "failure" }], null).state).toBe("failure");
    expect(checksState([], null).state).toBe("none");
  });

  test("開いている PR を集める（読み取りだけ）", async () => {
    const seen: string[] = [];
    const gh = fakeGitHub({
      "/search/issues": { items: [{ number: 23, repository_url: "https://api.github.com/repos/example-org/demo-app" }] },
      "/repos/example-org/demo-app/pulls/23": {
        title: "TASK-68 再試行", html_url: "https://github.com/x/pull/23", user: { login: "example-dave[bot]" }, draft: false,
        updated_at: "2026-10-19T10:00:00Z", additions: 182, deletions: 47, changed_files: 6, body: "## 変更点\n- 再試行を直した", head: { sha: "abc", ref: "hermes/retry" },
      },
      "/repos/example-org/demo-app/commits/abc/check-runs": { check_runs: [{ status: "completed", conclusion: "success" }] },
      "/repos/example-org/demo-app/commits/abc/status": { statuses: [] },
      "/repos/example-org/demo-app/deployments?sha=abc": [{ id: 7, environment: "Preview" }],
      "/repos/example-org/demo-app/deployments/7/statuses": [{ state: "success", environment_url: "https://preview.example" }],
    }, seen);
    const svc = new DevService(gh, "example-org");
    const s = await svc.refresh();
    expect(s.error).toBeNull();
    expect(s.prs[0]).toMatchObject({
      repo: "example-org/demo-app", number: 23, additions: 182, files: 6, summary: "再試行を直した",
      refs: ["TASK-68"], checks: { state: "success" }, previewUrl: "https://preview.example",
    });
    expect(seen[0]).toContain(encodeURIComponent("org:example-org is:pr is:open"));
  });

  test("トークンが無ければ、理由つきで空", () => {
    expect(new DevService(null, "o").snapshot().error).toContain("PLASMOD_GITHUB_TOKEN");
  });

  test("GitHub のエラーは前回の内容を残して error に入れる", async () => {
    const svc = new DevService(fakeGitHub({}), "o");
    const s = await svc.refresh();
    expect(s.error).toContain("HTTP 404");
    expect(s.prs).toEqual([]);
  });

  test("開発くんへの依頼文: マージは承認を求めて進める・差し戻しは指摘つき", () => {
    const prs = [{ repo: "o/r", number: 1, url: "https://github.com/o/r/pull/1" }];
    expect(devRequestText("merge", prs, "")).toContain("1件ずつ承認を求めて");
    expect(devRequestText("merge", prs, "")).toContain("- o/r#1 https://github.com/o/r/pull/1");
    expect(devRequestText("revise", prs, "テストを足して")).toContain("指摘: テストを足して");
  });
});

describe("Dev の依頼 API", () => {
  test("知っている PR だけを開発くんに送る。差し戻しは指摘が必須", async () => {
    const { createApp } = await import("../src/server/app");
    const { config } = await import("../src/server/config");
    const sent: { agent: string; id: string | null; text: string }[] = [];
    const { Store } = await import("../src/server/store");
    const store = new Store(":memory:");
    const agentList = [{ id: "dev", available: true, runtime: "claude-code" }, { id: "default", available: true, runtime: "hermes" }];
    const sessions = { send: async (agent: string, id: string | null, text: string) => (sent.push({ agent, id, text }), "777"), agents: () => agentList };
    const dev = new DevService(null, "o");
    (dev as unknown as { cache: unknown }).cache = { prs: [{ repo: "o/r", number: 1, url: "u1" }], fetchedAt: 1, error: null };
    (dev as unknown as { gh: unknown }).gh = {};
    const app = createApp({ ...config, devNoAuth: true }, {} as never, store, ".", { sessions: sessions as never, dev });
    const post = (body: unknown) => app.request("/api/dev/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ action: "merge", prs: [{ repo: "o/r", number: 1 }] })).status).toBe(200);
    expect(sent[0]).toMatchObject({ agent: "dev", id: null });
    expect(sent[0].text).toContain("o/r#1 u1");
    expect((await post({ action: "merge", prs: [{ repo: "evil/x", number: 9 }] })).status).toBe(400);
    expect((await post({ action: "revise", prs: [{ repo: "o/r", number: 1 }], note: " " })).status).toBe(400);
    expect((await post({ action: "delete", prs: [{ repo: "o/r", number: 1 }] })).status).toBe(400);
    // 依頼先は設定で変えられる。いないエージェントは断る
    const patch = (agent: unknown) => app.request("/api/dev-settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent }) });
    expect((await patch("nobody")).status).toBe(400);
    expect((await patch("default")).status).toBe(200);
    expect(((await (await app.request("/api/dev-settings")).json()) as { agent: string }).agent).toBe("default");
    expect((await post({ action: "merge", prs: [{ repo: "o/r", number: 1 }] })).status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ agent: "default" });
    expect(sent.length).toBe(1);
  });
});
