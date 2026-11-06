import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { filterHits } from "../src/server/search";
import { UsageAlert, usageNotice } from "../src/server/usage-alert";
import type { NousCredits, SearchHit } from "../src/shared/types";

const credits = (p: Partial<NousCredits>): NousCredits => ({ at: 0, paidAccess: true, reason: null, plan: "x", monthly: 100, subscriptionRemaining: 50, purchasedRemaining: 0, totalRemaining: 50, periodEnd: "2026-12-01T00:00:00Z", ...p });

describe("使用量の知らせ", () => {
  test("80%・95%・止まったときだけ", () => {
    expect(usageNotice(credits({}))).toBeNull();
    expect(usageNotice(credits({ subscriptionRemaining: 20 }))!.title).toContain("80%");
    expect(usageNotice(credits({ subscriptionRemaining: 3 }))!.title).toContain("95%");
    expect(usageNotice(credits({ paidAccess: false, reason: "no credits" }))!.message).toContain("no credits");
    expect(usageNotice(credits({ error: "x", subscriptionRemaining: 0 }))).toBeNull();
    expect(usageNotice(credits({ monthly: null }))).toBeNull();
  });

  test("同じ期間・同じ段階は1回だけ。段階が上がる・期間が変わると、また知らせる", async () => {
    let c = credits({ subscriptionRemaining: 20 });
    const sent: string[] = [];
    const a = new UsageAlert(new Database(":memory:"), async () => c, (n) => sent.push(n.key));
    expect(await a.check()).toBe(true);
    expect(await a.check()).toBe(false);
    c = credits({ subscriptionRemaining: 2 });
    expect(await a.check()).toBe(true);
    c = credits({ subscriptionRemaining: 2, periodEnd: "2027-01-01T00:00:00Z" });
    expect(await a.check()).toBe(true);
    expect(sent.length).toBe(3);
  });
});

describe("検索の絞り込み", () => {
  const hit = (kind: SearchHit["kind"], ref: string, at = 100): SearchHit => ({ kind, ref, title: "t", snippet: "", at });
  const look = {
    taskOf: (id: number) => (id === 1 ? { agent: "acct", project: "A" } : null),
    memoOf: (id: number) => (id === 2 ? { project: "A" } : null),
  };
  const all = [hit("session", "acct/s1"), hit("session", "dev/9"), hit("apptask", "1"), hit("memo", "2"), hit("report", "d", 5)];

  test("期間・エージェント・プロジェクト。分からないものは絞ると外れる", () => {
    expect(filterHits(all, { since: 0, agent: "", project: "" }, look).length).toBe(5);
    expect(filterHits(all, { since: 50, agent: "", project: "" }, look).map((h) => h.ref)).not.toContain("d");
    expect(filterHits(all, { since: 0, agent: "acct", project: "" }, look).map((h) => h.ref)).toEqual(["acct/s1", "1"]);
    expect(filterHits(all, { since: 0, agent: "", project: "A" }, look).map((h) => h.ref)).toEqual(["1", "2"]);
  });
});
