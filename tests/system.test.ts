import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import { config } from "../src/server/config";
import { parsePlans, SystemService } from "../src/server/system";

function fakes() {
  const bridgeCalls: Record<string, unknown>[] = [];
  const brokerCalls: string[][] = [];
  const bridge = {
    connected: true,
    request: async (o: Record<string, unknown>) => {
      bridgeCalls.push(o);
      if (o.type === "usage") return { usage: { h5: { "claude-opus": 1200 }, d7: { "claude-opus": 50000 }, messages_h5: 3, messages_d7: 40, oldest_h5: 1 } };
      if (o.type === "get_models" || o.type === "set_model") return { models: { chat: o.type === "set_model" ? o.model : null, worker: null }, choices: ["opus", "sonnet"] };
      if (o.type === "fs_list") {
        if (String(o.path).includes(".env")) throw new Error("見せない場所: .env");
        return { path: o.path, items: [{ name: "README.md", dir: false, size: 8, mtime: 1, locked: false }] };
      }
      if (o.type === "fs_read") return { path: o.path, size: 8, binary: false, text: "# hello\n" };
      throw new Error("unknown");
    },
  };
  const broker = async (...args: string[]) => {
    brokerCalls.push(args);
    if (args[0] === "usage") return JSON.stringify({ default: { h5: { tokens: 1, cost: 0, sessions: 1 }, d7: { tokens: 2, cost: 0, sessions: 1 }, d30: { tokens: 3, cost: 0.5, sessions: 2 }, models: [] } });
    if (args[0] === "models") return JSON.stringify({ acct1: { current: { provider: "nous", model: "hermes-4" }, choices: [{ provider: "nous", model: "hermes-4" }, { provider: "openai-codex", model: "gpt-5", note: "ChatGPT Plus" }] } });
    if (args[0] === "set-model") return "{}";
    if (args[0] === "credits") return JSON.stringify({ logged_in: true, paid_access: false, reason: "out_of_credits", plan: "Plus", monthly: 110, subscription_remaining: 19.32, purchased_remaining: 0, total_remaining: 19.32, period_end: null, error: null });
    if (args[0] === "fs-list") return JSON.stringify({ path: "", items: [] });
    throw new Error("unknown");
  };
  const names = (id: string) => ({ dev: "開発くん", acct1: "経理くん", default: "ハブ" })[id] ?? id;
  const svc = new SystemService(bridge as never, broker, [{ name: "Claude Pro", usd: 20 }, { name: "Nous", usd: 100 }], names);
  return { svc, bridgeCalls, brokerCalls };
}

describe("システム", () => {
  test("使用量: Claude（bridge）と Hermes（仲介）をまとめ、1分はキャッシュする", async () => {
    const { svc, bridgeCalls } = fakes();
    const u = await svc.usage();
    expect(u.monthlyUsd).toBe(120);
    expect("error" in u.claude ? null : u.claude.h5).toEqual({ "claude-opus": 1200 });
    expect(u.hermes.default).toMatchObject({ d30: { cost: 0.5 } });
    await svc.usage();
    expect(bridgeCalls.filter((c) => c.type === "usage").length).toBe(1);
    await svc.usage(true);
    expect(bridgeCalls.filter((c) => c.type === "usage").length).toBe(2);
  });

  test("Nous のクレジット: 仲介の返事を形をそろえて返し、5分はキャッシュする", async () => {
    const { svc, brokerCalls } = fakes();
    const c = await svc.credits();
    expect(c).toMatchObject({ paidAccess: false, reason: "out_of_credits", monthly: 110, subscriptionRemaining: 19.32, periodEnd: null });
    expect(c.error).toBeUndefined();
    await svc.credits();
    expect(brokerCalls.filter((a) => a[0] === "credits").length).toBe(1);
    await svc.credits(true);
    expect(brokerCalls.filter((a) => a[0] === "credits").length).toBe(2);
  });

  test("モデル: 開発くん（会話・カンバン）と Hermes のプロファイル。切り替えは許可されたものだけ", async () => {
    const { svc, bridgeCalls, brokerCalls } = fakes();
    const ms = await svc.models();
    expect(ms.map((m) => [m.key, m.name, m.current])).toEqual([
      ["dev:chat", "開発くん（会話）", "claude · 既定"],
      ["dev:worker", "開発くん（カンバン）", "claude · sonnet"],
      ["hermes:acct1", "経理くん", "nous · hermes-4"],
    ]);
    expect(ms[2].choices[1]).toEqual({ id: "1", label: "openai-codex · gpt-5", note: "ChatGPT Plus" });
    await svc.setModel("dev:worker", "opus");
    expect(bridgeCalls.at(-1)).toEqual({ type: "set_model", target: "worker", model: "opus" });
    await svc.setModel("hermes:acct1", "1");
    expect(brokerCalls.at(-1)).toEqual(["set-model", "acct1", "1"]);
    for (const [k, c] of [["hermes:acct1", "gpt-5"], ["hermes:../x", "0"], ["dev:other", "opus"], ["evil", "0"]])
      await expect(svc.setModel(k, c)).rejects.toThrow("切り替えられない");
  });

  test("API: ファイルの拒否は 403、知らない場所はエラー", async () => {
    const { svc } = fakes();
    const app = createApp({ ...config, devNoAuth: true }, {} as never, {} as never, ".", { system: svc });
    const ok = await app.request("/api/system/fs/work?read=1&path=repo/README.md");
    expect(((await ok.json()) as { text: string }).text).toBe("# hello\n");
    expect((await app.request("/api/system/fs/work?path=repo/.env")).status).toBe(403);
    expect((await app.request("/api/system/fs/root?path=")).status).toBe(500);
    const set = await app.request("/api/system/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "dev:chat", choice: "opus" }) });
    expect(((await set.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("月額の設定の読み込み", () => {
    expect(parsePlans('[{"name":"A","usd":20},{"name":"B"}]')).toEqual([{ name: "A", usd: 20 }]);
    expect(parsePlans("x")).toEqual([]);
  });
});
