import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/server/config";
import { Hub } from "../src/server/hub";
import { FixtureSource } from "../src/server/kanban";
import { deriveAgents, deriveCards, inboxCard } from "../src/server/model";
import { buildReport } from "../src/server/report";
import { Store } from "../src/server/store";
import type { Board, Card, KanbanTask } from "../src/shared/types";

const FIXTURE = join(import.meta.dir, "../fixtures/board.json");
const NOW = 1_792_460_000;
const task = (p: Partial<KanbanTask>): KanbanTask => ({
  id: "t_in1", title: "件名", body: null, assignee: "owner", status: "ready", priority: 0, created_by: "default",
  created_at: NOW, started_at: null, completed_at: null, last_heartbeat_at: null, block_kind: null, result: null, latest_comment: null, ...p,
});
const NONE = { snoozedUntil: new Map<string, number>(), decidedAt: new Map<string, number>() };

describe("受信箱のカード", () => {
  test("オーナーさん宛てのカンバンのカードは、任せる・あとで・不要の選択肢つきのカードになる。作った人がカードの主", () => {
    const c = inboxCard(task({ title: "期限が明日", body: "スライドを仕上げる", created_by: "hub1" }), config.profiles)!;
    expect(c).toMatchObject({ key: "task:t_in1", kind: "todo", agent: "default", statusLabel: "対応", body: "スライドを仕上げる", taskId: "t_in1" });
    expect(c.options.map((o) => o.id)).toEqual(["handle", "later", "dismiss"]);
    expect(inboxCard(task({ created_by: null }), config.profiles)!.agent).toBe("me");
    expect(inboxCard(task({ status: "done" }), config.profiles)).toBeNull();
  });

  test("旧形式の見出し（gh-card）は特別扱いしない。本文のまま", () => {
    const c = inboxCard(task({ body: "gh-card: reply\nagent: acct\n---\n本文" }), config.profiles)!;
    expect(c).toMatchObject({ kind: "todo", body: "gh-card: reply\nagent: acct\n---\n本文" });
    expect(c.delegate).toBeUndefined();
  });

  test("判断待ち・承認依頼より後ろ、メモより前。エージェントの数には入らない", () => {
    const board = { latest_event_id: 1, links: [], active_runs: [], fetched_at: 0, tasks: [
      task({ id: "t_b", title: "新しい", created_at: NOW + 60 }),
      task({ id: "t_c", title: "別", created_at: NOW + 30 }),
      task({ id: "t_d", title: "止まっている", assignee: "dev", status: "blocked", created_at: NOW }),
    ] } satisfies Board;
    const cards = deriveCards(board, [], config.profiles, NONE, NOW * 1000 + 1e6, [{ id: 1, title: "メモ", body: "", created_at: 1 }]);
    expect(cards.map((c) => c.key)).toEqual(["task:t_d", "task:t_b", "task:t_c", "note:1"]);
    expect(deriveAgents(board, config.profiles, "default").map((a) => a.id)).not.toContain("owner");
    // 受信箱の完了は、エージェントの実績に数えない
    const done = { ...board, tasks: [task({ id: "t_x", status: "done", completed_at: NOW })] };
    const r = buildReport(done, [], config.profiles, NOW * 1000 + 1000);
    expect(r.slides.flatMap((s) => (s.kind === "digest" ? s.agents : []))).toEqual([]);
  });
});

