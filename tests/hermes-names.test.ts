import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { HermesNameSync } from "../src/server/hermes-names";

/** 偽の仲介: Hermes 側の表示名を持ち、broker の set-display-name と同じ判定をする */
function fake(initial: Record<string, string> = {}) {
  const hermes = { ...initial };
  const calls: string[][] = [];
  let down = false;
  const call = async (...a: string[]) => {
    calls.push(a);
    if (down) throw new Error("仲介が落ちている");
    const [, id, raw] = a;
    const arg = JSON.parse(raw) as { name: string; expect?: string };
    const cur = hermes[id] ?? "";
    if (arg.expect !== undefined && cur !== arg.expect && cur !== arg.name) return JSON.stringify({ ok: false, conflict: true, current: cur });
    hermes[id] = arg.name;
    return JSON.stringify({ ok: true, current: arg.name });
  };
  return { hermes, calls, call, down: (v: boolean) => (down = v) };
}

describe("名前を Hermes に写す", () => {
  test("初めては Hermes 側が空なら書ける。2回目は前に書いた値を確かめる", async () => {
    const f = fake();
    const s = new HermesNameSync(new Database(":memory:"), f.call);
    expect(await s.sync("acct", "経理")).toMatchObject({ state: "synced", synced: "経理" });
    expect(f.hermes.acct).toBe("経理");
    expect(JSON.parse(f.calls[0][2])).toEqual({ name: "経理", expect: "" });
    await s.sync("acct", "経理部");
    expect(JSON.parse(f.calls[1][2])).toEqual({ name: "経理部", expect: "経理" });
    expect(f.hermes.acct).toBe("経理部");
  });

  test("Hermes 側で別に直されていたら上書きせず競合。本人が選べば上書きできる", async () => {
    const f = fake({ acct: "Hermes で付けた名前" });
    const s = new HermesNameSync(new Database(":memory:"), f.call);
    const r = await s.sync("acct", "経理");
    expect(r).toMatchObject({ state: "conflict", current: "Hermes で付けた名前" });
    expect(f.hermes.acct).toBe("Hermes で付けた名前");
    expect(s.get("acct")?.state).toBe("conflict");
    expect(await s.sync("acct", "経理", true)).toMatchObject({ state: "synced", synced: "経理" });
    expect(f.hermes.acct).toBe("経理");
  });

  test("失敗しても例外にならず、最後に書けた値を残す。直ったら再試行で書ける", async () => {
    const f = fake();
    const s = new HermesNameSync(new Database(":memory:"), f.call);
    await s.sync("acct", "経理");
    f.down(true);
    const r = await s.sync("acct", "経理部");
    expect(r).toMatchObject({ state: "failed", synced: "経理", error: "仲介が落ちている" });
    f.down(false);
    expect(await s.sync("acct", "経理部")).toMatchObject({ state: "synced", synced: "経理部" });
  });

  test("仲介が無いとき（Hermes につながっていない）は失敗として残る", async () => {
    const s = new HermesNameSync(new Database(":memory:"), null);
    expect(await s.sync("acct", "x")).toMatchObject({ state: "failed" });
  });

  test("同じ id の書き込みは順番に走る", async () => {
    const f = fake();
    const s = new HermesNameSync(new Database(":memory:"), f.call);
    const [a, b] = await Promise.all([s.sync("acct", "A"), s.sync("acct", "B")]);
    expect(a.state).toBe("synced");
    expect(b.state).toBe("synced");
    expect(f.hermes.acct).toBe("B");
    expect(JSON.parse(f.calls[1][2]).expect).toBe("A");
  });
});
