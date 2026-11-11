import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AppSettings } from "../src/server/profiles";
import { TokenTotal, windowTokens } from "../src/server/token-total";
import type { UsageSnapshot } from "../src/shared/types";

const snap = (claude: UsageSnapshot["claude"], hermes: UsageSnapshot["hermes"] = {}): UsageSnapshot => ({ claude, hermes, plans: [], monthlyUsd: 0, at: 0 });

describe("使ったトークンの総数", () => {
  test("窓の合計は Claude 7日 + Hermes 30日。取れなかった側は数えない", () => {
    const w = { tokens: 0, cost: 0, sessions: 0 };
    expect(windowTokens(snap({ h5: {}, d7: { a: 100, b: 50 }, messages_h5: 0, messages_d7: 0, oldest_h5: null }, { x: { h5: w, d7: w, d30: { ...w, tokens: 1000 }, models: [] }, y: { error: "x" } }))).toBe(1150);
    expect(windowTokens(snap({ error: "no" }))).toBe(0);
  });

  test("初回は今の合計を出発点にして、増えた分だけ足す。減っても総数は減らない", () => {
    const t = new TokenTotal(new AppSettings(new Database(":memory:")));
    expect(t.observe(1000)).toBe(1000);
    expect(t.observe(1500)).toBe(1500);
    expect(t.observe(1200)).toBe(1500); // 古い分が窓から抜けた
    expect(t.observe(1300)).toBe(1600);
    expect(t.get()).toBe(1600);
    expect(t.observe(Number.NaN)).toBe(1600);
  });
});