describe("受信箱の判断", () => {
  async function setup(tasks: KanbanTask[]) {
    const base = JSON.parse(readFileSync(FIXTURE, "utf8")) as Board;
    const path = join(mkdtempSync(join(tmpdir(), "gh-inbox-")), "board.json");
    writeFileSync(path, JSON.stringify({ ...base, tasks: [...base.tasks, ...tasks] }));
    const source = new FixtureSource(path);
    const swept: Card[][] = [];
    const once: Set<string>[] = [];
    const store = new Store(":memory:");
    const hub = new Hub(config, source, store, null, { sweep: async (c: Card[], _now: number, o: Set<string>) => void (swept.push(c), once.push(o)) } as never);
    await hub.refresh();
    return { hub, source, swept, once, store };
  }
  const todo = task({ id: "t_td", title: "請求書の返信", body: "田中さんから。" });

  test("任せる: ハブ（ハブ）にカードを起こし、受信箱のカードは完了にする（本文と一言を引き継ぐ）", async () => {
    const { hub, source } = await setup([todo]);
    await hub.act("task:t_td", "handle", "来週払いで返信して", "app");
    expect(source.log.find((l) => l.startsWith("create "))).toMatch(/^create t_fx\d+ default 請求書の返信$/);
    expect(source.log.some((l) => l.startsWith("complete t_td") && l.includes("対応する → t_fx"))).toBe(true);
    const board = await source.board();
    const made = board.tasks.find((t) => t.title === "請求書の返信" && t.assignee === "default")!;
    expect(made.body).toContain("来週払いで返信して");
    expect(made.body).toContain("田中さんから。");
    expect(made.body).toContain("受信箱のカード: t_td");
    expect(hub.cards().some((c) => c.key === "task:t_td")).toBe(false);
  });

  test("不要: 実行者を起こさず、完了にするだけ。あとでは残る", async () => {
    const { hub, source } = await setup([task({ id: "t_no", body: "x" }), task({ id: "t_lt", body: "y" })]);
    await hub.act("task:t_no", "dismiss", "もう済んでる", "app");
    await hub.act("task:t_lt", "later", "", "app");
    expect(source.log.filter((l) => l.startsWith("create"))).toEqual([]);
    expect(source.log.filter((l) => l.startsWith("complete")).map((l) => l.split(" ")[1])).toEqual(["t_no"]);
    expect(hub.cards().map((c) => c.key)).not.toContain("task:t_lt"); // スヌーズ中
    await expect(hub.act("task:t_no", "dismiss", "", "app")).rejects.toThrow("もう");
  });

  test("triage・todo の受信箱のカードは、完了ではなくコメントを残してアーカイブで閉じる（Hermes の完了は断る）", async () => {
    const { hub, source } = await setup([task({ id: "t_tr", status: "triage", body: "x" }), task({ id: "t_to", status: "todo", body: "y" })]);
    await hub.act("task:t_tr", "dismiss", "要らない", "app");
    await hub.act("task:t_to", "dismiss", "", "app");
    expect(source.log.filter((l) => l.startsWith("complete"))).toEqual([]);
    expect(source.log.filter((l) => /^(comment|archive) t_t[ro]/.test(l)).map((l) => l.split(" ").slice(0, 2).join(" "))).toEqual([
      "comment t_tr", "archive t_tr", "comment t_to", "archive t_to",
    ]);
    expect(source.log.find((l) => l.startsWith("comment t_tr"))).toContain("不要");
    expect(hub.cards().some((c) => c.key === "task:t_tr" || c.key === "task:t_to")).toBe(false);
  });

  test("カンバンのカードの仕分け: 担当を決めて todo に戻す／アーカイブ", async () => {
    const { hub, source } = await setup([task({ id: "t_sp", status: "triage", assignee: "design" }), task({ id: "t_ar", status: "triage", assignee: "acct" })]);
    await hub.specifyTask("t_sp", "acct");
    await hub.archiveTask("t_ar");
    const b = await source.board();
    expect(b.tasks.find((t) => t.id === "t_sp")).toMatchObject({ status: "todo", assignee: "acct" });
    expect(b.tasks.find((t) => t.id === "t_ar")!.status).toBe("archived");
    await expect(hub.specifyTask("t_sp", "default")).rejects.toThrow("仕分け待ちではない");
  });

  test("受信箱のカードは、届いたときに1回だけ通知する（再通知しない）", async () => {
    const { swept, once } = await setup([todo]);
    expect(swept.at(-1)!.some((c) => c.key === "task:t_td")).toBe(true);
    expect(once.at(-1)!.has("task:t_td")).toBe(true);
    expect(once.at(-1)!.has("task:t_8f2a")).toBe(false);
  });
});
