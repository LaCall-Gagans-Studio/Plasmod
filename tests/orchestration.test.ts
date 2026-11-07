import { describe, expect, test } from "bun:test";
import { agentLinks } from "../src/shared/orchestration";
import type { AgentProfile, KanbanTask } from "../src/shared/types";

const agents = [
  { id: "default", name: "ハブ", aliases: ["hub"] },
  { id: "dev", name: "開発" },
  { id: "acct", name: "経理" },
] as unknown as AgentProfile[];
const NOW = 1_800_000_000_000;
const S = NOW / 1000;
const card = (over: Partial<KanbanTask>): KanbanTask => ({ id: "t", title: "t", body: null, assignee: "dev", status: "ready", priority: 0, created_by: "default", created_at: S, started_at: null, completed_at: null, last_heartbeat_at: null, block_kind: null, result: null, latest_comment: null, ...over });

describe("オーケストレーションの線", () => {
  test("作成者→担当を束ね、動いているカードがあれば live", () => {
    const links = agentLinks(agents, [card({}), card({ status: "running", created_by: "hub" })], NOW);
    expect(links).toEqual([{ from: "default", to: "dev", count: 2, live: true }]);
  });

  test("エージェントでない作成者はオーナーの依頼。自分宛ては線にしない", () => {
    const links = agentLinks(agents, [card({ created_by: "owner", assignee: "acct" }), card({ created_by: null, assignee: "acct" }), card({ created_by: "dev", assignee: "dev" })], NOW);
    expect(links).toEqual([{ from: "me", to: "acct", count: 2, live: false }]);
  });

  test("閉じたカードは7日まで。開いているカードは古くても数える。担当がいなければ数えない", () => {
    const old = S - 8 * 86400;
    const links = agentLinks(agents, [
      card({ status: "done", created_at: old, completed_at: old }),
      card({ status: "done", assignee: "acct", created_at: old, completed_at: S - 86400 }),
      card({ status: "blocked", assignee: "default", created_by: "dev", created_at: old }),
      card({ assignee: null }),
    ], NOW);
    expect(links.map((l) => `${l.from}>${l.to}`).sort()).toEqual(["default>acct", "dev>default"]);
  });
});
