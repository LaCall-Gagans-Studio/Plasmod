import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { config } from "../src/server/config";
import { Hub } from "../src/server/hub";
import { FixtureSource } from "../src/server/kanban";
import { Store } from "../src/server/store";
import { SystemService } from "../src/server/system";
import type { AgentInfo, TaskDetail } from "../src/shared/types";

const FIXTURE = join(import.meta.dir, "../fixtures/board.json");

async function setup() {
  const store = new Store(":memory:");
  const source = new FixtureSource(FIXTURE);
  const hub = new Hub(config, source, store, null, null);
  await hub.refresh();
  return { app: createApp({ ...config, devNoAuth: true }, hub, store, "."), source };
}

describe("カードの詳細", () => {
  test("詳細を返し、コメントとファイルを付けられる", async () => {
    const { app, source } = await setup();
    const d = (await (await app.request("/api/tasks/t_8f2a")).json()) as TaskDetail;
    expect(d.task.title).toContain("PR #23");
    expect(d.comments.length).toBe(1);

    const r = await app.request("/api/tasks/t_8f2a/comment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: " 金額も見て " }) });
    const b = (await r.json()) as { ok: boolean; detail: TaskDetail };
    expect(b.ok).toBe(true);
    expect(b.detail.comments.at(-1)).toMatchObject({ author: "owner", body: "金額も見て" });

    const fd = new FormData();
    fd.append("text", "");
    fd.append("files", new File(["PNG"], "画面.png", { type: "image/png" }));
    expect((await app.request("/api/tasks/t_8f2a/comment", { method: "POST", body: fd })).status).toBe(200);
    expect(source.log.slice(-2)).toEqual(["attach t_8f2a 画面.png 3", "comment t_8f2a 📎 画面.png"]);
  });

  test("不正な ID・空のコメントは受けない", async () => {
    const { app } = await setup();
    expect((await app.request("/api/tasks/..%2Fx")).status).toBe(400);
    expect((await app.request("/api/tasks/t_nope")).status).toBe(500);
    expect((await app.request("/api/tasks/t_8f2a/comment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "  " }) })).status).toBe(400);
  });
});

describe("システムのエージェント", () => {
  test("開発くんは bridge、Hermes は仲介から。ファイルとスキルは読む場所付き", async () => {
    const bridge = {
      connected: true,
      request: async (o: Record<string, unknown>) => {
        if (o.type === "get_models") return { models: { chat: "opus", worker: null } };
        if (o.type === "fs_read") return { path: o.path, size: 5, binary: false, text: "# 開発くん" };
        throw new Error("unknown");
      },
    };
    const broker = async (...args: string[]) => {
      expect(args).toEqual(["agents"]);
      return JSON.stringify([{ id: "acct", model: { provider: "nous", model: "hermes-4" }, soul: "経理くん", files: { soul: "profiles/acct/SOUL.md" }, skills: [{ name: "books", description: "帳簿", category: "", path: "profiles/acct/skills/books/SKILL.md" }] }]);
    };
    const svc = new SystemService(bridge as never, broker, [], (id) => id);
    const out = (await svc.agents()) as AgentInfo[];
    expect(out[0]).toMatchObject({ id: "dev", soul: "# 開発くん", files: [{ root: "work", path: "CLAUDE.md" }] });
    expect(out[0].model).toContain("opus");
    expect(out[1]).toMatchObject({ id: "acct", model: "nous · hermes-4", files: [{ label: "SOUL.md（人格）", root: "hermes" }], skills: [{ name: "books", root: "hermes" }] });
  });
});
